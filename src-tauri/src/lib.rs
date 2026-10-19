use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::cluster::kubeconfig::{KubeConfigManager, KubeContextInfo};
use kubiki_core::cluster::namespaces::NamespaceService;
use serde_json::Value;
use std::process::Command;

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
async fn ping_cluster(context: String) -> Result<Value, String> {
    let mgr = KubeConfigManager::new();
    let pool = ClusterClientPool::new(mgr);
    let ver = pool.check_health(&context).await.map_err(|e| e.to_string())?;
    serde_json::to_value(ver).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_namespaces(context: String) -> Result<Vec<String>, String> {
    let mgr = KubeConfigManager::new();
    let pool = ClusterClientPool::new(mgr);
    let client = pool.get_client(&context).await.map_err(|e| e.to_string())?;
    let namespaces = NamespaceService::list_namespaces(&client)
        .await
        .map_err(|e| e.to_string())?;
    Ok(namespaces.into_iter().map(|n| n.name).collect())
}

#[tauri::command]
fn get_resources(context: String, kind: String, namespace: Option<String>) -> Result<Value, String> {
    let plural = match kind.as_str() {
        "Pod" => "pods",
        "Deployment" => "deployments",
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
        _ => "pods",
    };

    let mut cmd = Command::new("kubectl");
    cmd.args(["--context", &context, "get", plural, "-o", "json"]);

    let is_cluster_scoped = kind == "Node" || kind == "Namespace" || kind == "PersistentVolume" || kind == "StorageClass";

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

    let output = cmd.output().map_err(|e| format!("Failed to execute kubectl: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("kubectl error: {err}"));
    }

    serde_json::from_slice(&output.stdout).map_err(|e| format!("JSON parse error: {e}"))
}

#[tauri::command]
fn scale_workload(
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
        ])
        .output()
        .map_err(|e| format!("Failed to execute kubectl scale: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("kubectl scale error: {err}"));
    }

    Ok(format!("{target_kind}/{name} scaled to {replicas}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_kube_contexts,
            get_current_context,
            ping_cluster,
            get_namespaces,
            get_resources,
            scale_workload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
