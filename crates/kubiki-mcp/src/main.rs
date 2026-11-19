use kubiki_core::cluster::{client::ClusterClientPool, kubeconfig::KubeConfigManager};
use kubiki_mcp::{ClusterServer, ConnectionExecutor};
use kubiki_tools::*;
use rmcp::ServiceExt;
use std::{path::PathBuf, sync::Arc};
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionProfile {
    context: String,
    #[serde(default)]
    namespaces: Vec<String>,
    #[serde(default)]
    all_namespaces: bool,
    kubeconfig: Option<PathBuf>,
    policy: Option<PathBuf>,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("kubiki-mcp: {error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "--help".into());
    if command == "attach" {
        return kubiki_mcp::attached::attach(&PathBuf::from(
            args.next().ok_or("Expected bootstrap path")?,
        ))
        .await;
    }
    if command != "serve" {
        eprintln!(
            "Usage: kubiki-mcp serve --context NAME [--namespace NAME] [--all-namespaces] [--kubeconfig PATH] [--profile PATH]\n       kubiki-mcp serve --connections FILE --connection NAME\n       kubiki-mcp attach BOOTSTRAP\nPermissions are owned by the MCP host. Default exposure permits filtered reads only."
        );
        return Ok(());
    }
    let mut context = None;
    let mut namespaces = vec![];
    let mut all = false;
    let mut kubeconfig = None;
    let mut profile = None;
    let mut connections = None;
    let mut connection = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--connections" => {
                connections = Some(PathBuf::from(
                    args.next().ok_or("Missing connections file")?,
                ))
            }
            "--connection" => connection = Some(args.next().ok_or("Missing connection name")?),
            "--context" => context = Some(args.next().ok_or("Missing context")?),
            "--namespace" => namespaces.push(args.next().ok_or("Missing namespace")?),
            "--all-namespaces" => all = true,
            "--kubeconfig" => {
                kubeconfig = Some(PathBuf::from(args.next().ok_or("Missing kubeconfig")?))
            }
            "--profile" => profile = Some(PathBuf::from(args.next().ok_or("Missing profile")?)),
            _ => return Err(format!("Unknown argument {arg}")),
        }
    }
    match (connections, connection) {
        (Some(file), Some(name)) => {
            if context.is_some()
                || all
                || !namespaces.is_empty()
                || kubeconfig.is_some()
                || profile.is_some()
            {
                return Err(
                    "Choose either a named connection or explicit connection options".into(),
                );
            }
            let bytes = tokio::fs::read(&file).await.map_err(|e| e.to_string())?;
            let mut profiles: std::collections::BTreeMap<String, ConnectionProfile> =
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let selected = profiles.remove(&name).ok_or("Unknown connection profile")?;
            let dir = file.parent().unwrap_or(std::path::Path::new("."));
            context = Some(selected.context);
            namespaces = selected.namespaces;
            all = selected.all_namespaces;
            kubeconfig = selected.kubeconfig.map(|path| dir.join(path));
            profile = selected.policy.map(|path| dir.join(path));
        }
        (None, None) => {}
        _ => return Err("Specify both --connections and --connection".into()),
    }
    if !all && namespaces.is_empty() {
        return Err("Specify --namespace or --all-namespaces".into());
    }
    let context = context.ok_or("Specify --context to pin the cluster")?;
    let mut policy = if let Some(path) = profile {
        let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
        if bytes.len() > 1024 * 1024 {
            return Err("Profile exceeds 1 MiB".into());
        }
        serde_json::from_slice::<AgentPolicy>(&bytes).map_err(|e| e.to_string())?
    } else {
        AgentPolicy::default()
    };
    // Kubiki confirmations never leak into a host-owned connection.
    policy.confirm_reads = false;
    policy.always_ask.clear();
    policy.validate()?;
    let manager = KubeConfigManager::new();
    manager.set_custom_path(kubeconfig);
    let pool = ClusterClientPool::new(manager);
    let session = Session::new(
        format!("standalone-{}", std::process::id()),
        "mcp-host".into(),
        AgentScope {
            context,
            namespaces,
            all_namespaces: all,
        },
        policy,
        ClusterCapabilities {
            helm: true,
            argocd: true,
            flux: true,
        },
    );
    session.mode(AgentMode::Accept)?;
    session.phase(AgentPhase::Action)?;
    let journal = std::env::temp_dir().join(format!(
        "kubiki-mcp-{}-operations.jsonl",
        std::process::id()
    ));
    let executor = Arc::new(ConnectionExecutor {
        pool,
        journal,
        consent: Arc::new(kubernetes::HostConsent::default()),
        generation: std::sync::Mutex::new(None),
        permits: Arc::new(tokio::sync::Semaphore::new(2)),
    });
    let server = ClusterServer::new(session, executor, Arc::new(|_| {}), true);
    let draining = server.clone();
    let result = server
        .serve((tokio::io::stdin(), tokio::io::stdout()))
        .await
        .map_err(|e| e.to_string())?
        .waiting()
        .await
        .map_err(|e| e.to_string());
    draining.shutdown().await;
    result?;
    Ok(())
}
