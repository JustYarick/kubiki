use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::core::api::{ApiError, ResourceQuery};
use kubiki_core::{InformerManager, WatchBatch};
use std::time::Duration;
use tauri::ipc::Channel;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomWatchDefinition {
    name: String,
    uid: String,
}

#[tauri::command]
pub async fn watch_resources(
    query: ResourceQuery,
    subscription_id: String,
    custom_resource: Option<CustomWatchDefinition>,
    on_event: Channel<WatchBatch>,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    manager: tauri::State<'_, InformerManager>,
) -> Result<(), ApiError> {
    let pool = pool.inner().clone();
    let context = query.context.clone();
    let owner = window.label().to_owned();
    let manager = manager.inner().clone();
    let mut rx = if let Some(definition) = custom_resource {
        let expected = query.clone();
        manager
            .start_resolved_watch(&owner, &subscription_id, query.clone(), async move {
                let client = pool
                    .get_client(&context)
                    .await
                    .map_err(|error| ApiError::from_core(error, "watch", Some(&context)))?;
                let (resolved, resource, namespaced) =
                    kubiki_core::core::reads::resolve_custom_resource(
                        client.clone(),
                        context.clone(),
                        definition.name,
                        definition.uid,
                        expected.namespace.clone(),
                    )
                    .await?;
                if resolved.group != expected.group
                    || resolved.version != expected.version
                    || resolved.kind != expected.kind
                    || resolved.namespace != expected.namespace
                {
                    return Err(ApiError::from_status(
                        409,
                        "CRD identity or served version changed; refresh the definition",
                        "watch",
                        Some(&context),
                    ));
                }
                Ok((client, Some((resource, namespaced))))
            })
            .await?
    } else {
        manager
            .start_watch(&owner, &subscription_id, query.clone(), async move {
                pool.get_client(&context)
                    .await
                    .map_err(|error| ApiError::from_core(error, "watch", Some(&context)))
            })
            .await?
    };
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
