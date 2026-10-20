use futures::{SinkExt, StreamExt};
use kube::{Client, Config};
use kubiki_core::{
    core::api::{ResourceQuery, ResourceRef},
    pod_ops::{
        node_debug::{NodeDebugManager, NodeDebugRequest, NodeExecRequest},
        terminal::ExecEvent,
    },
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Notify, Semaphore},
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};
#[derive(Default)]
struct State {
    pod: Option<Value>,
    created: usize,
    deleted: usize,
    deny_permission: bool,
    deny_delete: bool,
    wrong_node: bool,
    replace: bool,
    pending: bool,
    delete_uids: Vec<String>,
    exec_uris: Vec<String>,
    ws_closed: bool,
}
fn request() -> NodeDebugRequest {
    NodeDebugRequest {
        resource: ResourceRef {
            query: ResourceQuery {
                context: "test".into(),
                group: String::new(),
                version: "v1".into(),
                kind: "Node".into(),
                namespace: None,
            },
            name: "worker".into(),
            uid: Some("node-uid".into()),
        },
        namespace: "debug".into(),
        image: "ubuntu:24.04".into(),
    }
}
async fn read_request(socket: &mut TcpStream) -> (String, Value) {
    let mut bytes = Vec::new();
    loop {
        let mut b = [0; 4096];
        let n = socket.read(&mut b).await.unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&b[..n]);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]);
            let length = headers
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|s| s.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                return (
                    headers
                        .lines()
                        .next()
                        .unwrap()
                        .replace("? HTTP/1.1", " HTTP/1.1"),
                    if length > 0 {
                        serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap()
                    } else {
                        Value::Null
                    },
                );
            }
        }
    }
}
async fn reply(socket: &mut TcpStream, status: u16, body: Value) {
    let body = body.to_string();
    socket.write_all(format!("HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
fn api_error(code: u16) -> Value {
    json!({"apiVersion":"v1","kind":"Status","status":"Failure","message":format!("API denied {code}"),"reason":if code==404{"NotFound"}else{"Forbidden"},"code":code})
}
struct Fixture {
    client: Client,
    state: Arc<Mutex<State>>,
    created: Arc<Notify>,
    create_gate: Arc<Semaphore>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn fixture() -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Client::try_from(Config::new(
        format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap(),
    ))
    .unwrap();
    let state = Arc::new(Mutex::new(State::default()));
    let data = state.clone();
    let created = Arc::new(Notify::new());
    let create_notify = created.clone();
    let create_gate = Arc::new(Semaphore::new(100));
    let gate = create_gate.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut probe = [0; 4096];
            let n = socket.peek(&mut probe).await.unwrap();
            if String::from_utf8_lossy(&probe[..n]).contains("/exec?") {
                let data = data.clone();
                tokio::spawn(async move {
                    let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
                    let capture = captured.clone();
                    let mut ws =
                        accept_hdr_async(socket, move |req: &Request, mut response: Response| {
                            *capture.lock().unwrap() = req.uri().to_string();
                            response.headers_mut().insert(
                                "sec-websocket-protocol",
                                "v4.channel.k8s.io".parse().unwrap(),
                            );
                            Ok(response)
                        })
                        .await
                        .unwrap();
                    data.lock()
                        .await
                        .exec_uris
                        .push(captured.lock().unwrap().clone());
                    while let Some(message) = ws.next().await {
                        let bytes = message.unwrap().into_data();
                        if bytes.first() == Some(&0) {
                            ws.send(Message::Binary(
                                [&[1][..], "node-host-output\r\n".as_bytes()]
                                    .concat()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                            ws.send(Message::Binary(
                                [&[3][..], json!({"status":"Success"}).to_string().as_bytes()]
                                    .concat()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                            break;
                        }
                    }
                    let _ = ws.close(None).await;
                    while let Some(message) = ws.next().await {
                        match message {
                            Ok(Message::Close(_)) | Err(_) => break,
                            _ => {}
                        }
                    }
                    data.lock().await.ws_closed = true;
                });
                continue;
            }
            let (line, body) = read_request(&mut socket).await;
            let (status, response) = {
                let mut s = data.lock().await;
                if line.starts_with("GET /api/v1/nodes/worker ") {
                    (
                        200,
                        json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"worker","uid":if s.wrong_node{"replacement"}else{"node-uid"}},"status":{"nodeInfo":{"architecture":"amd64","bootID":"test","containerRuntimeVersion":"test","kernelVersion":"test","kubeProxyVersion":"test","kubeletVersion":"test","machineID":"test","operatingSystem":"linux","osImage":"test","systemUUID":"test"}}}),
                    )
                } else if line.starts_with("POST /apis/authorization.k8s.io/") {
                    let mut review = body;
                    review["status"] = json!({"allowed":!s.deny_permission});
                    (201, review)
                } else if line.starts_with("POST /api/v1/namespaces/debug/pods ") {
                    let mut pod = body;
                    pod["metadata"]["uid"] = json!("debug-uid");
                    pod["metadata"]["resourceVersion"] = json!("10");
                    pod["status"] = json!({"phase":"Running","containerStatuses":[{"name":"debugger","ready":true,"restartCount":0,"image":"ubuntu","imageID":"test","state":if s.pending{json!({"waiting":{"reason":"ContainerCreating"}})}else{json!({"running":{}})}}]});
                    assert_eq!(pod["metadata"]["labels"]["kubiki.io/node-debug"], "true");
                    assert_eq!(pod["spec"]["nodeName"], "worker");
                    assert_eq!(pod["spec"]["automountServiceAccountToken"], false);
                    assert_eq!(
                        pod["spec"]["containers"][0]["securityContext"]["privileged"],
                        true
                    );
                    s.created += 1;
                    s.pod = Some(pod.clone());
                    create_notify.notify_one();
                    (201, pod)
                } else if line.starts_with("GET /api/v1/namespaces/debug/pods?") {
                    (
                        200,
                        json!({"apiVersion":"v1","kind":"PodList","items":s.pod.iter().cloned().collect::<Vec<_>>()}),
                    )
                } else if line.starts_with("GET /api/v1/namespaces/debug/pods/") {
                    if let Some(mut pod) = s.pod.clone() {
                        if s.replace {
                            pod["metadata"]["uid"] = json!("replacement");
                        }
                        (200, pod)
                    } else {
                        (404, api_error(404))
                    }
                } else if line.starts_with("DELETE /api/v1/namespaces/debug/pods/") {
                    if s.deny_delete {
                        (403, api_error(403))
                    } else {
                        s.delete_uids
                            .push(body["preconditions"]["uid"].as_str().unwrap().into());
                        assert_eq!(body["preconditions"]["uid"], "debug-uid");
                        s.deleted += 1;
                        s.pod = None;
                        (
                            200,
                            json!({"apiVersion":"v1","kind":"Status","status":"Success","code":200}),
                        )
                    }
                } else {
                    panic!("Unexpected request {line}")
                }
            };
            if line.starts_with("POST /api/v1/namespaces/debug/pods ") {
                let permit = gate.acquire().await.unwrap();
                permit.forget();
            }
            reply(&mut socket, status, response).await;
        }
    });
    Fixture {
        client,
        state,
        created,
        create_gate,
        server,
    }
}
#[tokio::test]
async fn provisions_uid_bound_privileged_helper_and_real_exec_uses_host_chroot_then_deletes() {
    let f = fixture().await;
    let manager = NodeDebugManager::default();
    let client = f.client.clone();
    let resource = manager
        .prepare(
            "main",
            "session",
            request(),
            async move { Ok(client) },
            |_| async { Ok(true) },
        )
        .await
        .unwrap();
    assert_eq!(resource.uid.as_deref(), Some("debug-uid"));
    assert_eq!(resource.query.namespace.as_deref(), Some("debug"));
    assert!(
        manager
            .list_other(f.client.clone(), "test", "debug")
            .await
            .unwrap()
            .is_empty()
    );
    let mut stream = manager
        .attach(
            "main",
            "exec",
            NodeExecRequest {
                debug_session_id: "session".into(),
                shell: "/bin/sh".into(),
                cols: 80,
                rows: 24,
            },
        )
        .await
        .unwrap()
        .output;
    let mut text = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(m) = stream.recv().await {
            match m.event {
                ExecEvent::Started => manager
                    .write("main", "session", "exec", "exit\r".into())
                    .await
                    .unwrap(),
                ExecEvent::Output { data } => text.extend(data),
                ExecEvent::Exited { code } => {
                    assert_eq!(code, 0);
                    break;
                }
                ExecEvent::Failed { error } => panic!("{}", error.message),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(String::from_utf8(text).unwrap(), "node-host-output\r\n");
    let uri = f.state.lock().await.exec_uris[0].clone();
    for field in [
        "command=chroot",
        "command=%2Fhost",
        "command=%2Fbin%2Fsh",
        "container=debugger",
        "tty=true",
    ] {
        assert!(uri.contains(field), "{uri}");
    }
    manager.stop("main", "session").await.unwrap();
    assert_eq!(f.state.lock().await.deleted, 1);
    assert_eq!(f.state.lock().await.delete_uids, ["debug-uid"]);
}
#[tokio::test]
async fn denies_rbac_and_replaced_nodes_before_any_pod_create() {
    for bad_node in [false, true] {
        let f = fixture().await;
        {
            let mut s = f.state.lock().await;
            s.wrong_node = bad_node;
            s.deny_permission = !bad_node;
        }
        let manager = NodeDebugManager::default();
        let client = f.client.clone();
        let err = manager
            .prepare(
                "main",
                "session",
                request(),
                async move { Ok(client) },
                |_| async { Ok(true) },
            )
            .await
            .unwrap_err();
        assert_eq!(err.status, Some(if bad_node { 409 } else { 403 }));
        manager.stop("main", "session").await.unwrap();
        assert_eq!(f.state.lock().await.created, 0);
    }
}
#[tokio::test]
async fn cancellation_during_create_waits_for_outcome_and_cleans_up_even_if_ready_was_never_delivered()
 {
    let f = fixture().await;
    f.create_gate.forget_permits(100);
    let manager = NodeDebugManager::default();
    let task_manager = manager.clone();
    let client = f.client.clone();
    let preparing = tokio::spawn(async move {
        task_manager
            .prepare(
                "main",
                "session",
                request(),
                async move { Ok(client) },
                |_| async { Ok(true) },
            )
            .await
    });
    f.created.notified().await;
    let stopping = manager.clone();
    let stop = tokio::spawn(async move { stopping.stop("main", "session").await });
    tokio::task::yield_now().await;
    f.create_gate.add_permits(1);
    assert!(preparing.await.unwrap().is_err());
    stop.await.unwrap().unwrap();
    assert_eq!(f.state.lock().await.deleted, 1);
    manager.stop("main", "late").await.unwrap();
    let client = f.client.clone();
    assert_eq!(
        manager
            .prepare(
                "main",
                "late",
                request(),
                async move { Ok(client) },
                |_| async { Ok(true) }
            )
            .await
            .unwrap_err()
            .status,
        Some(409)
    );
    assert_eq!(f.state.lock().await.created, 1);
}
#[tokio::test]
async fn cleanup_failure_is_retained_retryable_and_never_deletes_a_replacement() {
    for replace in [false, true] {
        let f = fixture().await;
        let manager = NodeDebugManager::default();
        let client = f.client.clone();
        manager
            .prepare(
                "main",
                "session",
                request(),
                async move { Ok(client) },
                |_| async { Ok(true) },
            )
            .await
            .unwrap();
        {
            let mut s = f.state.lock().await;
            s.deny_delete = !replace;
            s.replace = replace;
        }
        manager.stop("foreign", "session").await.unwrap();
        assert_eq!(f.state.lock().await.deleted, 0);
        assert_eq!(
            manager.stop("main", "session").await.unwrap_err().status,
            Some(if replace { 409 } else { 403 })
        );
        assert_eq!(
            manager.status("main", "session").await.unwrap().phase,
            "cleanup_failed"
        );
        assert_eq!(f.state.lock().await.deleted, 0);
        if !replace {
            f.state.lock().await.deny_delete = false;
            manager.stop("main", "session").await.unwrap();
            assert_eq!(f.state.lock().await.deleted, 1);
        }
    }
}
#[tokio::test]
async fn lists_and_deletes_only_inactive_marked_debug_pods_with_atomic_uid_precondition() {
    let f = fixture().await;
    let manager = NodeDebugManager::default();
    let client = f.client.clone();
    let resource = manager
        .prepare(
            "main",
            "session",
            request(),
            async move { Ok(client) },
            |_| async { Ok(true) },
        )
        .await
        .unwrap();
    assert_eq!(
        manager
            .remove_other(f.client.clone(), resource.clone(), |_| async { Ok(true) })
            .await
            .unwrap_err()
            .status,
        Some(409)
    );
    f.state.lock().await.deny_delete = true;
    assert!(manager.stop("main", "session").await.is_err());
    let pods = manager
        .list_other(f.client.clone(), "test", "debug")
        .await
        .unwrap();
    assert_eq!(pods.len(), 1);
    f.state.lock().await.deny_delete = false;
    manager
        .remove_other(f.client.clone(), pods[0].resource.clone(), |_| async {
            Ok(true)
        })
        .await
        .unwrap();
    assert_eq!(f.state.lock().await.deleted, 1);
}

#[tokio::test]
async fn node_create_requires_consent_to_exact_privileged_manifest_and_rechecks_node_afterwards() {
    for approve in [false, true] {
        let f = fixture().await;
        let manager = NodeDebugManager::default();
        let client = f.client.clone();
        let state = f.state.clone();
        let result = manager
            .prepare(
                "main",
                "review",
                request(),
                async move { Ok(client) },
                move |review| async move {
                    assert!(
                        review.contains("CREATE privileged")
                            && review.contains("node-uid")
                            && review.contains("ubuntu:24.04")
                    );
                    assert!(
                        review.contains("\"privileged\": true")
                            && review.contains("automatic deletion")
                            && review.contains("kubiki-node-debug-review")
                    );
                    assert_eq!(state.lock().await.created, 0);
                    if approve {
                        state.lock().await.wrong_node = true;
                    }
                    Ok(approve)
                },
            )
            .await
            .unwrap_err();
        if approve {
            assert_eq!(result.status, Some(409));
        } else {
            assert_eq!(result.code, kubiki_core::core::api::ApiErrorCode::Cancelled);
        }
        manager.stop_owner("main").await;
        assert_eq!(f.state.lock().await.created, 0);
        assert_eq!(f.state.lock().await.deleted, 0);
    }
}

#[tokio::test]
async fn orphan_delete_cancellation_and_concurrent_changes_never_delete() {
    let f = fixture().await;
    let manager = NodeDebugManager::default();
    let client = f.client.clone();
    let resource = manager
        .prepare(
            "main",
            "review",
            request(),
            async move { Ok(client) },
            |_| async { Ok(true) },
        )
        .await
        .unwrap();
    f.state.lock().await.deny_delete = true;
    assert!(manager.stop("main", "review").await.is_err());
    f.state.lock().await.deny_delete = false;
    let result = manager
        .remove_other(f.client.clone(), resource.clone(), |review| async move {
            assert!(
                review.contains("DELETE debug Pod")
                    && review.contains("debug-uid")
                    && review.contains("Resource version: \"10\"")
            );
            Ok(false)
        })
        .await
        .unwrap_err();
    assert_eq!(result.code, kubiki_core::core::api::ApiErrorCode::Cancelled);
    assert_eq!(f.state.lock().await.deleted, 0);
    let state = f.state.clone();
    assert_eq!(
        manager
            .remove_other(f.client.clone(), resource, move |_| async move {
                state.lock().await.pod.as_mut().unwrap()["metadata"]["resourceVersion"] =
                    json!("11");
                Ok(true)
            })
            .await
            .unwrap_err()
            .status,
        Some(409)
    );
    assert_eq!(f.state.lock().await.deleted, 0);
    manager.stop_owner("main").await;
}
