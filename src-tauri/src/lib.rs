use kubiki_core::cluster::kubeconfig::{KubeConfigManager, KubeContextInfo};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_kube_contexts,
            get_current_context
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
