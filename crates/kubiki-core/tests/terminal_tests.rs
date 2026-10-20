use futures::{SinkExt, StreamExt};
use kube::{Client, Config};
use kubiki_core::{
    core::api::{ApiError, ResourceQuery, ResourceRef},
    pod_ops::terminal::{ExecEvent, ExecRequest, PodTerminalManager},
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};
fn request() -> ExecRequest {
    ExecRequest {
        resource: ResourceRef {
            query: ResourceQuery {
                context: "test".into(),
                group: "".into(),
                version: "v1".into(),
                kind: "Pod".into(),
                namespace: Some("backend".into()),
            },
            name: "web".into(),
            uid: Some("uid".into()),
        },
        container: "app".into(),
        shell: "/bin/sh".into(),
        cols: 80,
        rows: 24,
    }
}
fn pod() -> Value {
    json!({"apiVersion":"v1","kind":"Pod","metadata":{"uid":"uid","name":"web","namespace":"backend"},"spec":{"containers":[{"name":"app","image":"test"}]},"status":{"phase":"Running","containerStatuses":[{"name":"app","ready":true,"restartCount":0,"image":"test","imageID":"id","state":{"running":{}}}]}})
}
async fn http(socket: &mut tokio::net::TcpStream, status: u16, body: Value) {
    let mut bytes = Vec::new();
    loop {
        let mut buf = [0; 1024];
        let n = socket.read(&mut buf).await.unwrap();
        bytes.extend_from_slice(&buf[..n]);
        if n == 0 || bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    assert!(
        String::from_utf8_lossy(&bytes).starts_with("GET /api/v1/namespaces/backend/pods/web ")
    );
    let body = body.to_string();
    socket.write_all(format!("HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
#[tokio::test]
async fn real_websocket_exec_carries_input_resize_utf8_output_and_exit_status() {
    for exit_code in [0, 7] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = Client::try_from(Config::new(
            format!("http://{}", listener.local_addr().unwrap())
                .parse()
                .unwrap(),
        ))
        .unwrap();
        let captured = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let frames = captured.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            http(&mut socket, 200, pod()).await;
            drop(socket);
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = accept_hdr_async(socket, |request: &Request, mut response: Response| {
                let uri = request.uri().to_string();
                assert!(uri.starts_with("/api/v1/namespaces/backend/pods/web/exec?"));
                for field in [
                    "container=app",
                    "command=%2Fbin%2Fsh",
                    "tty=true",
                    "stdin=true",
                    "stdout=true",
                ] {
                    assert!(uri.contains(field), "{uri}");
                }
                assert!(!uri.contains("stderr=true"));
                response.headers_mut().insert(
                    "sec-websocket-protocol",
                    "v4.channel.k8s.io".parse().unwrap(),
                );
                Ok(response)
            })
            .await
            .unwrap();
            let mut input_seen = false;
            let mut resized = false;
            loop {
                let data = ws.next().await.unwrap().unwrap().into_data().to_vec();
                frames.lock().unwrap().push(data.clone());
                if data.first() == Some(&0) {
                    assert_eq!(&data[1..], "echo привет\r\u{3}".as_bytes());
                    input_seen = true;
                }
                if data.first() == Some(&4)
                    && serde_json::from_slice::<Value>(&data[1..]).unwrap()
                        == json!({"Width":120,"Height":32})
                {
                    resized = true;
                }
                if input_seen && resized {
                    break;
                }
            }
            let bytes = "привет\r\n".as_bytes();
            ws.send(Message::Binary([&[1][..], &bytes[..3]].concat().into()))
                .await
                .unwrap();
            ws.send(Message::Binary([&[1][..], &bytes[3..]].concat().into()))
                .await
                .unwrap();
            ws.send(Message::Binary(
            [&[3][..], if exit_code==0 {json!({"status":"Success"})} else {json!({"status":"Failure","reason":"NonZeroExitCode","details":{"causes":[{"reason":"ExitCode","message":"7"}]}})}.to_string().as_bytes()]
                .concat()
                .into(),
        ))
        .await
        .unwrap();
            let _ = ws.close(None).await;
        });
        let manager = PodTerminalManager::default();
        let mut stream = manager
            .start("main", "shell", request(), async move { Ok(client) })
            .await
            .unwrap()
            .output;
        let mut output = Vec::new();
        let mut seq = 0;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(message) = stream.recv().await {
                assert_eq!(message.sequence, seq + 1);
                seq = message.sequence;
                match message.event {
                    ExecEvent::Started => {
                        manager.resize("main", "shell", 120, 32).await.unwrap();
                        manager
                            .write("main", "shell", "echo привет\r\u{3}".into())
                            .await
                            .unwrap();
                    }
                    ExecEvent::Output { data } => output.extend(data),
                    ExecEvent::Exited { code } => {
                        assert_eq!(code, exit_code);
                        break;
                    }
                    ExecEvent::Failed { error } => panic!("{error:?}"),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(String::from_utf8(output).unwrap(), "привет\r\n");
        server.await.unwrap();
        let frames = captured.lock().unwrap();
        let sizes: Vec<Value> = frames
            .iter()
            .filter(|f| f.first() == Some(&4))
            .map(|f| serde_json::from_slice(&f[1..]).unwrap())
            .collect();
        assert!(sizes.contains(&json!({"Width":80,"Height":24})));
        assert!(sizes.contains(&json!({"Width":120,"Height":32})));
        drop(frames);
        manager.stop("main", "shell").await;
        assert_eq!(manager.active_count().await, 0);
    }
}
#[tokio::test]
async fn uid_mismatch_completed_container_and_forbidden_fail_before_exec() {
    for (status, body, expected) in [
        (
            200,
            {
                let mut p = pod();
                p["metadata"]["uid"] = "replacement".into();
                p
            },
            409,
        ),
        (
            200,
            {
                let mut p = pod();
                p["status"]["containerStatuses"][0]["state"] = json!({"terminated":{"exitCode":0}});
                p
            },
            409,
        ),
        (
            403,
            json!({"kind":"Status","apiVersion":"v1","code":403,"message":"pods is forbidden","reason":"Forbidden"}),
            403,
        ),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = Client::try_from(Config::new(
            format!("http://{}", listener.local_addr().unwrap())
                .parse()
                .unwrap(),
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            http(&mut s, status, body).await;
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        let manager = PodTerminalManager::default();
        let mut output = manager
            .start("main", "denied", request(), async move { Ok(client) })
            .await
            .unwrap()
            .output;
        let message = tokio::time::timeout(Duration::from_secs(3), output.recv())
            .await
            .unwrap()
            .unwrap();
        let ExecEvent::Failed { error } = message.event else {
            panic!("unexpected {message:?}")
        };
        assert_eq!(error.status, Some(expected));
        manager.stop_owner("main").await;
        server.await.unwrap();
    }
}
#[tokio::test]
async fn cancellation_covers_pending_client_owner_isolation_and_input_limits() {
    let manager = PodTerminalManager::default();
    let _pending = manager
        .start(
            "one",
            "same",
            request(),
            std::future::pending::<Result<Client, ApiError>>(),
        )
        .await
        .unwrap();
    assert_eq!(
        manager
            .start("one", "same", request(), std::future::pending())
            .await
            .unwrap_err()
            .status,
        Some(409)
    );
    let _other = manager
        .start("two", "same", request(), std::future::pending())
        .await
        .unwrap();
    assert_eq!(
        manager
            .write("other", "same", "oops".into())
            .await
            .unwrap_err()
            .status,
        Some(404)
    );
    assert_eq!(
        manager
            .write("one", "same", "x".repeat(65537))
            .await
            .unwrap_err()
            .status,
        Some(400)
    );
    assert_eq!(
        manager
            .resize("one", "same", 0, 100)
            .await
            .unwrap_err()
            .status,
        Some(400)
    );
    manager.stop_owner("one").await;
    assert_eq!(manager.active_count().await, 1);
    manager.stop_owner("two").await;
    assert_eq!(manager.active_count().await, 0);
    let mut invalid = request();
    invalid.resource.uid = None;
    assert_eq!(
        manager
            .start("one", "bad", invalid, std::future::pending())
            .await
            .unwrap_err()
            .status,
        Some(400)
    );
}

#[tokio::test]
async fn exec_upgrade_rbac_denial_preserves_403_and_cancellation_closes_an_attached_socket() {
    for denied in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = Client::try_from(Config::new(
            format!("http://{}", listener.local_addr().unwrap())
                .parse()
                .unwrap(),
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            http(&mut socket, 200, pod()).await;
            drop(socket);
            let (mut socket, _) = listener.accept().await.unwrap();
            if denied {
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 1024];
                    let n = socket.read(&mut buffer).await.unwrap();
                    bytes.extend_from_slice(&buffer[..n]);
                    if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                assert!(String::from_utf8_lossy(&bytes).contains("/exec?"));
                socket
                    .write_all(
                        b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await
                    .unwrap();
            } else {
                let mut ws = accept_hdr_async(socket, |_: &Request, mut response: Response| {
                    response.headers_mut().insert(
                        "sec-websocket-protocol",
                        "v4.channel.k8s.io".parse().unwrap(),
                    );
                    Ok(response)
                })
                .await
                .unwrap();
                tokio::time::timeout(Duration::from_secs(3), async {
                    while let Some(Ok(message)) = ws.next().await {
                        if message.is_close() {
                            break;
                        }
                    }
                })
                .await
                .expect("closing the session must close the actual WebSocket");
            }
        });
        let manager = PodTerminalManager::default();
        let mut output = manager
            .start("main", "socket", request(), async move { Ok(client) })
            .await
            .unwrap()
            .output;
        let message = tokio::time::timeout(Duration::from_secs(3), output.recv())
            .await
            .unwrap()
            .unwrap();
        if denied {
            let ExecEvent::Failed { error } = message.event else {
                panic!("{message:?}")
            };
            assert_eq!(error.status, Some(403));
        } else {
            assert!(matches!(message.event, ExecEvent::Started));
        }
        manager.stop_owner("main").await;
        assert_eq!(manager.active_count().await, 0);
        server.await.unwrap();
    }
}
