//! Loopback-only authenticated Streamable HTTP transport for persistent desktop MCP access.
use bytes::Bytes;
use http::{HeaderMap, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::service::service_fn;
use hyper_util::{
    rt::{TokioExecutor, TokioIo},
    server::conn::auto::Builder as ConnBuilder,
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use std::{convert::Infallible, net::SocketAddr, sync::Arc};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

type HttpBody = BoxBody<Bytes, Infallible>;

pub fn generate_bearer_token() -> String {
    format!(
        "kubiki_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub struct HttpMcpServer {
    pub port: u16,
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl HttpMcpServer {
    pub async fn shutdown(mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), task).await;
        }
    }
}

impl Drop for HttpMcpServer {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn authorized(headers: &HeaderMap, expected_token: &str) -> bool {
    let Some(value) = headers.get(header::AUTHORIZATION) else {
        return false;
    };
    let Ok(text) = value.to_str() else {
        return false;
    };
    let Some(supplied) = text.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(supplied.as_bytes(), expected_token.as_bytes())
}

fn json_error(status: StatusCode, message: &str) -> Response<HttpBody> {
    let body = serde_json::json!({ "error": message }).to_string();
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body)).boxed())
        .unwrap()
}

pub async fn start_http(
    port: u16,
    token: Option<String>,
    factory: Arc<dyn Fn() -> crate::ClusterServer + Send + Sync>,
) -> Result<HttpMcpServer, String> {
    if let Some(ref t) = token {
        if t.len() < 32 {
            return Err("MCP HTTP bearer token is too short".into());
        }
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Cannot listen on {addr}: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    let cancel = CancellationToken::new();
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts([
            format!("127.0.0.1:{local_port}"),
            format!("localhost:{local_port}"),
            "127.0.0.1".into(),
            "localhost".into(),
        ])
        .enforce_origin_validation();
    let mut config = config;
    config.cancellation_token = cancel.child_token();

    let service = StreamableHttpService::new(
        move || Ok(factory()),
        Arc::new(LocalSessionManager::default()),
        config,
    );

    let accept_cancel = cancel.clone();
    let token = token.map(Arc::new);
    let task = tokio::spawn(async move {
        let permits = Arc::new(Semaphore::new(32));
        loop {
            let accepted = tokio::select! {
                biased;
                _ = accept_cancel.cancelled() => break,
                res = listener.accept() => res,
            };
            let Ok((stream, _)) = accepted else {
                break;
            };
            let Ok(permit) = permits.clone().try_acquire_owned() else {
                continue;
            };
            let service = service.clone();
            let token = token.clone();
            let conn_cancel = accept_cancel.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let io = TokioIo::new(stream);
                let svc = service_fn(move |req: Request<hyper::body::Incoming>| {
                    let service = service.clone();
                    let token = token.clone();
                    async move {
                        if req.uri().path() != "/mcp" {
                            return Ok::<_, Infallible>(json_error(
                                StatusCode::NOT_FOUND,
                                "Not found",
                            ));
                        }
                        if req.headers().contains_key(header::ORIGIN) {
                            return Ok(json_error(
                                StatusCode::FORBIDDEN,
                                "Browser cross-origin requests are not allowed",
                            ));
                        }
                        if let Some(ref expected) = token {
                            if !authorized(req.headers(), expected) {
                                return Ok(json_error(StatusCode::UNAUTHORIZED, "Unauthorized"));
                            }
                        }
                        Ok(service.handle(req).await)
                    }
                });
                let builder = ConnBuilder::new(TokioExecutor::new());
                let conn = builder.serve_connection_with_upgrades(io, svc);
                tokio::pin!(conn);
                tokio::select! {
                    _ = conn_cancel.cancelled() => {
                        conn.as_mut().graceful_shutdown();
                        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), &mut conn).await;
                    }
                    _ = &mut conn => {}
                }
            });
        }
    });

    Ok(HttpMcpServer {
        port: local_port,
        cancel,
        task: Some(task),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kubiki_tools::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct EchoExecutor;
    #[async_trait::async_trait]
    impl ToolExecutor for EchoExecutor {
        async fn execute(
            &self,
            _session: &Session,
            call: &ToolCall,
            _emit: &EventSink,
        ) -> Result<serde_json::Value, String> {
            Ok(json!({ "ok": true, "tool": call.name }))
        }
    }

    fn test_server() -> crate::ClusterServer {
        let session = Session::new(
            "http-test".into(),
            "desktop".into(),
            AgentScope::default(),
            AgentPolicy::default(),
            ClusterCapabilities::default(),
        );
        crate::ClusterServer::new(session, Arc::new(EchoExecutor), Arc::new(|_| {}), true)
    }

    async fn raw_http(port: u16, request: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; 8192];
        let mut out = Vec::new();
        loop {
            let n = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                stream.read(&mut buf),
            )
            .await;
            match n {
                Ok(Ok(0)) | Err(_) => break,
                Ok(Ok(n)) => out.extend_from_slice(&buf[..n]),
                Ok(Err(e)) => panic!("read error: {e}"),
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    #[tokio::test]
    async fn enforces_bearer_auth_origin_host_path_and_serves_mcp() {
        let token = "kubiki_0123456789abcdef0123456789abcdef".to_owned();
        let server = start_http(0, Some(token.clone()), Arc::new(test_server))
            .await
            .unwrap();
        let port = server.port;

        // 1. Missing token -> 401
        let unauth = raw_http(
            port,
            &format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"),
        )
        .await;
        assert!(unauth.starts_with("HTTP/1.1 401"), "got: {unauth}");

        // 2. Wrong token -> 401
        let wrong = raw_http(
            port,
            &format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer wrong_token_value\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"),
        )
        .await;
        assert!(wrong.starts_with("HTTP/1.1 401"), "got: {wrong}");

        // 3. Origin header -> 403
        let origin = raw_http(
            port,
            &format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nOrigin: http://evil.example\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"),
        )
        .await;
        assert!(origin.starts_with("HTTP/1.1 403"), "got: {origin}");

        // 4. DNS rebinding Host header -> 403
        let rebind = raw_http(
            port,
            &format!("POST /mcp HTTP/1.1\r\nHost: evil.attacker.test:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"),
        )
        .await;
        assert!(rebind.starts_with("HTTP/1.1 403"), "got: {rebind}");

        // 5. Unknown path -> 404
        let not_found = raw_http(
            port,
            &format!("GET /other HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"),
        )
        .await;
        assert!(not_found.starts_with("HTTP/1.1 404"), "got: {not_found}");

        // 6. Valid MCP initialize request -> 200
        let init_body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "test-client", "version": "1.0" }
            }
        })
        .to_string();
        let init_req = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            init_body.len(),
            init_body
        );
        let init_resp = raw_http(port, &init_req).await;
        assert!(init_resp.starts_with("HTTP/1.1 200"), "got: {init_resp}");
        assert!(init_resp.contains("mcp-session-id") || init_resp.contains("Mcp-Session-Id"), "got: {init_resp}");
        assert!(init_resp.contains("protocolVersion"), "got: {init_resp}");

        server.shutdown().await;
    }

    #[tokio::test]
    async fn loopback_without_bearer_still_rejects_origin_and_non_loopback_host() {
        let server = start_http(0, None, Arc::new(test_server)).await.unwrap();
        let port = server.port;

        let origin = raw_http(
            port,
            &format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://evil.example\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"),
        )
        .await;
        assert!(origin.starts_with("HTTP/1.1 403"), "got: {origin}");

        let rebind = raw_http(
            port,
            &format!("POST /mcp HTTP/1.1\r\nHost: attacker.local:{port}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"),
        )
        .await;
        assert!(rebind.starts_with("HTTP/1.1 403"), "got: {rebind}");

        let init_body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "test-client", "version": "1.0" }
            }
        })
        .to_string();
        let ok = raw_http(
            port,
            &format!(
                "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                init_body.len(),
                init_body
            ),
        )
        .await;
        assert!(ok.starts_with("HTTP/1.1 200"), "got: {ok}");
        server.shutdown().await;
    }
}
