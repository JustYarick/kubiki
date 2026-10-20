use kubiki_core::{
    core::api::ApiError,
    helm::{
        model::{HelmReleaseHistory, HelmRepo},
        reader::{HelmDocument, HelmReader, HelmReleasePage},
    },
};

#[tauri::command]
pub async fn list_helm_releases(
    context: String,
    namespace: Option<String>,
    offset: usize,
) -> Result<HelmReleasePage, ApiError> {
    HelmReader::default()
        .releases(&context, namespace.as_deref(), offset)
        .await
}

#[tauri::command]
pub async fn get_helm_history(
    context: String,
    namespace: String,
    name: String,
) -> Result<Vec<HelmReleaseHistory>, ApiError> {
    HelmReader::default()
        .history(&context, &namespace, &name)
        .await
}

#[tauri::command]
pub async fn get_helm_content(
    context: String,
    namespace: String,
    name: String,
    revision: u32,
    document: HelmDocument,
) -> Result<String, ApiError> {
    HelmReader::default()
        .content(&context, &namespace, &name, revision, document)
        .await
}

#[tauri::command]
pub async fn list_helm_repositories() -> Result<Vec<HelmRepo>, ApiError> {
    HelmReader::default().repositories().await
}
