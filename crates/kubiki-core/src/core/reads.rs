//! Native, context-bound reads shared by desktop and headless clients.
use super::api::{ApiError, ResourceQuery, resource_types, validate_query};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::{
    Api, Client,
    api::{ApiResource, DynamicObject, ListParams},
    discovery::{Discovery, Scope},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{future::Future, time::Duration};

pub async fn bounded<T>(
    context: &str,
    operation: &str,
    future: impl Future<Output = Result<T, kube::Error>>,
) -> Result<T, ApiError> {
    tokio::time::timeout(Duration::from_secs(20), future)
        .await
        .map_err(|_| {
            ApiError::from_status(504, "Kubernetes read timed out", operation, Some(context))
        })?
        .map_err(|e| match e {
            kube::Error::Api(e) => {
                ApiError::from_status(e.code, e.message, operation, Some(context))
            }
            e => ApiError::from_status(503, e.to_string(), operation, Some(context)),
        })
}

#[derive(Serialize)]
pub struct DiscoveredResourceType {
    #[serde(flatten)]
    resource: super::api::ResourceType,
    watch: bool,
}
pub async fn discover(
    client: Client,
    context: &str,
) -> Result<Vec<DiscoveredResourceType>, ApiError> {
    let groups: std::collections::HashSet<&str> = resource_types()
        .iter()
        .map(|resource| resource.group.as_str())
        .collect();
    let discovery = bounded(
        context,
        "api-resources",
        Discovery::new(client)
            .filter(&groups.into_iter().collect::<Vec<_>>())
            .run(),
    )
    .await?;
    let mut result = Vec::new();
    for group in discovery.groups() {
        for (ar, caps) in group.recommended_resources() {
            if !caps.supports_operation("list") {
                continue;
            }
            if let Some(known) = resource_types().iter().find(|r| {
                r.group == ar.group
                    && r.kind == ar.kind
                    && r.plural == ar.plural
                    && r.namespaced == (caps.scope == Scope::Namespaced)
            }) {
                let mut resource = known.clone();
                resource.version = ar.version;
                result.push(DiscoveredResourceType {
                    resource,
                    watch: caps.supports_operation("watch"),
                });
            }
        }
    }
    Ok(result)
}

fn api_for(client: Client, query: &ResourceQuery, ar: &ApiResource) -> Api<DynamicObject> {
    match &query.namespace {
        Some(ns) => Api::namespaced_with(client, ns, ar),
        None => Api::all_with(client, ar),
    }
}

fn build_api(
    client: Client,
    query: &ResourceQuery,
) -> Result<(Api<DynamicObject>, ApiResource), ApiError> {
    let known = validate_query(query)?;
    let ar = ApiResource {
        group: query.group.clone(),
        version: query.version.clone(),
        api_version: if query.group.is_empty() {
            query.version.clone()
        } else {
            format!("{}/{}", query.group, query.version)
        },
        kind: query.kind.clone(),
        plural: known.plural.clone(),
    };
    let api = api_for(client, query, &ar);
    Ok((api, ar))
}

async fn list(client: Client, query: &ResourceQuery, ar: &ApiResource) -> Result<Value, ApiError> {
    let api = api_for(client, query, ar);
    let mut params = ListParams::default().limit(500);
    let mut items = Vec::new();
    loop {
        let page = bounded(&query.context, "resources", api.list(&params))
            .await
            .map_err(|e| e.with_resource(query))?;
        items.extend(page.items.into_iter().map(|mut item| {
            item.metadata.managed_fields = None;
            item.types = Some(kube::core::TypeMeta {
                api_version: ar.api_version.clone(),
                kind: ar.kind.clone(),
            });
            item
        }));
        match page.metadata.continue_.filter(|s| !s.is_empty()) {
            Some(token) => params = params.continue_token(&token),
            None => break,
        }
    }
    Ok(json!({"items": items}))
}
pub async fn resources(client: Client, query: ResourceQuery) -> Result<Value, ApiError> {
    let (_, ar) = build_api(client.clone(), &query)?;
    list(client, &query, &ar).await
}

pub async fn resource_count(client: Client, query: ResourceQuery) -> Result<usize, ApiError> {
    let (api, _) = build_api(client, &query)?;
    let params = ListParams::default().limit(1);
    let page = bounded(
        &query.context,
        "resource-counts",
        api.list_metadata(&params),
    )
    .await
    .map_err(|e| e.with_resource(&query))?;
    let remaining = match page.metadata.remaining_item_count {
        Some(count) if count >= 0 => count as usize,
        None if page.metadata.continue_.as_deref().is_none_or(str::is_empty) => 0,
        _ => {
            return Err(ApiError::from_status(
                503,
                "The API did not provide a complete resource count",
                "resource-counts",
                Some(&query.context),
            )
            .with_resource(&query));
        }
    };
    Ok(page.items.len() + remaining)
}

pub async fn resource_counts(
    client: Client,
    queries: Vec<ResourceQuery>,
) -> std::collections::HashMap<String, usize> {
    use futures::StreamExt;
    let pairs: Vec<(String, Result<usize, ApiError>)> = futures::stream::iter(queries)
        .map(|query| {
            let client = client.clone();
            let kind = query.kind.clone();
            async move { (kind, resource_count(client, query).await) }
        })
        .buffer_unordered(4)
        .collect()
        .await;
    let mut counts = std::collections::HashMap::new();
    let mut incomplete = std::collections::HashSet::new();
    for (kind, count) in pairs {
        match count {
            Ok(count) => *counts.entry(kind).or_insert(0) += count,
            Err(_) => {
                incomplete.insert(kind);
            }
        }
    }
    counts.retain(|kind, _| !incomplete.contains(kind));
    counts
}

pub async fn custom_resources(
    client: Client,
    context: String,
    name: String,
    uid: String,
    namespace: Option<String>,
) -> Result<Value, ApiError> {
    let invalid = |message| ApiError::from_status(400, message, "custom-resources", Some(&context));
    let valid = |s: &str| {
        !s.is_empty()
            && s.len() <= 253
            && s.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".-".contains(&c))
            && !s.starts_with(['-', '.'])
            && !s.ends_with(['-', '.'])
    };
    if context.trim().is_empty()
        || !valid(&name)
        || uid.is_empty()
        || namespace
            .as_deref()
            .is_some_and(|ns| !valid(ns) || ns.len() > 63 || ns.contains('.'))
    {
        return Err(invalid(
            "Context, CRD name, UID and a valid namespace are required",
        ));
    }
    let definitions: Api<CustomResourceDefinition> = Api::all(client.clone());
    let crd = bounded(&context, "custom-resources", definitions.get(&name)).await?;
    if crd.metadata.uid.as_deref() != Some(&uid) {
        return Err(ApiError::from_status(
            409,
            "This CRD has been replaced. Refresh the resource list.",
            "custom-resources",
            Some(&context),
        ));
    }
    let version = crd
        .spec
        .versions
        .iter()
        .find(|v| v.served && v.storage)
        .or_else(|| crd.spec.versions.iter().find(|v| v.served))
        .ok_or_else(|| invalid("CRD has no served version"))?;
    let ar = ApiResource {
        group: crd.spec.group.clone(),
        version: version.name.clone(),
        api_version: format!("{}/{}", crd.spec.group, version.name),
        kind: crd.spec.names.kind.clone(),
        plural: crd.spec.names.plural.clone(),
    };
    let query = ResourceQuery {
        context,
        group: ar.group.clone(),
        version: ar.version.clone(),
        kind: ar.kind.clone(),
        namespace: if crd.spec.scope == "Namespaced" {
            namespace
        } else {
            None
        },
    };
    list(client, &query, &ar).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::client::Body;

    #[tokio::test]
    async fn discovery_does_not_query_unrelated_custom_api_groups() {
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        let service = tower::service_fn(move |request: http::Request<Body>| {
            let path = request.uri().path().to_owned();
            seen.lock().unwrap().push(path.clone());
            async move {
                let group = |name: &str| json!({ "name": name, "versions": [{ "groupVersion": format!("{name}/v1"), "version": "v1" }], "preferredVersion": { "groupVersion": format!("{name}/v1"), "version": "v1" } });
                let body = match path.as_str() {
                    "/apis" => {
                        json!({ "kind": "APIGroupList", "apiVersion": "v1", "groups": [group("apps"), group("unrelated.example.com")] })
                    }
                    "/api" => {
                        json!({ "kind": "APIVersions", "apiVersion": "v1", "versions": ["v1"], "serverAddressByClientCIDRs": [] })
                    }
                    "/api/v1" => {
                        json!({ "kind": "APIResourceList", "apiVersion": "v1", "groupVersion": "v1", "resources": [{ "name": "pods", "singularName": "pod", "namespaced": true, "kind": "Pod", "verbs": ["get", "list", "watch"] }] })
                    }
                    "/apis/apps/v1" => {
                        json!({ "kind": "APIResourceList", "apiVersion": "v1", "groupVersion": "apps/v1", "resources": [{ "name": "deployments", "singularName": "deployment", "namespaced": true, "kind": "Deployment", "verbs": ["get", "list", "watch"] }] })
                    }
                    other => panic!("Unexpected API discovery request: {other}"),
                };
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(200)
                        .body(Body::from(serde_json::to_vec(&body).unwrap()))
                        .unwrap(),
                )
            }
        });
        let resources = discover(Client::new(service, "default"), "prod")
            .await
            .unwrap();
        assert_eq!(resources.len(), 2);
        assert_eq!(requests.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn resource_counts_uses_limit_one_and_remaining_item_count() {
        let service = tower::service_fn(|request: http::Request<Body>| async move {
            let uri = request.uri().to_string();
            let body = if uri.contains("/configmaps?") {
                json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadataList", "metadata": { "continue": "unknown" }, "items": [{ "metadata": { "name": "one" } }] })
            } else if uri.contains("/pods?") && uri.contains("limit=1") && !uri.contains("blocked")
            {
                json!({
                    "apiVersion": "meta.k8s.io/v1",
                    "kind": "PartialObjectMetadataList",
                    "metadata": { "remainingItemCount": 8999, "continue": "tok" },
                    "items": [{ "metadata": { "name": "pod-0", "namespace": "default", "uid": "u-0" } }]
                })
            } else if uri.contains("/nodes?") && uri.contains("limit=1") {
                json!({
                    "apiVersion": "meta.k8s.io/v1",
                    "kind": "PartialObjectMetadataList",
                    "metadata": {},
                    "items": []
                })
            } else {
                return Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(403)
                        .body(Body::from(
                            serde_json::to_vec(&json!({
                                "kind": "Status",
                                "status": "Failure",
                                "message": "forbidden",
                                "code": 403
                            }))
                            .unwrap(),
                        ))
                        .unwrap(),
                );
            };
            Ok(http::Response::builder()
                .status(200)
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap())
        });
        let client = Client::new(service, "default");
        let counts = resource_counts(
            client.clone(),
            vec![
                ResourceQuery {
                    context: "prod".into(),
                    group: "".into(),
                    version: "v1".into(),
                    kind: "Pod".into(),
                    namespace: None,
                },
                ResourceQuery {
                    context: "prod".into(),
                    group: "".into(),
                    version: "v1".into(),
                    kind: "Node".into(),
                    namespace: None,
                },
                ResourceQuery {
                    context: "prod".into(),
                    group: "".into(),
                    version: "v1".into(),
                    kind: "ConfigMap".into(),
                    namespace: None,
                },
                ResourceQuery {
                    context: "prod".into(),
                    group: "".into(),
                    version: "v1".into(),
                    kind: "Secret".into(),
                    namespace: None,
                },
            ],
        )
        .await;
        assert_eq!(counts.get("Pod"), Some(&9000));
        assert_eq!(counts.get("Node"), Some(&0));
        assert_eq!(counts.get("Secret"), None);
        assert_eq!(counts.get("ConfigMap"), None);
        let counts = resource_counts(
            client,
            ["default", "blocked"]
                .map(|namespace| ResourceQuery {
                    context: "prod".into(),
                    group: "".into(),
                    version: "v1".into(),
                    kind: "Pod".into(),
                    namespace: Some(namespace.into()),
                })
                .to_vec(),
        )
        .await;
        assert_eq!(
            counts.get("Pod"),
            None,
            "a forbidden namespace must not produce a partial total"
        );
    }
}
