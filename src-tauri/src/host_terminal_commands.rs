use kubiki_core::pod_ops::host_terminal::{
    AnalysisRequest, HostTerminalInfo, HostTerminalManager, HostTerminalRequest, host_terminal_info,
};
use kubiki_core::{core::api::ApiError, pod_ops::terminal::ExecBatch};
use tauri::ipc::Channel;

#[derive(serde::Deserialize)]
pub struct AnalysisTerminalRequest {
    #[serde(flatten)]
    pub analysis: AnalysisRequest,
    pub cols: u16,
    pub rows: u16,
}

#[tauri::command]
pub async fn start_host_terminal(
    session_id: String,
    request: HostTerminalRequest,
    ack_timeout_secs: Option<u64>,
    on_event: Channel<ExecBatch>,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, HostTerminalManager>,
) -> Result<(), ApiError> {
    if request.analysis.is_some() {
        return Err(ApiError::from_status(
            400,
            "Use start_ai_analysis to launch an analysis agent",
            "host_terminal",
            None,
        ));
    }
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

#[tauri::command]
pub async fn start_ai_analysis(
    session_id: String,
    request: AnalysisTerminalRequest,
    ack_timeout_secs: Option<u64>,
    on_event: Channel<ExecBatch>,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, HostTerminalManager>,
) -> Result<(), ApiError> {
    let request = HostTerminalRequest {
        shell: None,
        cols: request.cols,
        rows: request.rows,
        analysis: Some(request.analysis),
    };
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

#[cfg(test)]
mod tests {
    use super::AnalysisTerminalRequest;

    #[test]
    fn analysis_ipc_requires_an_agent_and_prompt_instead_of_defaulting_to_a_shell() {
        assert!(
            serde_json::from_value::<AnalysisTerminalRequest>(
                serde_json::json!({ "cols": 80, "rows": 24 })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<AnalysisTerminalRequest>(
                serde_json::json!({ "agent": "codex", "cols": 80, "rows": 24 })
            )
            .is_err()
        );
        assert!(serde_json::from_value::<AnalysisTerminalRequest>(serde_json::json!({ "agent": "unknown", "prompt": "Analyze only", "cols": 80, "rows": 24 })).is_err());
        let request = serde_json::from_value::<AnalysisTerminalRequest>(serde_json::json!({ "agent": "opencode", "prompt": "Analyze only: Pod Pending", "cols": 80, "rows": 24 })).unwrap();
        assert_eq!(request.analysis.prompt, "Analyze only: Pod Pending");
    }
}
