use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_core::cluster::kubeconfig::{KubeConfigManager, KubeContextInfo};
use kubiki_core::cluster::namespaces::NamespaceService;
use kubiki_core::core::api::{ApiError, ApiErrorCode, ResourceQuery, validate_query};
use serde_json::Value;
use tokio::process::Command;

async fn kubectl(args: &[String], operation: &str, context: &str) -> Result<String, ApiError> {
    let mut command = Command::new("kubectl");
    command
        .args(args)
        .arg("--request-timeout=10s")
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), command.output())
        .await
        .map_err(|_| {
            ApiError::from_status(504, "kubectl request timed out", operation, Some(context))
        })?
        .map_err(|error| {
            let (code, message) = if error.kind() == std::io::ErrorKind::NotFound {
                (
                    ApiErrorCode::BridgeUnavailable,
                    "kubectl is not installed or is not available in PATH.".to_owned(),
                )
            } else {
                (ApiErrorCode::Internal, error.to_string())
            };
            ApiError::new(code, message, operation, Some(context), Some(503))
        })?;
    if !output.status.success() {
        return Err(ApiError::from_kubectl(
            String::from_utf8_lossy(&output.stderr).trim(),
            operation,
            Some(context),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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
pub fn get_kube_contexts() -> Result<Vec<KubeContextInfo>, ApiError> {
    KubeConfigManager::new()
        .list_contexts()
        .map_err(|error| ApiError::from_core(error, "contexts", None))
}

#[tauri::command]
pub fn get_current_context() -> Result<Option<String>, ApiError> {
    KubeConfigManager::new()
        .get_current_context()
        .map_err(|error| ApiError::from_core(error, "current_context", None))
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

#[tauri::command]
pub async fn get_resources(
    context: String,
    group: String,
    version: String,
    kind: String,
    namespace: Option<String>,
) -> Result<Value, ApiError> {
    let query = ResourceQuery {
        context,
        group,
        version,
        kind,
        namespace,
    };
    let resource = validate_query(&query)?;
    // Qualified plural avoids ambiguity between built-in kinds and similarly named CRDs.
    let plural = if resource.group.is_empty() {
        resource.plural.clone()
    } else {
        format!("{}.{}", resource.plural, resource.group)
    };
    let mut args = vec![
        "--context".into(),
        query.context.clone(),
        "get".into(),
        plural,
        "-o".into(),
        "json".into(),
    ];
    if resource.namespaced {
        match &query.namespace {
            Some(namespace) if namespace != "all" && !namespace.is_empty() => {
                args.extend(["-n".into(), namespace.clone()])
            }
            _ => args.push("-A".into()),
        }
    }
    let output = kubectl(&args, "resources", &query.context)
        .await
        .map_err(|error| error.with_resource(&query))?;
    serde_json::from_str(&output).map_err(|error| {
        ApiError::new(
            ApiErrorCode::Internal,
            format!("Invalid Kubernetes JSON: {error}"),
            "resources",
            Some(&query.context),
            None,
        )
        .with_resource(&query)
    })
}

#[tauri::command]
pub async fn scale_workload(
    context: String,
    kind: String,
    name: String,
    namespace: String,
    replicas: i32,
) -> Result<String, ApiError> {
    require_context(&context, "scale")?;
    let target = match kind.as_str() {
        "Deployment" => "deployments.apps",
        "StatefulSet" => "statefulsets.apps",
        _ => {
            return Err(ApiError::from_status(
                400,
                "Only Deployment and StatefulSet can be scaled",
                "scale",
                Some(&context),
            ));
        }
    };
    if name.is_empty() || namespace.is_empty() || !(0..=100000).contains(&replicas) {
        return Err(ApiError::from_status(
            400,
            "Invalid scale request",
            "scale",
            Some(&context),
        ));
    }
    let args = vec![
        "--context".into(),
        context.clone(),
        "scale".into(),
        target.into(),
        name.clone(),
        "-n".into(),
        namespace,
        format!("--replicas={replicas}"),
    ];
    kubectl(&args, "scale", &context).await?;
    Ok(format!("{target}/{name} scaled to {replicas}"))
}

#[tauri::command]
pub async fn get_pod_logs(
    context: String,
    name: String,
    namespace: String,
    container: Option<String>,
) -> Result<String, ApiError> {
    require_context(&context, "logs")?;
    if name.is_empty() || namespace.is_empty() {
        return Err(ApiError::from_status(
            400,
            "Pod name and namespace are required",
            "logs",
            Some(&context),
        ));
    }
    let mut args = vec![
        "--context".into(),
        context.clone(),
        "logs".into(),
        format!("pod/{name}"),
        "-n".into(),
        namespace,
        "--tail=500".into(),
        "--timestamps=true".into(),
    ];
    if let Some(container) = container {
        args.extend(["-c".into(), container]);
    }
    kubectl(&args, "logs", &context).await
}

#[tauri::command]
pub async fn update_secret_data(
    request: kubiki_core::core::secret_data::SecretDataRequest,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<k8s_openapi::api::core::v1::Secret, ApiError> {
    request.validate()?;
    let context = request.resource.query.context.clone();
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let client = pool.get_client(&context).await.map_err(|_| ApiError::from_status(503, "Cannot connect to Secret context", "secret_data", Some(&context)))?;
        kubiki_core::core::secret_data::update_secret_data(client, request).await
    }).await.map_err(|_| ApiError::from_status(504, "Secret update timed out. Refresh to verify the saved state", "secret_data", Some(&context)))?
}
