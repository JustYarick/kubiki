use kube::{Client, client::Body};
use kubiki_core::core::{
    api::ResourceRef,
    drain::expand_drain,
    mutations::{
        BatchIntent, MutationIntent, PreparedBatch, PreparedMutation, ResourceAction,
        ResourcePrecondition, ReviewKind,
    },
    reads,
};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
};
fn node_ref() -> ResourceRef {
    serde_json::from_value(json!({"context":"test","group":"","version":"v1","kind":"Node","namespace":null,"name":"worker","uid":"node-uid"})).unwrap()
}
fn node() -> Value {
    json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"worker","uid":"node-uid","resourceVersion":"10"},"spec":{"unschedulable":true}})
}
fn pod(name: &str) -> Value {
    json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":name,"namespace":"team","uid":format!("uid-{name}"),"resourceVersion":"20"},"spec":{"nodeName":"worker"},"status":{"phase":"Running"}})
}
struct Fixture {
    client: Client,
    node: Arc<Mutex<Value>>,
    requests: Arc<Mutex<Vec<String>>>,
}
fn fixture() -> Fixture {
    let state = Arc::new(Mutex::new(node()));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let (shared, captured) = (state.clone(), requests.clone());
    let service = tower::service_fn(move |request: http::Request<Body>| {
        let (state, requests) = (shared.clone(), captured.clone());
        async move {
            let method = request.method().clone();
            let path = request.uri().path().to_string();
            requests
                .lock()
                .unwrap()
                .push(format!("{} {}", method, request.uri()));
            let response = if path.ends_with("/nodes/worker") {
                state.lock().unwrap().clone()
            } else if path.ends_with("/pods") {
                json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":[pod("web")]})
            } else if path.ends_with("/eviction") {
                json!({"apiVersion":"v1","kind":"Status","status":"Success"})
            } else {
                pod(path.rsplit('/').next().unwrap())
            };
            Ok::<_, Infallible>(http::Response::new(Body::from(
                response.to_string().into_bytes(),
            )))
        }
    });
    Fixture {
        client: Client::new(service, "team"),
        node: state,
        requests,
    }
}
#[tokio::test]
async fn drain_refuses_a_recreated_or_changed_already_cordoned_node_before_listing_pods() {
    for field in ["uid", "resourceVersion"] {
        let f = fixture();
        f.node.lock().unwrap()["metadata"][field] = json!("replacement");
        let error = expand_drain(&f.client, node_ref(), "10".into(), true)
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, Some(409));
        assert_eq!(f.requests.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn drain_reads_only_its_node_and_rechecks_the_source_after_confirmation() {
    let f = fixture();
    let primary = node_ref();
    let condition = ResourcePrecondition::prepare(f.client.clone(), primary.clone(), "10".into())
        .await
        .unwrap();
    let intents = expand_drain(&f.client, primary.clone(), "10".into(), true)
        .await
        .unwrap();
    assert!(
        f.requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("fieldSelector=spec.nodeName%3Dworker"))
    );
    let batch = PreparedBatch::prepare(f.client, primary, intents)
        .await
        .unwrap()
        .with_preconditions(vec![condition]);
    let state = f.node.clone();
    let error = batch
        .confirm_and_commit(|_| async move {
            state.lock().unwrap()["metadata"]["uid"] = json!("replacement");
            Ok(true)
        })
        .await
        .unwrap_err();
    assert_eq!(error.status, Some(409));
    assert!(
        f.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET "))
    );
}
#[tokio::test]
async fn large_batch_reviews_keep_every_target_without_generated_diffs() {
    let f = fixture();
    let targets: Vec<_> = (0..200)
        .map(|n| format!("pod-{n}-{}", "x".repeat(180)))
        .collect();
    let steps = targets
        .iter()
        .map(|name| {
            let mut resource = node_ref();
            resource.query.kind = "Pod".into();
            resource.query.namespace = Some("team".into());
            resource.name = name.clone();
            resource.uid = Some(format!("uid-{name}"));
            BatchIntent::new(MutationIntent::Delete {
                resource,
                resource_version: "20".into(),
            })
        })
        .collect();
    let batch = PreparedBatch::prepare(f.client, node_ref(), steps)
        .await
        .unwrap();
    let details = batch.details();
    assert_eq!(details.kind, ReviewKind::Batch);
    assert_eq!(details.steps.len(), targets.len());
    for (step, name) in details.steps.iter().zip(&targets) {
        assert_eq!(&step.resource.name, name);
        assert!(step.diff.is_none());
        assert!(batch.review().contains(name));
    }
    assert!(!batch.review().contains("truncated"));
    assert!(
        f.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET "))
    );
}
#[tokio::test]
async fn action_cannot_be_applied_to_a_custom_kind_with_the_same_name() {
    let f = fixture();
    let mut target = node_ref();
    target.query.group = "example.org".into();
    assert!(
        PreparedMutation::prepare(
            f.client,
            MutationIntent::Action {
                resource: target,
                resource_version: "10".into(),
                action: ResourceAction::Cordon {
                    unschedulable: false
                }
            }
        )
        .await
        .is_err()
    );
    assert!(
        f.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET "))
    );
}
#[tokio::test]
async fn native_snapshot_reads_use_kubernetes_api_and_paginate() {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let calls = captured.clone();
    let service = tower::service_fn(move |request: http::Request<Body>| {
        let calls = calls.clone();
        async move {
            let mut calls = calls.lock().unwrap();
            calls.push(request.uri().to_string());
            let first = calls.len() == 1;
            let response = json!({"apiVersion":"v1","kind":"PodList","metadata":{"continue":if first{"page-2"}else{""}},"items":[pod(if first{"one"}else{"two"})]});
            Ok::<_, Infallible>(http::Response::new(Body::from(
                response.to_string().into_bytes(),
            )))
        }
    });
    let mut query = node_ref().query;
    query.kind = "Pod".into();
    query.namespace = Some("team".into());
    let result = reads::resources(Client::new(service, "team"), query)
        .await
        .unwrap();
    assert_eq!(result["items"].as_array().unwrap().len(), 2);
    let calls = captured.lock().unwrap();
    assert!(calls[0].starts_with("/api/v1/namespaces/team/pods?"));
    assert!(calls[1].contains("continue=page-2"));
}
