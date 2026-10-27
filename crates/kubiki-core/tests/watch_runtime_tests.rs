use kube::{Client, Config};
use kubiki_core::core::api::{ApiError, ResourceQuery};
use kubiki_core::{
    InformerManager, ResourceDelta, ResourceStore, WatchEvent, WatchPhase, WatchScope,
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

fn query() -> ResourceQuery {
    ResourceQuery {
        context: "test".into(),
        group: "".into(),
        version: "v1".into(),
        kind: "Pod".into(),
        namespace: Some("backend".into()),
    }
}
fn pod(uid: &str) -> Value {
    json!({"apiVersion":"v1","kind":"Pod","metadata":{"uid":uid,"name":uid,"namespace":"backend","resourceVersion":"10"}})
}

// Actual kube-rs HTTP client/runtime, with a local scripted Kubernetes API (no kubeconfig).
async fn api(
    responses: Vec<(u16, String)>,
) -> (Client, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Client::try_from(Config::new(
        format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap(),
    ))
    .unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let task = tokio::spawn(async move {
        for (status, body) in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0u8; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                    break;
                }
            }
            captured.lock().unwrap().push(
                String::from_utf8_lossy(&bytes)
                    .lines()
                    .next()
                    .unwrap()
                    .to_owned(),
            );
            if body == "HOLD" {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                std::future::pending::<()>().await;
            }
            let response = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (client, requests, task)
}

#[tokio::test]
async fn expired_watch_relists_atomically_and_removes_offline_deletions() {
    let list = |items: Vec<Value>, rv: &str| {
        json!({"apiVersion":"v1","kind":"PodList","metadata":{"resourceVersion":rv},"items":items})
            .to_string()
    };
    let watch = format!(
        "{}\n{}\n",
        json!({"type":"ADDED","object":pod("c")}),
        json!({"type":"ERROR","object":{"apiVersion":"v1","kind":"Status","status":"Failure","message":"too old","reason":"Expired","code":410}})
    );
    let (client, requests, server) = api(vec![
        (200, list(vec![pod("a"), pod("b")], "10")),
        (200, watch),
        (200, list(vec![pod("a"), pod("d")], "20")),
        (200, "HOLD".into()),
    ])
    .await;
    let store = ResourceStore::new();
    let manager = InformerManager::new(store.clone());
    let mut rx = manager
        .start_watch("main", "test", query(), async move { Ok(client) })
        .await
        .unwrap();
    let mut snapshots = Vec::new();
    let mut reconnecting = false;
    let mut sequence = 0;
    tokio::time::timeout(Duration::from_secs(8), async {
        while snapshots.len() < 2 {
            let message = rx.recv().await.unwrap();
            assert_eq!(message.sequence, sequence + 1);
            sequence = message.sequence;
            match message.event {
                WatchEvent::Delta(ResourceDelta::Restarted { items }) => snapshots.push(items),
                WatchEvent::Status {
                    phase: WatchPhase::Reconnecting,
                    error: Some(error),
                } => {
                    assert_eq!(error.status, Some(410));
                    reconnecting = true;
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(reconnecting);
    let ids = |items: &[Value]| {
        let mut ids: Vec<_> = items
            .iter()
            .map(|item| item["metadata"]["uid"].as_str().unwrap().to_owned())
            .collect();
        ids.sort();
        ids
    };
    assert_eq!(ids(&snapshots[0]), vec!["a", "b"]);
    assert_eq!(ids(&snapshots[1]), vec!["a", "d"]);
    let scope = WatchScope {
        subscription_id: "main:test".into(),
        query: query(),
    };
    assert_eq!(ids(&store.snapshot(&scope).await.unwrap()), vec!["a", "d"]);
    let captured = requests.lock().unwrap().clone();
    assert!(
        captured
            .iter()
            .filter(|request| request.contains("watch=true"))
            .all(|request| request.contains("timeoutSeconds=290"))
    );
    assert!(
        captured
            .iter()
            .all(|request| request.starts_with("GET /api/v1/namespaces/backend/pods?"))
    );
    assert!(
        captured
            .iter()
            .all(|request| !request.contains("fieldSelector"))
    );
    manager.stop_watch("main", "test").await;
    assert!(store.snapshot(&scope).await.is_none());
    assert_eq!(manager.active_count().await, 0);
    server.abort();
}

#[tokio::test]
async fn forbidden_list_is_terminal_and_never_publishes_an_empty_snapshot() {
    let (client,requests,server)=api(vec![(403,json!({"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Forbidden","message":"pods is forbidden","code":403}).to_string())]).await;
    let manager = InformerManager::new(ResourceStore::new());
    let mut rx = manager
        .start_watch("main", "denied", query(), async move { Ok(client) })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(message) = rx.recv().await {
            match message.event {
                WatchEvent::Delta(_) => panic!("forbidden must not become an empty snapshot"),
                WatchEvent::Status {
                    phase: WatchPhase::Failed,
                    error: Some(error),
                } => {
                    assert_eq!(error.status, Some(403));
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(requests.lock().unwrap().len(), 1);
    manager.stop_owner("main").await;
    server.abort();
}

#[tokio::test]
async fn stop_cancels_pending_client_and_isolates_owners_and_reused_ids() {
    struct Dropped(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let guard = Dropped(dropped.clone());
    let manager = InformerManager::new(ResourceStore::new());
    let mut rx = manager
        .start_watch("one", "same", query(), async move {
            let _guard = guard;
            std::future::pending::<Result<Client, ApiError>>().await
        })
        .await
        .unwrap();
    rx.recv().await.unwrap();
    let duplicate = manager
        .start_watch("one", "same", query(), std::future::pending())
        .await
        .unwrap_err();
    assert_eq!(duplicate.status, Some(409));
    let _other = manager
        .start_watch("two", "same", query(), std::future::pending())
        .await
        .unwrap();
    manager.stop_watch("two", "missing").await;
    assert_eq!(manager.active_count().await, 2);
    manager.stop_owner("one").await;
    assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(manager.active_count().await, 1);
    assert!(rx.recv().await.is_none());
    let _replacement = manager
        .start_watch("one", "same", query(), std::future::pending())
        .await
        .unwrap();
    manager.stop_owner("one").await;
    manager.stop_owner("two").await;
    assert_eq!(manager.active_count().await, 0);
}

#[tokio::test]
async fn a_quiet_watch_recovers_after_server_error_without_waiting_for_a_resource_change() {
    let list = json!({"apiVersion":"v1","kind":"PodList","metadata":{"resourceVersion":"10"},"items":[pod("unchanged")]}).to_string();
    let (client,_,server)=api(vec![(200,list),(503,json!({"apiVersion":"v1","kind":"Status","message":"temporarily unavailable","reason":"ServiceUnavailable","code":503}).to_string()),(200,"HOLD".into())]).await;
    let manager = InformerManager::new(ResourceStore::new());
    let mut rx = manager
        .start_watch("main", "quiet", query(), async move { Ok(client) })
        .await
        .unwrap();
    let mut disconnected = false;
    let mut snapshots = 0;
    tokio::time::timeout(Duration::from_secs(8), async {
        while let Some(message) = rx.recv().await {
            match message.event {
                WatchEvent::Delta(ResourceDelta::Restarted { .. }) => snapshots += 1,
                WatchEvent::Status {
                    phase: WatchPhase::Reconnecting,
                    ..
                } => disconnected = true,
                WatchEvent::Status {
                    phase: WatchPhase::Live,
                    error: None,
                } if disconnected => break,
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(disconnected);
    assert_eq!(snapshots, 1);
    manager.stop_owner("main").await;
    server.abort();
}

#[tokio::test]
async fn a_slow_consumer_backpressures_the_watcher_without_losing_order_or_cancellation() {
    let list =
        json!({"apiVersion":"v1","kind":"PodList","metadata":{"resourceVersion":"10"},"items":[]})
            .to_string();
    let changes = (0..500)
        .map(|i| json!({"type":"ADDED","object":pod(&format!("pod-{i}"))}).to_string())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let (client, _, server) = api(vec![(200, list), (200, changes), (200, "HOLD".into())]).await;
    let manager = InformerManager::new(ResourceStore::new());
    let mut rx = manager
        .start_watch("main", "burst", query(), async move { Ok(client) })
        .await
        .unwrap();
    let capacity = kubiki_core::informer::watcher::WATCH_QUEUE_CAPACITY;
    tokio::time::timeout(Duration::from_secs(3), async {
        while rx.len() < capacity {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let scope = WatchScope {
        subscription_id: "main:burst".into(),
        query: query(),
    };
    assert!(manager.store().snapshot(&scope).await.unwrap().len() < 500);
    let mut count = 0;
    let mut sequence = 0;
    tokio::time::timeout(Duration::from_secs(3), async {
        while count < 500 {
            let message = rx.recv().await.unwrap();
            assert_eq!(message.sequence, sequence + 1);
            sequence = message.sequence;
            if matches!(
                message.event,
                WatchEvent::Delta(ResourceDelta::Applied { .. })
            ) {
                count += 1;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(manager.store().snapshot(&scope).await.unwrap().len(), 500);
    manager.stop_owner("main").await;
    assert_eq!(manager.active_count().await, 0);
    server.abort();
}

#[tokio::test]
async fn all_builtin_collections_can_watch_five_namespaces_and_release_every_subscription() {
    let manager = InformerManager::new(ResourceStore::new());
    let mut receivers = Vec::new();
    for resource in kubiki_core::core::api::resource_types() {
        let namespaces = if resource.namespaced {
            vec![
                Some("alpha"),
                Some("beta"),
                Some("gamma"),
                Some("delta"),
                Some("epsilon"),
            ]
        } else {
            vec![None]
        };
        for namespace in namespaces {
            let query = ResourceQuery {
                context: "catalog-test".into(),
                group: resource.group.clone(),
                version: resource.version.clone(),
                kind: resource.kind.clone(),
                namespace: namespace.map(str::to_owned),
            };
            let id = format!("catalog-{}", receivers.len());
            receivers.push(
                manager
                    .start_watch("catalog", &id, query, std::future::pending())
                    .await
                    .unwrap(),
            );
        }
    }
    assert!(receivers.len() > 128);
    assert_eq!(manager.active_count().await, receivers.len());
    manager.stop_owner("catalog").await;
    assert_eq!(manager.active_count().await, 0);
}

#[tokio::test]
async fn a_paginated_initial_list_of_3500_pods_is_published_as_one_complete_snapshot() {
    let list = |range: std::ops::Range<usize>, continuation: &str| {
        json!({
            "apiVersion": "v1", "kind": "PodList",
            "metadata": { "resourceVersion": "10", "continue": continuation },
            "items": range.map(|index| pod(&format!("pod-{index}"))).collect::<Vec<_>>()
        })
        .to_string()
    };
    let (client, requests, server) = api(vec![
        (200, list(0..2000, "chunk-two")),
        (200, list(2000..3500, "")),
        (200, "HOLD".into()),
    ])
    .await;
    let manager = InformerManager::new(ResourceStore::new());
    let mut rx = manager
        .start_watch("scale", "snapshot", query(), async move { Ok(client) })
        .await
        .unwrap();
    let mut sequence = 0;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let message = rx.recv().await.unwrap();
            assert_eq!(message.sequence, sequence + 1);
            sequence = message.sequence;
            match message.event {
                WatchEvent::Delta(ResourceDelta::Restarted { items }) => {
                    assert_eq!(items.len(), 3500);
                    assert!(
                        items
                            .iter()
                            .any(|item| item["metadata"]["name"] == "pod-3499")
                    );
                    break;
                }
                WatchEvent::Delta(_) => panic!("Initial list must be atomic"),
                WatchEvent::Status {
                    phase: WatchPhase::Failed,
                    error,
                } => panic!("Watch failed: {error:?}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let scope = WatchScope {
        subscription_id: "scale:snapshot".into(),
        query: query(),
    };
    assert_eq!(manager.store().snapshot(&scope).await.unwrap().len(), 3500);
    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.contains("continue=chunk-two"))
    );
    manager.stop_owner("scale").await;
    assert!(manager.store().snapshot(&scope).await.is_none());
    server.abort();
}

#[tokio::test]
async fn crd_watch_strips_schema_and_validation() {
    let crd_query = ResourceQuery {
        context: "test".into(),
        group: "apiextensions.k8s.io".into(),
        version: "v1".into(),
        kind: "CustomResourceDefinition".into(),
        namespace: None,
    };
    let crd_item = json!({
        "apiVersion": "apiextensions.k8s.io/v1",
        "kind": "CustomResourceDefinition",
        "metadata": {
            "name": "crontabs.stable.example.com",
            "uid": "crd-uid-1",
            "resourceVersion": "100"
        },
        "spec": {
            "group": "stable.example.com",
            "validation": { "openAPIV3Schema": { "type": "object" } },
            "versions": [
                {
                    "name": "v1",
                    "served": true,
                    "storage": true,
                    "schema": {
                        "openAPIV3Schema": { "type": "object", "properties": { "cron": { "type": "string" } } }
                    }
                }
            ],
            "names": { "plural": "crontabs", "singular": "crontab", "kind": "CronTab" }
        }
    });
    let list = json!({
        "apiVersion": "apiextensions.k8s.io/v1",
        "kind": "CustomResourceDefinitionList",
        "metadata": { "resourceVersion": "100" },
        "items": [crd_item]
    })
    .to_string();

    let (client, requests, server) = api(vec![
        (200, list),
        (200, "HOLD".into()),
    ])
    .await;

    let manager = InformerManager::new(ResourceStore::new());
    let mut rx = manager
        .start_watch("main", "crd-watch", crd_query.clone(), async move { Ok(client) })
        .await
        .unwrap();

    let mut item_received = None;
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(message) = rx.recv().await {
            if let WatchEvent::Delta(ResourceDelta::Restarted { items }) = message.event {
                item_received = Some(items[0].clone());
                break;
            }
        }
    })
    .await
    .unwrap();

    let item = item_received.expect("should receive restarted delta");
    assert_eq!(item["metadata"]["name"], "crontabs.stable.example.com");
    assert_eq!(item["spec"]["group"], "stable.example.com");
    assert!(item["spec"].get("validation").is_none(), "spec.validation should be stripped");
    assert!(item["spec"]["versions"][0].get("schema").is_none(), "spec.versions[0].schema should be stripped");
    assert_eq!(item["spec"]["versions"][0]["name"], "v1");

    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("limit=500")),
        "Initial list request must include limit=500"
    );

    manager.stop_owner("main").await;
    server.abort();
}
