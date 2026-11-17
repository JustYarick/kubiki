use kubiki_core::cluster::{client::ClusterClientPool, kubeconfig::KubeConfigManager};
use kubiki_tools::kubernetes::{HostConsent, KubernetesTools};
use kubiki_tools::*;
use serde_json::{Value, json};
use std::sync::Arc;

#[tokio::test]
async fn event_pages_are_bound_to_the_query_and_resume_the_server_snapshot() {
    let session = Session::new(
        "events".into(),
        "test".into(),
        AgentScope {
            context: "fixture".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        },
        AgentPolicy {
            confirm_reads: false,
            ..Default::default()
        },
        ClusterCapabilities::all(),
    );
    let client = kube::Client::new(
        tower::service_fn(|request: http::Request<kube::client::Body>| async move {
            assert_eq!(request.uri().path(), "/api/v1/namespaces/apps/events");
            let query = request.uri().query().unwrap_or("");
            assert!(query.contains("involvedObject.uid"), "{query}");
            let second = query.contains("continue=next");
            let body = json!({"apiVersion":"v1","kind":"EventList","metadata":if second {json!({})} else {json!({"continue":"next"})},"items":[{"apiVersion":"v1","kind":"Event","metadata":{"name":if second {"second"} else {"first"},"namespace":"apps","uid":"event-id"},"involvedObject":{"uid":"pod-id"},"message":"fixture"}]});
            Ok::<_, std::convert::Infallible>(
                http::Response::builder()
                    .header("content-type", "application/json")
                    .body(kube::client::Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
        }),
        "apps",
    );
    let mut tools = KubernetesTools::scoped(
        &session,
        ClusterClientPool::new(KubeConfigManager::new()),
        None,
        None,
        Arc::new(HostConsent::default()),
        std::env::temp_dir().join("event-pagination-fixture"),
        Arc::new(tokio::sync::Semaphore::new(2)),
    )
    .unwrap();
    tools.client = Some(client);
    let _run = session.begin_run(0).unwrap();
    let emit: EventSink = Arc::new(|_| {});
    let call = |arguments: Value| ToolCall {
        id: "events".into(),
        name: "get_events".into(),
        arguments,
    };
    let first = tools
        .execute(
            &session,
            &call(json!({"namespace":"apps","uid":"pod-id"})),
            &emit,
        )
        .await
        .unwrap();
    assert_eq!(first["items"][0]["metadata"]["name"], "first");
    let cursor = first["cursor"].as_str().unwrap();
    let changed = tools
        .execute(
            &session,
            &call(json!({"namespace":"apps","uid":"other-id","cursor":cursor})),
            &emit,
        )
        .await;
    assert!(
        changed
            .unwrap_err()
            .contains("query/session permissions changed")
    );
    let next = tools
        .execute(
            &session,
            &call(json!({"namespace":"apps","uid":"pod-id","cursor":cursor})),
            &emit,
        )
        .await
        .unwrap();
    assert_eq!(next["items"][0]["metadata"]["name"], "second");
    assert_eq!(next["hasMore"], false);
}
