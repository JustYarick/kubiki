use futures::{SinkExt, StreamExt};
use kube::{Client, Config};
use kubiki_core::{
    core::api::{ResourceQuery, ResourceRef},
    pod_ops::port_forward::{ForwardRequest, PortForwardManager, service_target_port},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};
fn request(kind: &str) -> ForwardRequest {
    ForwardRequest {
        resource: ResourceRef {
            query: ResourceQuery {
                context: "test".into(),
                group: "".into(),
                version: "v1".into(),
                kind: kind.into(),
                namespace: Some("backend".into()),
            },
            name: "web".into(),
            uid: Some(
                if kind == "Pod" {
                    "pod-uid"
                } else {
                    "service-uid"
                }
                .into(),
            ),
        },
        remote_port: if kind == "Pod" { 8080 } else { 80 },
        local_port: 0,
    }
}
fn pod() -> Value {
    json!({"apiVersion":"v1","kind":"Pod","metadata":{"uid":"pod-uid","name":"web","namespace":"backend","labels":{"app":"web"}},"spec":{"containers":[{"name":"app","image":"test","ports":[{"name":"http","containerPort":8080}]}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}})
}
fn service() -> Value {
    json!({"apiVersion":"v1","kind":"Service","metadata":{"uid":"service-uid","name":"web","namespace":"backend"},"spec":{"selector":{"app":"web"},"ports":[{"port":80,"targetPort":"http"}]}})
}
struct Fixture {
    client: Client,
    task: JoinHandle<()>,
    refuse: Arc<AtomicBool>,
    upgrades: Arc<AtomicUsize>,
    selected: Arc<AtomicBool>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn fixture(mode: &'static str) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Client::try_from(Config::new(
        format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap(),
    ))
    .unwrap();
    let refuse = Arc::new(AtomicBool::new(false));
    let upgrades = Arc::new(AtomicUsize::new(0));
    let selected = Arc::new(AtomicBool::new(false));
    let (r, u, s) = (refuse.clone(), upgrades.clone(), selected.clone());
    let task = tokio::spawn(async move {
        let mut children = tokio::task::JoinSet::new();
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (refuse, upgrades, selected) = (r.clone(), u.clone(), s.clone());
            children.spawn(async move {
                let mut header = [0; 8192]; let size = socket.peek(&mut header).await.unwrap(); let text = String::from_utf8_lossy(&header[..size]).to_string();
                if text.contains("/portforward?") {
                    assert!(text.contains("ports=8080")); upgrades.fetch_add(1, Ordering::SeqCst);
                    let ws = accept_hdr_async(socket, |req: &Request, mut res: Response| {
                        if mode == "forbidden" { return Err(tokio_tungstenite::tungstenite::http::Response::builder().status(403).body(Some("portforward forbidden".into())).unwrap()); }
                        res.headers_mut().insert("sec-websocket-protocol", req.headers().get("sec-websocket-protocol").unwrap().clone()); Ok(res)
                    }).await;
                    let Ok(mut ws) = ws else { return; };
                    for channel in [0, 1] { ws.send(Message::Binary(vec![channel, 0x90, 0x1f].into())).await.unwrap(); }
                    if mode == "closed" { let _ = ws.close(None).await; return; }
                    if refuse.load(Ordering::SeqCst) { let mut message = vec![1]; message.extend(b"connection refused by application"); let _ = ws.send(Message::Binary(message.into())).await; }
                    while let Some(Ok(message)) = ws.next().await { if message.is_binary() { if ws.send(message).await.is_err() { break; } } }
                    return;
                }
                if mode == "delay" { tokio::time::sleep(Duration::from_secs(30)).await; return; }
                let path = text.split_whitespace().nth(1).unwrap_or("");
                let mut body = if path.contains("/services/") { service() } else if path.contains("/pods?") {
                    selected.store(path.contains("labelSelector=app%3Dweb"), Ordering::SeqCst);
                    json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":[pod()]})
                } else { pod() };
                if mode == "recreated" { body["metadata"]["uid"] = json!("new-uid"); }
                let mut consumed = [0;8192]; let _ = socket.read(&mut consumed).await;
                let body = body.to_string(); let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            });
            while children.try_join_next().is_some() {}
        }
    });
    Fixture {
        client,
        task,
        refuse,
        upgrades,
        selected,
    }
}
async fn until(mut predicate: impl AsyncFnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !predicate().await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn actual_websocket_tcp_transfer_auto_port_counters_owner_isolation_and_stop() {
    for kind in ["Pod", "Service"] {
        let f = fixture("ok").await;
        let manager = PortForwardManager::new();
        let session = manager
            .start("main", "tunnel", f.client.clone(), request(kind))
            .await
            .unwrap();
        assert!(session.local_port > 0);
        assert_eq!(session.pod_port, 8080);
        assert_eq!(session.pod_uid, "pod-uid");
        if kind == "Service" {
            assert!(f.selected.load(Ordering::SeqCst));
        }
        assert!(manager.list("other").await.is_empty());
        manager.stop("other", "tunnel").await;
        let mut socket = TcpStream::connect(("127.0.0.1", session.local_port))
            .await
            .unwrap();
        socket.write_all(b"hello").await.unwrap();
        let mut response = [0; 5];
        tokio::time::timeout(Duration::from_secs(3), socket.read_exact(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&response, b"hello");
        until(async || manager.list("main").await[0].bytes_received >= 5).await;
        assert!(manager.list("main").await[0].bytes_sent >= 5);
        manager.stop_owner("main").await;
        assert!(manager.list("main").await.is_empty());
        let mut one = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), socket.read(&mut one))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        until(async || {
            TcpStream::connect(("127.0.0.1", session.local_port))
                .await
                .is_err()
        })
        .await;
    }
}
#[tokio::test]
async fn permission_recreation_port_conflict_and_pending_cancellation_are_not_active_tunnels() {
    for (mode, status) in [("forbidden", 403), ("recreated", 409), ("closed", 503)] {
        let f = fixture(mode).await;
        let manager = PortForwardManager::new();
        assert_eq!(
            manager
                .start("main", "tunnel", f.client.clone(), request("Pod"))
                .await
                .unwrap_err()
                .status,
            Some(status)
        );
        assert!(manager.list("main").await.is_empty());
        if mode == "recreated" {
            assert_eq!(f.upgrades.load(Ordering::SeqCst), 0);
        }
    }
    let f = fixture("ok").await;
    let manager = PortForwardManager::new();
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut req = request("Pod");
    req.local_port = occupied.local_addr().unwrap().port();
    assert_eq!(
        manager
            .start("main", "busy", f.client.clone(), req)
            .await
            .unwrap_err()
            .status,
        Some(409)
    );
    assert_eq!(f.upgrades.load(Ordering::SeqCst), 0);
    let f = fixture("delay").await;
    let copy = manager.clone();
    let client = f.client.clone();
    let pending =
        tokio::spawn(async move { copy.start("main", "pending", client, request("Pod")).await });
    until(async || !manager.list("main").await.is_empty()).await;
    manager.stop_owner("main").await;
    assert_eq!(pending.await.unwrap().unwrap_err().status, Some(409));
    assert!(manager.list("main").await.is_empty());
}
#[tokio::test]
async fn remote_application_errors_are_visible_in_session_status() {
    let f = fixture("ok").await;
    let manager = PortForwardManager::new();
    let session = manager
        .start("main", "tunnel", f.client.clone(), request("Pod"))
        .await
        .unwrap();
    f.refuse.store(true, Ordering::SeqCst);
    let _socket = TcpStream::connect(("127.0.0.1", session.local_port))
        .await
        .unwrap();
    until(async || manager.list("main").await[0].last_error.is_some()).await;
    assert!(
        manager.list("main").await[0]
            .last_error
            .as_ref()
            .unwrap()
            .message
            .contains("connection refused")
    );
    manager.stop_owner("main").await;
}
#[test]
fn service_ports_resolve_numeric_named_and_restartable_init_and_reject_udp_or_missing_ports() {
    let mut svc: k8s_openapi::api::core::v1::Service = serde_json::from_value(service()).unwrap();
    let mut pod: k8s_openapi::api::core::v1::Pod = serde_json::from_value(pod()).unwrap();
    assert_eq!(service_target_port(&svc, &pod, 80).unwrap(), 8080);
    svc.spec.as_mut().unwrap().ports.as_mut().unwrap()[0].protocol = Some("UDP".into());
    assert!(service_target_port(&svc, &pod, 80).is_err());
    svc.spec.as_mut().unwrap().ports.as_mut().unwrap()[0].protocol = None;
    let containers = std::mem::take(&mut pod.spec.as_mut().unwrap().containers);
    pod.spec.as_mut().unwrap().init_containers = Some(containers);
    assert!(service_target_port(&svc, &pod, 80).is_err());
    pod.spec.as_mut().unwrap().init_containers.as_mut().unwrap()[0].restart_policy =
        Some("Always".into());
    assert_eq!(service_target_port(&svc, &pod, 80).unwrap(), 8080);
    svc.spec.as_mut().unwrap().ports.as_mut().unwrap()[0].target_port =
        Some(k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(9000));
    assert_eq!(service_target_port(&svc, &pod, 80).unwrap(), 9000);
}
