use crate::read_tasks::ReadTasks;
use kubiki_core::{
    cluster::client::ClusterClientPool,
    core::api::ApiError,
    helm::{
        model::{HelmRelease, HelmReleaseHistory, HelmRepo},
        reader::{HelmDocument, HelmReader},
    },
};
use std::time::Duration;

/// Pin the same merged configuration used by the native Kubernetes client.
/// The reader owns its private copy through reads and reviewed mutations.
pub(crate) async fn cluster_reader(pool: &ClusterClientPool) -> Result<HelmReader, ApiError> {
    let manager = pool.get_config_manager().clone();
    tokio::task::spawn_blocking(move || HelmReader::default().with_config_manager(&manager))
        .await
        .map_err(|_| {
            ApiError::from_status(500, "Cannot prepare Helm configuration", "helm", None)
        })?
}

#[tauri::command]
pub async fn search_helm_charts(
    query: String,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<serde_json::Value, ApiError> {
    reads
        .run(
            window.label(),
            request_id,
            None,
            "helm",
            Duration::from_secs(65),
            async { HelmReader::default().search_charts(&query).await },
        )
        .await
}

#[tauri::command]
pub async fn get_helm_inventory(
    context: String,
    namespace: Option<String>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<Vec<HelmRelease>, ApiError> {
    reads
        .run(
            window.label(),
            request_id,
            Some(&context),
            "helm",
            Duration::from_secs(65),
            async {
                if let Ok(client) = pool.get_client(&context).await {
                    if let Some(releases) = kubiki_core::helm::storage::list_releases_fast(
                        &client,
                        &context,
                        namespace.as_deref(),
                    )
                    .await
                    {
                        return Ok(releases);
                    }
                }
                cluster_reader(&pool)
                    .await?
                    .inventory(&context, namespace.as_deref())
                    .await
            },
        )
        .await
}

#[tauri::command]
pub async fn get_helm_history(
    context: String,
    namespace: String,
    name: String,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<Vec<HelmReleaseHistory>, ApiError> {
    reads
        .run(
            window.label(),
            request_id,
            Some(&context),
            "helm",
            Duration::from_secs(65),
            async {
                if let Ok(client) = pool.get_client(&context).await {
                    if let Some(history) = kubiki_core::helm::storage::release_history_fast(
                        &client, &context, &namespace, &name,
                    )
                    .await
                    {
                        return Ok(history);
                    }
                }
                cluster_reader(&pool)
                    .await?
                    .history(&context, &namespace, &name)
                    .await
            },
        )
        .await
}

#[tauri::command]
pub async fn get_helm_content(
    context: String,
    namespace: String,
    name: String,
    revision: u32,
    document: HelmDocument,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<String, ApiError> {
    reads
        .run(
            window.label(),
            request_id,
            Some(&context),
            "helm",
            Duration::from_secs(65),
            async {
                if let Ok(client) = pool.get_client(&context).await {
                    if let Some(content) = kubiki_core::helm::storage::release_content_fast(
                        &client, &context, &namespace, &name, revision, document,
                    )
                    .await
                    {
                        return Ok(content);
                    }
                }
                cluster_reader(&pool)
                    .await?
                    .content(&context, &namespace, &name, revision, document)
                    .await
            },
        )
        .await
}

#[tauri::command]
pub async fn list_helm_repositories(
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<Vec<HelmRepo>, ApiError> {
    reads
        .run(
            window.label(),
            request_id,
            None,
            "helm",
            Duration::from_secs(65),
            async { HelmReader::default().repositories().await },
        )
        .await
}
