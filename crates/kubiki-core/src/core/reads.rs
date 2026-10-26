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
    let discovery = bounded(context, "api-resources", Discovery::new(client).run()).await?;
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

async fn list(client: Client, query: &ResourceQuery, ar: &ApiResource) -> Result<Value, ApiError> {
    let api: Api<DynamicObject> = match &query.namespace {
        Some(ns) => Api::namespaced_with(client, ns, ar),
        None => Api::all_with(client, ar),
    };
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
    let known = validate_query(&query)?;
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
    list(client, &query, &ar).await
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
