use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::core::api::{ApiError, ResourceRef};
use kubiki_core::pod_ops::node_debug::{
    DebugPod, NodeDebugManager, NodeDebugRequest, NodeDebugState, NodeDebugResult, NodeExecRequest,
};
use kubiki_core::pod_ops::terminal::{ExecBatch, ExecEvent, ExecMessage};
use std::time::Duration;
use tauri::ipc::Channel;

#[tauri::command]
pub async fn start_node_exec(
    session_id: String,
    request: NodeExecRequest,
    on_event: Channel<ExecBatch>,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, NodeDebugManager>,
) -> Result<(), ApiError> {
    let manager = manager.inner().clone();
    let owner = window.label().to_owned();
    let debug_session_id = request.debug_session_id.clone();
    let mut subscription = match manager.attach(&owner, &session_id, request).await {
        Ok(subscription) => subscription,
        Err(error) => return Err(error),
    };
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
                    let _=on_event.send(ExecBatch{session_id:session_id.clone(),messages:vec![ExecMessage{sequence:sequence+1,event:ExecEvent::Failed{error:ApiError::from_status(504,"Terminal renderer stopped consuming output. Reconnect the session.","node_debug",None)}}]});
                    break;
                }
            }
            if ended {
                break;
            }
        }
        // One shell leaves; the helper Pod dies only with the last one on the Node.
        manager.release_exec(&owner, &debug_session_id, &session_id).await;
    });
    Ok(())
}
#[tauri::command]
pub async fn write_node_exec(
    session_id: String,
    debug_session_id: String,
    data: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, NodeDebugManager>,
) -> Result<(), ApiError> {
    manager
        .write(window.label(), &debug_session_id, &session_id, data)
        .await
}
#[tauri::command]
pub async fn resize_node_exec(
    session_id: String,
    debug_session_id: String,
    cols: u16,
    rows: u16,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, NodeDebugManager>,
) -> Result<(), ApiError> {
    manager
        .resize(window.label(), &debug_session_id, &session_id, cols, rows)
        .await
}
#[tauri::command]
pub async fn ack_node_exec(
    session_id: String,
    debug_session_id: String,
    sequence: u64,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, NodeDebugManager>,
) -> Result<(), ApiError> {
    manager
        .ack(window.label(), &debug_session_id, &session_id, sequence)
        .await
}
#[tauri::command]
pub async fn close_node_exec(
    session_id: String,
    debug_session_id: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, NodeDebugManager>,
) -> Result<(), ApiError> {
    manager
        .release_exec(window.label(), &debug_session_id, &session_id)
        .await;
    Ok(())
}
#[tauri::command]
pub async fn cancel_node_debug(
    resource: ResourceRef,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, NodeDebugManager>,
) -> Result<(), ApiError> {
    if resource.query.kind != "Node" || resource.uid.as_ref().is_none_or(|uid| uid.is_empty()) {
        return Err(ApiError::from_status(
            400,
            "A Node reference with UID is required",
            "node_debug",
            Some(&resource.query.context),
        ));
    }
    manager
        .cancel_prepare(
            window.label(),
            &kubiki_core::pod_ops::node_debug::derived_session_id(&resource),
        )
        .await;
    Ok(())
}
#[tauri::command]
pub async fn stop_node_debugs(
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, NodeDebugManager>,
) -> Result<(), ApiError> {
    manager.stop_owner(window.label()).await;
    Ok(())
}

pub async fn prepare_node_debug(
    request: NodeDebugRequest,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    manager: tauri::State<'_, NodeDebugManager>,
) -> Result<NodeDebugResult, ApiError> {
    let client = pool.inner().clone();
    let context = request.resource.query.context.clone();
    let review_resource = request.resource.clone();
    let dialog_window = window.clone();
    manager
        .prepare(
            window.label(),
            request,
            async move {
                client.get_client(&context).await.map_err(
                    |e| ApiError::from_core(e, "node_debug", Some(&context)),
                )
            },
            move |review| {
                let window = dialog_window.clone();
                let resource = review_resource.clone();
                async move { crate::mutation_guard::confirm(window, &resource, review).await }
            },
        )
        .await
}
#[tauri::command]
pub async fn node_debug_status(
    session_id: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, NodeDebugManager>,
) -> Result<Option<NodeDebugState>, ApiError> {
    Ok(manager.status(window.label(), &session_id).await)
}
#[tauri::command]
pub async fn stop_node_debug(
    session_id: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, NodeDebugManager>,
) -> Result<(), ApiError> {
    manager.stop(window.label(), &session_id).await
}
#[tauri::command]
pub async fn list_other_debug_pods(
    context: String,
    namespace: String,
    pool: tauri::State<'_, ClusterClientPool>,
    manager: tauri::State<'_, NodeDebugManager>,
) -> Result<Vec<DebugPod>, ApiError> {
    let client = pool
        .get_client(&context)
        .await
        .map_err(|e| ApiError::from_core(e, "node_debug", Some(&context)))?;
    manager.list_other(client, &context, &namespace).await
}
