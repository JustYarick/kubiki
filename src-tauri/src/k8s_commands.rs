use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::cluster::kubeconfig::KubeContextInfo;
use kubiki_core::cluster::namespaces::NamespaceService;
use kubiki_core::core::api::{ApiError, ApiErrorCode, ResourceQuery};
use serde_json::Value;

fn require_context(context: &str, operation: &str) -> Result<(), ApiError> {
    if context.trim().is_empty() {
        return Err(ApiError::from_status(
            400,
            "A Kubernetes context is required",
            operation,
            Some(context),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn get_kube_contexts(
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<Vec<KubeContextInfo>, ApiError> {
    pool.get_config_manager()
        .list_contexts()
        .map_err(|error| ApiError::from_core(error, "contexts", None))
}

#[tauri::command]
pub fn get_current_context(
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<Option<String>, ApiError> {
    pool.get_config_manager()
        .get_current_context()
        .map_err(|error| ApiError::from_core(error, "current_context", None))
}

#[tauri::command]
pub fn get_kubeconfig_path(
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<String, ApiError> {
    pool.get_config_manager()
        .get_config_path()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|error| ApiError::from_core(error, "get_kubeconfig_path", None))
}

#[tauri::command]
pub async fn set_kubeconfig_path(
    path: Option<String>,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<Vec<KubeContextInfo>, ApiError> {
    let path_buf = path.and_then(|p| {
        let trimmed = p.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(std::path::PathBuf::from(trimmed))
        }
    });
    if let Some(ref pb) = path_buf {
        if !pb.exists() {
            return Err(ApiError::from_status(
                400,
                format!("Kubeconfig file not found at {}", pb.display()),
                "set_kubeconfig_path",
                None,
            ));
        }
    }
    pool.set_custom_kubeconfig_path(path_buf);
    pool.invalidate_all().await;
    pool.get_config_manager()
        .list_contexts()
        .map_err(|error| ApiError::from_core(error, "contexts", None))
}

#[tauri::command]
pub async fn ping_cluster(
    context: String,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<Value, ApiError> {
    require_context(&context, "ping")?;
    let version = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        pool.check_health(&context),
    )
    .await
    .map_err(|_| {
        ApiError::from_status(
            504,
            "Cluster health request timed out",
            "ping",
            Some(&context),
        )
    })?
    .map_err(|error| ApiError::from_core(error, "ping", Some(&context)))?;
    serde_json::to_value(version).map_err(|error| {
        ApiError::new(
            ApiErrorCode::Internal,
            error.to_string(),
            "ping",
            Some(&context),
            None,
        )
    })
}

#[tauri::command]
pub async fn get_namespaces(
    context: String,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<Vec<String>, ApiError> {
    require_context(&context, "namespaces")?;
    let namespaces = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let client = pool.get_client(&context).await?;
        NamespaceService::list_namespaces(&client).await
    })
    .await
    .map_err(|_| {
        ApiError::from_status(
            504,
            "Namespace discovery timed out",
            "namespaces",
            Some(&context),
        )
    })?
    .map_err(|error| ApiError::from_core(error, "namespaces", Some(&context)))?;
    Ok(namespaces
        .into_iter()
        .map(|namespace| namespace.name)
        .collect())
}

async fn read_client(pool: &ClusterClientPool, context: &str) -> Result<kube::Client, ApiError> {
    require_context(context, "resources")?;
    tokio::time::timeout(std::time::Duration::from_secs(15), pool.get_client(context))
        .await
        .map_err(|_| {
            ApiError::from_status(
                504,
                "Context connection timed out",
                "resources",
                Some(context),
            )
        })?
        .map_err(|e| ApiError::from_core(e, "resources", Some(context)))
}
#[tauri::command]
pub async fn get_api_resources(
    context: String,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<Vec<kubiki_core::core::reads::DiscoveredResourceType>, ApiError> {
    kubiki_core::core::reads::discover(read_client(&pool, &context).await?, &context).await
}
#[tauri::command]
pub async fn get_resources(
    context: String,
    group: String,
    version: String,
    kind: String,
    namespace: Option<String>,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<Value, ApiError> {
    let query = ResourceQuery {
        context,
        group,
        version,
        kind,
        namespace,
    };
    kubiki_core::core::reads::resources(read_client(&pool, &query.context).await?, query).await
}
#[tauri::command]
pub async fn get_resource_counts(
    context: String,
    queries: Vec<ResourceQuery>,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<std::collections::HashMap<String, usize>, ApiError> {
    let client = read_client(&pool, &context).await?;
    Ok(kubiki_core::core::reads::resource_counts(client, queries).await)
}
#[tauri::command]
pub async fn get_custom_resources(
    context: String,
    name: String,
    uid: String,
    namespace: Option<String>,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<Value, ApiError> {
    kubiki_core::core::reads::custom_resources(
        read_client(&pool, &context).await?,
        context,
        name,
        uid,
        namespace,
    )
    .await
}
#[tauri::command]
pub async fn get_pod_logs(
    context: String,
    name: String,
    namespace: String,
    container: Option<String>,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<String, ApiError> {
    use k8s_openapi::api::core::v1::Pod;
    use kube::{Api, api::LogParams};
    require_context(&context, "logs")?;
    if name.is_empty() || namespace.is_empty() {
        return Err(ApiError::from_status(
            400,
            "Pod name and namespace are required",
            "logs",
            Some(&context),
        ));
    }
    let api: Api<Pod> = Api::namespaced(read_client(&pool, &context).await?, &namespace);
    kubiki_core::core::reads::bounded(
        &context,
        "logs",
        api.logs(
            &name,
            &LogParams {
                container,
                tail_lines: Some(500),
                timestamps: true,
                limit_bytes: Some(4 * 1024 * 1024),
                ..LogParams::default()
            },
        ),
    )
    .await
}

#[tauri::command]
pub async fn get_overview_metrics(
    context: String,
    namespace: Option<String>,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<kubiki_core::metrics::overview::OverviewMetrics, ApiError> {
    kubiki_core::metrics::overview::validate_scope(&context, namespace.as_deref())?;
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let client = pool
            .get_client(&context)
            .await
            .map_err(|error| ApiError::from_core(error, "metrics", Some(&context)))?;
        kubiki_core::metrics::overview::get_overview_metrics(client, context.clone(), namespace)
            .await
    })
    .await
    .map_err(|_| {
        ApiError::from_status(504, "Metrics request timed out", "metrics", Some(&context))
    })?
}
