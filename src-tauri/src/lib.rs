mod k8s_commands;

use k8s_commands::*;
use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::cluster::kubeconfig::KubeConfigManager;

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
