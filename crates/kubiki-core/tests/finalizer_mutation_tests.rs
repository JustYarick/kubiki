//! Finalizer removal is a targeted merge patch, not a whole-object replace.
//! Read/write HTTP fixtures only: these tests never use kubeconfig or a live cluster.
use kube::{Client, client::Body};
use kubiki_core::core::{
    mutations::{MutationIntent, PreparedMutation},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

struct Fixture {
    client: Client,
    state: Arc<Mutex<Value>>,
    requests: Arc<Mutex<Vec<(String, String, Value)>>>,
}
fn object() -> Value {
    json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"team","uid":"original","resourceVersion":"10","finalizers":["example.com/a","example.com/b"]},"spec":{"replicas":1}})
}
fn fixture(initial: Value) -> Fixture {
    fixture_with(initial, None)
}
/// `reinserts` emulates a controller restoring its finalizer right after the
/// patch lands, before the follow-up read — the in-use PVC case on real clusters.
fn fixture_with(initial: Value, reinserts: Option<String>) -> Fixture {
    let state = Arc::new(Mutex::new(initial));
    let requests: Arc<Mutex<Vec<(String, String, Value)>>> = Arc::default();
    let (s, r) = (state.clone(), requests.clone());
    let service = tower::service_fn(move |request: http::Request<Body>| {
        let (state, requests) = (s.clone(), r.clone());
        let reinserts = reinserts.clone();
        async move {
            let method = request.method().to_string();
            let uri = request.uri().to_string();
            let bytes = request.into_body().collect_bytes().await.unwrap();
            let payload = if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap()
            };
            requests
                .lock()
                .unwrap()
                .push((method.clone(), uri.clone(), payload.clone()));
            // Model a metadata merge for PATCH/PUT so the response object carries
            // the finalizer list the renderer would use for re-add detection.
            if (method == "PATCH" || method == "PUT") && !payload.is_null() {
                let mut current = state.lock().unwrap().clone();
                if let Some(metadata) = payload.get("metadata").and_then(Value::as_object) {
                    let meta = current
                        .get_mut("metadata")
                        .and_then(Value::as_object_mut)
                        .unwrap();
                    for (key, value) in metadata {
                        meta.insert(key.clone(), value.clone());
                    }
                }
                if let Some(finalizer) = reinserts {
                    let meta = current
                        .get_mut("metadata")
                        .and_then(Value::as_object_mut)
                        .unwrap();
                    let list = meta
                        .entry("finalizers")
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                        .unwrap();
                    if !list.iter().any(|item| item == &json!(finalizer)) {
                        list.push(json!(finalizer));
                    }
                }
                *state.lock().unwrap() = current;
            }
            let body = state.lock().unwrap().to_string().into_bytes();
            Ok::<_, std::convert::Infallible>(
                http::Response::builder()
                    .status(200)
                    .body(Body::from(body))
                    .unwrap(),
            )
        }
    });
    Fixture {
        client: Client::new(service, "team"),
        state,
        requests,
    }
}
fn intent(finalizer: &str) -> MutationIntent {
    MutationIntent::RemoveFinalizer {
        resource: serde_json::from_value(json!({
            "context":"prod","group":"apps","version":"v1","kind":"Deployment",
            "namespace":"team","name":"web","uid":"original"
        }))
        .unwrap(),
        finalizer: finalizer.into(),
    }
}
fn writes(f: &Fixture) -> Vec<(String, String, Value)> {
    f.requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _, _)| method != "GET")
        .cloned()
        .collect()
}

#[tokio::test]
async fn review_pins_the_live_object_and_commit_is_a_single_rv_pinned_patch() {
    let f = fixture(object());
    let plan = PreparedMutation::prepare(f.client.clone(), intent("example.com/b"))
        .await
        .unwrap();
    let requests = f.requests.clone();
    let updated = plan
        .confirm_and_commit(|review| async move {
            assert!(review.contains("Remove finalizer"));
            assert!(review.contains("metadata.finalizers"));
            assert!(review.contains("example.com/a") && review.contains("example.com/b"));
            assert!(review.contains("original"));
            assert!(review.contains("re-add") || review.contains("Re-add"));
            assert!(
                !requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(method, _, _)| method != "GET"),
                "the review must not write anything"
            );
            Ok(true)
        })
        .await
        .unwrap();
    let writes = writes(&f);
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].0, "PATCH");
    assert_eq!(
        writes[0].1,
        "/apis/apps/v1/namespaces/team/deployments/web?"
    );
    assert_eq!(writes[0].2["metadata"]["uid"], "original");
    assert_eq!(writes[0].2["metadata"]["resourceVersion"], "10");
    assert_eq!(writes[0].2["metadata"]["finalizers"], json!(["example.com/a"]));
    // The response still carries the live finalizer list for re-add detection.
    assert_eq!(updated["metadata"]["finalizers"], json!(["example.com/a"]));
}

#[tokio::test]
async fn controller_readd_is_reported_in_the_followup_object() {
    let f = fixture_with(object(), Some("example.com/b".into()));
    let plan = PreparedMutation::prepare(f.client.clone(), intent("example.com/b"))
        .await
        .unwrap();
    let updated = plan.confirm_and_commit(|_| async { Ok(true) }).await.unwrap();
    // One patch still happened; the verdict object shows the incoming finalizer.
    assert_eq!(writes(&f).len(), 1);
    assert_eq!(
        updated["metadata"]["finalizers"],
        json!(["example.com/a", "example.com/b"])
    );
}

#[tokio::test]
async fn absent_finalizer_fails_prepare_with_only_reads() {
    let f = fixture(object());
    let error = match PreparedMutation::prepare(f.client.clone(), intent("example.com/zzz")).await {
        Ok(_) => panic!("absent finalizer must fail preparation"),
        Err(error) => error,
    };
    assert_eq!(error.status, Some(400));
    assert!(writes(&f).is_empty());
}

#[tokio::test]
async fn uid_mismatch_is_rejected_before_any_write() {
    let f = fixture(object());
    let intent = MutationIntent::RemoveFinalizer {
        resource: serde_json::from_value(json!({
            "context":"prod","group":"apps","version":"v1","kind":"Deployment",
            "namespace":"team","name":"web","uid":"replaced"
        }))
        .unwrap(),
        finalizer: "example.com/b".into(),
    };
    let error = match PreparedMutation::prepare(f.client.clone(), intent).await {
        Ok(_) => panic!("uid mismatch must fail preparation"),
        Err(error) => error,
    };
    assert_eq!(error.status, Some(409));
    assert!(writes(&f).is_empty());
}

#[tokio::test]
async fn cancel_and_concurrent_change_never_patch() {
    for mode in ["cancel", "rv_race"] {
        let f = fixture(object());
        let plan = PreparedMutation::prepare(f.client.clone(), intent("example.com/b"))
            .await
            .unwrap();
        let state = f.state.clone();
        let result = plan
            .confirm_and_commit(|_| async {
                match mode {
                    "cancel" => Ok(false),
                    "rv_race" => {
                        state.lock().unwrap()["metadata"]["resourceVersion"] = json!("11");
                        Ok(true)
                    }
                    other => unreachable!("{other}"),
                }
            })
            .await;
        assert!(result.is_err(), "{mode}");
        assert!(writes(&f).is_empty(), "{mode}");
    }
}
