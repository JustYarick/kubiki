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
pub async fn get_api_resources(context: String) -> Result<String, ApiError> {
    require_context(&context, "api-resources")?;
    kubectl(
        &[
            "--context".into(),
            context.clone(),
            "api-resources".into(),
            "--verbs=list".into(),
            "-o".into(),
            "wide".into(),
            "--no-headers".into(),
        ],
        "api-resources",
        &context,
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
pub async fn get_custom_resources(
    context: String,
    name: String,
    uid: String,
    namespace: Option<String>,
) -> Result<Value, ApiError> {
    let invalid = |message: &str| {
        ApiError::new(
            ApiErrorCode::InvalidRequest,
            message,
            "custom-resources",
            Some(&context),
            Some(400),
        )
    };
    let valid_name = |value: &str| {
        !value.is_empty()
            && value.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && value
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
    };
    if context.trim().is_empty() || !valid_name(&name) || uid.is_empty() {
        return Err(invalid("Context, CRD name and UID are required"));
    }
    if let Some(namespace) = &namespace {
        if namespace.is_empty()
            || namespace.len() > 63
            || namespace.starts_with('-')
            || namespace.ends_with('-')
            || !namespace
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err(invalid("Invalid namespace"));
        }
    }
    let args = vec![
        "--context".into(),
        context.clone(),
        "get".into(),
        format!("customresourcedefinitions.apiextensions.k8s.io/{name}"),
        "-o".into(),
        "json".into(),
    ];
    let output = kubectl(&args, "custom-resources", &context).await?;
    let crd: Value = serde_json::from_str(&output).map_err(|_| invalid("Invalid CRD response"))?;
    if crd["metadata"]["uid"].as_str() != Some(uid.as_str()) {
        return Err(ApiError::from_status(
            409,
            "This CRD has been replaced. Refresh the resource list.",
            "custom-resources",
            Some(&context),
        ));
    }
    let group = crd["spec"]["group"].as_str().unwrap_or("");
    let plural = crd["spec"]["names"]["plural"].as_str().unwrap_or("");
    let scope = crd["spec"]["scope"].as_str().unwrap_or("");
    if !valid_name(group) || !valid_name(plural) || !matches!(scope, "Namespaced" | "Cluster") {
        return Err(invalid("Invalid CRD definition"));
    }
    let mut args = vec![
        "--context".into(),
        context.clone(),
        "get".into(),
        format!("{plural}.{group}"),
        "-o".into(),
        "json".into(),
    ];
    if scope == "Namespaced" {
        match namespace {
            Some(namespace) => args.extend(["-n".into(), namespace]),
            None => args.push("-A".into()),
        }
    }
    let output = kubectl(&args, "custom-resources", &context).await?;
    serde_json::from_str(&output).map_err(|_| invalid("Invalid custom resource list"))
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
