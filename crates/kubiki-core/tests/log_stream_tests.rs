use kube::{Client, Config};
use kubiki_core::{
    core::api::{ApiError, ResourceQuery, ResourceRef},
    pod_ops::log_sessions::{LogEvent, LogRequest, PodLogManager},
};
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
fn request() -> LogRequest {
    LogRequest {
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
        follow: true,
        previous: false,
        tail_lines: 100,
        since_seconds: Some(300),
    }
}
async fn header(socket: &mut TcpStream) -> String {
    let mut data = Vec::new();
    loop {
        let mut b = [0; 1024];
        let n = socket.read(&mut b).await.unwrap();
        data.extend_from_slice(&b[..n]);
        if n == 0 || data.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8_lossy(&data).into_owned()
}
async fn reply(socket: &mut TcpStream, status: u16, body: String) {
    socket.write_all(format!("HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
async fn fixture() -> (TcpListener, Client) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Client::try_from(Config::new(
        format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap(),
    ))
    .unwrap();
    (listener, client)
}
fn pod(uid: &str) -> String {
    json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"web","namespace":"backend","uid":uid},"spec":{"containers":[{"name":"app","image":"test"}]}}).to_string()
}

#[tokio::test]
async fn streams_before_eof_and_passes_follow_previous_tail_since_and_timestamps() {
    for previous in [false, true] {
        let (listener, client) = fixture().await;
        let (finish, finished) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(
                header(&mut socket)
                    .await
                    .starts_with("GET /api/v1/namespaces/backend/pods/web ")
            );
            reply(&mut socket, 200, pod("uid")).await;
            drop(socket);
            let (mut socket, _) = listener.accept().await.unwrap();
            let url = header(&mut socket).await;
            for value in [
                "/pods/web/log?",
                "container=app",
                "tailLines=100",
                "sinceSeconds=300",
                "timestamps=true",
            ] {
                assert!(url.contains(value), "{url}");
            }
            assert_eq!(url.contains("previous=true"), previous);
            assert_eq!(url.contains("follow=true"), !previous);
            socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n").await.unwrap();
            let bytes = "2026-10-20T08:00:00Z привет 🌍\n".as_bytes();
            for part in [&bytes[..25], &bytes[25..]] {
                socket
                    .write_all(format!("{:X}\r\n", part.len()).as_bytes())
                    .await
                    .unwrap();
                socket.write_all(part).await.unwrap();
                socket.write_all(b"\r\n").await.unwrap();
            }
            finished.await.unwrap();
            socket.write_all(b"0\r\n\r\n").await.unwrap();
        });
        let manager = PodLogManager::default();
        let mut req = request();
        req.previous = previous;
        req.follow = !previous;
        let mut output = manager
            .start("main", "logs", req, async move { Ok(client) })
            .await
            .unwrap()
            .output;
        let mut bytes = Vec::new();
        let mut sequence = 0;
        tokio::time::timeout(Duration::from_secs(5), async {
            while !bytes.ends_with(b"\n") {
                let m = output.recv().await.unwrap();
                assert_eq!(m.sequence, sequence + 1);
                sequence = m.sequence;
                match m.event {
                    LogEvent::Output { data } => bytes.extend(data),
                    LogEvent::Started => {}
                    other => panic!("{other:?}"),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "2026-10-20T08:00:00Z привет 🌍\n"
        );
        finish.send(()).unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(5), output.recv())
                .await
                .unwrap()
                .unwrap()
                .event,
            LogEvent::Completed
        ));
        manager.stop("main", "logs").await;
        assert_eq!(manager.session_count().await, 0);
        server.await.unwrap();
    }
}
#[tokio::test]
async fn preserves_get_and_log_403_and_rejects_recreated_pod_before_logs() {
    for mode in [0, 1, 2] {
        let (listener, client) = fixture().await;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            header(&mut socket).await;
            if mode == 0 {
                reply(&mut socket,403,json!({"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Forbidden","message":"get pods denied","code":403}).to_string()).await;
            } else {
                reply(
                    &mut socket,
                    200,
                    pod(if mode == 1 { "new-uid" } else { "uid" }),
                )
                .await;
                drop(socket);
                if mode == 2 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    header(&mut socket).await;
                    reply(&mut socket,403,json!({"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Forbidden","message":"pods/log denied","code":403}).to_string()).await;
                } else {
                    assert!(
                        tokio::time::timeout(Duration::from_millis(100), listener.accept())
                            .await
                            .is_err()
                    );
                }
            }
        });
        let manager = PodLogManager::default();
        let mut output = manager
            .start("main", "logs", request(), async move { Ok(client) })
            .await
            .unwrap()
            .output;
        let message = tokio::time::timeout(Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap();
        match message.event {
            LogEvent::Failed { error } => {
                assert_eq!(error.status, Some(if mode == 1 { 409 } else { 403 }));
                assert_eq!(error.operation, "logs");
            }
            other => panic!("{other:?}"),
        }
        manager.stop_owner("main").await;
        server.await.unwrap();
    }
}
#[tokio::test]
async fn cancellation_closes_stream_and_owner_isolation_protects_other_sessions() {
    let (listener, client) = fixture().await;
    let (closed, closed_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        header(&mut socket).await;
        reply(&mut socket, 200, pod("uid")).await;
        drop(socket);
        let (mut socket, _) = listener.accept().await.unwrap();
        header(&mut socket).await;
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        let mut b = [0; 1];
        let n = socket.read(&mut b).await.unwrap();
        closed.send(n).unwrap();
    });
    let manager = PodLogManager::default();
    let mut output = manager
        .start("main", "logs", request(), async move { Ok(client) })
        .await
        .unwrap()
        .output;
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap()
            .event,
        LogEvent::Started
    ));
    manager.stop("other-window", "logs").await;
    assert_eq!(manager.session_count().await, 1);
    manager.stop_owner("main").await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), closed_rx)
            .await
            .unwrap()
            .unwrap(),
        0
    );
    server.await.unwrap();
    let _pending = manager
        .start(
            "main",
            "pending",
            request(),
            std::future::pending::<Result<Client, ApiError>>(),
        )
        .await
        .unwrap();
    manager.stop_owner("main").await;
    assert_eq!(manager.session_count().await, 0);
}
#[tokio::test]
async fn rejects_invalid_options_before_connection_and_bounds_session_count() {
    let manager = PodLogManager::default();
    for change in [0, 1, 2, 3] {
        let mut req = request();
        match change {
            0 => req.tail_lines = 10001,
            1 => req.since_seconds = Some(-1),
            2 => req.resource.uid = None,
            _ => req.previous = true,
        };
        assert_eq!(
            manager
                .start("main", "invalid", req, std::future::pending())
                .await
                .err()
                .unwrap()
                .status,
            Some(400)
        );
    }
    let mut outputs = Vec::new();
    for i in 0..32 {
        outputs.push(
            manager
                .start(
                    "main",
                    &format!("logs-{i}"),
                    request(),
                    std::future::pending(),
                )
                .await
                .unwrap(),
        );
    }
    assert_eq!(
        manager
            .start("main", "extra", request(), std::future::pending())
            .await
            .err()
            .unwrap()
            .status,
        Some(429)
    );
    manager.stop_owner("main").await;
    assert_eq!(manager.session_count().await, 0);
}
