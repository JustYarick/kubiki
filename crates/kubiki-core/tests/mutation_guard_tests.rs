use kube::{Client, client::Body};
use kubiki_core::core::{
    api::ResourceRef,
    mutations::{BatchIntent, MutationIntent, PreparedBatch, PreparedMutation},
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
async fn concise_consent_precedes_writes_and_scaling_keeps_atomic_identity() {
    let f = fixture("Deployment", 200);
    let plan = PreparedMutation::prepare(f.client, scale()).await.unwrap();
    let observed_writes = f.writes.clone();
    plan.confirm_and_commit(|review| async move {
        assert_eq!(review, "Scale from 3 to 0 replicas.");
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
async fn batch_confirms_once_before_any_write_and_commits_every_step() {
    let f = fixture("Deployment", 200);
    let resource = resource("Deployment");
    let steps = vec![
        BatchIntent::new(MutationIntent::Delete {
            resource: resource.clone(),
            resource_version: "10".into(),
        }),
        BatchIntent::new(MutationIntent::Delete {
            resource: resource.clone(),
            resource_version: "10".into(),
        }),
    ];
    let batch = PreparedBatch::prepare(f.client, resource, steps)
        .await
        .unwrap();
    let writes_before_confirmation = f.writes.clone();
    let confirmations = Arc::new(AtomicUsize::new(0));
    let counter = confirmations.clone();
    let result = batch
        .confirm_and_commit(|review| {
            counter.fetch_add(1, Ordering::SeqCst);
            assert!(review.contains("2 operations"));
            assert!(writes_before_confirmation.lock().unwrap().is_empty());
            async { Ok(true) }
        })
        .await
        .unwrap();
    assert_eq!(confirmations.load(Ordering::SeqCst), 1);
    assert_eq!(result["succeeded"], 2);
    assert_eq!(result["failed"], 0);
    assert_eq!(result["stopped"], false);
    assert_eq!(f.writes.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn batch_stops_after_a_critical_failure() {
    let f = fixture("Deployment", 403);
    let resource = resource("Deployment");
    let steps = vec![
        BatchIntent::critical(MutationIntent::Delete {
            resource: resource.clone(),
            resource_version: "10".into(),
        }),
        BatchIntent::new(MutationIntent::Delete {
            resource: resource.clone(),
            resource_version: "10".into(),
        }),
    ];
    let batch = PreparedBatch::prepare(f.client, resource, steps)
        .await
        .unwrap();
    let result = batch
        .confirm_and_commit(|_| async { Ok(true) })
        .await
        .unwrap();
    assert_eq!(result["succeeded"], 0);
    assert_eq!(result["failed"], 1);
    assert_eq!(result["stopped"], true);
    assert_eq!(f.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn batch_continues_after_noncritical_failures() {
    let f = fixture("Deployment", 403);
    let resource = resource("Deployment");
    let steps = vec![
        BatchIntent::new(MutationIntent::Delete {
            resource: resource.clone(),
            resource_version: "10".into(),
        }),
        BatchIntent::new(MutationIntent::Delete {
            resource: resource.clone(),
            resource_version: "10".into(),
        }),
    ];
    let batch = PreparedBatch::prepare(f.client, resource, steps)
        .await
        .unwrap();
    let result = batch
        .confirm_and_commit(|_| async { Ok(true) })
        .await
        .unwrap();
    assert_eq!(result["succeeded"], 0);
    assert_eq!(result["failed"], 2);
    assert_eq!(result["stopped"], false);
    assert_eq!(f.writes.lock().unwrap().len(), 2);
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
async fn secret_confirmation_counts_changed_keys_without_listing_data_and_commits_exact_payload() {
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
    assert_eq!(review, "Update Secret data (3 changed keys).");
    assert!(!review.contains("keep"));
    assert!(!review.contains("YmVmb3Jl") && !review.contains("YWZ0ZXI="));
    assert!(plan.details().steps[0].diff.is_none());
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
async fn no_op_and_immutable_changes_never_prompt_or_write() {
    for mode in ["noop", "immutable"] {
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
    for mode in ["uid", "rv", "kind", "group", "replicas", "namespace"] {
        let f = fixture("Deployment", 200);
        let mut target = resource("Deployment");
        let mut rv = "10".to_string();
        let mut replicas = 1;
        match mode {
            "uid" => target.uid = None,
            "rv" => rv.clear(),
            "kind" => target.query.kind = "Pod".into(),
            "group" => target.query.group = "custom.example".into(),
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
    assert_eq!(
        review,
        "Delete this Deployment and its dependent resources."
    );
    assert_eq!(
        plan.details().steps[0].resource.uid.as_deref(),
        Some("original")
    );
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

#[tokio::test]
async fn large_secret_values_do_not_expand_or_leak_into_the_review() {
    let f = fixture("Secret", 200);
    let plan = PreparedMutation::prepare(f.client, secret(json!({"large":"YWFh".repeat(7000)})))
        .await
        .unwrap();
    assert!(plan.review().len() < 1000);
    assert!(!plan.review().contains("YWFh"));
    assert!(plan.details().steps[0].diff.is_none());
    assert!(f.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn generated_restart_reviews_intent_without_expanding_large_resource_bodies() {
    use kubiki_core::core::mutations::{ResourceAction, ReviewKind};
    let f = fixture("Deployment", 200);
    f.state.lock().unwrap()["metadata"]["annotations"]["large"] = json!("x".repeat(40000));
    f.state.lock().unwrap()["spec"]["template"] = json!({"metadata":{"labels":{"app":"web"}},"spec":{"containers":[{"name":"app","image":"nginx"}]}});
    let prepared = PreparedMutation::prepare(
        f.client,
        MutationIntent::Action {
            resource: resource("Deployment"),
            resource_version: "10".into(),
            action: ResourceAction::Restart,
        },
    )
    .await
    .unwrap();
    assert_eq!(prepared.details().kind, ReviewKind::Action);
    assert_eq!(prepared.details().steps[0].operation, "RESTART");
    assert!(prepared.details().steps[0].diff.is_none());
    assert!(prepared.review().len() < 1000);
    prepared
        .confirm_and_commit(|_| async { Ok(true) })
        .await
        .unwrap();
    let writes = f.writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].1["metadata"]["annotations"]["large"]
            .as_str()
            .unwrap()
            .len(),
        40000
    );
    assert!(
        writes[0]
            .1
            .pointer("/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt")
            .is_some()
    );
}

#[tokio::test]
async fn run_now_preserves_job_template_labels_and_annotations() {
    use kubiki_core::core::mutations::ResourceAction;

    let cronjob = json!({
        "apiVersion": "batch/v1",
        "kind": "CronJob",
        "metadata": {
            "name": "backup",
            "namespace": "backend",
            "uid": "cron-uid",
            "resourceVersion": "10"
        },
        "spec": {
            "schedule": "0 0 * * *",
            "jobTemplate": {
                "metadata": {
                    "labels": {"team": "data", "backup": "daily"},
                    "annotations": {"example.com/policy": "keep"}
                },
                "spec": {
                    "template": {
                        "metadata": {"labels": {"app": "backup"}},
                        "spec": {
                            "restartPolicy": "Never",
                            "containers": [{"name": "backup", "image": "busybox"}]
                        }
                    }
                }
            }
        }
    });
    let writes = Arc::new(Mutex::new(Vec::new()));
    let captured = writes.clone();
    let service = tower::service_fn(move |req: http::Request<Body>| {
        let cronjob = cronjob.clone();
        let captured = captured.clone();
        async move {
            let path = req.uri().path().to_string();
            let status;
            let response = if req.method() == http::Method::GET
                && path.ends_with("/namespaces/backend/cronjobs/backup")
            {
                status = 200;
                cronjob
            } else if req.method() == http::Method::GET
                && path.ends_with("/namespaces/backend/jobs/backup-manual")
            {
                status = 404;
                json!({"apiVersion": "v1", "kind": "Status", "status": "Failure", "reason": "NotFound", "code": 404})
            } else if req.method() == http::Method::POST
                && path.ends_with("/namespaces/backend/jobs")
            {
                let bytes = req.into_body().collect_bytes().await.unwrap();
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                captured.lock().unwrap().push(body.clone());
                status = 201;
                body
            } else {
                status = 404;
                json!({"apiVersion": "v1", "kind": "Status", "status": "Failure", "reason": "NotFound", "code": 404})
            };
            Ok::<_, std::convert::Infallible>(
                http::Response::builder()
                    .status(status)
                    .body(Body::from(response.to_string().into_bytes()))
                    .unwrap(),
            )
        }
    });
    let resource: ResourceRef = serde_json::from_value(json!({
        "context": "production",
        "group": "batch",
        "version": "v1",
        "kind": "CronJob",
        "namespace": "backend",
        "name": "backup",
        "uid": "cron-uid"
    }))
    .unwrap();
    let plan = PreparedMutation::prepare(
        Client::new(service, "backend"),
        MutationIntent::Action {
            resource,
            resource_version: "10".into(),
            action: ResourceAction::RunCronJob {
                name: "backup-manual".into(),
            },
        },
    )
    .await
    .unwrap();
    plan.confirm_and_commit(|review| async move {
        assert!(review.contains("backup-manual"));
        Ok(true)
    })
    .await
    .unwrap();

    let writes = writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    let job = &writes[0];
    assert_eq!(job["metadata"]["name"], "backup-manual");
    assert_eq!(job["metadata"]["namespace"], "backend");
    assert_eq!(
        job["metadata"]["labels"],
        json!({"team": "data", "backup": "daily"})
    );
    assert_eq!(
        job["metadata"]["annotations"],
        json!({
            "example.com/policy": "keep",
            "cronjob.kubernetes.io/instantiate": "manual"
        })
    );
    assert_eq!(
        job["spec"]["template"]["metadata"]["labels"],
        json!({"app": "backup"})
    );
}
