use kube::{Client, client::Body};
use kubiki_core::metrics::overview::{get_overview_metrics, validate_scope};
use serde_json::json;
use std::sync::{Arc, Mutex};
fn client(deny_nodes: bool, missing_cpu: bool) -> (Client, Arc<Mutex<Vec<String>>>) {
    let paths = Arc::new(Mutex::new(vec![]));
    let captured = paths.clone();
    let service = tower::service_fn(move |request: http::Request<Body>| {
        let path = request.uri().path().to_owned();
        captured.lock().unwrap().push(path.clone());
        async move {
            let node = path.ends_with("/nodes");
            let status = if node && deny_nodes { 403 } else { 200 };
            let usage = if missing_cpu {
                json!({"memory":"64Mi"})
            } else {
                json!({"cpu":"125000000n","memory":"64Mi"})
            };
            let item = if node {
                json!({"metadata":{"name":"worker"},"timestamp":"2026-10-20T12:00:00Z","window":"15s","usage":usage})
            } else {
                json!({"metadata":{"name":"web","namespace":"a"},"timestamp":"2026-10-20T12:00:00Z","window":"15s","containers":[{"name":"app","usage":usage}]})
            };
            let body = if status == 403 {
                json!({"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","message":"metrics forbidden","code":403})
            } else {
                json!({"apiVersion":"metrics.k8s.io/v1beta1","kind":if node {"NodeMetricsList"} else {"PodMetricsList"},"metadata":{},"items":[item]})
            };
            Ok::<_, std::convert::Infallible>(
                http::Response::builder()
                    .status(status)
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
        }
    });
    (Client::new(service, "default"), paths)
}
#[tokio::test]
async fn namespace_metrics_never_query_node_or_other_namespace_metrics() {
    let (client, paths) = client(false, false);
    let result = get_overview_metrics(client, "test".into(), Some("a".into()))
        .await
        .unwrap();
    assert_eq!(
        result.pods.items.unwrap()[0].containers[0].cpu,
        "125000000n"
    );
    assert!(result.nodes.items.is_none());
    assert_eq!(
        *paths.lock().unwrap(),
        vec!["/apis/metrics.k8s.io/v1beta1/namespaces/a/pods"]
    );
}
#[tokio::test]
async fn node_rbac_denial_preserves_403_without_hiding_pod_metrics() {
    let (client, paths) = client(true, false);
    let result = get_overview_metrics(client, "test".into(), None)
        .await
        .unwrap();
    assert!(result.pods.items.is_some());
    assert_eq!(result.nodes.error.unwrap().status, Some(403));
    assert_eq!(paths.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn missing_quantities_are_errors_instead_of_fake_zero_usage_and_scope_is_validated() {
    let (client, _) = client(false, true);
    let result = get_overview_metrics(client, "test".into(), None)
        .await
        .unwrap();
    assert!(result.nodes.error.is_some());
    assert!(result.pods.error.is_some());
    for (context, ns) in [
        ("", None),
        ("test", Some("bad/name")),
        ("test", Some("all")),
    ] {
        assert!(validate_scope(context, ns).is_err());
    }
}
