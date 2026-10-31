//! Per-run transport budgets. Writes and their receipts are never dropped here.
use http_body::Body as HttpBody;
use kube::{Client, client::Body};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

pub struct ReadBudget {
    calls: AtomicUsize,
    bytes: AtomicUsize,
    max_calls: usize,
    max_bytes: usize,
    response_bytes: usize,
    deadline: std::sync::Mutex<tokio::time::Instant>,
}
fn exceeded(message: &str) -> kube::Error {
    kube::Error::Api(kube::error::ErrorResponse {
        status: "Failure".into(),
        code: 429,
        reason: "ReadBudgetExceeded".into(),
        message: message.into(),
    })
}
fn charge(counter: &AtomicUsize, amount: usize, maximum: usize) -> bool {
    let mut current = counter.load(Ordering::SeqCst);
    loop {
        let Some(next) = current.checked_add(amount).filter(|next| *next <= maximum) else {
            return false;
        };
        match counter.compare_exchange_weak(current, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return true,
            Err(value) => current = value,
        }
    }
}
impl ReadBudget {
    pub fn new(
        max_calls: usize,
        max_bytes: usize,
        response_bytes: usize,
        duration: Duration,
    ) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            bytes: AtomicUsize::new(0),
            max_calls,
            max_bytes,
            response_bytes,
            deadline: std::sync::Mutex::new(tokio::time::Instant::now() + duration),
        }
    }
    fn deadline(&self) -> tokio::time::Instant {
        *self.deadline.lock().unwrap()
    }
    pub fn exclude_approval_wait(&self, wait: Duration) {
        *self.deadline.lock().unwrap() += wait;
    }
    pub fn expired(&self) -> bool {
        tokio::time::Instant::now() >= self.deadline()
    }
    pub fn stats(&self) -> serde_json::Value {
        serde_json::json!({"httpGetAttempts":self.requests(),"requestLimit":self.max_calls,"bodyBytes":self.bytes(),"byteLimit":self.max_bytes,"remainingMs":self.deadline().saturating_duration_since(tokio::time::Instant::now()).as_millis()})
    }
    pub fn requests(&self) -> usize {
        self.calls.load(Ordering::Relaxed)
    }
    pub fn bytes(&self) -> usize {
        self.bytes.load(Ordering::Relaxed)
    }
    pub fn wrap(self: &Arc<Self>, client: Client) -> Client {
        let namespace = client.default_namespace().to_owned();
        let budget = self.clone();
        Client::new(
            tower::service_fn(move |request: http::Request<Body>| {
                let client = client.clone();
                let budget = budget.clone();
                async move {
                    if request.method() != http::Method::GET {
                        return client.send(request).await;
                    }
                    tokio::time::timeout_at(budget.deadline(), async move {
                    let uri=request.uri().clone();
                    let headers=request.headers().clone();
                    let version=request.version();
                    let mut attempt=0;
                    let response=loop {
                        if budget.expired() {return Err(exceeded("AI Kubernetes read deadline exhausted"));}
                        if !charge(&budget.calls,1,budget.max_calls) {return Err(exceeded("AI Kubernetes read request budget exhausted"));}
                        let mut request=http::Request::builder().method(http::Method::GET).uri(uri.clone()).version(version).body(Body::empty()).unwrap();
                        *request.headers_mut()=headers.clone();
                        let response=client.send(request).await?;
                        if attempt==0 && matches!(response.status().as_u16(),429|503) {
                            let delay=match response.headers().get(http::header::RETRY_AFTER) {
                                Some(value)=>value.to_str().ok().and_then(|v|v.parse::<u64>().ok()).filter(|n|*n<=1).map(Duration::from_secs),
                                None=>Some(Duration::from_millis(100+(budget.requests() as u64%3)*37)),
                            };
                            if let Some(delay)=delay {
                                drop(response);
                                attempt+=1;
                                tokio::time::sleep(delay).await;
                                continue;
                            }
                        }
                        break response;
                    };
                    let (parts, mut body) = response.into_parts();
                    let mut bytes = Vec::new();
                    while let Some(frame) = futures::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_frame(cx)).await {
                        if let Ok(chunk) = frame?.into_data() {
                            if bytes.len().saturating_add(chunk.len()) > budget.response_bytes { return Err(exceeded("AI Kubernetes response exceeds byte budget; narrow fields/selectors or page size")); }
                            if !charge(&budget.bytes, chunk.len(), budget.max_bytes) { return Err(exceeded("AI Kubernetes total byte budget exhausted")); }
                            bytes.extend_from_slice(&chunk);
                        }
                    }
                    Ok(http::Response::from_parts(parts, Body::from(bytes)))
                }).await.map_err(|_| exceeded("AI Kubernetes read deadline exhausted"))?
                }
            }),
            namespace,
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn client() -> Client {
        Client::new(
            tower::service_fn(|_: http::Request<Body>| async {
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(200)
                        .body(Body::from(vec![b'x'; 20]))
                        .unwrap(),
                )
            }),
            "default",
        )
    }
    #[tokio::test]
    async fn human_approval_wait_does_not_expire_the_read_deadline_or_expand_request_caps() {
        let budget = ReadBudget::new(1, 100, 100, Duration::ZERO);
        assert!(budget.expired());
        budget.exclude_approval_wait(Duration::from_secs(3600));
        assert!(!budget.expired());
        assert_eq!(budget.stats()["requestLimit"], 1);
        assert_eq!(budget.requests(), 0);
    }
    #[tokio::test]
    async fn request_byte_and_response_caps_apply_to_reads_only() {
        let budget = Arc::new(ReadBudget::new(1, 100, 100, Duration::from_secs(1)));
        let client = budget.wrap(client());
        let request = || {
            http::Request::builder()
                .uri("/api")
                .body(Body::empty())
                .unwrap()
        };
        assert!(client.send(request()).await.is_ok());
        assert!(client.send(request()).await.is_err());
        assert!(
            client
                .send(
                    http::Request::builder()
                        .method("PATCH")
                        .uri("/api")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .is_ok()
        );
        assert_eq!(budget.requests(), 1);
        assert_eq!(budget.bytes(), 20);
        for (total, response) in [(10, 100), (100, 10)] {
            let budget = Arc::new(ReadBudget::new(5, total, response, Duration::from_secs(1)));
            assert!(
                budget
                    .wrap(super::tests::client())
                    .send(request())
                    .await
                    .is_err()
            );
        }
    }
    #[tokio::test]
    async fn retries_transient_reads_once_and_never_retries_denials() {
        for status in [429, 503, 403] {
            let seen = Arc::new(AtomicUsize::new(0));
            let count = seen.clone();
            let client = Client::new(
                tower::service_fn(move |_: http::Request<Body>| {
                    let first = count.fetch_add(1, Ordering::SeqCst) == 0;
                    async move {
                        Ok::<_, std::convert::Infallible>(
                            http::Response::builder()
                                .status(if first { status } else { 200 })
                                .header("retry-after", "0")
                                .body(Body::empty())
                                .unwrap(),
                        )
                    }
                }),
                "default",
            );
            let budget = Arc::new(ReadBudget::new(3, 100, 100, Duration::from_secs(1)));
            let response = budget
                .wrap(client)
                .send(
                    http::Request::builder()
                        .uri("/api")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status().as_u16(),
                if status == 403 { 403 } else { 200 }
            );
            assert_eq!(
                seen.load(Ordering::SeqCst),
                if status == 403 { 1 } else { 2 }
            );
        }
    }
}
