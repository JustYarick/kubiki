use kubiki_core::cluster::{client::ClusterClientPool, kubeconfig::KubeConfigManager};
use kubiki_tools::kubernetes::{HostConsent, KubernetesTools};
use kubiki_tools::*;
use serde_json::{Value, json};
use std::sync::Arc;
fn target() -> Target {
    Target {
        group: "apps".into(),
        version: "v1".into(),
        kind: "Deployment".into(),
        namespace: Some("apps".into()),
        name: "web".into(),
    }
}
fn session() -> Session {
    Session::new(
        "receipt-test".into(),
        "host".into(),
        AgentScope {
            context: "fixture".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        },
        AgentPolicy {
            confirm_reads: false,
            workload_configuration: true,
            ..Default::default()
        },
        ClusterCapabilities::default(),
    )
}
fn tools(session: &Session, uid: &str, generation: u64) -> KubernetesTools {
    let value = json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"apps","uid":uid,"generation":generation},"spec":{"replicas":1},"status":{"observedGeneration":generation,"replicas":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1}});
    let client = kube::Client::new(
        tower::service_fn(move |_: http::Request<kube::client::Body>| {
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
fn accepted(session: &Session) {
    let call = ToolCall {
        id: "write".into(),
        name: "scale_workload".into(),
        arguments: json!({"replicas":1}),
    };
    session.accepted_operations.lock().unwrap().save(
        AcceptedOperation::new(
            "op-1".into(),
            &call,
            target(),
            &json!({"metadata":{"uid":"accepted-uid","generation":2}}),
        )
        .unwrap(),
    );
}
async fn verify(tools: &KubernetesTools, session: &Session, extra: Value) -> Result<Value, String> {
    let mut args = serde_json::to_value(target()).unwrap();
    args["timeoutSeconds"] = json!(1);
    for (k, v) in extra.as_object().unwrap() {
        args[k] = v.clone();
    }
    let emit: EventSink = Arc::new(|_| {});
    tools
        .execute(
            session,
            &ToolCall {
                id: "verify".into(),
                name: "verify_workload".into(),
                arguments: args,
            },
            &emit,
        )
        .await
}
#[tokio::test]
async fn fresh_executor_uses_connection_receipt_and_rejects_replacement_even_without_operation_id()
{
    let session = session();
    let first = tools(&session, "accepted-uid", 2);
    accepted(&session);
    drop(first);
    let next = tools(&session, "replacement-uid", 2);
    assert!(
        verify(&next, &session, json!({"operationId":"op-1"}))
            .await
            .unwrap_err()
            .contains("replaced")
    );
    assert!(
        verify(&next, &session, json!({}))
            .await
            .unwrap_err()
            .contains("replaced")
    );
}
#[tokio::test]
async fn verification_binds_generation_and_does_not_accept_unrelated_or_expired_operations() {
    let session = session();
    accepted(&session);
    assert_eq!(
        verify(
            &tools(&session, "accepted-uid", 2),
            &session,
            json!({"operationId":"op-1"})
        )
        .await
        .unwrap()["verification"],
        "verified"
    );
    assert_eq!(
        verify(
            &tools(&session, "accepted-uid", 3),
            &session,
            json!({"operationId":"op-1","expectedGeneration":3})
        )
        .await
        .unwrap()["verification"],
        "pending"
    );
    assert!(
        verify(
            &tools(&session, "accepted-uid", 2),
            &session,
            json!({"operationId":"unknown"})
        )
        .await
        .is_err()
    );
    let other = Session::new(
        "other".into(),
        "host".into(),
        session.scope.clone(),
        AgentPolicy {
            confirm_reads: false,
            ..Default::default()
        },
        ClusterCapabilities::default(),
    );
    assert!(
        verify(
            &tools(&other, "accepted-uid", 2),
            &other,
            json!({"operationId":"op-1"})
        )
        .await
        .is_err()
    );
    assert_eq!(
        verify(&tools(&other, "accepted-uid", 2), &other, json!({}))
            .await
            .unwrap()["verification"],
        "unavailable"
    );
}
