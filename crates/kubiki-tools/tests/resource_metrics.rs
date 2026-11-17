use kubiki_core::cluster::{client::ClusterClientPool, kubeconfig::KubeConfigManager};
use kubiki_tools::{
    kubernetes::{HostConsent, KubernetesTools},
    *,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn fixture(policy: AgentPolicy) -> (Session, KubernetesTools, Arc<Mutex<Vec<String>>>) {
    fixture_scope(policy, false)
}
fn fixture_scope(
    policy: AgentPolicy,
    all_namespaces: bool,
) -> (Session, KubernetesTools, Arc<Mutex<Vec<String>>>) {
    let session = Session::new(
        "metrics".into(),
        "test".into(),
        AgentScope {
            context: "fixture".into(),
            namespaces: vec!["apps".into()],
            all_namespaces,
        },
        policy,
        ClusterCapabilities::all(),
    );
    let reads = Arc::new(Mutex::new(Vec::new()));
    let seen = reads.clone();
    let client = kube::Client::new(
        tower::service_fn(move |request: http::Request<kube::client::Body>| {
            let path = request.uri().path().to_owned();
            seen.lock().unwrap().push(path.clone());
            let pod = json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"web","namespace":"apps","uid":"pod-id","creationTimestamp":"2026-11-17T09:00:00Z"},"spec":{"nodeName":"worker","containers":[{"name":"app","resources":{"requests":{"cpu":"250m","memory":"256Mi"},"limits":{"cpu":"1","memory":"512Mi"}}}]},"status":{"phase":"Running"}});
            let body = match path.as_str() {
                "/api/v1/namespaces" => {
                    json!({"apiVersion":"v1","kind":"NamespaceList","metadata":{},"items":[{"metadata":{"name":"apps"}}]})
                }
                "/api/v1/namespaces/apps/pods/web" => pod.clone(),
                "/api/v1/nodes/worker" => {
                    json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"worker","uid":"node-id"},"status":{"capacity":{"cpu":"8","memory":"16Gi"},"allocatable":{"cpu":"7","memory":"15Gi"}}})
                }
                "/api/v1/namespaces/apps/pods" => {
                    assert!(
                        request
                            .uri()
                            .query()
                            .unwrap_or_default()
                            .contains("spec.nodeName")
                    );
                    let mut finished = pod.clone();
                    finished["metadata"]["name"] = json!("finished");
                    finished["status"]["phase"] = json!("Succeeded");
                    json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":[pod,finished]})
                }
                "/apis/metrics.k8s.io/v1beta1/namespaces/apps/pods/web" => {
                    json!({"apiVersion":"metrics.k8s.io/v1beta1","kind":"PodMetrics","metadata":{"name":"web","namespace":"apps"},"timestamp":"2026-11-17T10:00:00Z","window":"15s","containers":[{"name":"app","usage":{"cpu":"125000000n","memory":"64Mi"}}]})
                }
                "/apis/metrics.k8s.io/v1beta1/nodes/worker" => {
                    json!({"apiVersion":"metrics.k8s.io/v1beta1","kind":"NodeMetrics","metadata":{"name":"worker"},"timestamp":"2026-11-17T10:00:00Z","window":"15s","usage":{"cpu":"2","memory":"4Gi"}})
                }
                _ => panic!("Unexpected read: {path}"),
            };
            async move {
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .header("content-type", "application/json")
                        .body(kube::client::Body::from(body.to_string().into_bytes()))
                        .unwrap(),
                )
            }
        }),
        "apps",
    );
    let mut tools = KubernetesTools::scoped(
        &session,
        ClusterClientPool::new(KubeConfigManager::new()),
        None,
        None,
        Arc::new(HostConsent::default()),
        std::env::temp_dir().join("resource-metrics-fixture"),
        Arc::new(tokio::sync::Semaphore::new(2)),
    )
    .unwrap();
    tools.client = Some(client);
    (session, tools, reads)
}
async fn metrics(
    session: &Session,
    tools: &KubernetesTools,
    arguments: Value,
) -> Result<Value, String> {
    let emit: EventSink = Arc::new(|_| {});
    tools
        .execute(
            session,
            &ToolCall {
                id: "metrics".into(),
                name: "get_metrics".into(),
                arguments,
            },
            &emit,
        )
        .await
}

#[tokio::test]
async fn pod_usage_and_effective_budgets_are_distinct_and_preserve_existing_container_metrics() {
    let (session, tools, _) = fixture(AgentPolicy {
        confirm_reads: false,
        ..Default::default()
    });
    let _run = session.begin_run(0).unwrap();
    let result = metrics(&session, &tools, json!({"namespace":"apps","name":"web"}))
        .await
        .unwrap();
    let metric = &result["metrics"][0];
    assert_eq!(metric["usage"]["cpu"], 0.125);
    assert_eq!(metric["usage"]["memory"], 67108864.0);
    assert_eq!(metric["budgets"]["cpu"]["requests"], 0.25);
    assert_eq!(metric["budgets"]["memory"]["limits"], 536870912.0);
    assert_eq!(metric["containers"][0]["cpu"], "125000000n");
}

