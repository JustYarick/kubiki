use kubiki_core::cluster::{client::ClusterClientPool, kubeconfig::KubeConfigManager};
use kubiki_tools::kubernetes::{HostConsent, KubernetesTools};
use kubiki_tools::*;
use serde_json::{Value, json};
use std::sync::Arc;
fn session(denied_paths: Vec<String>) -> Session {
    Session::new(
        "receipt-test".into(),
        "host".into(),
        AgentScope {
            context: "fixture".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        },
        AgentPolicy {
            denied_paths,
            confirm_reads: false,
            workload_configuration: true,
            ..Default::default()
        },
        ClusterCapabilities::default(),
    )
}
fn tools(session: &Session, value: Value) -> KubernetesTools {
    let client = kube::Client::new(
        tower::service_fn(move |request: http::Request<kube::client::Body>| {
            assert_eq!(
                request.uri().path(),
                "/api/v1/namespaces/apps/pods/agent-abcde"
            );
            let v = value.clone();
            async move {
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .header("content-type", "application/json")
                        .body(kube::client::Body::from(serde_json::to_vec(&v).unwrap()))
                        .unwrap(),
                )
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
        std::env::temp_dir().join("kubiki-receipt-fixture.jsonl"),
        Arc::new(tokio::sync::Semaphore::new(2)),
    )
    .unwrap();
    tools.client = Some(client);
    tools
}

#[tokio::test]
async fn pod_diagnostics_preserve_exact_owners_without_guessing_or_extra_reads() {
    for kind in [
        "DaemonSet",
        "StatefulSet",
        "ReplicaSet",
        "Job",
        "CustomController",
    ] {
        let owner = json!({"apiVersion":if kind == "Job" {"batch/v1"} else if kind == "CustomController" {"example.io/v1"} else {"apps/v1"},"kind":kind,"name":"actual-owner","uid":"owner-uid","controller":true});
        let pod = json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"agent-abcde","namespace":"apps","uid":"pod-uid","ownerReferences":[owner.clone()]},"status":{"phase":"Running"}});
        for denied_paths in [
            vec![],
            vec!["/metadata/ownerReferences".to_string()],
            vec!["/metadata/ownerReferences/0/uid".into()],
        ] {
            let expected = if denied_paths.is_empty() {
                json!([owner.clone()])
            } else if denied_paths[0].ends_with("/uid") {
                let mut o = owner.clone();
                o.as_object_mut().unwrap().remove("uid");
                json!([o])
            } else {
                Value::Null
            };
            let session = session(denied_paths);
            let tools = tools(&session, pod.clone());
            let emit: EventSink = Arc::new(|_| {});
            let result = tools
                .execute(
                    &session,
                    &ToolCall {
                        id: "diagnose".into(),
                        name: "get_pod_diagnostics".into(),
                        arguments: json!({"namespace":"apps","name":"agent-abcde"}),
                    },
                    &emit,
                )
                .await
                .unwrap();
            assert_eq!(result["ownerReferences"], expected);
            assert_eq!(result["evidence"]["uid"], "pod-uid");
        }
    }
}

#[tokio::test]
async fn missing_ownership_remains_unknown() {
    let session = session(vec![]);
    let tools = tools(
        &session,
        json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"agent-abcde","namespace":"apps"}}),
    );
    let emit: EventSink = Arc::new(|_| {});
    let result = tools
        .execute(
            &session,
            &ToolCall {
                id: "diagnose".into(),
                name: "get_pod_diagnostics".into(),
                arguments: json!({"namespace":"apps","name":"agent-abcde"}),
            },
            &emit,
        )
        .await
        .unwrap();
    assert!(result["ownerReferences"].is_null());
}
