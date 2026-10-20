mod k8s_commands;
mod terminal_commands;
mod log_commands;
mod watch_commands;

use k8s_commands::*;
use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::cluster::kubeconfig::KubeConfigManager;
use kubiki_core::pod_ops::terminal::PodTerminalManager;
use kubiki_core::{InformerManager, ResourceStore};
use tauri::Manager;
use terminal_commands::*;
use log_commands::*;
use kubiki_core::pod_ops::log_sessions::PodLogManager;
use watch_commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }

    tauri::Builder::default()
        .manage(ClusterClientPool::new(KubeConfigManager::new()))
        .manage(InformerManager::new(ResourceStore::new()))
        .manage(PodTerminalManager::default())
        .manage(PodLogManager::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_kube_contexts,
            get_current_context,
            ping_cluster,
            get_namespaces,
            get_resources,
            scale_workload,
            get_pod_logs,
            watch_resources,
            stop_resource_watch,
            stop_resource_watches,
            start_pod_logs,
            ack_pod_logs,
            close_pod_logs,
            stop_pod_logs,
            start_pod_exec,
            write_pod_exec,
            resize_pod_exec,
            ack_pod_exec,
            close_pod_exec,
            stop_pod_execs,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let manager = window.state::<InformerManager>().inner().clone();
                let terminals = window.state::<PodTerminalManager>().inner().clone();
                let logs = window.state::<PodLogManager>().inner().clone();
                let owner = window.label().to_owned();
                tauri::async_runtime::spawn(async move {
                    manager.stop_owner(&owner).await;
                    terminals.stop_owner(&owner).await;
                    logs.stop_owner(&owner).await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
