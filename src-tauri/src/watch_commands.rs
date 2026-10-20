use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::core::api::{ApiError, ResourceQuery};
use kubiki_core::{InformerManager, WatchBatch};
use std::time::Duration;
use tauri::ipc::Channel;

#[tauri::command]
pub async fn watch_resources(
    query: ResourceQuery,
    subscription_id: String,
    on_event: Channel<WatchBatch>,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    manager: tauri::State<'_, InformerManager>,
) -> Result<(), ApiError> {
    let pool = pool.inner().clone();
    let context = query.context.clone();
    let owner = window.label().to_owned();
    let manager = manager.inner().clone();
    let mut rx = manager
        .start_watch(&owner, &subscription_id, query.clone(), async move {
            pool.get_client(&context)
                .await
                .map_err(|error| ApiError::from_core(error, "watch", Some(&context)))
        })
        .await?;
    tauri::async_runtime::spawn(async move {
        let mut messages = Vec::with_capacity(128);
        let mut timer = tokio::time::interval(Duration::from_millis(50));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let (ended, flush) = tokio::select! {
                message = rx.recv(), if messages.len() < 128 => match message { Some(message) => { messages.push(message); (false, false) }, None => (true, true) },
                _ = timer.tick() => (false, true),
            };
            if !messages.is_empty() && flush {
                let batch = WatchBatch {
                    subscription_id: subscription_id.clone(),
                    query: query.clone(),
                    messages: std::mem::take(&mut messages),
                };
                if on_event.send(batch).is_err() {
                    break;
                }
            }
            if ended {
                break;
            }
        }
        manager.stop_watch(&owner, &subscription_id).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_resource_watch(
    subscription_id: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, InformerManager>,
) -> Result<(), ApiError> {
    manager.stop_watch(window.label(), &subscription_id).await;
    Ok(())
}

/// A fresh page/context connection also cleans subscriptions left by a webview reload.
#[tauri::command]
pub async fn stop_resource_watches(
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, InformerManager>,
) -> Result<(), ApiError> {
    manager.stop_owner(window.label()).await;
    Ok(())
}
