//! One-shot log slices: validation, UID/container preconditions, bounded reads.
//! Read/write HTTP fixtures only: these tests never use kubeconfig or a live cluster.
use kube::{Client, client::Body};
use kubiki_core::pod_ops::logs::LogSliceRequest;
use serde_json::json;
use std::sync::{Arc, Mutex};

fn slice() -> LogSliceRequest {
    serde_json::from_value(json!({
        "resource": {"context":"test","group":"","version":"v1","kind":"Pod","namespace":"backend","name":"web","uid":"uid"},
        "container": "app",
        "previous": false,
        "tail_lines": 100,
        "since_seconds": 300
    }))
    .unwrap()
}
fn pod(uid: &str) -> String {
    json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"web","namespace":"backend","uid":uid},"spec":{"containers":[{"name":"app","image":"test"}]}}).to_string()
}
struct Fixture {
    client: Client,
    requests: Arc<Mutex<Vec<(String, String)>>>,
}
async fn fixture(pod_uid: &str, log_status: u16) -> Fixture {
    let requests: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let r = requests.clone();
    let pod_uid = pod_uid.to_string();
    let service = tower::service_fn(move |request: http::Request<Body>| {
        let requests = r.clone();
        let (pod_uid, log_status) = (pod_uid.clone(), log_status);
        async move {
            let method = request.method().to_string();
            let uri = request.uri().to_string();
            requests.lock().unwrap().push((method, uri.clone()));
            let (status, body) = if uri.contains("/log?") {
                if log_status >= 400 {
                    (
                        log_status,
                        json!({"kind":"Status","apiVersion":"v1","status":"Failure","code":log_status,"reason":"Forbidden","message":"pods/log denied"}).to_string(),
                    )
                } else {
                    (200, "2026-10-20T08:00:00Z привет 🌍\n".into())
                }
            } else {
                (200, pod(&pod_uid))
            };
            Ok::<_, std::convert::Infallible>(
                http::Response::builder()
                    .status(status)
                    .body(Body::from(body.into_bytes()))
                    .unwrap(),
            )
        }
    });
    Fixture {
        client: Client::new(service, "backend"),
        requests,
    }
}
#[tokio::test]
async fn slice_requests_xxx_urls_and_returns_the_text() {
    let f = fixture("uid", 200).await;
    let text = slice().read(f.client.clone()).await.unwrap();
    assert_eq!(text, "2026-10-20T08:00:00Z привет 🌍\n");
    let requests = f.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].0, "GET");
    assert_eq!(requests[0].1, "/api/v1/namespaces/backend/pods/web");
    let url = &requests[1].1;
    for value in ["/pods/web/log?", "container=app", "tailLines=100", "sinceSeconds=300", "timestamps=true", "limitBytes=4194304"] {
        assert!(url.contains(value), "{url} misses {value}");
    }
    assert!(!url.contains("previous=true") && !url.contains("sinceTime"));
}
#[tokio::test]
async fn since_time_is_sent_and_previous_marks_the_snapshot() {
    let f = fixture("uid", 200).await;
    let mut request = slice();
    request.tail_lines = None;
    request.since_seconds = None;
    request.since_time = Some("2026-10-20T08:00:00Z".into());
    request.previous = true;
    let _ = request.read(f.client.clone()).await.unwrap();
    let url = &f.requests.lock().unwrap()[1].1;
    assert!(url.contains("sinceTime=2026-10-20T08%3A00%3A00Z"), "{url}");
    assert!(url.contains("previous=true"));
    assert!(!url.contains("tailLines"), "{url}");
}
#[tokio::test]
async fn recreated_pod_and_forbidden_logs_keep_the_api_status() {
    // Success case for contrast, then the two honest failure surfaces.
    let f = fixture("uid", 200).await;
    slice().read(f.client).await.unwrap();
    let f = fixture("uid", 403).await;
    let error = slice().read(f.client).await.unwrap_err();
    assert_eq!(error.status, Some(403));
    assert_eq!(error.message, "pods/log denied");
    let f = fixture("new-uid", 200).await;
    let error = slice().read(f.client).await.unwrap_err();
    assert_eq!(error.status, Some(409));
    assert_eq!(error.message, "Pod was recreated; open the current Pod to read its logs");
    let f = fixture("uid", 200).await;
    let mut foreign = slice();
    foreign.container = "sidecar".into();
    let error = foreign.read(f.client).await.unwrap_err();
    assert_eq!(error.status, Some(400));
    assert_eq!(error.message, "Container does not belong to the selected Pod");
}
#[tokio::test]
async fn validation_rejects_bad_identities_windows_and_conflicts() {
    fn base() -> kubiki_core::core::api::ResourceRef {
        serde_json::from_value(json!({"context":"test","group":"","version":"v1","kind":"Pod","namespace":"backend","name":"web","uid":"uid"})).unwrap()
    }
    let broken: Vec<(LogSliceRequest, &str)> = vec![
        (LogSliceRequest { resource: base(), container: "app".into(), previous: false, tail_lines: None, since_time: None, since_seconds: None }, "baseline"),
        (LogSliceRequest { resource: serde_json::from_value(json!({"context":"test","group":"","version":"v1","kind":"Deployment","namespace":"backend","name":"web","uid":"uid"})).unwrap(), container: "app".into(), previous: false, tail_lines: None, since_time: None, since_seconds: None }, "kind"),
        (LogSliceRequest { resource: serde_json::from_value(json!({"context":"test","group":"","version":"v1","kind":"Pod","namespace":null,"name":"web","uid":"uid"})).unwrap(), container: "app".into(), previous: false, tail_lines: None, since_time: None, since_seconds: None }, "namespace"),
        (LogSliceRequest { resource: serde_json::from_value(json!({"context":"test","group":"","version":"v1","kind":"Pod","namespace":"backend","name":"web","uid":null})).unwrap(), container: "app".into(), previous: false, tail_lines: None, since_time: None, since_seconds: None }, "uid"),
        (LogSliceRequest { resource: base(), container: "App A".into(), previous: false, tail_lines: None, since_time: None, since_seconds: None }, "container"),
        (LogSliceRequest { resource: base(), container: "app".into(), previous: false, tail_lines: Some(10001), since_time: None, since_seconds: None }, "tail"),
        (LogSliceRequest { resource: base(), container: "app".into(), previous: false, tail_lines: None, since_time: None, since_seconds: Some(604801) }, "since"),
        (LogSliceRequest { resource: base(), container: "app".into(), previous: false, tail_lines: None, since_time: Some("2026-01-01T00:00:00Z".into()), since_seconds: Some(5) }, "exclusive"),
        (LogSliceRequest { resource: base(), container: "app".into(), previous: false, tail_lines: None, since_time: Some("not-a-time".into()), since_seconds: None }, "since_time"),
    ];
    // The first row documents the valid baseline; every other row must fail.
    let [baseline, rest @ ..] = &broken[..] else { unreachable!() };
    assert!(baseline.0.validate().is_ok(), "{}", baseline.1);
    for (request, label) in rest {
        assert!(request.validate().is_err(), "{label} must be rejected");
    }
    // A resumed poll carries only sinceTime; that shape stays valid.
    let resumed = LogSliceRequest { resource: base(), container: "app".into(), previous: false, tail_lines: None, since_time: Some("2026-01-01T00:00:00Z".into()), since_seconds: None };
    resumed.validate().unwrap();
}
