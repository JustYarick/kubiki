//! Common resource resolution for UI and agent reads. No AI policy or credentials.
use super::api::ResourceQuery;
use kube::{
    Api, Client,
    api::{ApiResource, DynamicObject},
    discovery::{Discovery, Scope},
};

pub async fn resolve_api(
    client: Client,
    query: &ResourceQuery,
    allow_all_namespaces: bool,
) -> Result<(Api<DynamicObject>, bool, ApiResource), String> {
    let valid = |s: &str, empty: bool| {
        (empty || !s.is_empty())
            && s.len() <= 253
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
    };
    if !valid(&query.group, true)
        || !valid(&query.version, false)
        || !valid(&query.kind, false)
        || query.namespace.as_ref().is_some_and(|s| !valid(s, false))
    {
        return Err("Invalid resource identity".into());
    }
    let builtin = super::api::resource_type(&query.kind).filter(|r| r.group == query.group);
    let (ar, namespaced) = if let Some(known) = builtin {
        if known.version != query.version {
            // Discovery validates non-default served versions too.
            let discovery = Discovery::new(client.clone())
                .filter(&[&query.group])
                .run()
                .await
                .map_err(|_| "API discovery failed")?;
            let group = discovery
                .groups()
                .find(|g| g.name() == query.group)
                .ok_or("Unknown API group")?;
            group
                .resources_by_stability()
                .into_iter()
                .find(|(r, _)| r.kind == query.kind && r.version == query.version)
                .map(|(r, c)| (r, c.scope == Scope::Namespaced))
                .ok_or("Unsupported resource version")?
        } else {
            (
                ApiResource {
                    group: query.group.clone(),
                    version: query.version.clone(),
                    api_version: if query.group.is_empty() {
                        query.version.clone()
                    } else {
                        format!("{}/{}", query.group, query.version)
                    },
                    kind: query.kind.clone(),
                    plural: known.plural.clone(),
                },
                known.namespaced,
            )
        }
    } else {
        let discovery = Discovery::new(client.clone())
            .filter(&[&query.group])
            .run()
            .await
            .map_err(|_| "API discovery failed")?;
        let group = discovery
            .groups()
            .find(|g| g.name() == query.group)
            .ok_or("Unknown API group")?;
        group
            .resources_by_stability()
            .into_iter()
            .find(|(r, _)| r.kind == query.kind && r.version == query.version)
            .map(|(r, c)| (r, c.scope == Scope::Namespaced))
            .ok_or("Unknown resource kind/version")?
    };
    if (namespaced && query.namespace.is_none() && !allow_all_namespaces)
        || (!namespaced && query.namespace.is_some())
    {
        return Err("Specify one explicit namespace for namespaced resources; cluster resources require null namespace".into());
    }
    let resource_api = if let Some(ns) = &query.namespace {
        Api::namespaced_with(client, ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };
    Ok((resource_api, builtin.is_some(), ar))
}

/// Shared transport contract. Authorization and egress projection stay with the caller.
pub struct ResourceAccess {
    api: Api<DynamicObject>,
    pub builtin: bool,
    resource: ApiResource,
}
pub struct ResourcePage {
    pub items: Vec<serde_json::Value>,
    pub continuation: Option<String>,
    pub resource_version: Option<String>,
}
fn validate_name(name: &str) -> Result<(), kube::Error> {
    if name.is_empty()
        || name.len() > 253
        || matches!(name, "." | "..")
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-.:_".contains(&c))
    {
        Err(kube::Error::Api(kube::error::ErrorResponse {
            status: "Failure".into(),
            message: "Invalid resource name".into(),
            reason: "BadRequest".into(),
            code: 400,
        }))
    } else {
        Ok(())
    }
}
impl ResourceAccess {
    pub async fn new(
        client: Client,
        query: &ResourceQuery,
        allow_all_namespaces: bool,
    ) -> Result<Self, String> {
        let (api, builtin, resource) = resolve_api(client, query, allow_all_namespaces).await?;
        Ok(Self {
            api,
            builtin,
            resource,
        })
    }
    pub fn from_resource(client: Client, query: &ResourceQuery, resource: ApiResource) -> Self {
        let api = if let Some(ns) = &query.namespace {
            Api::namespaced_with(client, ns, &resource)
        } else {
            Api::all_with(client, &resource)
        };
        Self {
            api,
            builtin: false,
            resource,
        }
    }
    fn metadata_value(&self, metadata: kube::core::ObjectMeta) -> serde_json::Value {
        serde_json::json!({"apiVersion":self.resource.api_version,"kind":self.resource.kind,"metadata":metadata})
    }
    pub async fn get_object(&self, name: &str) -> Result<DynamicObject, kube::Error> {
        validate_name(name)?;
        self.api.get(name).await
    }
    pub async fn get_optional(&self, name: &str) -> Result<Option<DynamicObject>, kube::Error> {
        validate_name(name)?;
        self.api.get_opt(name).await
    }
    pub async fn list_metadata(
        &self,
        params: &kube::api::ListParams,
    ) -> Result<kube::api::ObjectList<kube::core::PartialObjectMeta<DynamicObject>>, kube::Error>
    {
        self.api.list_metadata(params).await
    }
    pub async fn get(
        &self,
        name: &str,
        metadata_only: bool,
    ) -> Result<serde_json::Value, kube::Error> {
        validate_name(name)?;
        if metadata_only {
            return Ok(self.metadata_value(self.api.get_metadata(name).await?.metadata));
        }
        let mut item = self.api.get(name).await?;
        item.types = Some(kube::core::TypeMeta {
            api_version: self.resource.api_version.clone(),
            kind: self.resource.kind.clone(),
        });
        serde_json::to_value(item).map_err(kube::Error::SerdeError)
    }
    pub async fn page(
        &self,
        params: &kube::api::ListParams,
        metadata_only: bool,
    ) -> Result<ResourcePage, kube::Error> {
        if metadata_only {
            let page = self.api.list_metadata(params).await?;
            return Ok(ResourcePage {
                items: page
                    .items
                    .into_iter()
                    .map(|item| self.metadata_value(item.metadata))
                    .collect(),
                continuation: page.metadata.continue_.filter(|s| !s.is_empty()),
                resource_version: page.metadata.resource_version,
            });
        }
        let page = self.api.list(params).await?;
        let items = page
            .items
            .into_iter()
            .map(|mut item| {
                item.types = Some(kube::core::TypeMeta {
                    api_version: self.resource.api_version.clone(),
                    kind: self.resource.kind.clone(),
                });
                serde_json::to_value(item)
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(kube::Error::SerdeError)?;
        Ok(ResourcePage {
            items,
            continuation: page.metadata.continue_.filter(|s| !s.is_empty()),
            resource_version: page.metadata.resource_version,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::client::Body;
    use serde_json::json;
    #[test]
    fn names_allow_rbac_identities_but_cannot_change_http_paths() {
        assert!(validate_name("system:discovery").is_ok());
        for name in [".", "..", "../secrets", "a?watch=true", "a/b", ""] {
            assert!(validate_name(name).is_err());
        }
    }
    #[tokio::test]
    async fn metadata_and_full_reads_share_transport_without_body_fallback_or_extra_gets() {
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        let client = Client::new(
            tower::service_fn(move |req: http::Request<Body>| {
                let metadata = req
                    .headers()
                    .get("accept")
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.contains("PartialObjectMetadata"));
                seen.lock().unwrap().push((req.uri().to_string(), metadata));
                async move {
                    let value = if metadata {
                        json!({"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadataList","metadata":{},"items":[{"metadata":{"name":"web","uid":"1"}}]})
                    } else {
                        json!({"apiVersion":"v1","kind":"PodList","metadata":{"continue":"next"},"items":[{"metadata":{"name":"web","uid":"1"},"status":{"phase":"Pending"}}]})
                    };
                    Ok::<_, std::convert::Infallible>(
                        http::Response::builder()
                            .status(200)
                            .body(Body::from(serde_json::to_vec(&value).unwrap()))
                            .unwrap(),
                    )
                }
            }),
            "default",
        );
        let query = ResourceQuery {
            context: "prod".into(),
            group: "".into(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: Some("apps".into()),
        };
        let access = ResourceAccess::new(client, &query, false).await.unwrap();
        let params = kube::api::ListParams::default().limit(10).labels("app=web");
        let full = access.page(&params, false).await.unwrap();
        assert_eq!(full.items[0]["status"]["phase"], "Pending");
        assert_eq!(full.continuation.as_deref(), Some("next"));
        let metadata = access.page(&params, true).await.unwrap();
        assert!(metadata.items[0].get("status").is_none());
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(!requests[0].1 && requests[1].1);
        assert!(requests.iter().all(
            |(path, _)| path.starts_with("/api/v1/namespaces/apps/pods?")
                && path.contains("limit=10")
                && path.contains("labelSelector=")
        ));
    }
}
