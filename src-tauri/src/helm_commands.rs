use kubiki_core::{
    core::api::ApiError,
    helm::{
        model::{HelmReleaseHistory, HelmRepo},
        reader::{HelmDocument, HelmReader, HelmReleasePage},
    },
};

#[tauri::command]
pub async fn mutate_helm(
    window: tauri::WebviewWindow,
    guard: tauri::State<'_, crate::mutation_guard::MutationGuard>,
    request: kubiki_core::helm::mutations::HelmMutation,
) -> Result<serde_json::Value, ApiError> {
    let resource = request.resource();
    let _guard = guard.acquire(&resource)?;
    let prepared =
        kubiki_core::helm::mutations::PreparedHelmMutation::prepare(HelmReader::default(), request)
            .await?;
    prepared
        .confirm_and_commit(|review| crate::mutation_guard::confirm(window, &resource, review))
        .await
}

#[tauri::command]
pub async fn search_helm_charts(query: String) -> Result<serde_json::Value, ApiError> {
    HelmReader::default().search_charts(&query).await
}

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
