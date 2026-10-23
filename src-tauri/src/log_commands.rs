//! Pod log reads for the polling viewer. Every command is a bounded one-shot slice.
use kubiki_core::{
    cluster::client::ClusterClientPool,
    core::api::ApiError,
    pod_ops::logs::LogSliceRequest,
};
use serde_json::Value;

#[tauri::command]
pub async fn get_pod_log_slice(
    request: LogSliceRequest,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<Value, ApiError> {
    let connect_context = request.resource.query.context.clone();
    let client = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        pool.get_client(&connect_context),
    )
    .await
    .map_err(|_| {
        ApiError::from_status(504, "Context connection timed out", "logs", Some(&connect_context))
    })?
    .map_err(|e| ApiError::from_core(e, "logs", Some(&connect_context)))?;
    let text = request.read(client).await?;
    serde_json::to_value(text).map_err(|_| {
        ApiError::from_status(500, "Cannot encode the log slice", "logs", Some(&connect_context))
    })
}
