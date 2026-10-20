use kube::{Client, client::Body};
use kubiki_core::core::secret_data::{SecretDataRequest, update_secret_data};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
fn request() -> SecretDataRequest {
    serde_json::from_value(json!({"resource":{"context":"test","group":"","version":"v1","kind":"Secret","namespace":"backend","name":"credentials","uid":"uid"},"resource_version":"10","data":{"password":"0J/RgNC40LLQtdGC","binary":"/wAB","empty":""}})).unwrap()
}
fn secret() -> Value {
    json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"credentials","namespace":"backend","uid":"uid","resourceVersion":"10","annotations":{"keep":"yes"}},"type":"Opaque","data":{"old":"b2xk"}})
}
fn api(current: Value, failure: u16) -> (Client, Arc<Mutex<Vec<Value>>>) {
    let writes = Arc::new(Mutex::new(vec![]));
    let captured = writes.clone();
    let service = tower::service_fn(move |req: http::Request<Body>| {
        let current = current.clone();
        let writes = captured.clone();
        async move {
            assert_eq!(
                req.uri().path(),
                "/api/v1/namespaces/backend/secrets/credentials"
            );
            let mut status = 200;
            let body = if req.method() == http::Method::GET {
                current
            } else {
                assert_eq!(req.method(), http::Method::PUT);
                let value: Value =
                    serde_json::from_slice(&req.into_body().collect_bytes().await.unwrap())
                        .unwrap();
                writes.lock().unwrap().push(value.clone());
                if failure > 0 {
                    status = failure;
                    json!({"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Conflict","message":"sensitive-value-from-server","code":failure})
                } else {
                    value
                }
            };
            Ok::<_, std::convert::Infallible>(
                http::Response::builder()
                    .status(status)
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
        }
    });
    (Client::new(service, "backend"), writes)
}
#[tokio::test]
async fn updates_only_data_preserves_metadata_and_puts_atomic_uid_and_version() {
    let (client, writes) = api(secret(), 0);
    let request = request();
    update_secret_data(client, request.clone(), |_| async { Ok(true) })
        .await
        .unwrap();
    let writes = writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0]["data"],
        serde_json::to_value(request.data).unwrap()
    );
    assert_eq!(writes[0]["metadata"], secret()["metadata"]);
    assert_eq!(writes[0]["type"], "Opaque");
}
#[tokio::test]
async fn refuses_stale_recreated_immutable_and_invalid_requests_without_writes() {
    {
        let mut current = secret();
        current["metadata"]["resourceVersion"] = json!("11");
        let (client, writes) = api(current, 0);
        assert_eq!(
            update_secret_data(client, request(), |_| async { Ok(true) })
                .await
                .unwrap_err()
                .status,
            Some(409)
        );
        assert!(writes.lock().unwrap().is_empty());
    }
    let mut current = secret();
    current["metadata"]["uid"] = json!("replacement");
    let (client, writes) = api(current, 0);
    assert_eq!(
        update_secret_data(client, request(), |_| async { Ok(true) })
            .await
            .unwrap_err()
            .status,
        Some(409)
    );
    assert!(writes.lock().unwrap().is_empty());
    let mut current = secret();
    current["immutable"] = json!(true);
    let (client, writes) = api(current, 0);
    assert_eq!(
        update_secret_data(client, request(), |_| async { Ok(true) })
            .await
            .unwrap_err()
            .status,
        Some(422)
    );
    assert!(writes.lock().unwrap().is_empty());
    for (key, value) in [("bad/key", ""), ("ok", "!"), ("ok", "Zh==")] {
        let mut req = request();
        req.data.insert(key.into(), value.into());
        assert!(req.validate().is_err());
    }
    let mut req = request();
    req.data.insert("large".into(), "YWFh".repeat(350000));
    assert!(req.validate().is_err());
}
#[tokio::test]
async fn preserves_rbac_and_race_status_without_leaking_server_values() {
    for status in [403, 409, 422] {
        let (client, _) = api(secret(), status);
        let error = update_secret_data(client, request(), |_| async { Ok(true) })
            .await
            .unwrap_err();
        assert_eq!(error.status, Some(status));
        assert!(!error.message.contains("sensitive"));
    }
}
