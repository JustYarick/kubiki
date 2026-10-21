//! Read/write HTTP fixtures only: these tests never use kubeconfig or a live cluster.
use kube::{Client, client::Body};
use kubiki_core::core::{
    api::ResourceRef,
    mutations::{ManifestTarget, MutationIntent, PreparedMutation},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

type Requests = Arc<Mutex<Vec<(String, String, Value)>>>;
struct Fixture {
    client: Client,
    state: Arc<Mutex<Option<Value>>>,
    requests: Requests,
}
fn object() -> Value {
    json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"team","uid":"original","resourceVersion":"10","managedFields":[{"manager":"controller"}]},"spec":{"replicas":3},"status":{"readyReplicas":3}})
}
fn fixture(initial: Option<Value>, write_status: u16) -> Fixture {
    let state = Arc::new(Mutex::new(initial));
    let requests: Requests = Arc::default();
    let (s, r) = (state.clone(), requests.clone());
    let service = tower::service_fn(move |request: http::Request<Body>| {
        let (state, requests) = (s.clone(), r.clone());
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
            let (status, body) = if method == "GET" && uri == "/apis/example.io/v1beta1" {
                (
                    200,
                    json!({"apiVersion":"v1","kind":"APIResourceList","groupVersion":"example.io/v1beta1","resources":[{"name":"widgets","singularName":"widget","kind":"Widget","namespaced":true,"verbs":["get","create","update","delete"]}]}),
                )
            } else if method == "GET" {
                match state.lock().unwrap().clone() {
                    Some(value) => (200, value),
                    None => (
                        404,
                        json!({"kind":"Status","apiVersion":"v1","status":"Failure","code":404,"reason":"NotFound"}),
                    ),
                }
            } else if write_status >= 400 {
                (
                    write_status,
                    json!({"kind":"Status","apiVersion":"v1","status":"Failure","code":write_status,"reason":"Conflict","message":"private-value"}),
                )
            } else if method == "DELETE" {
                (200, state.lock().unwrap().clone().unwrap())
            } else {
                (200, payload)
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
        client: Client::new(service, "team"),
        state,
        requests,
    }
}
fn manifest(value: Value, target: Option<ManifestTarget>) -> MutationIntent {
    MutationIntent::Manifest {
        context: "prod".into(),
        manifest: value.to_string(),
        target,
    }
}
fn target(value: &Value) -> ManifestTarget {
    let (group, version) = value["apiVersion"]
        .as_str()
        .unwrap()
        .split_once('/')
        .unwrap_or(("", "v1"));
    ManifestTarget { resource: serde_json::from_value(json!({"context":"prod","group":group,"version":version,"kind":value["kind"],"namespace":value["metadata"]["namespace"],"name":value["metadata"]["name"],"uid":value["metadata"]["uid"]})).unwrap(), resource_version: value["metadata"]["resourceVersion"].as_str().unwrap().into() }
}
fn writes(requests: &Requests) -> Vec<(String, String, Value)> {
    requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _, _)| method != "GET")
        .cloned()
        .collect()
}
#[tokio::test]
async fn yaml_review_is_exact_and_update_preserves_server_fields_with_atomic_uid_and_version() {
    let f = fixture(Some(object()), 200);
    let mut next = object();
    next["spec"]["replicas"] = json!(0);
    next["status"]["readyReplicas"] = json!(999);
    next["metadata"]
        .as_object_mut()
        .unwrap()
        .remove("managedFields");
    let plan = PreparedMutation::prepare(f.client, manifest(next, Some(target(&object()))))
        .await
        .unwrap();
    let requests = f.requests.clone();
    plan.confirm_and_commit(|review| async move {
        assert!(review.contains("/spec/replicas") && review.contains("BEFORE 3 → AFTER 0"));
        assert!(review.contains("original") && review.contains("prod") && review.contains("team"));
        assert!(!review.contains("999"));
        assert!(writes(&requests).is_empty());
        Ok(true)
    })
    .await
    .unwrap();
    let writes = writes(&f.requests);
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].0, "PUT");
    assert_eq!(
        writes[0].1,
        "/apis/apps/v1/namespaces/team/deployments/web?"
    );
    assert_eq!(writes[0].2["metadata"]["uid"], "original");
    assert_eq!(writes[0].2["metadata"]["resourceVersion"], "10");
    assert_eq!(writes[0].2["status"], object()["status"]);
    assert_eq!(
        writes[0].2["metadata"]["managedFields"],
        object()["metadata"]["managedFields"]
    );
}
#[tokio::test]
async fn yaml_cancel_unavailable_dialog_and_concurrent_recreation_never_write() {
    for mode in ["cancel", "dialog_error", "uid", "resourceVersion"] {
        let f = fixture(Some(object()), 200);
        let mut next = object();
        next["spec"]["replicas"] = json!(0);
        let plan = PreparedMutation::prepare(f.client, manifest(next, None))
            .await
            .unwrap();
        let result = plan
            .confirm_and_commit(|_| async {
                if mode == "dialog_error" {
                    return Err(kubiki_core::core::mutations::error(
                        &target(&object()).resource,
                        503,
                        "Unavailable",
                    ));
                }
                if mode == "cancel" {
                    return Ok(false);
                }
                f.state.lock().unwrap().as_mut().unwrap()["metadata"][mode] = json!("replaced");
                Ok(true)
            })
            .await;
        assert!(result.is_err());
        assert!(writes(&f.requests).is_empty(), "{mode}");
    }
}
#[tokio::test]
async fn identity_changes_missing_preconditions_and_deleted_objects_cannot_be_saved() {
    for mode in [
        "rename",
        "namespace",
        "context",
        "uid",
        "version",
        "missing_uid",
        "missing_version",
        "deleted",
    ] {
        let f = fixture(
            if mode == "deleted" {
                None
            } else {
                Some(object())
            },
            200,
        );
        let mut next = object();
        next["spec"]["replicas"] = json!(0);
        let original = target(&next);
        match mode {
            "rename" => next["metadata"]["name"] = json!("other"),
            "namespace" => next["metadata"]["namespace"] = json!("other"),
            "uid" => next["metadata"]["uid"] = json!("other"),
            "version" => next["metadata"]["resourceVersion"] = json!("11"),
            "missing_uid" => {
                next["metadata"].as_object_mut().unwrap().remove("uid");
            }
            "missing_version" => {
                next["metadata"]
                    .as_object_mut()
                    .unwrap()
                    .remove("resourceVersion");
            }
            _ => (),
        }
        let intent = if mode == "context" {
            MutationIntent::Manifest {
                context: "different".into(),
                manifest: next.to_string(),
                target: Some(original),
            }
        } else {
            manifest(
                next,
                if mode.starts_with("missing") {
                    None
                } else {
                    Some(original)
                },
            )
        };
        assert!(
            PreparedMutation::prepare(f.client, intent).await.is_err(),
            "{mode}"
        );
        assert!(writes(&f.requests).is_empty());
    }
}
#[tokio::test]
async fn create_requires_confirmation_and_cannot_overwrite_a_concurrently_created_object() {
    for mode in ["ok", "cancel", "appeared", "atomic_conflict"] {
        let f = fixture(None, if mode == "atomic_conflict" { 409 } else { 200 });
        let new = json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"new","namespace":"team"},"data":{"key":"value"}});
        let plan = PreparedMutation::prepare(f.client, manifest(new.clone(), None))
            .await
            .unwrap();
        let state = f.state.clone();
        let requests = f.requests.clone();
        let result = plan
            .confirm_and_commit(|review| async move {
                assert!(review.contains("CREATE") && review.contains("value"));
                assert!(writes(&requests).is_empty());
                if mode == "appeared" {
                    *state.lock().unwrap() = Some(new);
                }
                Ok(mode != "cancel")
            })
            .await;
        let w = writes(&f.requests);
        if mode == "ok" {
            assert!(result.is_ok());
            assert_eq!(w.len(), 1);
            assert_eq!(w[0].0, "POST");
        } else {
            assert!(result.is_err());
            assert_eq!(w.len(), usize::from(mode == "atomic_conflict"));
        }
    }
}
#[tokio::test]
async fn malformed_multi_object_and_unreviewable_yaml_fail_closed() {
    for text in ["kind: List\napiVersion: v1\nitems: []".into(), "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n  namespace: team\n---\nkind: ConfigMap".into(),
        json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"../other","namespace":"team"}}).to_string(),
        json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"generateName":"random-","namespace":"team"}}).to_string(), "a".repeat(1024*1024+1)] {
        let f = fixture(None, 200);
        assert!(PreparedMutation::prepare(f.client, MutationIntent::Manifest { context: "prod".into(), manifest: text, target: None }).await.is_err());
        assert!(f.requests.lock().unwrap().is_empty());
    }
    let f = fixture(Some(object()), 200);
    let mut next = object();
    next["spec"]["payload"] = json!("sensitive".repeat(4000));
    assert!(
        PreparedMutation::prepare(f.client, manifest(next, None))
            .await
            .is_err()
    );
    assert!(writes(&f.requests).is_empty());
}
#[tokio::test]
async fn discovered_custom_objects_use_the_exact_served_version_for_save_and_delete() {
    for delete in [false, true] {
        let mut current = object();
        current["apiVersion"] = json!("example.io/v1beta1");
        current["kind"] = json!("Widget");
        let f = fixture(Some(current.clone()), 200);
        let identity = target(&current);
        let intent = if delete {
            MutationIntent::Delete {
                resource: identity.resource,
                resource_version: identity.resource_version,
            }
        } else {
            let mut next = current;
            next["spec"]["replicas"] = json!(1);
            manifest(next, Some(identity))
        };
        PreparedMutation::prepare(f.client, intent)
            .await
            .unwrap()
            .confirm_and_commit(|_| async { Ok(true) })
            .await
            .unwrap();
        let w = writes(&f.requests);
        assert_eq!(w.len(), 1);
        assert!(
            w[0].1
                .starts_with("/apis/example.io/v1beta1/namespaces/team/widgets/web")
        );
        assert_eq!(w[0].0, if delete { "DELETE" } else { "PUT" });
    }
}
#[tokio::test]
async fn every_builtin_delete_requires_fresh_identity_and_cancel_never_deletes() {
    for kind in kubiki_core::core::api::resource_types() {
        for approve in [false, true] {
            let namespace = if kind.namespaced { Some("team") } else { None };
            let version = if kind.group.is_empty() {
                kind.version.clone()
            } else {
                format!("{}/{}", kind.group, kind.version)
            };
            let current = json!({"apiVersion":version,"kind":kind.kind,"metadata":{"name":"web","namespace":namespace,"uid":"original","resourceVersion":"10"}});
            let f = fixture(Some(current), 200);
            let resource: ResourceRef = serde_json::from_value(json!({"context":"prod","group":kind.group,"version":kind.version,"kind":kind.kind,"namespace":namespace,"name":"web","uid":"original"})).unwrap();
            let plan = PreparedMutation::prepare(
                f.client,
                MutationIntent::Delete {
                    resource,
                    resource_version: "10".into(),
                },
            )
            .await
            .unwrap();
            let result = plan
                .confirm_and_commit(|review| async move {
                    assert!(review.contains("DELETE") && review.contains("original"));
                    Ok(approve)
                })
                .await;
            let w = writes(&f.requests);
            assert_eq!(w.len(), usize::from(approve), "{}", kind.kind);
            assert_eq!(result.is_ok(), approve);
            if approve {
                assert_eq!(w[0].0, "DELETE");
                assert_eq!(
                    w[0].2["preconditions"],
                    json!({"uid":"original","resourceVersion":"10"})
                );
            }
        }
    }
}