#[tokio::test]
async fn node_usage_is_host_metrics_and_scoped_reservations_exclude_finished_pods() {
    let (session, tools, reads) = fixture(AgentPolicy {
        confirm_reads: false,
        cluster_resources: true,
        ..Default::default()
    });
    let _run = session.begin_run(0).unwrap();
    let result = metrics(
        &session,
        &tools,
        json!({"kind":"Node","namespace":null,"name":"worker","podNamespaces":["apps"]}),
    )
    .await
    .unwrap();
    let metric = &result["metrics"][0];
    assert_eq!(metric["usage"]["cpu"], 2.0);
    assert_eq!(metric["capacity"]["cpu"], 8.0);
    assert_eq!(metric["allocatable"]["cpu"], 7.0);
    assert_eq!(metric["allocations"]["cpu"]["requests"], 0.25);
    assert_eq!(metric["allocations"]["activePods"], 1);
    assert_eq!(metric["allocations"]["status"], "partial");
    assert!(
        reads
            .lock()
            .unwrap()
            .iter()
            .all(|path| !path.ends_with("/namespaces"))
    );
}

#[tokio::test]
async fn scope_and_metric_denials_prevent_reads_and_hidden_budgets_remain_unknown() {
    for policy in [
        AgentPolicy {
            confirm_reads: false,
            ..Default::default()
        },
        AgentPolicy {
            confirm_reads: false,
            cluster_resources: true,
            denied_paths: vec!["/status/metrics".into()],
            ..Default::default()
        },
    ] {
        let (session, tools, reads) = fixture(policy);
        let _run = session.begin_run(0).unwrap();
        assert!(
            metrics(
                &session,
                &tools,
                json!({"kind":"Node","namespace":null,"name":"worker"})
            )
            .await
            .is_err()
        );
        assert!(reads.lock().unwrap().is_empty());
    }
    let (session, tools, _) = fixture(AgentPolicy {
        confirm_reads: false,
        denied_paths: vec!["/spec/containers/0/resources".into()],
        ..Default::default()
    });
    let _run = session.begin_run(0).unwrap();
    let result = metrics(&session, &tools, json!({"namespace":"apps","name":"web"}))
        .await
        .unwrap();
    assert_eq!(result["metrics"][0]["budgets"]["status"], "unknown");
    assert_eq!(result["metrics"][0]["usage"]["cpu"], 0.125);
}

#[tokio::test]
async fn node_allocations_are_complete_only_after_all_namespaces_and_pages_are_observed() {
    let (session, tools, _) = fixture_scope(
        AgentPolicy {
            confirm_reads: false,
            cluster_resources: true,
            ..Default::default()
        },
        true,
    );
    let _run = session.begin_run(0).unwrap();
    let result = metrics(
        &session,
        &tools,
        json!({"kind":"Node","namespace":null,"name":"worker"}),
    )
    .await
    .unwrap();
    assert_eq!(result["metrics"][0]["allocations"]["status"], "complete");
    assert_eq!(
        result["metrics"][0]["allocations"]["memory"]["requests"],
        268435456.0
    );
}

#[tokio::test]
async fn aggregates_never_reconstruct_hidden_container_or_host_usage() {
    for (path, args) in [
        (
            "/status/metrics/containers/0/cpu",
            json!({"namespace":"apps","name":"web"}),
        ),
        (
            "/status/metrics/cpu",
            json!({"kind":"Node","namespace":null,"name":"worker","podNamespaces":["apps"]}),
        ),
    ] {
        let (session, tools, _) = fixture(AgentPolicy {
            confirm_reads: false,
            cluster_resources: true,
            denied_paths: vec![path.into()],
            ..Default::default()
        });
        let _run = session.begin_run(0).unwrap();
        let result = metrics(&session, &tools, args).await.unwrap();
        assert!(result["metrics"][0]["usage"]["cpu"].is_null());
        assert!(result["metrics"][0]["usage"]["memory"].as_f64().is_some());
    }
}

#[tokio::test]
async fn unavailable_pod_inventory_is_unknown_reservation_instead_of_zero() {
    let (session, tools, reads) = fixture(AgentPolicy {
        confirm_reads: false,
        cluster_resources: true,
        rules: vec![ResourceRule {
            group: "".into(),
            kind: "Pod".into(),
            namespace: "*".into(),
            name: "*".into(),
            read: DataAccess::None,
            writes: vec![],
        }],
        ..Default::default()
    });
    let _run = session.begin_run(0).unwrap();
    let result = metrics(
        &session,
        &tools,
        json!({"kind":"Node","namespace":null,"name":"worker","podNamespaces":["apps"]}),
    )
    .await
    .unwrap();
    let metric = &result["metrics"][0];
    assert_eq!(metric["usage"]["cpu"], 2.0);
    assert_eq!(metric["allocations"]["status"], "unavailable");
    assert!(metric["allocations"]["cpu"]["requests"].is_null());
    assert!(
        reads
            .lock()
            .unwrap()
            .iter()
            .all(|path| !path.ends_with("/pods"))
    );
}
