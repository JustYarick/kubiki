use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::cluster::kubeconfig::KubeConfigManager;
use kubiki_core::cluster::namespaces::NamespaceService;
use kubiki_core::crd::discovery::CrdDiscoveryService;
use kubiki_core::helm::client::HelmClient;
use kubiki_core::metrics::client::MetricsService;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let command = args.get(1).map(|s| s.as_str()).unwrap_or("help");

    let config_mgr = KubeConfigManager::new();
    let pool = ClusterClientPool::new(config_mgr.clone());

    match command {
        "contexts" => {
            let contexts = config_mgr.list_contexts()?;
            println!("{}", serde_json::to_string_pretty(&contexts)?);
        }
        "current-context" => {
            let current = config_mgr.get_current_context()?;
            println!("{}", serde_json::json!({ "current_context": current }));
        }
        "ping" => {
            let context = args.get(2).cloned().or_else(|| {
                config_mgr.get_current_context().ok().flatten()
            }).unwrap_or_else(|| "default".into());

            match pool.check_health(&context).await {
                Ok(version) => {
                    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                        "status": "connected",
                        "context": context,
                        "version": version
                    }))?);
                }
                Err(err) => {
                    eprintln!("{}", serde_json::json!({
                        "status": "error",
                        "context": context,
                        "error": err.to_string()
                    }));
                    std::process::exit(1);
                }
            }
        }
        "namespaces" => {
            let context = args.get(2).cloned().or_else(|| {
                config_mgr.get_current_context().ok().flatten()
            }).unwrap_or_else(|| "default".into());

            let client = pool.get_client(&context).await?;
            let namespaces = NamespaceService::list_namespaces(&client).await?;
            println!("{}", serde_json::to_string_pretty(&namespaces)?);
        }
        "crds" => {
            let context = args.get(2).cloned().or_else(|| {
                config_mgr.get_current_context().ok().flatten()
            }).unwrap_or_else(|| "default".into());

            let client = pool.get_client(&context).await?;
            let crds = CrdDiscoveryService::list_crds(&client).await?;
            println!("{}", serde_json::to_string_pretty(&crds)?);
        }
        "metrics" => {
            let context = args.get(2).cloned().or_else(|| {
                config_mgr.get_current_context().ok().flatten()
            }).unwrap_or_else(|| "default".into());

            let client = pool.get_client(&context).await?;
            let node_metrics = MetricsService::get_node_metrics(&client).await?;
            let pod_metrics = MetricsService::get_pod_metrics(&client, None).await?;
            println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                "nodes": node_metrics,
                "pods": pod_metrics
            }))?);
        }
        "helm-releases" => {
            let ns = args.get(2).map(|s| s.as_str());
            let releases = HelmClient::list_releases(ns).await?;
            println!("{}", serde_json::to_string_pretty(&releases)?);
        }
        "helm-repos" => {
            let repos = HelmClient::list_repositories().await?;
            println!("{}", serde_json::to_string_pretty(&repos)?);
        }
        _ => {
            println!(r#"Kubiki Core CLI - Headless Kubernetes Engine

Usage:
  kubiki-cli contexts                List all available kubeconfig contexts
  kubiki-cli current-context         Show current active context
  kubiki-cli ping [context]          Verify cluster connectivity and API version
  kubiki-cli namespaces [context]    List all cluster namespaces
  kubiki-cli crds [context]          Discover all CRDs with printer columns
  kubiki-cli metrics [context]       Retrieve Node and Pod metrics
  kubiki-cli helm-releases [ns]      List Helm 3 releases
  kubiki-cli helm-repos              List configured Helm repositories
"#);
        }
    }

    Ok(())
}
