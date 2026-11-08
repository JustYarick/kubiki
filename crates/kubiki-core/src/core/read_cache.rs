//! Per-connection/run discovery cache and in-flight GET coalescing.
//! Ordinary sequential resource reads are always fresh; writes clear all entries.
use kube::{Client, client::Body};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;
struct Cached {
    at: Instant,
    status: http::StatusCode,
    headers: http::HeaderMap,
    bytes: Vec<u8>,
}
#[derive(Default)]
pub struct ReadCache {
    entries: Mutex<VecDeque<(String, Arc<AsyncMutex<Option<Cached>>>)>>,
}
impl ReadCache {
    pub fn wrap(self: &Arc<Self>, client: Client) -> Client {
        let namespace = client.default_namespace().to_owned();
        let cache = self.clone();
        Client::new(
            tower::service_fn(move |request: http::Request<Body>| {
                let client = client.clone();
                let cache = cache.clone();
                async move {
                    if request.method() != http::Method::GET {
                        cache.entries.lock().unwrap().clear();
                        return client.send(request).await;
                    }
                    let uri = request.uri().to_string();
                    if uri.contains("watch=true") || request.uri().path().ends_with("/log") {
                        return client.send(request).await;
                    }
                    let requested_at = Instant::now();
                    let discovery = matches!(request.uri().path(), "/api" | "/apis")
                        || (request.uri().path().starts_with("/apis/")
                            && request.uri().path().split('/').count() <= 4)
                        || request.uri().path() == "/api/v1";
                    let key = format!("{} {:?}", uri, request.headers().get("accept"));
                    let slot = {
                        let mut entries = cache.entries.lock().unwrap();
                        if let Some((_, slot)) = entries.iter().find(|(k, _)| *k == key) {
                            slot.clone()
                        } else {
                            // At most 32 cached responses of 128 KiB, plus current bounded reads.
                            if entries.len() >= 32 {
                                entries.pop_front();
                            }
                            let slot = Arc::new(AsyncMutex::new(None));
                            entries.push_back((key, slot.clone()));
                            slot
                        }
                    };
                    let mut stored = slot.lock().await;
                    if let Some(cached) = stored.as_ref() {
                        if (discovery && cached.at.elapsed() < Duration::from_secs(60))
                            || cached.at >= requested_at
                        {
                            let mut response = http::Response::builder()
                                .status(cached.status)
                                .body(Body::from(cached.bytes.clone()))
                                .unwrap();
                            *response.headers_mut() = cached.headers.clone();
                            return Ok(response);
                        }
                    }
                    let response = client.send(request).await?;
                    if !response.status().is_success() {
                        return Ok(response);
                    }
                    let (parts, body) = response.into_parts();
                    // The caller wraps the transport in ReadBudget before this layer.
                    let bytes = body.collect_bytes().await?;
                    if bytes.len() <= 128 * 1024 {
                        *stored = Some(Cached {
                            at: Instant::now(),
                            status: parts.status,
                            headers: parts.headers.clone(),
                            bytes: bytes.to_vec(),
                        });
                    } else {
                        *stored = None;
                    }
                    Ok(http::Response::from_parts(parts, Body::from(bytes)))
                }
            }),
            namespace,
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    async fn coalesces_simultaneous_reads_but_refreshes_resources_and_invalidates_on_write() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let client = Client::new(
            tower::service_fn(move |_: http::Request<Body>| {
                let calls = seen.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    Ok::<_, std::convert::Infallible>(http::Response::new(Body::from(
                        b"{}".to_vec(),
                    )))
                }
            }),
            "default",
        );
        let client = Arc::new(ReadCache::default()).wrap(client);
        let request = |path: &str| {
            http::Request::builder()
                .uri(path)
                .body(Body::empty())
                .unwrap()
        };
        let (a, b) = tokio::join!(
            client.send(request("/api/v1/pods")),
            client.send(request("/api/v1/pods"))
        );
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        client.send(request("/api/v1/pods")).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        client.send(request("/api/v1")).await.unwrap();
        client.send(request("/api/v1")).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        client
            .send(
                http::Request::builder()
                    .method("PATCH")
                    .uri("/api/v1/pods/web")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        client.send(request("/api/v1")).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 5);
    }
}
