use crate::read_tasks::ReadTasks;
use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::cluster::kubeconfig::KubeContextInfo;
use kubiki_core::cluster::namespaces::NamespaceService;
use kubiki_core::core::api::{ApiError, ApiErrorCode, ResourceQuery};
use kubiki_core::core::read_cache::ReadCache;
use kubiki_core::core::reads::ReadListOptions;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
pub struct ContextReadCache {
    contexts: Mutex<HashMap<String, Arc<ReadCache>>>,
}

impl ContextReadCache {
    pub fn cache_for(&self, context: &str) -> Arc<ReadCache> {
        let mut map = self.contexts.lock().unwrap();
        map.entry(context.to_owned())
            .or_insert_with(|| Arc::new(ReadCache::default()))
            .clone()
    }

    pub fn invalidate(&self, context: &str) {
        if let Some(cache) = self.contexts.lock().unwrap().get(context).cloned() {
            cache.clear();
        }
    }

    pub fn invalidate_all(&self) {
        self.contexts.lock().unwrap().clear();
    }
}

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
pub fn get_kubeconfig_path(pool: tauri::State<'_, ClusterClientPool>) -> Result<String, ApiError> {
    pool.get_config_manager()
        .get_config_path()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|error| ApiError::from_core(error, "get_kubeconfig_path", None))
}

#[tauri::command]
pub async fn set_kubeconfig_path(
    path: Option<String>,
    agents: tauri::State<'_, crate::agent_commands::AgentManager>,
    pool: tauri::State<'_, ClusterClientPool>,
    cache: tauri::State<'_, ContextReadCache>,
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
    agents.invalidate();
    cache.invalidate_all();
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
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<Value, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "ping_cluster",
            Duration::from_secs(30),
            async {
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
            },
        )
        .await
}

#[tauri::command]
pub async fn get_namespaces(
    context: String,
    pool: tauri::State<'_, ClusterClientPool>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<Vec<String>, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "get_namespaces",
            Duration::from_secs(30),
            async {
                require_context(&context, "namespaces")?;
                let names = tokio::time::timeout(std::time::Duration::from_secs(20), async {
                    let client = pool.get_client(&context).await?;
                    NamespaceService::list_namespace_names(&client).await
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
                Ok(names)
            },
        )
        .await
}

async fn read_client(
    pool: &ClusterClientPool,
    cache: &ContextReadCache,
    context: &str,
) -> Result<kube::Client, ApiError> {
    require_context(context, "resources")?;
    let client = tokio::time::timeout(std::time::Duration::from_secs(15), pool.get_client(context))
        .await
        .map_err(|_| {
            ApiError::from_status(
                504,
                "Context connection timed out",
                "resources",
                Some(context),
            )
        })?
        .map_err(|e| ApiError::from_core(e, "resources", Some(context)))?;
    Ok(cache.cache_for(context).wrap(client))
}
#[tauri::command]
pub async fn get_api_resources(
    context: String,
    pool: tauri::State<'_, ClusterClientPool>,
    cache: tauri::State<'_, ContextReadCache>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<Vec<kubiki_core::core::reads::DiscoveredResourceType>, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "get_api_resources",
            Duration::from_secs(30),
            async {
                kubiki_core::core::reads::discover(
                    read_client(&pool, &cache, &context).await?,
                    &context,
                )
                .await
            },
        )
        .await
}
#[tauri::command]
pub async fn get_resources(
    context: String,
    group: String,
    version: String,
    kind: String,
    namespace: Option<String>,
    options: Option<ReadListOptions>,
    pool: tauri::State<'_, ClusterClientPool>,
    cache: tauri::State<'_, ContextReadCache>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<Value, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "get_resources",
            Duration::from_secs(60),
            async {
                let query = ResourceQuery {
                    context,
                    group,
                    version,
                    kind,
                    namespace,
                };
                kubiki_core::core::reads::resources_with_options(
                    read_client(&pool, &cache, &query.context).await?,
                    query,
                    options.unwrap_or_default(),
                )
                .await
            },
        )
        .await
}
#[tauri::command]
pub async fn get_resource(
    context: String,
    group: String,
    version: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    metadata_only: Option<bool>,
    pool: tauri::State<'_, ClusterClientPool>,
    cache: tauri::State<'_, ContextReadCache>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<Value, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "get_resource",
            Duration::from_secs(30),
            async {
                let query = ResourceQuery {
                    context,
                    group,
                    version,
                    kind,
                    namespace,
                };
                kubiki_core::core::reads::get_resource(
                    read_client(&pool, &cache, &query.context).await?,
                    query,
                    name,
                    metadata_only.unwrap_or(false),
                )
                .await
            },
        )
        .await
}
#[tauri::command]
pub async fn get_resource_counts(
    context: String,
    queries: Vec<ResourceQuery>,
    pool: tauri::State<'_, ClusterClientPool>,
    cache: tauri::State<'_, ContextReadCache>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<std::collections::HashMap<String, usize>, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "get_resource_counts",
            Duration::from_secs(30),
            async {
                if queries.len() > 4096 || queries.iter().any(|query| query.context != context) {
                    return Err(ApiError::from_status(
                        400,
                        "Invalid resource count queries",
                        "resource-counts",
                        Some(&context),
                    ));
                }
                let client = read_client(&pool, &cache, &context).await?;
                Ok(kubiki_core::core::reads::resource_counts(client, queries).await)
            },
        )
        .await
}
#[tauri::command]
pub async fn get_custom_resources(
    context: String,
    name: String,
    uid: String,
    namespace: Option<String>,
    options: Option<ReadListOptions>,
    pool: tauri::State<'_, ClusterClientPool>,
    cache: tauri::State<'_, ContextReadCache>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<Value, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "get_custom_resources",
            Duration::from_secs(60),
            async {
                kubiki_core::core::reads::custom_resources_with_options(
                    read_client(&pool, &cache, &context).await?,
                    context,
                    name,
                    uid,
                    namespace,
                    options.unwrap_or_default(),
                )
                .await
            },
        )
        .await
}
#[tauri::command]
pub async fn get_custom_resource(
    context: String,
    crd_name: String,
    uid: String,
    namespace: Option<String>,
    name: String,
    metadata_only: Option<bool>,
    pool: tauri::State<'_, ClusterClientPool>,
    cache: tauri::State<'_, ContextReadCache>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<Value, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "get_custom_resource",
            Duration::from_secs(30),
            async {
                kubiki_core::core::reads::get_custom_resource(
                    read_client(&pool, &cache, &context).await?,
                    context,
                    crd_name,
                    uid,
                    namespace,
                    name,
                    metadata_only.unwrap_or(false),
                )
                .await
            },
        )
        .await
}
#[tauri::command]
pub async fn get_custom_search_inventory(
    context: String,
    namespace: Option<String>,
    pool: tauri::State<'_, ClusterClientPool>,
    cache: tauri::State<'_, ContextReadCache>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<Value, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "get_custom_search_inventory",
            Duration::from_secs(60),
            async {
                kubiki_core::core::reads::custom_search_inventory(
                    read_client(&pool, &cache, &context).await?,
                    context,
                    namespace,
                )
                .await
            },
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
    cache: tauri::State<'_, ContextReadCache>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<String, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "get_pod_logs",
            Duration::from_secs(30),
            async {
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
                let api: Api<Pod> =
                    Api::namespaced(read_client(&pool, &cache, &context).await?, &namespace);
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
            },
        )
        .await
}

