use kubiki_core::pod_ops::host_terminal::{
    HostTerminalInfo, HostTerminalManager, HostTerminalRequest, host_terminal_info,
};
use kubiki_core::{
    core::api::ApiError,
    pod_ops::terminal::{ExecBatch, ExecEvent, ExecMessage},
};
use std::time::Duration;
use tauri::ipc::Channel;

#[tauri::command]
pub async fn start_host_terminal(
    session_id: String,
    request: HostTerminalRequest,
    on_event: Channel<ExecBatch>,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, HostTerminalManager>,
) -> Result<(), ApiError> {
    let manager = manager.inner().clone();
    let owner = window.label().to_owned();
    let mut subscription = manager.start(&owner, &session_id, request).await?;
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
                    let _=on_event.send(ExecBatch{session_id:session_id.clone(),messages:vec![ExecMessage{sequence:sequence+1,event:ExecEvent::Failed{error:ApiError::from_status(504,"Terminal renderer stopped consuming output. Reconnect the session.","host_terminal",None)}}]});
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
