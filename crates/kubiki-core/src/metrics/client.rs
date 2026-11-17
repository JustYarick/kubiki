use crate::core::error::KubikiError;
use kube::Client;
use kube::api::{Api, DynamicObject, ListParams};
use kube::discovery::ApiResource;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ContainerMetric {
    pub name: String,
    pub cpu: String,
    pub memory: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PodMetricsInfo {
    pub name: String,
    pub namespace: String,
    pub timestamp: String,
    pub window: String,
    pub containers: Vec<ContainerMetric>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NodeMetricsInfo {
    pub name: String,
    pub timestamp: String,
    pub window: String,
    pub cpu: String,
    pub memory: String,
}

pub struct MetricsService;

impl MetricsService {
    /// Retrieve CPU/Memory metrics for all nodes via metrics.k8s.io
    pub async fn get_node_metrics(client: &Client) -> Result<Vec<NodeMetricsInfo>, KubikiError> {
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &node_metrics_resource());
        api.list(&ListParams::default()).await.map_err(KubikiError::from)?
            .into_iter().map(parse_node_metric).collect()
    }

    pub async fn get_node_metric(client: &Client, name: &str) -> Result<NodeMetricsInfo, KubikiError> {
        if name.is_empty() || name.len() > 253 || !name.bytes().all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c)) {
            return Err(KubikiError::Internal("Invalid Node metrics identity".into()));
        }
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &node_metrics_resource());
        parse_node_metric(api.get(name).await.map_err(KubikiError::from)?)
    }

    /// Retrieve CPU/Memory metrics for all pods in a namespace
    pub async fn get_pod_metrics(
        client: &Client,
        namespace: Option<&str>,
    ) -> Result<Vec<PodMetricsInfo>, KubikiError> {
        let ar = ApiResource {
            group: "metrics.k8s.io".into(),
            version: "v1beta1".into(),
            api_version: "metrics.k8s.io/v1beta1".into(),
            kind: "PodMetrics".into(),
            plural: "pods".into(),
        };

        let api: Api<DynamicObject> = match namespace {
            Some(ns) if ns != "all" => Api::namespaced_with(client.clone(), ns, &ar),
            _ => Api::all_with(client.clone(), &ar),
        };

        let list = api
            .list(&ListParams::default())
            .await
            .map_err(KubikiError::from)?;

        list.into_iter().map(parse_pod_metric).collect()
    }

    pub async fn get_pod_metric(
        client: &Client,
        namespace: &str,
        name: &str,
    ) -> Result<PodMetricsInfo, KubikiError> {
        if [namespace, name].iter().any(|s| {
            s.is_empty()
                || s.len() > 253
                || !s
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
        }) {
            return Err(KubikiError::Internal("Invalid metrics identity".into()));
        }
        let ar = ApiResource {
            group: "metrics.k8s.io".into(),
            version: "v1beta1".into(),
            api_version: "metrics.k8s.io/v1beta1".into(),
            kind: "PodMetrics".into(),
            plural: "pods".into(),
        };
        let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), namespace, &ar);
        parse_pod_metric(api.get(name).await.map_err(KubikiError::from)?)
    }
}

fn parse_pod_metric(item: DynamicObject) -> Result<PodMetricsInfo, KubikiError> {
    let name = item.metadata.name.unwrap_or_default();
    let ns = item.metadata.namespace.unwrap_or_default();
    let timestamp = item
        .data
        .get("timestamp")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    let window = item
        .data
        .get("window")
        .and_then(|w| w.as_str())
        .unwrap_or_default()
        .to_string();

    let mut containers = Vec::new();
    if let Some(cont_list) = item.data.get("containers").and_then(|c| c.as_array()) {
        for c in cont_list {
            let c_name = c
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or_default()
                .to_string();
            let usage = c.get("usage");
            let cpu = usage
                .and_then(|u| u.get("cpu"))
                .and_then(|val| val.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    KubikiError::Internal(
                        "Metrics API returned a missing CPU or memory quantity".into(),
                    )
                })?
                .to_string();
            let memory = usage
                .and_then(|u| u.get("memory"))
                .and_then(|val| val.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    KubikiError::Internal(
                        "Metrics API returned a missing CPU or memory quantity".into(),
                    )
                })?
                .to_string();

            containers.push(ContainerMetric {
                name: c_name,
                cpu,
                memory,
            });
        }
    }

    Ok(PodMetricsInfo {
        name,
        namespace: ns,
        timestamp,
        window,
        containers,
    })
}

fn node_metrics_resource() -> ApiResource {
    ApiResource { group: "metrics.k8s.io".into(), version: "v1beta1".into(), api_version: "metrics.k8s.io/v1beta1".into(), kind: "NodeMetrics".into(), plural: "nodes".into() }
}
fn parse_node_metric(item: DynamicObject) -> Result<NodeMetricsInfo, KubikiError> {
    let value = |key: &str| item.data["usage"][key].as_str().filter(|v| !v.is_empty()).map(str::to_owned)
        .ok_or_else(|| KubikiError::Internal("Metrics API returned a missing CPU or memory quantity".into()));
    Ok(NodeMetricsInfo { name: item.metadata.name.clone().unwrap_or_default(), timestamp: item.data["timestamp"].as_str().unwrap_or_default().into(), window: item.data["window"].as_str().unwrap_or_default().into(), cpu: value("cpu")?, memory: value("memory")? })
}
