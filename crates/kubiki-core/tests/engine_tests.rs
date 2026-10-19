use kubiki_core::core::events::{EventBus, KubikiEvent};
use kubiki_core::informer::delta::ResourceDelta;
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
async fn test_resource_store_multi_namespace_filtering() {
    let store = ResourceStore::new();

    // Pod in default namespace
    let pod_default = json!({
        "metadata": {
            "name": "web-default",
            "namespace": "default",
            "uid": "uid-default-1"
        }
    });

    // Pod in kube-system namespace
    let pod_system = json!({
        "metadata": {
            "name": "coredns",
            "namespace": "kube-system",
            "uid": "uid-system-1"
        }
    });

    store
        .apply_delta(&ResourceDelta::Applied {
            gvk: "Pod".into(),
            uid: "uid-default-1".into(),
            name: "web-default".into(),
            namespace: Some("default".into()),
            data: pod_default,
        })
        .await;

    store
        .apply_delta(&ResourceDelta::Applied {
            gvk: "Pod".into(),
            uid: "uid-system-1".into(),
            name: "coredns".into(),
            namespace: Some("kube-system".into()),
            data: pod_system,
        })
        .await;

    // Total count
    assert_eq!(store.count("Pod").await, 2);

    // Filter by default
    let default_items = store.get_resources("Pod", Some("default")).await;
    assert_eq!(default_items.len(), 1);
    assert_eq!(
        default_items[0]["metadata"]["name"].as_str().unwrap(),
        "web-default"
    );

    // Filter by kube-system
    let system_items = store.get_resources("Pod", Some("kube-system")).await;
    assert_eq!(system_items.len(), 1);
    assert_eq!(
        system_items[0]["metadata"]["name"].as_str().unwrap(),
        "coredns"
    );

    // Filter by all
    let all_items = store.get_resources("Pod", Some("all")).await;
    assert_eq!(all_items.len(), 2);
}

#[test]
fn test_port_forward_session_serialization() {
    let session = PortForwardSession {
        id: "default:nginx:80".into(),
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
