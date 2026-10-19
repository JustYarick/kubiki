use crate::core::error::KubikiError;
use kube::api::{Api, DynamicObject, ListParams};
use kube::discovery::ApiResource;
use kube::Client;
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
        let ar = ApiResource {
            group: "metrics.k8s.io".into(),
            version: "v1beta1".into(),
            api_version: "metrics.k8s.io/v1beta1".into(),
            kind: "NodeMetrics".into(),
            plural: "nodes".into(),
        };

        let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
        let list = api.list(&ListParams::default()).await.map_err(|e| {
            KubikiError::KubeApiError(format!("Failed to query metrics.k8s.io/v1beta1/nodes: {e}"))
        })?;

        let mut metrics = Vec::new();
        for item in list {
            let name = item.metadata.name.unwrap_or_default();
            let timestamp = item.data.get("timestamp").and_then(|t| t.as_str()).unwrap_or_default().to_string();
            let window = item.data.get("window").and_then(|w| w.as_str()).unwrap_or_default().to_string();

            let usage = item.data.get("usage");
            let cpu = usage.and_then(|u| u.get("cpu")).and_then(|c| c.as_str()).unwrap_or("0").to_string();
            let memory = usage.and_then(|u| u.get("memory")).and_then(|m| m.as_str()).unwrap_or("0").to_string();

            metrics.push(NodeMetricsInfo {
                name,
                timestamp,
                window,
                cpu,
                memory,
            });
        }

        Ok(metrics)
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

        let list = api.list(&ListParams::default()).await.map_err(|e| {
            KubikiError::KubeApiError(format!("Failed to query metrics.k8s.io/v1beta1/pods: {e}"))
        })?;

        let mut metrics = Vec::new();
        for item in list {
            let name = item.metadata.name.unwrap_or_default();
            let ns = item.metadata.namespace.unwrap_or_default();
            let timestamp = item.data.get("timestamp").and_then(|t| t.as_str()).unwrap_or_default().to_string();
            let window = item.data.get("window").and_then(|w| w.as_str()).unwrap_or_default().to_string();

            let mut containers = Vec::new();
            if let Some(cont_list) = item.data.get("containers").and_then(|c| c.as_array()) {
                for c in cont_list {
                    let c_name = c.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string();
                    let usage = c.get("usage");
                    let cpu = usage.and_then(|u| u.get("cpu")).and_then(|val| val.as_str()).unwrap_or("0").to_string();
                    let memory = usage.and_then(|u| u.get("memory")).and_then(|val| val.as_str()).unwrap_or("0").to_string();

                    containers.push(ContainerMetric {
                        name: c_name,
                        cpu,
                        memory,
                    });
                }
            }

            metrics.push(PodMetricsInfo {
                name,
                namespace: ns,
                timestamp,
                window,
                containers,
            });
        }

        Ok(metrics)
    }
}
