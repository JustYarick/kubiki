//! Native, context-bound reads shared by desktop and headless clients.
use super::api::{ApiError, ResourceQuery, resource_types, validate_query};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::{
    Api, Client,
    api::{ApiResource, ListParams},
    discovery::{Discovery, Scope},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{future::Future, time::Duration};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadListOptions {
    #[serde(default)]
    pub metadata_only: bool,
    pub label_selector: Option<String>,
    pub field_selector: Option<String>,
    pub limit: Option<u32>,
    pub projection: Option<String>,
}

fn validate_object_name(name: &str, operation: &str, context: &str) -> Result<(), ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed != name
        || trimmed.len() > 253
        || trimmed.bytes().any(|b| b <= 0x20 || matches!(b, b'/' | b'\\' | b'?' | b'#'))
    {
        return Err(ApiError::from_status(
            400,
            "Invalid resource name",
            operation,
            Some(context),
        ));
    }
    Ok(())
}

pub(crate) fn strip_crd_schemas_json(item: &mut Value) {
    if let Some(spec) = item.get_mut("spec").and_then(Value::as_object_mut) {
        spec.remove("validation");
        if let Some(versions) = spec.get_mut("versions").and_then(Value::as_array_mut) {
            for version in versions {
                if let Some(version_obj) = version.as_object_mut() {
                    version_obj.remove("schema");
                }
            }
        }
    }
}

fn clean_list_item(mut item: Value, is_crd: bool) -> Value {
    if let Some(metadata) = item.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.remove("managedFields");
    }
    if is_crd {
        strip_crd_schemas_json(&mut item);
    }
    item
}

fn project_containers(list: Option<&Value>) -> Option<Value> {
    let items = list?.as_array()?;
    let projected: Vec<Value> = items
        .iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            let mut out = Map::new();
            if let Some(name) = obj.get("name") {
                out.insert("name".into(), name.clone());
            }
            if let Some(image) = obj.get("image") {
                out.insert("image".into(), image.clone());
            }
            Some(Value::Object(out))
        })
        .collect();
    if projected.is_empty() {
        None
    } else {
        Some(Value::Array(projected))
    }
}

