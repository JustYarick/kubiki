//! Authorization can be revoked during commit's final live read. No cluster or
//! kubeconfig is used: the service records every actual mutation request.
use kube::{Client, client::Body};
use kubiki_core::core::{
    api::ResourceRef,
    mutations::{MutationIntent, PreparedMutation, cancelled},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[tokio::test]
async fn revocation_during_final_reads_prevents_create_and_update_dispatch() {
    for creation in [true, false] {
        let revoked = Arc::new(AtomicBool::new(false));
        let reads = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(AtomicUsize::new(0));
        let (r, rs, w) = (revoked.clone(), reads.clone(), writes.clone());
        let service = tower::service_fn(move |req: http::Request<Body>| {
            let (revoked, reads, writes) = (r.clone(), rs.clone(), w.clone());
            async move {
                let (status, body) = if req.method() == http::Method::GET {
                    if reads.fetch_add(1, Ordering::SeqCst) > 0 {
                        revoked.store(true, Ordering::SeqCst);
                    }
                    if creation {
                        (
                            404,
                            json!({"apiVersion":"v1","kind":"Status","status":"Failure","code":404,"reason":"NotFound"}),
                        )
                    } else {
                        (
                            200,
                            json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"apps","uid":"original","resourceVersion":"1"},"spec":{"replicas":1}}),
                        )
                    }
                } else {
                    writes.fetch_add(1, Ordering::SeqCst);
                    (200, json!({}))
                };
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(status)
                        .body(Body::from(body.to_string().into_bytes()))
                        .unwrap(),
                )
            }
        });
        let client = Client::new(service, "apps");
        let resource:ResourceRef=serde_json::from_value(json!({"context":"prod","group":"apps","version":"v1","kind":"Deployment","namespace":"apps","name":"web","uid":"original"})).unwrap();
        let intent = if creation {
            MutationIntent::Manifest {context:"prod".into(),manifest:json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"apps"},"spec":{"replicas":1}}).to_string(),target:None}
        } else {
            MutationIntent::Scale {
                resource: resource.clone(),
                resource_version: "1".into(),
                replicas: 2,
            }
        };
        let prepared = PreparedMutation::prepare(client, intent).await.unwrap();
        assert!(!revoked.load(Ordering::SeqCst));
        let result = prepared
            .commit_guarded(|| {
                assert!(
                    revoked.load(Ordering::SeqCst),
                    "authorization must run after the final read"
                );
                Err(cancelled(&resource, "AI mode changed"))
            })
            .await;
        assert!(result.is_err());
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        assert!(reads.load(Ordering::SeqCst) >= 2);
    }
}

#[tokio::test]
async fn guarded_scale_keeps_resource_version_preconditions_when_authorized() {
    let write = Arc::new(std::sync::Mutex::new(Value::Null));
    let retained = write.clone();
    let service = tower::service_fn(move |req: http::Request<Body>| {
        let retained = retained.clone();
        async move {
            if req.method() != http::Method::GET {
                *retained.lock().unwrap() =
                    serde_json::from_slice(&req.into_body().collect_bytes().await.unwrap())
                        .unwrap();
            }
            Ok::<_,std::convert::Infallible>(http::Response::new(Body::from(json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"apps","uid":"original","resourceVersion":"1"},"spec":{"replicas":1}}).to_string().into_bytes())))
        }
    });
    let resource:ResourceRef=serde_json::from_value(json!({"context":"prod","group":"apps","version":"v1","kind":"Deployment","namespace":"apps","name":"web","uid":"original"})).unwrap();
    PreparedMutation::prepare(
        Client::new(service, "apps"),
        MutationIntent::Scale {
            resource,
            resource_version: "1".into(),
            replicas: 2,
        },
    )
    .await
    .unwrap()
    .commit_guarded(|| Ok(()))
    .await
    .unwrap();
    assert_eq!(
        *write.lock().unwrap(),
        json!({"metadata":{"uid":"original","resourceVersion":"1"},"spec":{"replicas":2}})
    );
}
