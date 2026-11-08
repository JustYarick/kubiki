use kubiki_ai::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

async fn endpoint(status: u16, body: &str) -> (ProviderProfile, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/private-route/v1", listener.local_addr().unwrap());
    let body = body.to_owned();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let count = socket.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                let length = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .map(|n| n.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        let reason = if status == 200 { "OK" } else { "Unauthorized" };
        socket.write_all(format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
        String::from_utf8(bytes).unwrap()
    });
    (
        ProviderProfile {
            id: "llama-fixture".into(),
            name: "Local llama.cpp".into(),
            protocol: ProviderProtocol::OpenaiCompatible,
            base_url,
        },
        task,
    )
}

#[tokio::test]
async fn model_discovery_sends_no_authorization_for_a_keyless_local_server() {
    let (profile, task) = endpoint(200, r#"{"data":[{"id":"local-model"}]}"#).await;
    let client = ProviderClient::new(profile, String::new()).unwrap();
    assert_eq!(client.models().await.unwrap()[0].id, "local-model");
    let request = task.await.unwrap().to_ascii_lowercase();
    assert!(request.starts_with("get /private-route/v1/models "));
    assert!(!request.contains("authorization:") && !request.contains("x-api-key:"));
}

async fn denied(generation: bool) {
    for key in ["", "synthetic-rejected-key"] {
        let (profile, task) =
            endpoint(401, r#"{"error":{"message":"sensitive-error-body"}}"#).await;
        let origin = profile
            .base_url
            .split("/private-route")
            .next()
            .unwrap()
            .to_owned();
        let client = ProviderClient::new(profile, key.into()).unwrap();
        let error = if generation {
            let emit: EventSink = std::sync::Arc::new(|_| {});
            client
                .complete(
                    "local-model",
                    &GenerationOptions::default(),
                    "Test",
                    &[Turn::User("Hello".into())],
                    &[],
                    &emit,
                )
                .await
                .unwrap_err()
        } else {
            client.models().await.unwrap_err()
        };
        assert!(error.contains(&origin) && error.contains("HTTP 401"));
        assert!(error.contains(if key.is_empty() {
            "no API key was sent"
        } else {
            "configured API key was rejected"
        }));
        for private in [
            "private-route",
            "synthetic-rejected-key",
            "sensitive-error-body",
        ] {
            assert!(!error.contains(private));
        }
        let request = task.await.unwrap().to_ascii_lowercase();
        assert_eq!(
            request.contains("authorization: bearer synthetic-rejected-key"),
            !key.is_empty()
        );
        assert!(request.starts_with(if generation {
            "post /private-route/v1/chat/completions "
        } else {
            "get /private-route/v1/models "
        }));
    }
}

#[tokio::test]
async fn model_discovery_auth_error_identifies_server_and_credential_state_without_leaking_secrets()
{
    denied(false).await;
}

#[tokio::test]
async fn generation_auth_error_identifies_server_and_credential_state_without_leaking_secrets() {
    denied(true).await;
}