fn project_pod_spec(spec: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for key in [
        "nodeName",
        "serviceAccountName",
        "clusterIP",
        "type",
        "ingressClassName",
        "storageClassName",
        "volumeName",
        "accessModes",
        "capacity",
    ] {
        if let Some(v) = spec.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    for key in ["containers", "initContainers", "ephemeralContainers"] {
        if let Some(projected) = project_containers(spec.get(key)) {
            out.insert(key.into(), projected);
        }
    }
    out
}

fn project_search_item(mut item: Value, ar: &ApiResource) -> Value {
    let Some(root) = item.as_object_mut() else {
        return item;
    };
    let mut projected = Map::new();
    for key in ["apiVersion", "kind"] {
        if let Some(v) = root.remove(key) {
            projected.insert(key.into(), v);
        }
    }
    if projected.get("kind").is_none() {
        projected.insert("kind".into(), Value::String(ar.kind.clone()));
    }
    if let Some(Value::Object(mut meta)) = root.remove("metadata") {
        meta.remove("managedFields");
        if let Some(Value::Object(annotations)) = meta.get_mut("annotations") {
            annotations.remove("kubectl.kubernetes.io/last-applied-configuration");
            if annotations.is_empty() {
                meta.remove("annotations");
            }
        }
        projected.insert("metadata".into(), Value::Object(meta));
    }

    if let Some(Value::Object(spec)) = root.get("spec") {
        let mut kept_spec = project_pod_spec(spec);
        if let Some(rules) = spec.get("rules").and_then(Value::as_array) {
            let hosts: Vec<Value> = rules
                .iter()
                .filter_map(|r| r.get("host").map(|h| json!({ "host": h })))
                .collect();
            if !hosts.is_empty() {
                kept_spec.insert("rules".into(), Value::Array(hosts));
            }
        }
        if let Some(tmpl) = spec.get("template").and_then(Value::as_object) {
            let mut kept_tmpl = Map::new();
            if let Some(tspec) = tmpl.get("spec").and_then(Value::as_object) {
                let pts = project_pod_spec(tspec);
                if !pts.is_empty() {
                    kept_tmpl.insert("spec".into(), Value::Object(pts));
                }
            }
            if !kept_tmpl.is_empty() {
                kept_spec.insert("template".into(), Value::Object(kept_tmpl));
            }
        }
        if let Some(jtmpl) = spec
            .get("jobTemplate")
            .and_then(|v| v.get("spec"))
            .and_then(|v| v.get("template"))
            .and_then(|v| v.get("spec"))
            .and_then(Value::as_object)
        {
            let pjs = project_pod_spec(jtmpl);
            if !pjs.is_empty() {
                kept_spec.insert(
                    "jobTemplate".into(),
                    json!({ "spec": { "template": { "spec": Value::Object(pjs) } } }),
                );
            }
        }
        if !kept_spec.is_empty() {
            projected.insert("spec".into(), Value::Object(kept_spec));
        }
    }

    if let Some(Value::Object(status)) = root.get("status") {
        let mut kept_status = Map::new();
        for key in [
            "phase",
            "reason",
            "message",
            "podIP",
            "podIPs",
            "hostIP",
            "conditions",
            "replicas",
            "readyReplicas",
            "availableReplicas",
            "updatedReplicas",
            "unavailableReplicas",
            "currentReplicas",
            "desiredNumberScheduled",
            "numberReady",
            "succeeded",
            "failed",
            "active",
            "loadBalancer",
            "addresses",
            "nodeInfo",
            "capacity",
            "allocatable",
        ] {
            if let Some(v) = status.get(key) {
                kept_status.insert(key.into(), v.clone());
            }
        }
        if !kept_status.is_empty() {
            projected.insert("status".into(), Value::Object(kept_status));
        }
    }

    // Preserve Event fields used for issue/search mapping when listing Events with projection
    for key in ["type", "reason", "message", "involvedObject", "count", "lastTimestamp"] {
        if let Some(v) = root.remove(key) {
            projected.insert(key.into(), v);
        }
    }

    Value::Object(projected)
}

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

async fn list_with_options(
    client: Client,
    query: &ResourceQuery,
    ar: &ApiResource,
    options: &ReadListOptions,
) -> Result<Value, ApiError> {
    let access = super::access::ResourceAccess::from_resource(client, query, ar.clone());
    let limit = options.limit.unwrap_or(500).clamp(1, 1000);
    let mut params = ListParams::default().limit(limit);
    if let Some(labels) = options
        .label_selector
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        params = params.labels(labels);
    }
    if let Some(fields) = options
        .field_selector
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        params = params.fields(fields);
    }
    let is_crd =
        ar.kind == "CustomResourceDefinition" && ar.group == "apiextensions.k8s.io";
    let search_projection =
        !options.metadata_only && options.projection.as_deref() == Some("search");
    let mut items = Vec::new();
    loop {
        let page = bounded(
            &query.context,
            "resources",
            access.page(&params, options.metadata_only),
        )
        .await
        .map_err(|e| e.with_resource(query))?;
        items.extend(page.items.into_iter().map(|item| {
            if search_projection {
                project_search_item(item, ar)
            } else {
                clean_list_item(item, is_crd)
            }
        }));
        match page.continuation {
            Some(token) => params = params.continue_token(&token),
            None => break,
        }
    }
    Ok(json!({"items": items}))
}

pub async fn resources(client: Client, query: ResourceQuery) -> Result<Value, ApiError> {
    resources_with_options(client, query, ReadListOptions::default()).await
}

