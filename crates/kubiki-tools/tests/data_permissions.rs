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

#[test]
fn diagnostic_crds_expose_status_without_values_and_preserve_explicit_denials() {
    let target = Target { group:"helm.toolkit.fluxcd.io".into(), version:"v2".into(), kind:"HelmRelease".into(), namespace:Some("apps".into()),name:"web".into() };
    let source = json!({"apiVersion":"helm.toolkit.fluxcd.io/v2","kind":"HelmRelease","metadata":{"name":"web"},"spec":{"values":{"password":"private"},"dependsOn":[{"name":"database"}],"chart":{"spec":{"valuesFiles":["private.yaml"]}}},"status":{"conditions":[{"type":"Ready","status":"False","reason":"RetriesExceeded"}],"installFailures":1,"lastAttemptedRevision":"1.2.3"}});
    let policy = AgentPolicy::default();
    let result = policy.project(&target,&source,false).unwrap();
    assert_eq!(result["status"]["installFailures"],1);
    assert_eq!(result["spec"]["dependsOn"][0]["name"],"database");
    assert!(result["spec"].get("values").is_none());
    assert!(result["spec"].get("chart").is_none());
    let fields = vec!["status.conditions".into(),"spec.values".into()];
    assert_eq!(policy.denied_fields(&target,false,&fields),vec!["spec.values"]);
    let metadata = AgentPolicy { custom_resources:DataAccess::Metadata, ..Default::default() };
    assert_eq!(metadata.denied_fields(&target,false,&fields),fields);
    let denied = AgentPolicy { rules:vec![ResourceRule {group:target.group.clone(),kind:target.kind.clone(),namespace:"*".into(),name:"*".into(),read:DataAccess::None,writes:vec![]}],..Default::default() };
    assert!(denied.project(&target,&source,false).is_err());
    let excluded = AgentPolicy { denied_paths:vec!["/status/conditions".into()],..Default::default() };
    assert!(excluded.project(&target,&source,false).unwrap()["status"].get("conditions").is_none());
    assert_eq!(excluded.denied_fields(&target,false,&["status.conditions[*].message".into()]),vec!["status.conditions[*].message"]);
}

#[tokio::test]
async fn exact_read_reports_when_all_requested_fields_are_denied() {
    let session = session(AgentPolicy { confirm_reads:false,rules:vec![ResourceRule { group:"".into(),kind:"Event".into(),namespace:"apps".into(),name:"fixture".into(),read:DataAccess::Metadata,writes:vec![] }], ..Default::default() });
    let tools = tools(&session, Arc::new(AtomicUsize::new(0)));
    let _run = session.begin_run(0).unwrap();
    let emit: EventSink = Arc::new(|_| {});
    let result = tools.execute(&session, &ToolCall { id:"read".into(),name:"get_resource".into(),arguments:json!({"group":"","version":"v1","kind":"Event","namespace":"apps","name":"fixture","fields":["status.conditions"]}) }, &emit).await.unwrap();
    assert_eq!(result["fieldAccess"]["allRequestedFieldsDenied"],true);
    assert_eq!(result["fieldAccess"]["denied"],json!(["status.conditions"]));
    assert!(result["resource"].get("status").is_none());
    assert_eq!(result["resource"]["metadata"]["name"],"fixture");
}
