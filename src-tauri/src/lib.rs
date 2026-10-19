use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::cluster::kubeconfig::{KubeConfigManager, KubeContextInfo};
use kubiki_core::cluster::namespaces::NamespaceService;
use serde_json::Value;
use tokio::process::Command;

#[tauri::command]
fn get_kube_contexts() -> Result<Vec<KubeContextInfo>, String> {
    let mgr = KubeConfigManager::new();
    mgr.list_contexts().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_current_context() -> Result<Option<String>, String> {
    let mgr = KubeConfigManager::new();
    mgr.get_current_context().map_err(|e| e.to_string())
}

#[tauri::command]
async fn ping_cluster(
    context: String,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<Value, String> {
    let ver = pool
        .check_health(&context)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(ver).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_namespaces(
    context: String,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<Vec<String>, String> {
    let client = pool.get_client(&context).await.map_err(|e| e.to_string())?;
    let namespaces = NamespaceService::list_namespaces(&client)
        .await
        .map_err(|e| e.to_string())?;
    Ok(namespaces.into_iter().map(|n| n.name).collect())
}

#[tauri::command]
async fn get_resources(
    context: String,
    kind: String,
    namespace: Option<String>,
) -> Result<Value, String> {
    let plural = match kind.as_str() {
        "Pod" => "pods",
        "Deployment" => "deployments",
        "ReplicaSet" => "replicasets",
        "Event" => "events",
        "CustomResourceDefinition" => "customresourcedefinitions",
        "StatefulSet" => "statefulsets",
        "DaemonSet" => "daemonsets",
        "Job" => "jobs",
        "CronJob" => "cronjobs",
        "Service" => "services",
        "Ingress" => "ingresses",
        "ConfigMap" => "configmaps",
        "Secret" => "secrets",
        "PersistentVolumeClaim" => "pvc",
        "PersistentVolume" => "pv",
        "StorageClass" => "storageclasses",
        "Node" => "nodes",
        "Namespace" => "namespaces",
        _ => return Err(format!("Unsupported resource kind: {kind}")),
    };

    let mut cmd = Command::new("kubectl");
    cmd.args([
        "--context",
        &context,
        "get",
        plural,
        "-o",
        "json",
        "--request-timeout=10s",
    ]);
    cmd.kill_on_drop(true);

    let is_cluster_scoped = kind == "Node"
        || kind == "Namespace"
        || kind == "PersistentVolume"
        || kind == "StorageClass"
        || kind == "CustomResourceDefinition";

    if !is_cluster_scoped {
        if let Some(ref ns) = namespace {
            if ns != "all" && !ns.is_empty() {
                cmd.args(["-n", ns]);
            } else {
                cmd.arg("-A");
            }
        } else {
            cmd.arg("-A");
        }
    }

    let output = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output())
        .await
        .map_err(|_| "kubectl request timed out".to_string())?
        .map_err(|e| format!("Failed to execute kubectl: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("kubectl error: {err}"));
    }

    serde_json::from_slice(&output.stdout).map_err(|e| format!("JSON parse error: {e}"))
}

#[tauri::command]
async fn scale_workload(
    context: String,
    kind: String,
    name: String,
    namespace: String,
    replicas: i32,
) -> Result<String, String> {
    let target_kind = match kind.as_str() {
        "Deployment" => "deployment",
        "StatefulSet" => "statefulset",
        _ => return Err("Only Deployment and StatefulSet can be scaled".to_string()),
    };

    if replicas < 0 {
        return Err("Replicas must be non-negative".into());
    }
    let output = Command::new("kubectl")
        .args([
            "--context",
            &context,
            "scale",
            target_kind,
            &name,
            "-n",
            &namespace,
            &format!("--replicas={replicas}"),
            "--request-timeout=10s",
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to execute kubectl scale: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("kubectl scale error: {err}"));
    }

    Ok(format!("{target_kind}/{name} scaled to {replicas}"))
}

#[tauri::command]
async fn get_pod_logs(
    context: String,
    name: String,
    namespace: String,
    container: Option<String>,
) -> Result<String, String> {
    let mut cmd = Command::new("kubectl");
    cmd.args([
        "--context",
        &context,
        "logs",
        &format!("pod/{name}"),
        "-n",
        &namespace,
        "--tail=500",
        "--timestamps=true",
        "--request-timeout=10s",
    ]);
    if let Some(container) = container {
        cmd.args(["-c", &container]);
    }
    cmd.kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output())
        .await
        .map_err(|_| "Pod logs request timed out".to_string())?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }

    tauri::Builder::default()
        .manage(ClusterClientPool::new(KubeConfigManager::new()))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_kube_contexts,
            get_current_context,
            ping_cluster,
            get_namespaces,
            get_resources,
            scale_workload,
            get_pod_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