pub async fn resources_with_options(
    client: Client,
    query: ResourceQuery,
    options: ReadListOptions,
) -> Result<Value, ApiError> {
    validate_query(&query)?;
    let (_, _, ar) = super::access::resolve_api(client.clone(), &query, true)
        .await
        .map_err(|message| {
            ApiError::from_status(400, message, "resources", Some(&query.context))
        })?;
    list_with_options(client, &query, &ar, &options).await
}

fn strip_managed_fields(item: &mut Value) {
    if let Some(metadata) = item.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.remove("managedFields");
    }
}

pub async fn get_resource(
    client: Client,
    query: ResourceQuery,
    name: String,
    metadata_only: bool,
) -> Result<Value, ApiError> {
    validate_query(&query)?;
    validate_object_name(&name, "resource", &query.context)?;
    let (_, _, ar) = super::access::resolve_api(client.clone(), &query, true)
        .await
        .map_err(|message| {
            ApiError::from_status(400, message, "resource", Some(&query.context))
        })?;
    let access = super::access::ResourceAccess::from_resource(client, &query, ar);
    let mut item = bounded(&query.context, "resource", access.get(&name, metadata_only))
        .await
        .map_err(|e| e.with_resource(&query))?;
    strip_managed_fields(&mut item);
    Ok(item)
}

pub async fn resource_count(client: Client, query: ResourceQuery) -> Result<usize, ApiError> {
    validate_query(&query)?;
    let (api, _, _) = super::access::resolve_api(client, &query, true)
        .await
        .map_err(|message| {
            ApiError::from_status(400, message, "resource-counts", Some(&query.context))
        })?;
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
        .buffer_unordered(24)
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
    custom_resources_with_options(
        client,
        context,
        name,
        uid,
        namespace,
        ReadListOptions::default(),
    )
    .await
}

pub async fn custom_resources_with_options(
    client: Client,
    context: String,
    name: String,
    uid: String,
    namespace: Option<String>,
    options: ReadListOptions,
) -> Result<Value, ApiError> {
    let (query, ar, _) =
        resolve_custom_resource(client.clone(), context, name, uid, namespace).await?;
    list_with_options(client, &query, &ar, &options).await
}

pub async fn get_custom_resource(
    client: Client,
    context: String,
    crd_name: String,
    uid: String,
    namespace: Option<String>,
    name: String,
    metadata_only: bool,
) -> Result<Value, ApiError> {
    validate_object_name(&name, "custom-resource", &context)?;
    let (query, ar, _) =
        resolve_custom_resource(client.clone(), context, crd_name, uid, namespace).await?;
    let access = super::access::ResourceAccess::from_resource(client, &query, ar);
    let mut item = bounded(
        &query.context,
        "custom-resource",
        access.get(&name, metadata_only),
    )
    .await
    .map_err(|e| e.with_resource(&query))?;
    strip_managed_fields(&mut item);
    Ok(item)
}

