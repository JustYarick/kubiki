use crate::core::error::KubikiError;
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CrdPrinterColumn {
    pub name: String,
    pub type_: String,
    pub json_path: String,
    pub description: Option<String>,
    pub priority: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CrdVersionInfo {
    pub name: String,
    pub served: bool,
    pub storage: bool,
    pub printer_columns: Vec<CrdPrinterColumn>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CrdInfo {
    pub name: String,
    pub group: String,
    pub kind: String,
    pub plural: String,
    pub singular: Option<String>,
    pub scope: String, // Namespaced or Cluster
    pub versions: Vec<CrdVersionInfo>,
}

pub struct CrdDiscoveryService;

impl CrdDiscoveryService {
    /// Discover all CRDs registered in the cluster
    pub async fn list_crds(client: &Client) -> Result<Vec<CrdInfo>, KubikiError> {
        let crd_api: Api<CustomResourceDefinition> = Api::all(client.clone());
        let list = crd_api.list(&ListParams::default()).await.map_err(|e| {
            KubikiError::KubeApiError(format!("Failed to list CustomResourceDefinitions: {e}"))
        })?;

        let mut crds = Vec::new();
        for item in list {
            let spec = item.spec;
            let group = spec.group;
            let kind = spec.names.kind;
            let plural = spec.names.plural;
            let singular = spec.names.singular;
            let scope = spec.scope;
            let name = item.metadata.name.unwrap_or_default();

            let versions = spec
                .versions
                .into_iter()
                .map(|v| {
                    let printer_columns = v
                        .additional_printer_columns
                        .unwrap_or_default()
                        .into_iter()
                        .map(|c| CrdPrinterColumn {
                            name: c.name,
                            type_: c.type_,
                            json_path: c.json_path,
                            description: c.description,
                            priority: c.priority.unwrap_or(0),
                        })
                        .collect();

                    CrdVersionInfo {
                        name: v.name,
                        served: v.served,
                        storage: v.storage,
                        printer_columns,
                    }
                })
                .collect();

            crds.push(CrdInfo {
                name,
                group,
                kind,
                plural,
                singular,
                scope,
                versions,
            });
        }

        crds.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(crds)
    }
}
