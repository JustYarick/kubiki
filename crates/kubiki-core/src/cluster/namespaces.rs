use crate::core::error::KubikiError;
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
};
use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, ListParams, PostParams};
use kube::Client;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NamespaceInfo {
    pub name: String,
    pub status: String,
    pub creation_timestamp: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CanIRequest {
    pub verb: String,
    pub resource: String,
    pub group: Option<String>,
    pub namespace: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CanIResponse {
    pub allowed: bool,
    pub reason: Option<String>,
}

pub struct NamespaceService;

impl NamespaceService {
    /// List all namespaces accessible in the cluster
    pub async fn list_namespaces(client: &Client) -> Result<Vec<NamespaceInfo>, KubikiError> {
        let api: Api<Namespace> = Api::all(client.clone());
        let list = api.list(&ListParams::default()).await.map_err(KubikiError::from)?;

        let result = list
            .into_iter()
            .map(|ns| {
                let name = ns.metadata.name.unwrap_or_default();
                let status = ns
                    .status
                    .and_then(|s| s.phase)
                    .unwrap_or_else(|| "Active".into());
                let creation_timestamp = ns
                    .metadata
                    .creation_timestamp
                    .map(|t| t.0.to_rfc3339());

                NamespaceInfo {
                    name,
                    status,
                    creation_timestamp,
                }
            })
            .collect();

        Ok(result)
    }

    /// Check if the current user has permission to perform an action (kubectl auth can-i)
    pub async fn can_i(
        client: &Client,
        request: CanIRequest,
    ) -> Result<CanIResponse, KubikiError> {
        let api: Api<SelfSubjectAccessReview> = Api::all(client.clone());
        let review = SelfSubjectAccessReview {
            spec: SelfSubjectAccessReviewSpec {
                resource_attributes: Some(ResourceAttributes {
                    verb: Some(request.verb),
                    resource: Some(request.resource),
                    group: request.group,
                    namespace: request.namespace,
                    ..Default::default()
                }),
                non_resource_attributes: None,
            },
            status: None,
            metadata: Default::default(),
        };

        let response = api.create(&PostParams::default(), &review).await.map_err(KubikiError::from)?;

        let status = response.status.unwrap_or_default();
        Ok(CanIResponse {
            allowed: status.allowed,
            reason: status.reason,
        })
    }
}
