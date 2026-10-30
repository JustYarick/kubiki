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
