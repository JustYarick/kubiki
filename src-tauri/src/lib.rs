#[cfg(target_os = "linux")]
mod graphics;
mod port_forward_commands;
mod shell_environment;
use kubiki_core::pod_ops::port_forward::PortForwardManager;
use port_forward_commands::*;
mod mutation_guard;
mod update_commands;
use mutation_guard::resolve_mutation_confirm;
mod mutation_commands;
mod agent_commands;
mod agent_tools;
use mutation_commands::*;
mod extension_commands;
use extension_commands::{ExtensionManager, extension_cancel, extension_request};
mod exec_ack;
mod exec_stream;
mod helm_commands;
mod host_terminal_commands;
mod k8s_commands;
mod read_tasks;
mod log_commands;
mod node_commands;
mod terminal_commands;
mod watch_commands;
#[cfg(test)]
mod kubernetes_tls_tests;
use helm_commands::*;

use host_terminal_commands::*;
use k8s_commands::*;
use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::cluster::kubeconfig::KubeConfigManager;
use kubiki_core::pod_ops::host_terminal::HostTerminalManager;
use kubiki_core::pod_ops::node_debug::NodeDebugManager;
use kubiki_core::pod_ops::terminal::PodTerminalManager;
use kubiki_core::{InformerManager, ResourceStore};
use log_commands::*;
use node_commands::*;
use tauri::Manager;
use terminal_commands::*;
use watch_commands::*;

#[cfg(all(test, target_os = "linux"))]
mod dependency_regressions {
    #[test]
    fn optimized_glib_string_variant_iteration_is_safe() {
        use glib::prelude::ToVariant;
        let variant = ["first", "middle", "last"].to_variant();
        assert_eq!(variant.array_iter_str().unwrap().collect::<Vec<_>>(), ["first", "middle", "last"]);
        let mut iter = variant.array_iter_str().unwrap();
        assert_eq!(iter.next(), Some("first"));
        assert_eq!(iter.next_back(), Some("last"));
        assert_eq!(iter.last(), Some("middle"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    shell_environment::initialize();
    #[cfg(target_os = "linux")]
    {
        let graphics = graphics::initialize().unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(2);
        });
        if graphics.options.report_only {
            print!("{}", graphics.report);
            return;
        }
        eprintln!("{}", graphics.report);
    }

    tauri::Builder::default()
        .manage(ClusterClientPool::new(KubeConfigManager::new()))
        .manage(read_tasks::ReadTasks::default())
        .manage(InformerManager::new(ResourceStore::disabled()))
        .manage(PodTerminalManager::default())
        .manage(NodeDebugManager::default())
        .manage(HostTerminalManager::default())
        .manage(PortForwardManager::default())
        .manage(ExtensionManager::default())
        .manage(mutation_guard::MutationGuard::default())
        .manage(agent_commands::AgentManager::default())
        .manage(update_commands::DesktopUpdater::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            agent_commands::ai_get_settings,
            agent_commands::ai_save_settings,
            agent_commands::ai_set_credential,
            agent_commands::ai_list_models,
            agent_commands::ai_create_session,
            agent_commands::ai_set_mode,
            agent_commands::ai_stop,
            agent_commands::ai_send_message,
            update_commands::check_app_update,
            update_commands::download_app_update,
            update_commands::install_app_update,
            extension_request,
            extension_cancel,
            get_helm_inventory,
            read_tasks::cancel_read_task,
            mutate_resource,
            search_helm_charts,
            get_helm_history,
            get_helm_content,
            list_helm_repositories,
            start_port_forward,
            list_port_forwards,
            stop_port_forward,
            stop_port_forwards,
            get_kube_contexts,
            get_current_context,
            get_kubeconfig_path,
            set_kubeconfig_path,
            ping_cluster,
            get_overview_metrics,
            get_namespaces,
            get_resources,
            get_resource_counts,
            get_api_resources,
            get_custom_resources,
            delete_resource,
            resolve_mutation_confirm,
            get_pod_logs,
            get_pod_log_slice,
            watch_resources,
            stop_resource_watch,
            stop_resource_watches,
            get_host_terminal_info,
            start_host_terminal,
            start_ai_analysis,
            write_host_terminal,
            resize_host_terminal,
            ack_host_terminal,
            close_host_terminal,
            stop_host_terminals,
            node_debug_status,
            stop_node_debug,
            cancel_node_debug,
            stop_node_debugs,
            list_other_debug_pods,
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
                mutation_guard::cancel_owner(window.label());
                window.state::<agent_commands::AgentManager>().stop_owner(window.label());
                let extensions = window.state::<ExtensionManager>().inner().clone();
                let manager = window.state::<InformerManager>().inner().clone();
                let terminals = window.state::<PodTerminalManager>().inner().clone();
                let hosts = window.state::<HostTerminalManager>().inner().clone();
                let nodes = window.state::<NodeDebugManager>().inner().clone();
                let forwards = window.state::<PortForwardManager>().inner().clone();
                let reads = window.state::<read_tasks::ReadTasks>().inner().clone();
                let owner = window.label().to_owned();
                reads.stop_owner(&owner);
                tauri::async_runtime::spawn(async move {
                    extensions.close().await;
                    manager.stop_owner(&owner).await;
                    terminals.stop_owner(&owner).await;
                    nodes.stop_owner(&owner).await;
                    hosts.stop_owner(&owner).await;
                    forwards.stop_owner(&owner).await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
