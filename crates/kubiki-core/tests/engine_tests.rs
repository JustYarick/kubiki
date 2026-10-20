use kubiki_core::core::events::{EventBus, KubikiEvent};
use kubiki_core::informer::delta::{ResourceDelta, WatchScope};
use kubiki_core::core::api::{ResourceQuery, ResourceRef};
use kubiki_core::informer::store::ResourceStore;
use kubiki_core::pod_ops::port_forward::{ForwardStatus, ForwardTargetKind, PortForwardSession};
use serde_json::json;

#[tokio::test]
async fn test_event_bus_broadcast() {
    let bus = EventBus::new(32);
    let mut rx = bus.subscribe();

    let event = KubikiEvent::ClusterConnected {
        context: "minikube".into(),
        version: "v1.32.0".into(),
    };

    bus.publish(event.clone());

    let received = rx.recv().await.unwrap();
    assert_eq!(received, event);
}

#[tokio::test]
async fn resource_snapshots_are_isolated_by_context_namespace_and_subscription() {
    let store = ResourceStore::new();
    let scope = |context: &str, namespace: &str, id: &str| WatchScope {
        subscription_id: id.into(), query: ResourceQuery { context: context.into(), group: "".into(), version: "v1".into(), kind: "Pod".into(), namespace: Some(namespace.into()) },
    };
    let a = scope("a", "default", "one");
    let b = scope("a", "other", "two");
    let c = scope("b", "default", "three");
    let d = scope("a", "default", "four");
    for target in [&a, &b, &c, &d] {
        store.apply_delta(target, &ResourceDelta::Restarted { items: vec![json!({ "metadata": { "uid": "same-uid", "namespace": target.query.namespace, "name": "web" } })] }).await;
    }
    store.apply_delta(&a, &ResourceDelta::Restarted { items: vec![] }).await;
    assert!(store.snapshot(&a).await.unwrap().is_empty());
    for target in [&b, &c, &d] { assert_eq!(store.snapshot(target).await.unwrap().len(), 1); }
    store.remove(&a).await;
    assert!(store.snapshot(&a).await.is_none());
    store.apply_delta(&b, &ResourceDelta::Deleted { uid: "same-uid".into() }).await;
    assert!(store.snapshot(&b).await.unwrap().is_empty());
    assert_eq!(store.snapshot(&c).await.unwrap().len(), 1);
}

#[test]
fn test_port_forward_session_serialization() {
    let session = PortForwardSession {
        id: "default-nginx-80".into(),
        resource: ResourceRef { query: ResourceQuery { context: "test".into(), group: "".into(), version: "v1".into(), kind: "Pod".into(), namespace: Some("default".into()) }, name: "nginx".into(), uid: Some("uid".into()) },
        pod_name: "nginx".into(), pod_uid: "uid".into(), pod_port: 80, last_error: None, started_at: 0,
        target_kind: ForwardTargetKind::Pod,
        namespace: "default".into(),
        name: "nginx".into(),
        local_port: 8080,
        remote_port: 80,
        status: ForwardStatus::Active,
        bytes_sent: 1024,
        bytes_received: 2048,
    };

    let serialized = serde_json::to_string(&session).unwrap();
    assert!(serialized.contains("8080"));
    assert!(serialized.contains("nginx"));
}
