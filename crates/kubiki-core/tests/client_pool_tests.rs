//! Concurrent startup must share one credential provider and HTTP client per context.
#![cfg(unix)]
use kubiki_core::cluster::{client::ClusterClientPool, kubeconfig::KubeConfigManager};
use serde_json::json;
use std::{
    os::unix::fs::PermissionsExt,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
#[tokio::test]
async fn parallel_collection_startup_shares_the_credential_provider() {
    let dir = std::env::temp_dir().join(format!(
        "kubiki-pool-test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(dir.clone());
    let login = dir.join("login.sh");
    let counter = dir.join("count");
    let config = dir.join("config");
    std::fs::write(&login, "#!/bin/sh\nprintf x >> \"$1\"\nprintf '%s' '{\"apiVersion\":\"client.authentication.k8s.io/v1\",\"kind\":\"ExecCredential\",\"status\":{\"token\":\"fixture-token\",\"expirationTimestamp\":\"2099-01-01T00:00:00Z\"}}'\n").unwrap();
    std::fs::set_permissions(&login, std::fs::Permissions::from_mode(0o700)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    std::fs::write(&config, json!({"apiVersion":"v1","kind":"Config","current-context":"test","clusters":[{"name":"test","cluster":{"server":server}}],"contexts":[{"name":"test","context":{"cluster":"test","user":"test"}}],"users":[{"name":"test","user":{"exec":{"apiVersion":"client.authentication.k8s.io/v1","command":login,"args":[counter],"interactiveMode":"Never"}}}]}).to_string()).unwrap();
    let serving = tokio::spawn(async move {
        let mut tasks = vec![];
        for _ in 0..32 {
            let (mut socket, _) = listener.accept().await.unwrap();
            tasks.push(tokio::spawn(async move {
                let mut bytes = Vec::new();
                loop { let mut chunk = [0; 4096]; let n = socket.read(&mut chunk).await.unwrap(); assert!(n > 0); bytes.extend_from_slice(&chunk[..n]); if bytes.windows(4).any(|p| p == b"\r\n\r\n") { break; } }
                let request = String::from_utf8(bytes).unwrap(); assert!(request.starts_with("GET /version "));
                assert!(request.to_lowercase().contains("authorization: bearer fixture-token"));
                let body = json!({"gitVersion":"v1.35.0","major":"1","minor":"35","gitCommit":"fixture","gitTreeState":"clean","buildDate":"2026-01-01T00:00:00Z","goVersion":"go1","compiler":"gc","platform":"linux/amd64"}).to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
    });
    let pool = ClusterClientPool::new(KubeConfigManager::with_custom_path(config));
    tokio::time::timeout(Duration::from_secs(10), async {
        let results = futures::future::join_all((0..32).map(|_| async {
            pool.get_client("test")
                .await
                .unwrap()
                .apiserver_version()
                .await
                .unwrap()
        }))
        .await;
        assert_eq!(results.len(), 32);
        serving.await.unwrap();
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(counter).unwrap(),
        "xx",
        "One shared client initializes credentials in Config, then refreshes once for its first HTTP request; 32 reads must not build 32 providers"
    );
}
