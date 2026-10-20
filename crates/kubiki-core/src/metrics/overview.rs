use super::client::{MetricsService, NodeMetricsInfo, PodMetricsInfo};
use crate::core::api::{ApiError, ResourceQuery, validate_query};
use kube::Client;
use serde::Serialize;
use std::{future::Future, time::Duration};

#[derive(Serialize)]
pub struct MetricSource<T> {
    pub items: Option<Vec<T>>,
    pub error: Option<ApiError>,
}
#[derive(Serialize)]
pub struct OverviewMetrics {
    pub context: String,
    pub namespace: Option<String>,
    pub nodes: MetricSource<NodeMetricsInfo>,
    pub pods: MetricSource<PodMetricsInfo>,
}
async fn source<T>(
    context: &str,
    operation: &str,
    future: impl Future<Output = Result<Vec<T>, crate::KubikiError>>,
) -> MetricSource<T> {
    match tokio::time::timeout(Duration::from_secs(15), future).await {
        Ok(Ok(items)) => MetricSource {
            items: Some(items),
            error: None,
        },
        Ok(Err(error)) => MetricSource {
            items: None,
            error: Some(ApiError::from_core(error, operation, Some(context))),
        },
        Err(_) => MetricSource {
            items: None,
            error: Some(ApiError::from_status(
                504,
                "Metrics request timed out",
                operation,
                Some(context),
            )),
        },
    }
}
pub fn validate_scope(context: &str, namespace: Option<&str>) -> Result<(), ApiError> {
    validate_query(&ResourceQuery {
        context: context.into(),
        group: String::new(),
        version: "v1".into(),
        kind: "Pod".into(),
        namespace: namespace.map(str::to_owned),
    })?;
    if namespace == Some("all") {
        return Err(ApiError::from_status(
            400,
            "Use null for All Namespaces",
            "metrics",
            Some(context),
        ));
    }
    Ok(())
}
pub async fn get_overview_metrics(
    client: Client,
    context: String,
    namespace: Option<String>,
) -> Result<OverviewMetrics, ApiError> {
    validate_scope(&context, namespace.as_deref())?;
    let pods = source(
        &context,
        "pod_metrics",
        MetricsService::get_pod_metrics(&client, namespace.as_deref()),
    );
    let nodes = async {
        if namespace.is_none() {
            source(
                &context,
                "node_metrics",
                MetricsService::get_node_metrics(&client),
            )
            .await
        } else {
            MetricSource {
                items: None,
                error: None,
            }
        }
    };
    let (pods, nodes) = tokio::join!(pods, nodes);
    Ok(OverviewMetrics {
        context,
        namespace,
        nodes,
        pods,
    })
}
