//! Node drain preparation shared by native and headless callers.
use super::{
    api::{ApiError, ResourceQuery, ResourceRef, validate_query},
    mutations::{BatchIntent, MutationIntent, ResourceAction, bounded, error},
};
use kube::api::{Api, ApiResource, DynamicObject, ListParams};
use serde_json::Value;

fn core_api(kind: &str) -> ApiResource {
    let plural = match kind {
        "Pod" => "pods".to_string(),
        "Node" => "nodes".to_string(),
        other => format!("{}s", other.to_ascii_lowercase()),
    };
    ApiResource {
        group: String::new(),
        version: "v1".into(),
        api_version: "v1".into(),
        kind: kind.into(),
        plural,
    }
}

/// Turn a drain step into the exact operations `kubectl drain` performs: cordon
/// when needed, then one eviction per non-daemonset, non-mirror, live pod.
pub async fn expand_drain(
    client: &kube::Client,
    node: ResourceRef,
    resource_version: String,
    cordon_critical: bool,
) -> Result<Vec<BatchIntent>, ApiError> {
    let context = node.query.context.clone();
    let nodes: Api<DynamicObject> = Api::all_with(client.clone(), &core_api("Node"));
    if node.query.kind != "Node" || !node.query.group.is_empty() || node.query.namespace.is_some() {
        return Err(error(&node, 400, "Drain requires an exact core/v1 Node"));
    }
    validate_query(&node.query)?;
    let current = bounded(&node, nodes.get(&node.name)).await?;
    if node.uid.is_none()
        || resource_version.is_empty()
        || current.metadata.uid != node.uid
        || current.metadata.resource_version.as_deref() != Some(&resource_version)
    {
        return Err(error(
            &node,
            409,
            "Node changed or was recreated. Refresh and try again",
        ));
    }
    let mut intents = Vec::new();
    let unschedulable = current
        .data
        .get("spec")
        .and_then(|spec| spec.get("unschedulable"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !unschedulable {
        let cordon = MutationIntent::Action {
            resource: node.clone(),
            resource_version: resource_version.clone(),
            action: ResourceAction::Cordon {
                unschedulable: true,
            },
        };
        intents.push(if cordon_critical {
            BatchIntent::critical(cordon)
        } else {
            BatchIntent::new(cordon)
        });
    }

    let pods: Api<DynamicObject> = Api::all_with(client.clone(), &core_api("Pod"));
    let listed = bounded(
        &node,
        pods.list(&ListParams::default().fields(&format!("spec.nodeName={}", node.name))),
    )
    .await?;
    for pod in listed.items {
        let Some(name) = pod.metadata.name.clone() else {
            continue;
        };
        let Some(namespace) = pod.metadata.namespace.clone() else {
            continue;
        };
        if pod.metadata.deletion_timestamp.is_some()
            || matches!(
                pod.data.pointer("/status/phase").and_then(Value::as_str),
                Some("Succeeded" | "Failed")
            )
        {
            continue;
        }
        let on_node = pod
            .data
            .get("spec")
            .and_then(|spec| spec.get("nodeName"))
            .and_then(|value| value.as_str())
            == Some(node.name.as_str());
        if !on_node {
            continue;
        }
        let is_mirror = pod
            .metadata
            .annotations
            .as_ref()
            .and_then(|annotations| annotations.get("kubernetes.io/config.mirror"))
            .is_some();
        let is_daemonset = pod.metadata.owner_references.as_ref().is_some_and(|refs| {
            refs.iter()
                .any(|owner| owner.kind == "DaemonSet" && owner.controller.unwrap_or(false))
        });
        if is_mirror || is_daemonset {
            continue;
        }
        let pod_ref = ResourceRef {
            query: ResourceQuery {
                context: context.clone(),
                group: String::new(),
                version: "v1".into(),
                kind: "Pod".into(),
                namespace: Some(namespace),
            },
            name,
            uid: pod.metadata.uid.clone(),
        };
        intents.push(BatchIntent::new(MutationIntent::Evict {
            resource: pod_ref,
            resource_version: pod.metadata.resource_version.clone().unwrap_or_default(),
        }));
    }
    Ok(intents)
}
