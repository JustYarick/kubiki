use kubiki_core::{
    cluster::client::ClusterClientPool,
    core::api::ApiError,
    pod_ops::terminal::{ExecBatch, ExecRequest, PodTerminalManager},
};
use tauri::ipc::Channel;

#[tauri::command]
pub async fn start_pod_exec(
    session_id: String,
    request: ExecRequest,
    ack_timeout_secs: Option<u64>,
    on_event: Channel<ExecBatch>,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    manager: tauri::State<'_, PodTerminalManager>,
    _guard: tauri::State<'_, crate::mutation_guard::MutationGuard>,
) -> Result<(), ApiError> {
    kubiki_core::pod_ops::terminal::validate_request(&request)?;
    if request.mode == kubiki_core::pod_ops::terminal::TerminalMode::Attach {
        let review = format!(
            "Attach directly to the primary process (PID 1) of container '{}' in Pod '{}'. Keystrokes or interrupts (Ctrl+C) will be delivered directly to the running application.",
            request.container, request.resource.name
        );
        if !crate::mutation_guard::confirm_action(
            window.clone(),
            &request.resource,
            review,
            "container_attach",
        )
        .await?
        {
            return Err(kubiki_core::core::mutations::cancelled(
                &request.resource,
                "Attach access was cancelled",
            ));
        }
    }
    let pool = pool.inner().clone();
    let manager = manager.inner().clone();
    let owner = window.label().to_owned();
    let context = request.resource.query.context.clone();
    let connect_context = context.clone();
    let op = match request.mode {
        kubiki_core::pod_ops::terminal::TerminalMode::Attach => "attach",
        kubiki_core::pod_ops::terminal::TerminalMode::Exec => "exec",
    };
    let mut subscription = manager
        .start(&owner, &session_id, request, async move {
            pool.get_client(&connect_context)
                .await
                .map_err(|e| ApiError::from_core(e, op, Some(&connect_context)))
        })
        .await?;
    tauri::async_runtime::spawn(async move {
        crate::exec_stream::forward(
            &mut subscription,
            &session_id,
            &on_event,
            ack_timeout_secs,
            op,
            Some(&context),
        )
        .await;
        manager.stop(&owner, &session_id).await;
    });
    Ok(())
}
#[tauri::command]
pub async fn start_pod_attach(
    session_id: String,
    mut request: ExecRequest,
    ack_timeout_secs: Option<u64>,
    on_event: Channel<ExecBatch>,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    manager: tauri::State<'_, PodTerminalManager>,
    guard: tauri::State<'_, crate::mutation_guard::MutationGuard>,
) -> Result<(), ApiError> {
    request.mode = kubiki_core::pod_ops::terminal::TerminalMode::Attach;
    start_pod_exec(
        session_id,
        request,
        ack_timeout_secs,
        on_event,
        window,
        pool,
        manager,
        guard,
    )
    .await
}
#[tauri::command]
pub async fn write_pod_exec(
    session_id: String,
    data: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PodTerminalManager>,
) -> Result<(), ApiError> {
    manager.write(window.label(), &session_id, data).await
}
#[tauri::command]
pub async fn resize_pod_exec(
    session_id: String,
    cols: u16,
    rows: u16,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PodTerminalManager>,
) -> Result<(), ApiError> {
    manager
        .resize(window.label(), &session_id, cols, rows)
        .await
}
#[tauri::command]
pub async fn ack_pod_exec(
    session_id: String,
    sequence: u64,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PodTerminalManager>,
) -> Result<(), ApiError> {
    manager
        .acknowledge(window.label(), &session_id, sequence)
        .await
}
#[tauri::command]
pub async fn close_pod_exec(
    session_id: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PodTerminalManager>,
) -> Result<(), ApiError> {
    manager.stop(window.label(), &session_id).await;
    Ok(())
}
#[tauri::command]
pub async fn stop_pod_execs(
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PodTerminalManager>,
) -> Result<(), ApiError> {
    manager.stop_owner(window.label()).await;
    Ok(())
}
