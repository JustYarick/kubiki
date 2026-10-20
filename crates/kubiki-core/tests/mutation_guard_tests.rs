use kube::{Client, client::Body};
use kubiki_core::core::{
    api::ResourceRef,
    mutations::{MutationIntent, PreparedMutation},
    secret_data::SecretDataRequest,
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn resource(kind: &str) -> ResourceRef {
    serde_json::from_value(json!({"context":"production","group":if kind=="Secret"{""}else{"apps"},"version":"v1","kind":kind,"namespace":"backend","name":"web","uid":"original"})).unwrap()
}
fn current(kind: &str) -> Value {
    json!({"apiVersion":if kind=="Secret"{"v1"}else{"apps/v1"},"kind":kind,"metadata":{"uid":"original","resourceVersion":"10","name":"web","namespace":"backend","annotations":{"preserved":"yes"}},"spec":{"replicas":3},"data":{"old":"c2VjcmV0"}})
}
fn scale() -> MutationIntent {
    MutationIntent::Scale {
        resource: resource("Deployment"),
        resource_version: "10".into(),
        replicas: 0,
    }
}
fn secret(data: Value) -> MutationIntent {
    MutationIntent::Secret(SecretDataRequest {
        resource: resource("Secret"),
        resource_version: "10".into(),
        data: serde_json::from_value(data).unwrap(),
    })
}
struct Fixture {
    client: Client,
    state: Arc<Mutex<Value>>,
    writes: Arc<Mutex<Vec<(String, Value)>>>,
    reads: Arc<AtomicUsize>,
}
fn fixture(kind: &str, write_status: u16) -> Fixture {
    let state = Arc::new(Mutex::new(current(kind)));
    let writes = Arc::new(Mutex::new(vec![]));
    let reads = Arc::new(AtomicUsize::new(0));
    let (s, w, r) = (state.clone(), writes.clone(), reads.clone());
    let service = tower::service_fn(move |req: http::Request<Body>| {
        let (state, writes, reads) = (s.clone(), w.clone(), r.clone());
        async move {
            let (body, status) = if req.method() == http::Method::GET {
                reads.fetch_add(1, Ordering::SeqCst);
                (state.lock().unwrap().clone(), 200)
            } else {
                let uri = req.uri().to_string();
                let method = req.method().to_string();
                let bytes = req.into_body().collect_bytes().await.unwrap();
                let body: Value = if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                let recorded_method = if method == "DELETE" {
                    format!("{method} {uri}")
                } else {
                    method
                };
                writes.lock().unwrap().push((recorded_method, body.clone()));
                if write_status >= 400 {
                    (
                        json!({"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Conflict","message":"sensitive-server-value","code":write_status}),
                        write_status,
                    )
                } else {
                    (state.lock().unwrap().clone(), 200)
                }
            };
            Ok::<_, std::convert::Infallible>(
                http::Response::builder()
                    .status(status)
                    .body(Body::from(body.to_string().into_bytes()))
                    .unwrap(),
            )
        }
    });
    Fixture {
        client: Client::new(service, "backend"),
        state,
        writes,
        reads,
    }
}
#[tokio::test]
async fn consent_sees_server_diff_before_any_write_and_scales_only_replicas_with_atomic_identity() {
    let f = fixture("Deployment", 200);
    let plan = PreparedMutation::prepare(f.client, scale()).await.unwrap();
    let observed_writes = f.writes.clone();
    plan.confirm_and_commit(|review| async move {
        assert!(
            review.contains("production")
                && review.contains("original")
                && review.contains("backend")
        );
        assert!(review.contains("spec.replicas: 3 → 0"));
        assert!(observed_writes.lock().unwrap().is_empty());
        Ok(true)
    })
    .await
    .unwrap();
    let writes = f.writes.lock().unwrap();
    assert_eq!(
        writes.as_slice(),
        &[(
            "PATCH".into(),
            json!({"metadata":{"uid":"original","resourceVersion":"10"},"spec":{"replicas":0}})
        )]
    );
    assert_eq!(f.reads.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn cancel_and_failed_consent_never_write() {
    for fail in [false, true] {
        let f = fixture("Deployment", 200);
        let plan = PreparedMutation::prepare(f.client, scale()).await.unwrap();
        let result = plan
            .confirm_and_commit(|_| async {
                if fail {
                    Err(kubiki_core::core::api::ApiError::from_status(
                        503,
                        "Dialog unavailable",
                        "mutation",
                        None,
                    ))
                } else {
                    Ok(false)
                }
            })
            .await;
        assert!(result.is_err());
        assert!(f.writes.lock().unwrap().is_empty());
        assert_eq!(f.reads.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn stale_or_recreated_objects_rejected_before_prompt_and_after_consent() {
    for key in ["uid", "resourceVersion"] {
        for before_review in [true, false] {
            let f = fixture("Deployment", 200);
            if before_review {
                f.state.lock().unwrap()["metadata"][key] = json!("changed");
            }
            let prepared = PreparedMutation::prepare(f.client, scale()).await;
            let result = if before_review {
                prepared.err().unwrap()
            } else {
                prepared
                    .unwrap()
                    .confirm_and_commit(|_| async {
                        f.state.lock().unwrap()["metadata"][key] = json!("changed");
                        Ok(true)
                    })
                    .await
                    .unwrap_err()
            };
            assert_eq!(result.status, Some(409));
            assert!(f.writes.lock().unwrap().is_empty());
        }
    }
}
#[tokio::test]
async fn secret_diff_lists_added_changed_removed_keys_and_commits_only_the_reviewed_payload() {
    let f = fixture("Secret", 200);
    f.state.lock().unwrap()["data"] =
        json!({"old":"c2VjcmV0","change":"YmVmb3Jl","keep":"c2FtZQ=="});
    let plan = PreparedMutation::prepare(
        f.client,
        secret(json!({"new":"bmV3","change":"YWZ0ZXI=","keep":"c2FtZQ=="})),
    )
    .await
    .unwrap();
    let review = plan.review();
    assert!(
        review.contains("data/old")
            && review.contains("(removed)")
            && review.contains("data/new")
            && review.contains("(absent)")
    );
    assert!(!review.contains("data/keep"));
    assert!(review.contains("YmVmb3Jl") && review.contains("YWZ0ZXI="));
    plan.confirm_and_commit(|_| async { Ok(true) })
        .await
        .unwrap();
    let writes = f.writes.lock().unwrap();
    assert_eq!(writes[0].0, "PUT");
    assert_eq!(writes[0].1["metadata"]["resourceVersion"], "10");
    assert_eq!(writes[0].1["metadata"]["annotations"]["preserved"], "yes");
    assert_eq!(
        writes[0].1["data"],
        json!({"new":"bmV3","change":"YWZ0ZXI=","keep":"c2FtZQ=="})
    );
}
#[tokio::test]
async fn no_op_immutable_and_unreviewably_large_changes_never_prompt_or_write() {
    for mode in ["noop", "immutable", "large"] {
        let f = fixture("Secret", 200);
        if mode == "immutable" {
            f.state.lock().unwrap()["immutable"] = json!(true);
        }
        let data = match mode {
            "noop" => json!({"old":"c2VjcmV0"}),
            "large" => json!({"large":"YWFh".repeat(7000)}),
            _ => json!({"new":"YWJj"}),
        };
        assert!(
            PreparedMutation::prepare(f.client, secret(data))
                .await
                .is_err()
        );
        assert!(f.writes.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn missing_identity_invalid_kind_and_negative_replicas_fail_without_api_access() {
    for mode in ["uid", "rv", "kind", "replicas", "namespace"] {
        let f = fixture("Deployment", 200);
        let mut target = resource("Deployment");
        let mut rv = "10".to_string();
        let mut replicas = 1;
        match mode {
            "uid" => target.uid = None,
            "rv" => rv.clear(),
            "kind" => target.query.kind = "Pod".into(),
            "replicas" => replicas = -1,
            _ => target.query.namespace = None,
        };
        assert!(
            PreparedMutation::prepare(
                f.client,
                MutationIntent::Scale {
                    resource: target,
                    resource_version: rv,
                    replicas
                }
            )
            .await
            .is_err()
        );
        assert_eq!(f.reads.load(Ordering::SeqCst), 0);
    }
}
#[tokio::test]
async fn atomic_conflict_after_final_read_has_no_retry_and_sanitized_errors() {
    let f = fixture("Deployment", 409);
    let plan = PreparedMutation::prepare(f.client, scale()).await.unwrap();
    let error = plan
        .confirm_and_commit(|_| async { Ok(true) })
        .await
        .unwrap_err();
    assert_eq!(error.status, Some(409));
    assert!(!error.retryable);
    assert!(!error.message.contains("sensitive-server-value"));
    assert_eq!(f.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn prepared_delete_shows_server_identity_and_propagation_before_commit_and_pins_uid_rv() {
    let f = fixture("Deployment", 200);
    f.state.lock().unwrap()["metadata"]["labels"] = json!({"app":"web"});
    let plan = PreparedMutation::prepare(
        f.client,
        MutationIntent::Delete {
            resource: resource("Deployment"),
            resource_version: "10".into(),
        },
    )
    .await
    .unwrap();
    let review = plan.review().to_owned();
    assert!(
        review.contains("DELETE")
            && review.contains("background garbage collection")
            && review.contains("dependents")
            && review.contains("app"),
        "{review}"
    );
    assert!(review.contains("Resource version: \"10\""));
    let writes = f.writes.clone();
    plan.confirm_and_commit(|_| async move {
        assert!(writes.lock().unwrap().is_empty());
        Ok(true)
    })
    .await
    .unwrap();
    let writes = f.writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    let request = &writes[0];
    assert!(request.0.starts_with("DELETE "));
    assert_eq!(request.1["preconditions"]["uid"], "original", "{request:?}");
    assert_eq!(request.1["preconditions"]["resourceVersion"], "10");
    assert_eq!(request.1["propagationPolicy"], "Background");
}