#[tauri::command]
pub async fn get_overview_metrics(
    context: String,
    namespace: Option<String>,
    pool: tauri::State<'_, ClusterClientPool>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<kubiki_core::metrics::overview::OverviewMetrics, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "get_overview_metrics",
            Duration::from_secs(30),
            async {
                kubiki_core::metrics::overview::validate_scope(&context, namespace.as_deref())?;
                tokio::time::timeout(std::time::Duration::from_secs(20), async {
                    let client = pool
                        .get_client(&context)
                        .await
                        .map_err(|error| ApiError::from_core(error, "metrics", Some(&context)))?;
                    kubiki_core::metrics::overview::get_overview_metrics(
                        client,
                        context.clone(),
                        namespace,
                    )
                    .await
                })
                .await
                .map_err(|_| {
                    ApiError::from_status(
                        504,
                        "Metrics request timed out",
                        "metrics",
                        Some(&context),
                    )
                })?
            },
        )
        .await
}

#[tauri::command]
pub async fn get_pod_metric(
    context: String,
    namespace: String,
    name: String,
    pool: tauri::State<'_, ClusterClientPool>,
    request_id: Option<String>,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<kubiki_core::metrics::client::PodMetricsInfo, ApiError> {
    let task_context = context.clone();
    reads
        .run(
            window.label(),
            request_id,
            Some(&task_context),
            "get_pod_metric",
            Duration::from_secs(20),
            async {
                require_context(&context, "pod-metric")?;
                if namespace.trim().is_empty() || name.trim().is_empty() {
                    return Err(ApiError::from_status(
                        400,
                        "Pod namespace and name are required",
                        "pod-metric",
                        Some(&context),
                    ));
                }
                tokio::time::timeout(std::time::Duration::from_secs(15), async {
                    let client = pool
                        .get_client(&context)
                        .await
                        .map_err(|error| ApiError::from_core(error, "pod-metric", Some(&context)))?;
                    kubiki_core::metrics::client::MetricsService::get_pod_metric(
                        &client,
                        &namespace,
                        &name,
                    )
                    .await
                    .map_err(|error| ApiError::from_core(error, "pod-metric", Some(&context)))
                })
                .await
                .map_err(|_| {
                    ApiError::from_status(
                        504,
                        "Pod metrics request timed out",
                        "pod-metric",
                        Some(&context),
                    )
                })?
            },
        )
        .await
}
