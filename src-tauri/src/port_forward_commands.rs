use kubiki_core::{
    cluster::client::ClusterClientPool,
    core::api::ApiError,
    pod_ops::port_forward::{
        ForwardRequest, PortForwardManager, PortForwardSession, validate_request,
    },
};
use tauri::Manager;

#[tauri::command]
pub async fn start_port_forward(
    session_id: String,
    request: ForwardRequest,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    manager: tauri::State<'_, PortForwardManager>,
) -> Result<PortForwardSession, ApiError> {
    validate_request(&request)?;
    let context = &request.resource.query.context;
    let client = tokio::time::timeout(std::time::Duration::from_secs(15), pool.get_client(context))
        .await
        .map_err(|_| {
            ApiError::from_status(
                504,
                "Loading cluster client timed out",
                "port_forward",
                Some(context),
            )
        })?
        .map_err(|e| ApiError::from_core(e, "port_forward", Some(context)))?;
    if window
        .app_handle()
        .get_webview_window(window.label())
        .is_none()
    {
        return Err(ApiError::from_status(
            409,
            "Window closed",
            "port_forward",
            Some(context),
        ));
    }
    manager
        .start(window.label(), &session_id, client, request)
        .await
}
#[tauri::command]
pub async fn list_port_forwards(
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PortForwardManager>,
) -> Result<Vec<PortForwardSession>, ApiError> {
    Ok(manager.list(window.label()).await)
}
#[tauri::command]
pub async fn stop_port_forward(
    session_id: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PortForwardManager>,
) -> Result<(), ApiError> {
    manager.stop(window.label(), &session_id).await;
    Ok(())
}
#[tauri::command]
pub async fn stop_port_forwards(
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PortForwardManager>,
) -> Result<(), ApiError> {
    manager.stop_owner(window.label()).await;
    Ok(())
}
