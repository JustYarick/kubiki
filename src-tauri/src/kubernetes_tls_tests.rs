//! Exercise the desktop's unified TLS dependency graph, rather than a mocked
//! kube::Client service or the core crate's different feature graph.
use kubiki_ai::{ProviderClient, ProviderProfile, ProviderProtocol};

fn isolated_process(test: &str) -> bool {
    if std::env::var("KUBIKI_TLS_TEST_CHILD").as_deref() == Ok(test) {
        return true;
    }
    // CryptoProvider is process-global. Run each startup order in a fresh
    // process so another parallel test cannot accidentally initialize it first.
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env("KUBIKI_TLS_TEST_CHILD", test)
        .output()
        .expect("start isolated desktop TLS test");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    false
}

fn ai_client() -> ProviderClient {
    ProviderClient::new(
        ProviderProfile {
            id: "tls-test".into(),
            name: "TLS regression".into(),
            protocol: ProviderProtocol::Responses,
            base_url: "https://ai.invalid/v1".into(),
        },
        String::new(),
    )
    .expect("AI HTTPS connector must initialize")
}

#[tokio::test]
async fn kubernetes_https_client_initializes_before_ai_or_updater() {
    if !isolated_process(
        "kubernetes_tls_tests::kubernetes_https_client_initializes_before_ai_or_updater",
    ) {
        return;
    }
    // No network or user kubeconfig: constructing the real connector is enough
    // to catch conflicting process-level crypto providers at cold startup.
    let config = kube::Config::new("https://127.0.0.1:6443".parse().unwrap());
    kube::Client::try_from(config).expect("desktop Kubernetes HTTPS connector must initialize");
    let _ai = ai_client();
}

#[tokio::test]
async fn kubernetes_https_client_initializes_after_ai() {
    if !isolated_process("kubernetes_tls_tests::kubernetes_https_client_initializes_after_ai") {
        return;
    }
    let _ai = ai_client();
    let config = kube::Config::new("https://127.0.0.1:6443".parse().unwrap());
    kube::Client::try_from(config).expect("AI initialization must preserve Kubernetes TLS");
}

#[tokio::test]
#[ignore = "read-only /version probe against the current kubeconfig context; requires cluster access"]
async fn current_cluster_version_is_reachable_before_and_after_ai() {
    use kubiki_core::{ClusterClientPool, KubeConfigManager};
    let config = KubeConfigManager::new();
    let context = config
        .get_current_context()
        .unwrap()
        .expect("current Kubernetes context");
    let pool = ClusterClientPool::new(config);
    let before = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        pool.check_health(&context),
    )
    .await
    .expect("Kubernetes health deadline")
    .expect("Kubernetes HTTPS health before AI");
    let _ai = ai_client();
    pool.invalidate(&context).await;
    let after = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        pool.check_health(&context),
    )
    .await
    .expect("Kubernetes health deadline")
    .expect("Kubernetes HTTPS health after AI");
    assert_eq!(before.git_version, after.git_version);
    println!(
        "Native Kubernetes /version succeeds before and after AI initialization: {}",
        after.git_version
    );
}

#[tokio::test]
async fn invalidated_connection_rejects_a_pinned_agent_client_before_dispatch() {
    use kubiki_core::{ClusterClientPool, KubeConfigManager};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let _ai = ai_client();
    let path = std::env::temp_dir().join(format!(
        "kubiki-agent-lease-{}-{}.yaml",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _cleanup = Cleanup(path.clone());
    std::fs::write(&path,"apiVersion: v1\nkind: Config\ncurrent-context: fixture\nclusters:\n- name: local\n  cluster:\n    server: http://127.0.0.1:9\ncontexts:\n- name: fixture\n  context:\n    cluster: local\n    namespace: apps\nusers: []\n").unwrap();
    let pool = ClusterClientPool::new(KubeConfigManager::with_custom_path(path));
    let (client, generation) = pool.get_client_with_generation("fixture").await.unwrap();
    assert_eq!(
        pool.get_client_with_generation("fixture").await.unwrap().1,
        generation
    );
    let invalid = Arc::new(AtomicBool::new(false));
    let signal = invalid.clone();
    let pinned = pool.pin_client(
        client,
        "fixture".into(),
        generation,
        Arc::new(move || {
            signal.store(true, Ordering::SeqCst);
        }),
        Arc::new(|| true),
    );
    let revoked = Arc::new(AtomicBool::new(false));
    let signal = revoked.clone();
    let (raw, _) = pool.get_client_with_generation("fixture").await.unwrap();
    let guarded = pool.pin_client(
        raw,
        "fixture".into(),
        generation,
        Arc::new(|| {}),
        Arc::new(move || {
            signal.store(true, Ordering::SeqCst);
            false
        }),
    );
    let request = kube::core::Request::new("/api/v1/namespaces/apps/pods")
        .delete("web", &kube::api::DeleteParams::default())
        .unwrap()
        .map(kube::client::Body::from);
    assert!(guarded.send(request).await.is_err());
    assert!(
        revoked.load(Ordering::SeqCst),
        "permissions must be rechecked after async generation validation, before write dispatch"
    );
    pool.invalidate("fixture").await;
    let new_generation = pool.get_client_with_generation("fixture").await.unwrap().1;
    assert_ne!(new_generation, generation);
    let api: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(pinned, "apps");
    assert!(
        api.list_metadata(&kube::api::ListParams::default())
            .await
            .is_err()
    );
    assert!(
        invalid.load(Ordering::SeqCst),
        "old client must revoke its owning session before an HTTP dispatch"
    );
}
