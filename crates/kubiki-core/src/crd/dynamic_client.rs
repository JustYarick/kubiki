use crate::core::error::KubikiError;
use kube::api::{Api, DynamicObject, ListParams};
use kube::discovery::ApiResource;
use kube::Client;
use serde_json::Value;

pub struct DynamicCrdService;

impl DynamicCrdService {
    /// List all instances of any custom resource definition dynamically
    pub async fn list_instances(
        client: Client,
        group: &str,
        version: &str,
        plural: &str,
        kind: &str,
        namespace: Option<&str>,
    ) -> Result<Vec<Value>, KubikiError> {
        let ar = ApiResource {
            group: group.to_string(),
            version: version.to_string(),
            api_version: format!("{}/{}", group, version),
            kind: kind.to_string(),
            plural: plural.to_string(),
        };

        let api: Api<DynamicObject> = match namespace {
            Some(ns) if ns != "all" => Api::namespaced_with(client, ns, &ar),
            _ => Api::all_with(client, &ar),
        };

        let list = api.list(&ListParams::default()).await.map_err(|e| {
            KubikiError::KubeApiError(format!("Failed to list dynamic CRD instances: {e}"))
        })?;

        let items: Vec<Value> = list
            .into_iter()
            .filter_map(|obj| serde_json::to_value(obj).ok())
            .collect();

        Ok(items)
    }
}