/// Discover all CRDs once and concurrently probe each (`limit=1` metadata) so only non-empty CRs are listed.
pub async fn custom_search_inventory(
    client: Client,
    context: String,
    namespace: Option<String>,
) -> Result<Value, ApiError> {
    use futures::StreamExt;
    if context.trim().is_empty()
        || namespace
            .as_deref()
            .is_some_and(|ns| !super::api::is_valid_namespace(ns))
    {
        return Err(ApiError::from_status(
            400,
            "Context and a valid namespace are required",
            "custom-search",
            Some(&context),
        ));
    }

    let definitions: Api<CustomResourceDefinition> = Api::all(client.clone());
    let mut crd_params = ListParams::default().limit(500);
    let mut targets = Vec::new();
    loop {
        let page = bounded(&context, "custom-search", definitions.list(&crd_params)).await?;
        for crd in page.items {
            let Some(version) = crd
                .spec
                .versions
                .iter()
                .find(|v| v.served && v.storage)
                .or_else(|| crd.spec.versions.iter().find(|v| v.served))
            else {
                continue;
            };
            let ar = ApiResource {
                group: crd.spec.group.clone(),
                version: version.name.clone(),
                api_version: format!("{}/{}", crd.spec.group, version.name),
                kind: crd.spec.names.kind.clone(),
                plural: crd.spec.names.plural.clone(),
            };
            let namespaced = crd.spec.scope == "Namespaced";
            let query = ResourceQuery {
                context: context.clone(),
                group: ar.group.clone(),
                version: ar.version.clone(),
                kind: ar.kind.clone(),
                namespace: if namespaced { namespace.clone() } else { None },
            };
            targets.push((query, ar));
        }
        match page.metadata.continue_.as_deref().filter(|t| !t.is_empty()) {
            Some(token) => crd_params = crd_params.continue_token(token),
            None => break,
        }
    }

    let results: Vec<Result<Vec<Value>, String>> = futures::stream::iter(targets)
        .map(|(query, ar)| {
            let client = client.clone();
            async move {
                let label = format!("{} ({})", ar.kind, ar.group);
                let access = super::access::ResourceAccess::from_resource(
                    client.clone(),
                    &query,
                    ar.clone(),
                );
                let probe = ListParams::default().limit(1);
                let page = bounded(&query.context, "custom-search", access.page(&probe, true))
                    .await
                    .map_err(|e| format!("{label}: {}", e.message))?;
                if page.items.is_empty() {
                    return Ok(Vec::new());
                }
                let list = list_with_options(
                    client,
                    &query,
                    &ar,
                    &ReadListOptions {
                        metadata_only: false,
                        label_selector: None,
                        field_selector: None,
                        limit: None,
                        projection: Some("search".into()),
                    },
                )
                .await
                .map_err(|e| format!("{label}: {}", e.message))?;
                Ok(list
                    .get("items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default())
            }
        })
        .buffer_unordered(24)
        .collect()
        .await;

    let mut items = Vec::new();
    let mut errors = Vec::new();
    for res in results {
        match res {
            Ok(batch) => items.extend(batch),
            Err(err) => errors.push(err),
        }
    }
    Ok(json!({ "items": items, "errors": errors }))
}

/// Resolve a CRD against the live definition, including its UID and served version.
/// Shared by one-shot lists and watches; renderer-provided plural/scope are never trusted.
pub async fn resolve_custom_resource(
    client: Client, context: String, name: String, uid: String, namespace: Option<String>,
) -> Result<(ResourceQuery, ApiResource, bool), ApiError> {
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
    Ok((query, ar, crd.spec.scope == "Namespaced"))
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

    #[tokio::test]
    async fn list_strips_crd_schemas_and_applies_search_projection_and_selectors() {
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        let service = tower::service_fn(move |request: http::Request<Body>| {
            let path = request.uri().path().to_owned();
            let query = request.uri().query().unwrap_or("").to_owned();
            let accept = request
                .headers()
                .get(http::header::ACCEPT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            seen.lock().unwrap().push((path.clone(), query, accept));
            async move {
                let body = match path.as_str() {
                    "/apis/apiextensions.k8s.io/v1/customresourcedefinitions" => json!({
                        "apiVersion": "apiextensions.k8s.io/v1",
                        "kind": "CustomResourceDefinitionList",
                        "metadata": {},
                        "items": [{
                            "apiVersion": "apiextensions.k8s.io/v1",
                            "kind": "CustomResourceDefinition",
                            "metadata": { "name": "widgets.example.io", "managedFields": [{"manager": "kubectl"}] },
                            "spec": {
                                "group": "example.io",
                                "names": { "kind": "Widget", "plural": "widgets" },
                                "scope": "Namespaced",
                                "validation": { "openAPIV3Schema": { "type": "object" } },
                                "versions": [{ "name": "v1", "served": true, "storage": true, "schema": { "openAPIV3Schema": { "type": "object" } } }]
                            }
                        }]
                    }),
                    "/api/v1/namespaces/prod/pods" => json!({
                        "apiVersion": "v1",
                        "kind": "PodList",
                        "metadata": {},
                        "items": [{
                            "apiVersion": "v1",
                            "kind": "Pod",
                            "metadata": {
                                "name": "api-1",
                                "namespace": "prod",
                                "uid": "pod-1",
                                "labels": { "app": "api" },
                                "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "huge-json", "note": "keep" },
                                "managedFields": [{"manager": "kubelet"}]
                            },
                            "spec": {
                                "nodeName": "node-1",
                                "containers": [{ "name": "api", "image": "ghcr.io/api:v1", "env": [{ "name": "SECRET", "value": "huge" }] }],
                                "volumes": [{ "name": "data" }]
                            },
                            "status": {
                                "phase": "Running",
                                "podIP": "10.0.0.5",
                                "containerStatuses": [{ "name": "api", "ready": true }]
                            }
                        }]
                    }),
                    "/api/v1/namespaces/prod/pods/api-1" => json!({
                        "apiVersion": "v1",
                        "kind": "Pod",
                        "metadata": { "name": "api-1", "namespace": "prod", "uid": "pod-1", "managedFields": [{"manager": "kubelet"}] },
                        "spec": { "nodeName": "node-1" }
                    }),
                    _ => json!({ "apiVersion": "v1", "kind": "List", "items": [] }),
                };
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(200)
                        .body(Body::from(serde_json::to_vec(&body).unwrap()))
                        .unwrap(),
                )
            }
        });
        let client = Client::new(service, "default");

        let crds = resources(
            client.clone(),
            ResourceQuery {
                context: "prod".into(),
                group: "apiextensions.k8s.io".into(),
                version: "v1".into(),
                kind: "CustomResourceDefinition".into(),
                namespace: None,
            },
        )
        .await
        .unwrap();
        let crd = &crds["items"][0];
        assert!(crd["metadata"].get("managedFields").is_none());
        assert!(crd["spec"].get("validation").is_none());
        assert!(crd["spec"]["versions"][0].get("schema").is_none());

        let projected = resources_with_options(
            client.clone(),
            ResourceQuery {
                context: "prod".into(),
                group: "".into(),
                version: "v1".into(),
                kind: "Pod".into(),
                namespace: Some("prod".into()),
            },
            ReadListOptions {
                metadata_only: false,
                label_selector: Some("app=api".into()),
                field_selector: Some("status.phase=Running".into()),
                limit: Some(250),
                projection: Some("search".into()),
            },
        )
        .await
        .unwrap();
        let pod = &projected["items"][0];
        assert_eq!(pod["spec"]["containers"][0]["image"], "ghcr.io/api:v1");
        assert!(pod["spec"]["containers"][0].get("env").is_none());
        assert!(pod["spec"].get("volumes").is_none());
        assert_eq!(pod["status"]["phase"], "Running");
        assert_eq!(pod["metadata"]["annotations"]["note"], "keep");
        assert!(pod["metadata"]["annotations"]
            .get("kubectl.kubernetes.io/last-applied-configuration")
            .is_none());

        let single = get_resource(
            client.clone(),
            ResourceQuery {
                context: "prod".into(),
                group: "".into(),
                version: "v1".into(),
                kind: "Pod".into(),
                namespace: Some("prod".into()),
            },
            "api-1".into(),
            true,
        )
        .await
        .unwrap();
        assert_eq!(single["metadata"]["name"], "api-1");
        assert!(single["metadata"].get("managedFields").is_none());

        let err = get_resource(
            client,
            ResourceQuery {
                context: "prod".into(),
                group: "".into(),
                version: "v1".into(),
                kind: "Pod".into(),
                namespace: Some("prod".into()),
            },
            "bad/name".into(),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, Some(400));

        let recorded = requests.lock().unwrap();
        assert!(recorded.iter().any(|(path, q, _)| {
            path == "/api/v1/namespaces/prod/pods"
                && q.contains("limit=250")
                && q.contains("labelSelector=app%3Dapi")
                && q.contains("fieldSelector=status.phase%3DRunning")
        }));
        assert!(recorded.iter().any(|(path, _, accept)| {
            path == "/api/v1/namespaces/prod/pods/api-1"
                && accept.contains("PartialObjectMetadata")
        }));
    }

    #[tokio::test]
    async fn custom_search_inventory_skips_empty_crds_without_individual_crd_gets() {
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        let service = tower::service_fn(move |request: http::Request<Body>| {
            let path = request.uri().path().to_owned();
            let query = request.uri().query().unwrap_or("").to_owned();
            let accept = request
                .headers()
                .get(http::header::ACCEPT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            seen.lock().unwrap().push((path.clone(), query.clone(), accept));
            async move {
                let body = match path.as_str() {
                    "/apis/apiextensions.k8s.io/v1/customresourcedefinitions" => json!({
                        "apiVersion": "apiextensions.k8s.io/v1",
                        "kind": "CustomResourceDefinitionList",
                        "metadata": {},
                        "items": [
                            {
                                "apiVersion": "apiextensions.k8s.io/v1",
                                "kind": "CustomResourceDefinition",
                                "metadata": { "name": "widgets.example.io", "uid": "crd-1" },
                                "spec": {
                                    "group": "example.io",
                                    "names": { "kind": "Widget", "plural": "widgets" },
                                    "scope": "Namespaced",
                                    "versions": [{ "name": "v1", "served": true, "storage": true }]
                                }
                            },
                            {
                                "apiVersion": "apiextensions.k8s.io/v1",
                                "kind": "CustomResourceDefinition",
                                "metadata": { "name": "emptythings.example.io", "uid": "crd-2" },
                                "spec": {
                                    "group": "example.io",
                                    "names": { "kind": "EmptyThing", "plural": "emptythings" },
                                    "scope": "Namespaced",
                                    "versions": [{ "name": "v1", "served": true, "storage": true }]
                                }
                            }
                        ]
                    }),
                    "/apis/example.io/v1/widgets" if query.contains("limit=1") => json!({
                        "apiVersion": "meta.k8s.io/v1",
                        "kind": "PartialObjectMetadataList",
                        "metadata": {},
                        "items": [{ "metadata": { "name": "w1", "namespace": "prod", "uid": "w1" } }]
                    }),
                    "/apis/example.io/v1/widgets" => json!({
                        "apiVersion": "example.io/v1",
                        "kind": "WidgetList",
                        "metadata": {},
                        "items": [{
                            "apiVersion": "example.io/v1",
                            "kind": "Widget",
                            "metadata": { "name": "w1", "namespace": "prod", "uid": "w1" },
                            "spec": { "huge": "blob" },
                            "status": { "phase": "Ready" }
                        }]
                    }),
                    "/apis/example.io/v1/emptythings" => json!({
                        "apiVersion": "meta.k8s.io/v1",
                        "kind": "PartialObjectMetadataList",
                        "metadata": {},
                        "items": []
                    }),
                    _ => json!({ "apiVersion": "v1", "kind": "List", "items": [] }),
                };
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(200)
                        .body(Body::from(serde_json::to_vec(&body).unwrap()))
                        .unwrap(),
                )
            }
        });
        let client = Client::new(service, "default");
        let res = custom_search_inventory(client, "prod".into(), None).await.unwrap();
        assert_eq!(res["items"].as_array().unwrap().len(), 1);
        assert_eq!(res["items"][0]["metadata"]["name"], "w1");
        assert!(res["items"][0].get("spec").is_none());
        assert_eq!(res["errors"].as_array().unwrap().len(), 0);

        let recorded = requests.lock().unwrap();
        assert!(!recorded.iter().any(|(p, _, _)| p.contains("customresourcedefinitions/")));
        assert_eq!(recorded.iter().filter(|(p, _, _)| p == "/apis/example.io/v1/emptythings").count(), 1);
    }
}
