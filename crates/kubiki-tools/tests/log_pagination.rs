use kubiki_core::cluster::{client::ClusterClientPool, kubeconfig::KubeConfigManager};
use kubiki_tools::kubernetes::{HostConsent, KubernetesTools};
use kubiki_tools::*;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn filtered_log_pages_preserve_lines_without_rereading_and_revoke_on_policy_change() {
    let session = Session::new(
        "logs".into(),
        "test".into(),
        AgentScope {
            context: "fixture".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        },
        AgentPolicy {
            confirm_reads: false,
            logs: true,
            ..Default::default()
        },
        ClusterCapabilities::all(),
    );
    let reads = Arc::new(AtomicUsize::new(0));
    let observed = reads.clone();
    let client = kube::Client::new(
        tower::service_fn(move |request: http::Request<kube::client::Body>| {
            observed.fetch_add(1, Ordering::SeqCst);
            async move {
                let body = if request.uri().path().ends_with("/log") {
                    assert!(request.uri().query().unwrap().contains("sinceTime="));
                    "2026-11-17T10:00:00Z keep first\n2026-11-17T10:00:00Z omit\n2026-11-17T10:00:00Z keep second\n2026-11-17T10:00:01Z keep third\n".to_owned()
                } else {
                    assert_eq!(request.uri().path(), "/api/v1/namespaces/apps/pods/web");
                    json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"web","namespace":"apps","uid":"pod-id"},"spec":{"containers":[{"name":"web","image":"fixture"}]}}).to_string()
                };
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .header("content-type", "application/json")
                        .body(kube::client::Body::from(body.into_bytes()))
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
        std::env::temp_dir().join("log-pagination-fixture"),
        Arc::new(tokio::sync::Semaphore::new(2)),
    )
    .unwrap();
    tools.client = Some(client);
    let run = session.begin_run(0).unwrap();
    let emit: EventSink = Arc::new(|_| {});
    let call = |arguments: Value| ToolCall {
        id: "logs".into(),
        name: "get_logs".into(),
        arguments,
    };
    let args = json!({"namespace":"apps","name":"web","uid":"pod-id","container":"web","mode":"lines","contains":"keep","pageSize":1,"sinceTime":"2026-11-17T10:00:00Z"});
    let first = tools
        .execute(&session, &call(args.clone()), &emit)
        .await
        .unwrap();
    assert_eq!(first["lines"][0]["line"], 1);
    let mut next_args = args.clone();
    next_args["cursor"] = first["cursor"].clone();
    let mut changed = next_args.clone();
    changed["contains"] = json!("omit");
    assert!(
        tools
            .execute(&session, &call(changed), &emit)
            .await
            .unwrap_err()
            .contains("query/session permissions changed")
    );
    let next = tools
        .execute(&session, &call(next_args.clone()), &emit)
        .await
        .unwrap();
    assert_eq!(next["lines"][0]["line"], 3);
    assert_eq!(next["capturedAt"], first["capturedAt"]);
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    next_args["cursor"] = next["cursor"].clone();
    let last = tools
        .execute(&session, &call(next_args.clone()), &emit)
        .await
        .unwrap();
    assert_eq!(last["lines"][0]["line"], 4);
    assert_eq!(last["hasMore"], false);
    let mut invalid = args.clone();
    invalid["sinceSeconds"] = json!(60);
    assert!(
        tools
            .execute(&session, &call(invalid), &emit)
            .await
            .is_err()
    );
    let mut invalid = args;
    invalid["mode"] = json!("diagnostic");
    assert!(
        tools
            .execute(&session, &call(invalid), &emit)
            .await
            .is_err()
    );
    drop(run);
    session
        .set_policy(session.control().unwrap().policy)
        .unwrap();
    let _run = session
        .begin_run(session.control().unwrap().revision)
        .unwrap();
    assert!(
        tools
            .execute(&session, &call(next_args), &emit)
            .await
            .unwrap_err()
            .contains("cursor")
    );
    assert_eq!(reads.load(Ordering::SeqCst), 2);
}
