use kubiki_core::{
    cluster::client::ClusterClientPool,
    core::api::ApiError,
    pod_ops::log_sessions::{LogBatch, LogEvent, LogMessage, LogRequest, PodLogManager},
};
use std::time::Duration;
use tauri::ipc::Channel;

#[tauri::command]
pub async fn start_pod_logs(
    session_id: String,
    request: LogRequest,
    on_event: Channel<LogBatch>,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    manager: tauri::State<'_, PodLogManager>,
) -> Result<(), ApiError> {
    let pool = pool.inner().clone();
    let manager = manager.inner().clone();
    let owner = window.label().to_owned();
    let context = request.resource.query.context.clone();
    let connect_context = context.clone();
    let mut subscription = manager
        .start(&owner, &session_id, request, async move {
            pool.get_client(&connect_context)
                .await
                .map_err(|e| ApiError::from_core(e, "logs", Some(&connect_context)))
        })
        .await?;
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_millis(50));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut messages = Vec::new();
        let mut bytes = 0;
        loop {
            let (flush, ended) = tokio::select! {
                message=subscription.output.recv(),if messages.len()<8 && bytes<32768 => match message {Some(message)=>{if let LogEvent::Output{data}=&message.event {bytes+=data.len();} messages.push(message); (false,false)},None=>(true,true)},
                _=timer.tick()=>(true,false),
            };
            if flush && !messages.is_empty() {
                let sequence = messages.last().unwrap().sequence;
                if on_event
                    .send(LogBatch {
                        session_id: session_id.clone(),
                        messages: std::mem::take(&mut messages),
                    })
                    .is_err()
                {
                    break;
                }
                bytes = 0;
                // The viewer acknowledges after consuming bytes into its bounded buffer. One IPC batch in flight.
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
                    let _ = on_event.send(LogBatch {
                        session_id: session_id.clone(),
                        messages: vec![LogMessage {
                            sequence: sequence + 1,
                            event: LogEvent::Failed {
                                error: ApiError::from_status(
                                    504,
                                    "Log viewer stopped consuming output. Reconnect the session.",
                                    "logs",
                                    Some(&context),
                                ),
                            },
                        }],
                    });
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
pub async fn ack_pod_logs(
    session_id: String,
    sequence: u64,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PodLogManager>,
) -> Result<(), ApiError> {
    manager
        .acknowledge(window.label(), &session_id, sequence)
        .await
}
#[tauri::command]
pub async fn close_pod_logs(
    session_id: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PodLogManager>,
) -> Result<(), ApiError> {
    manager.stop(window.label(), &session_id).await;
    Ok(())
}
#[tauri::command]
pub async fn stop_pod_logs(
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PodLogManager>,
) -> Result<(), ApiError> {
    manager.stop_owner(window.label()).await;
    Ok(())
}
