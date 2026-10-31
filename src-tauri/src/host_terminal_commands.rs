use kubiki_core::pod_ops::host_terminal::{
    HostTerminalInfo, HostTerminalManager, HostTerminalRequest, host_terminal_info,
};
use kubiki_core::{core::api::ApiError, pod_ops::terminal::ExecBatch};
use tauri::ipc::Channel;

#[tauri::command]
pub async fn start_host_terminal(
    session_id: String,
    request: HostTerminalRequest,
    ack_timeout_secs: Option<u64>,
    on_event: Channel<ExecBatch>,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, HostTerminalManager>,
) -> Result<(), ApiError> {
    start_local_session(
        session_id,
        request,
        ack_timeout_secs,
        on_event,
        window,
        manager.inner().clone(),
    )
    .await
}

async fn start_local_session(
    session_id: String,
    request: HostTerminalRequest,
    ack_timeout_secs: Option<u64>,
    on_event: Channel<ExecBatch>,
    window: tauri::WebviewWindow,
    manager: HostTerminalManager,
) -> Result<(), ApiError> {
    let owner = window.label().to_owned();
    let mut subscription = manager.start(&owner, &session_id, request).await?;
    tauri::async_runtime::spawn(async move {
        crate::exec_stream::forward(
            &mut subscription,
            &session_id,
            &on_event,
            ack_timeout_secs,
            "host_terminal",
            None,
        )
        .await;
        manager.stop(&owner, &session_id).await;
    });
    Ok(())
}
#[tauri::command]
pub async fn write_host_terminal(
    session_id: String,
    data: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, HostTerminalManager>,
) -> Result<(), ApiError> {
    manager.write(window.label(), &session_id, data).await
}
#[tauri::command]
pub async fn resize_host_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, HostTerminalManager>,
) -> Result<(), ApiError> {
    manager
        .resize(window.label(), &session_id, cols, rows)
        .await
}
#[tauri::command]
pub async fn ack_host_terminal(
    session_id: String,
    sequence: u64,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, HostTerminalManager>,
) -> Result<(), ApiError> {
    manager
        .acknowledge(window.label(), &session_id, sequence)
        .await
}
#[tauri::command]
pub async fn close_host_terminal(
    session_id: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, HostTerminalManager>,
) -> Result<(), ApiError> {
    manager.stop(window.label(), &session_id).await;
    Ok(())
}
#[tauri::command]
pub async fn stop_host_terminals(
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, HostTerminalManager>,
) -> Result<(), ApiError> {
    manager.stop_owner(window.label()).await;
    Ok(())
}

#[tauri::command]
pub fn get_host_terminal_info() -> Result<HostTerminalInfo, ApiError> {
    host_terminal_info()
}
