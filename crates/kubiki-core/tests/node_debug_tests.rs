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
fn exec(session_id: &str) -> NodeExecRequest {
    NodeExecRequest {
        resource: request().resource.clone(),
        debug_session_id: session_id.into(),
        shell: "/bin/sh".into(),
        cols: 80,
        rows: 24,
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
    node_gate: Arc<Semaphore>,
    node_read: Arc<Notify>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn deleted_with(state: Arc<Mutex<State>>, expected: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if state.lock().await.deleted >= expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
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
    let node_gate = Arc::new(Semaphore::new(1000));
    let node_read = Arc::new(Notify::new());
    let (node_gate_server, node_read_server) = (node_gate.clone(), node_read.clone());
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
            // One task per connection, so a gated POST never starves the
            // concurrent GET/DELETE traffic of an automatic cleanup.
            let data = data.clone();
            let gate = gate.clone();
            let notify = create_notify.clone();
            let (node_gate, node_read) = (node_gate_server.clone(), node_read_server.clone());
            tokio::spawn(async move {
                let (line, body) = read_request(&mut socket).await;
                if line.starts_with("GET /api/v1/nodes/worker ") {
                    node_read.notify_one();
                    node_gate.acquire().await.unwrap().forget();
                }
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
                        notify.notify_one();
                        let permit = gate.acquire().await.unwrap();
                        permit.forget();
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
                reply(&mut socket, status, response).await;
            });
        }
    });
    Fixture {
        client,
        state,
        created,
        create_gate,
        node_gate,
        node_read,
        server,
    }
}

