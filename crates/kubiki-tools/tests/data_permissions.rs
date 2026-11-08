use kubiki_core::cluster::{client::ClusterClientPool, kubeconfig::KubeConfigManager};
use kubiki_tools::kubernetes::{HostConsent, KubernetesTools};
use kubiki_tools::*;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

fn session(policy: AgentPolicy) -> Session {
    Session::new(
        "permissions".into(),
        "test".into(),
        AgentScope {
            context: "fixture".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        },
        policy,
        ClusterCapabilities::all(),
    )
}

fn tools(session: &Session, reads: Arc<AtomicUsize>) -> KubernetesTools {
    let client = kube::Client::new(
        tower::service_fn(move |_: http::Request<kube::client::Body>| {
            reads.fetch_add(1, Ordering::SeqCst);
            async {
                Ok::<_, std::convert::Infallible>(http::Response::builder().header("content-type", "application/json")
                .body(kube::client::Body::from(serde_json::to_vec(&json!({
                    "apiVersion":"v1","kind":"Event","metadata":{"name":"fixture","namespace":"apps","uid":"uid"},"message":"event-content"
                })).unwrap())).unwrap())
            }
        }),
        "apps",
    );
    let mut tools = KubernetesTools::scoped(
        session,
        ClusterClientPool::new(KubeConfigManager::new()),
        None,
        None,
        Arc::new(HostConsent::default()),
        std::env::temp_dir().join("unused-permission-test-journal"),
        Arc::new(tokio::sync::Semaphore::new(2)),
    )
    .unwrap();
    tools.client = Some(client);
    tools
}

#[tokio::test]
async fn category_denials_block_generic_reads_and_lists_before_http_even_with_content_rules() {
    let policy = AgentPolicy {
        events: false,
        metrics: false,
        confirm_reads: false,
        custom_resources: DataAccess::Content,
        rules: vec![ResourceRule {
            group: "*".into(),
            kind: "*".into(),
            namespace: "*".into(),
            name: "*".into(),
            read: DataAccess::Content,
            writes: vec![],
        }],
        ..Default::default()
    };
    let session = session(policy);
    let reads = Arc::new(AtomicUsize::new(0));
    let tools = tools(&session, reads.clone());
    let _running = session.begin_run(0).unwrap();
    let emit: EventSink = Arc::new(|_| {});
    for (group, version, kind) in [
        ("", "v1", "Event"),
        ("events.k8s.io", "v1", "Event"),
        ("metrics.k8s.io", "v1beta1", "PodMetrics"),
    ] {
        for name in ["get_resource", "list_resources"] {
            let mut args = json!({"group":group,"version":version,"kind":kind,"namespace":"apps"});
            if name == "get_resource" {
                args["name"] = json!("fixture");
            }
            let result = tools
                .execute(
                    &session,
                    &ToolCall {
                        id: name.into(),
                        name: name.into(),
                        arguments: args,
                    },
                    &emit,
                )
                .await;
            assert!(result.unwrap_err().contains("disabled by policy"));
        }
    }
    assert_eq!(reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn policy_change_revokes_cached_payloads_without_reusing_evidence_ids() {
    let session = session(AgentPolicy {
        confirm_reads: false,
        ..Default::default()
    });
    let reads = Arc::new(AtomicUsize::new(0));
    let tools = tools(&session, reads.clone());
    let emit: EventSink = Arc::new(|_| {});
    let run = session.begin_run(0).unwrap();
    let old = tools.execute(&session, &ToolCall {id:"read".into(), name:"get_resource".into(), arguments:json!({"group":"","version":"v1","kind":"Event","namespace":"apps","name":"fixture"})}, &emit).await.unwrap();
    let id = session.save_evidence(0, &old).unwrap().unwrap();
    drop(run);
    let mut policy = session.control().unwrap().policy;
    policy.events = false;
    session.set_policy(policy).unwrap();
    assert!(session.save_evidence(0, &old).is_err());
    let revision = session.control().unwrap().revision;
    let _run = session.begin_run(revision).unwrap();
    let result = tools
        .execute(
            &session,
            &ToolCall {
                id: "cached".into(),
                name: "get_evidence".into(),
                arguments: json!({"evidenceId":id}),
            },
            &emit,
        )
        .await;
    assert!(result.is_err());
    let fresh = session
        .save_evidence(revision, &json!({"observation":"permitted"}))
        .unwrap()
        .unwrap();
    assert_ne!(id, fresh);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}
