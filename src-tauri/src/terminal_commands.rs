use kubiki_core::{
    cluster::client::ClusterClientPool,
    core::api::ApiError,
    pod_ops::terminal::{ExecBatch, ExecEvent, ExecMessage, ExecRequest, PodTerminalManager},
};
use std::time::Duration;
use tauri::ipc::Channel;

#[tauri::command]
pub async fn start_pod_exec(
    session_id: String,
    request: ExecRequest,
    on_event: Channel<ExecBatch>,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    manager: tauri::State<'_, PodTerminalManager>,
    _guard: tauri::State<'_, crate::mutation_guard::MutationGuard>,
) -> Result<(), ApiError> {
    kubiki_core::pod_ops::terminal::validate_request(&request)?;
    let review = format!(
        "Open interactive container shell:\nResource: {}/{}\nNamespace: {}\nContainer: {}\nShell: {}",
        request.resource.query.kind,
        request.resource.name,
        request.resource.query.namespace.as_deref().unwrap_or("default"),
        request.container,
        request.shell
    );
    if !crate::mutation_guard::confirm(window.clone(), &request.resource, review).await? {
        return Err(kubiki_core::core::mutations::cancelled(
            &request.resource,
            "Interactive shell access was cancelled",
        ));
    }
    let pool = pool.inner().clone();
    let manager = manager.inner().clone();
    let owner = window.label().to_owned();
    let context = request.resource.query.context.clone();
    let connect_context = context.clone();
    let mut subscription = manager
        .start(&owner, &session_id, request, async move {
            pool.get_client(&connect_context)
                .await
                .map_err(|e| ApiError::from_core(e, "exec", Some(&connect_context)))
        })
        .await?;
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_millis(16));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut messages = Vec::new();
        let mut bytes = 0;
        loop {
            let (flush, ended) = tokio::select! {
                message=subscription.output.recv(),if messages.len()<32 && bytes<65536 => match message {Some(message)=>{if let ExecEvent::Output{data}=&message.event {bytes+=data.len();} messages.push(message); (false,false)},None=>(true,true)},
                _=timer.tick()=>(true,false),
            };
            if flush && !messages.is_empty() {
                let sequence = messages.last().unwrap().sequence;
                if on_event
                    .send(ExecBatch {
                        session_id: session_id.clone(),
                        messages: std::mem::take(&mut messages),
                    })
                    .is_err()
                {
                    break;
                }
                bytes = 0;
                // The renderer acknowledges after xterm has parsed the bytes. One IPC batch in flight.
                let ack = async {
                    while *subscription.acknowledgements.borrow_and_update() != sequence {
                        subscription
                            .acknowledgements
                            .changed()
                            .await
                            .map_err(|_| ())?;
                    }
                    Ok::<_, ()>(())
                };
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(30), ack).await,
                    Ok(Ok(()))
                ) {
                    let _=on_event.send(ExecBatch{session_id:session_id.clone(),messages:vec![ExecMessage{sequence:sequence+1,event:ExecEvent::Failed{error:ApiError::from_status(504,"Terminal renderer stopped consuming output. Reconnect the session.","exec",Some(&context))}}]});
                    break;
                }
            }
            if ended {
                break;
            }
        }
        manager.stop(&owner, &session_id).await;
    });
    Ok(())
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