#[tokio::test]
async fn provisions_uid_bound_privileged_helper_and_real_exec_uses_host_chroot_then_deletes() {
    let f = fixture().await;
    let manager = NodeDebugManager::default();
    let client = f.client.clone();
    let result = manager
        .prepare("main", request(), async move { Ok(client) }, |_| async {
            Ok(true)
        })
        .await
        .unwrap();
    assert!(!result.reused);
    assert_eq!(result.pod.uid.as_deref(), Some("debug-uid"));
    assert_eq!(result.pod.query.namespace.as_deref(), Some("debug"));
    // The deterministic session identifiers derive from the Node UID.
    assert_eq!(result.session_id, "node-uid");
    assert_eq!(result.pod.name, "kubiki-node-debug-node-uid");
    assert!(
        manager
            .list_other(f.client.clone(), "test", "debug")
            .await
            .unwrap()
            .is_empty()
    );
    let mut stream = manager
        .attach("main", "exec", exec(&result.session_id))
        .await
        .unwrap()
        .output;
    let mut text = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(m) = stream.recv().await {
            match m.event {
                ExecEvent::Started => manager
                    .write("main", &result.session_id, "exec", "exit\r".into())
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
    manager.stop("main", &result.session_id).await.unwrap();
    assert_eq!(f.state.lock().await.deleted, 1);
    assert_eq!(f.state.lock().await.delete_uids, ["debug-uid"]);
}

#[tokio::test]
async fn second_terminal_reuses_the_pod_and_refcounted_close_keeps_it_until_the_last_shell() {
    let f = fixture().await;
    let manager = NodeDebugManager::default();
    let client = f.client.clone();
    let prepared = manager
        .prepare("main", request(), async move { Ok(client) }, |_| async {
            Ok(true)
        })
        .await
        .unwrap();
    let session_id = prepared.session_id.clone();
    // A second shell on the same Node reattaches to the same Pod silently.
    // The client future and consent are never reached on the reuse path.
    let reused = manager
        .prepare(
            "main",
            request(),
            std::future::pending::<Result<Client, kubiki_core::core::api::ApiError>>(),
            |_| async { unreachable!("reuse must not open a dialog") },
        )
        .await
        .unwrap();
    assert!(reused.reused);
    assert_eq!(reused.pod.uid, prepared.pod.uid);
    assert_eq!(f.state.lock().await.created, 1);
    manager
        .attach("main", "one", exec(&session_id))
        .await
        .unwrap();
    manager
        .attach("main", "two", exec(&session_id))
        .await
        .unwrap();
    // The first shell leaves; the Pod must survive for the second one.
    manager.release_exec("main", &session_id, "one").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(f.state.lock().await.deleted, 0);
    assert!(manager.status("main", &session_id).await.unwrap().phase == "ready");
    // The last shell leaves: the helper Pod is deleted without any dialog.
    manager.release_exec("main", &session_id, "two").await;
    deleted_with(f.state.clone(), 1).await;
    assert_eq!(f.state.lock().await.delete_uids, ["debug-uid"]);
    assert!(manager.status("main", &session_id).await.is_none());
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
            .prepare("main", request(), async move { Ok(client) }, |_| async {
                Ok(true)
            })
            .await
            .unwrap_err();
        assert_eq!(err.status, Some(if bad_node { 409 } else { 403 }));
        // Nothing was created; stopping still succeeds (it only records a latch).
        manager.stop("main", "node-uid").await.unwrap();
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
    let req = request();
    let preparing = tokio::spawn(async move {
        task_manager
            .prepare("main", req, async move { Ok(client) }, |_| async {
                Ok(true)
            })
            .await
    });
    f.created.notified().await;
    let stopping = manager.clone();
    let stop = tokio::spawn(async move { stopping.stop("main", "node-uid").await });
    tokio::task::yield_now().await;
    f.create_gate.add_permits(1);
    assert!(preparing.await.unwrap().is_err());
    stop.await.unwrap().unwrap();
    assert_eq!(f.state.lock().await.deleted, 1);
    // The cancelled lease was removed, so a later prepare starts fresh.
    f.create_gate.add_permits(1);
    let client = f.client.clone();
    let again = manager
        .prepare("main", request(), async move { Ok(client) }, |_| async {
            Ok(true)
        })
        .await
        .unwrap();
    assert_eq!(again.pod.uid.as_deref(), Some("debug-uid"));
    assert_eq!(f.state.lock().await.created, 2);
    manager.stop("main", &again.session_id).await.unwrap();
    // stop() on an already-removed session records a latch: exactly one
    // re-open within it is rejected, so a racing teardown never resurrects.
    manager.stop("main", &again.session_id).await.unwrap();
    let client = f.client.clone();
    let latched = manager
        .prepare("main", request(), async move { Ok(client) }, |_| async {
            Ok(true)
        })
        .await
        .unwrap_err();
    assert_eq!(latched.status, Some(409));
    assert_eq!(f.state.lock().await.created, 2);
    // The next attempt gets through (the latch is single-use).
    f.create_gate.add_permits(1);
    let client = f.client.clone();
    let third = manager
        .prepare("main", request(), async move { Ok(client) }, |_| async {
            Ok(true)
        })
        .await
        .unwrap();
    assert_eq!(third.pod.uid.as_deref(), Some("debug-uid"));
    assert_eq!(f.state.lock().await.created, 3);
    manager.stop("main", &third.session_id).await.unwrap();
}

#[tokio::test]
async fn cleanup_failure_is_retained_retryable_and_never_deletes_a_replacement() {
    for replace in [false, true] {
        let f = fixture().await;
        let manager = NodeDebugManager::default();
        let client = f.client.clone();
        let prepared = manager
            .prepare("main", request(), async move { Ok(client) }, |_| async {
                Ok(true)
            })
            .await
            .unwrap();
        {
            let mut s = f.state.lock().await;
            s.deny_delete = !replace;
            s.replace = replace;
        }
        manager.stop("foreign", &prepared.session_id).await.unwrap();
        assert_eq!(f.state.lock().await.deleted, 0);
        assert_eq!(
            manager
                .stop("main", &prepared.session_id)
                .await
                .unwrap_err()
                .status,
            Some(if replace { 409 } else { 403 })
        );
        assert_eq!(
            manager
                .status("main", &prepared.session_id)
                .await
                .unwrap()
                .phase,
            "cleanup_failed"
        );
        assert_eq!(f.state.lock().await.deleted, 0);
        if !replace {
            f.state.lock().await.deny_delete = false;
            manager.stop("main", &prepared.session_id).await.unwrap();
            assert_eq!(f.state.lock().await.deleted, 1);
        }
    }
}

#[tokio::test]
async fn lists_and_deletes_only_inactive_marked_debug_pods_with_atomic_uid_precondition() {
    let f = fixture().await;
    let manager = NodeDebugManager::default();
    let client = f.client.clone();
    let prepared = manager
        .prepare("main", request(), async move { Ok(client) }, |_| async {
            Ok(true)
        })
        .await
        .unwrap();
    let resource = prepared.pod.clone();
    assert_eq!(
        manager
            .remove_other(f.client.clone(), resource.clone(), |_| async { Ok(true) })
            .await
            .unwrap_err()
            .status,
        Some(409)
    );
    f.state.lock().await.deny_delete = true;
    assert!(manager.stop("main", &prepared.session_id).await.is_err());
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
                request(),
                async move { Ok(client) },
                move |review| {
                    let state = state.clone();
                    async move {
                        assert!(
                            review.contains("CREATE privileged")
                                && review.contains("node-uid")
                                && review.contains("ubuntu:24.04")
                        );
                        assert!(
                            review.contains("\"privileged\": true")
                                && review.contains("deleted automatically")
                                && review.contains("kubiki-node-debug-node-uid")
                        );
                        assert_eq!(state.lock().await.created, 0);
                        if approve {
                            state.lock().await.wrong_node = true;
                        }
                        Ok(approve)
                    }
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
    let prepared = manager
        .prepare("main", request(), async move { Ok(client) }, |_| async {
            Ok(true)
        })
        .await
        .unwrap();
    let resource = prepared.pod.clone();
    f.state.lock().await.deny_delete = true;
    assert!(manager.stop("main", &prepared.session_id).await.is_err());
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

#[tokio::test]
async fn create_consent_covers_lifecycle_and_cleanup_never_prompts() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let f = fixture().await;
    let manager = NodeDebugManager::default();
    let client = f.client.clone();
    let prompts = Arc::new(AtomicUsize::new(0));
    let observed = prompts.clone();
    let prepared = manager
        .prepare(
            "main",
            request(),
            async move { Ok(client) },
            move |review| {
                let prompts = observed.clone();
                async move {
                    prompts.fetch_add(1, Ordering::SeqCst);
                    assert!(review.starts_with("CREATE privileged"));
                    assert!(review.contains("deleted automatically"));
                    Ok(true)
                }
            },
        )
        .await
        .unwrap();
    assert_eq!(prompts.load(Ordering::SeqCst), 1);
    // Consent is never requested again: cleanup runs silently, even while a
    // window that could host the dialog is gone.
    manager.stop("main", &prepared.session_id).await.unwrap();
    assert_eq!(prompts.load(Ordering::SeqCst), 1);
    assert_eq!(f.state.lock().await.deleted, 1);
    assert!(manager.status("main", &prepared.session_id).await.is_none());
}

#[tokio::test]
async fn opening_shell_reserves_the_lease_before_the_last_existing_shell_closes() {
    let f = fixture().await;
    let manager = NodeDebugManager::default();
    let client = f.client.clone();
    let prepared = manager
        .prepare("main", request(), async move { Ok(client) }, |_| async {
            Ok(true)
        })
        .await
        .unwrap();
    let first = manager
        .attach("main", "first", exec(&prepared.session_id))
        .await
        .unwrap();
    f.node_gate.forget_permits(f.node_gate.available_permits());
    // Consume notifications from preparation and the first attach.
    while tokio::time::timeout(Duration::from_millis(1), f.node_read.notified())
        .await
        .is_ok()
    {}
    let (second_manager, session) = (manager.clone(), prepared.session_id.clone());
    let opening = tokio::spawn(async move {
        second_manager
            .attach("main", "second", exec(&session))
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), f.node_read.notified())
        .await
        .unwrap();
    manager
        .release_exec("main", &prepared.session_id, "first")
        .await;
    drop(first);
    assert_eq!(f.state.lock().await.deleted, 0);
    assert_eq!(
        manager
            .status("main", &prepared.session_id)
            .await
            .unwrap()
            .phase,
        "ready"
    );
    f.node_gate.add_permits(1);
    let second = opening.await.unwrap().unwrap();
    assert_eq!(f.state.lock().await.deleted, 0);
    manager
        .release_exec("main", &prepared.session_id, "second")
        .await;
    drop(second);
    deleted_with(f.state.clone(), 1).await;
}
