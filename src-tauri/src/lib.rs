mod port_forward_commands;
use port_forward_commands::*;
use kubiki_core::pod_ops::port_forward::PortForwardManager;
mod mutation_guard;
mod k8s_commands;
mod terminal_commands;
mod node_commands;
mod host_terminal_commands;
mod log_commands;
mod watch_commands;

use k8s_commands::*;
use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::cluster::kubeconfig::KubeConfigManager;
use kubiki_core::pod_ops::terminal::PodTerminalManager;
use kubiki_core::{InformerManager, ResourceStore};
use tauri::Manager;
use terminal_commands::*;
use node_commands::*;
use kubiki_core::pod_ops::node_debug::NodeDebugManager;
use host_terminal_commands::*;
use kubiki_core::pod_ops::host_terminal::HostTerminalManager;
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
        .manage(NodeDebugManager::default())
        .manage(HostTerminalManager::default())
        .manage(PodLogManager::default())
        .manage(PortForwardManager::default())
        .manage(mutation_guard::MutationGuard::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            start_port_forward,
            list_port_forwards,
            stop_port_forward,
            stop_port_forwards,
            get_kube_contexts,
            get_current_context,
            ping_cluster,
            get_overview_metrics,
            get_namespaces,
            get_resources,
            scale_workload,
            update_secret_data,
            get_pod_logs,
            watch_resources,
            stop_resource_watch,
            stop_resource_watches,
            start_pod_logs,
            ack_pod_logs,
            close_pod_logs,
            stop_pod_logs,
            get_host_terminal_info,
            start_host_terminal,
            write_host_terminal,
            resize_host_terminal,
            ack_host_terminal,
            close_host_terminal,
            stop_host_terminals,
            prepare_node_debug,
            node_debug_status,
            stop_node_debug,
            stop_node_debugs,
            list_other_debug_pods,
            remove_other_debug_pod,
            start_node_exec,
            write_node_exec,
            resize_node_exec,
            ack_node_exec,
            close_node_exec,
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
                let hosts = window.state::<HostTerminalManager>().inner().clone();
                let nodes = window.state::<NodeDebugManager>().inner().clone();
                let forwards = window.state::<PortForwardManager>().inner().clone();
                let owner = window.label().to_owned();
                tauri::async_runtime::spawn(async move {
                    manager.stop_owner(&owner).await;
                    terminals.stop_owner(&owner).await;
                    nodes.stop_owner(&owner).await;
                    hosts.stop_owner(&owner).await;
                    logs.stop_owner(&owner).await;
                    forwards.stop_owner(&owner).await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
