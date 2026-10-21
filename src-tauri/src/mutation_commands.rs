//! The only renderer entry points that may create, change or delete Kubernetes objects.
//! Requests contain intent only. Consent is obtained in the native backend, never from IPC.
use kubiki_core::{
    cluster::client::ClusterClientPool,
    core::{
        api::{ApiError, ResourceQuery, ResourceRef},
        mutations::{ManifestTarget, MutationIntent, PreparedMutation},
    },
    helm::{
        mutations::{HelmMutation, PreparedHelmMutation},
        reader::HelmReader,
    },
    pod_ops::node_debug::{NodeDebugManager, NodeDebugRequest},
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChangeRequest {
    Manifest {
        context: String,
        manifest: String,
        target: Option<ManifestTarget>,
    },
    Scale {
        resource: ResourceRef,
        resource_version: String,
        replicas: i32,
    },
    Secret {
        request: kubiki_core::core::secret_data::SecretDataRequest,
    },
    Evict {
        resource: ResourceRef,
        resource_version: String,
    },
    Helm {
        request: HelmMutation,
    },
    NodeDebug {
        session_id: String,
        request: NodeDebugRequest,
    },
}
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum DeleteRequest {
    Resource {
        resource: ResourceRef,
        resource_version: String,
    },
    DebugPod {
        resource: ResourceRef,
    },
}
impl ChangeRequest {
    fn resource(&self) -> ResourceRef {
        match self {
            Self::Scale { resource, .. } => resource.clone(),
            Self::Evict { resource, .. } => resource.clone(),
            Self::Secret { request } => request.resource.clone(),
            Self::Helm { request } => request.resource(),
            Self::NodeDebug { request, .. } => request.resource.clone(),
            Self::Manifest {
                context, target, ..
            } => target
                .as_ref()
                .map(|t| t.resource.clone())
                .unwrap_or(ResourceRef {
                    query: ResourceQuery {
                        context: context.clone(),
                        group: String::new(),
                        version: "v1".into(),
                        kind: "Manifest".into(),
                        namespace: None,
                    },
                    name: "manifest".into(),
                    uid: None,
                }),
        }
    }
}
async fn client(
    pool: &ClusterClientPool,
    resource: &ResourceRef,
) -> Result<kube::Client, ApiError> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        pool.get_client(&resource.query.context),
    )
    .await
    .map_err(|_| {
        kubiki_core::core::mutations::error(resource, 504, "Context connection timed out")
    })?
    .map_err(|_| {
        kubiki_core::core::mutations::error(
            resource,
            503,
            "Cannot connect to the requested context",
        )
    })
}

#[tauri::command]
pub async fn mutate_resource(
    request: ChangeRequest,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    nodes: tauri::State<'_, NodeDebugManager>,
    guard: tauri::State<'_, crate::mutation_guard::MutationGuard>,
) -> Result<Value, ApiError> {
    let resource = request.resource();
    let _gate = guard.acquire(&resource)?;
    if let ChangeRequest::NodeDebug {
        session_id,
        request,
    } = request
    {
        return crate::node_commands::prepare_node_debug(session_id, request, window, pool, nodes)
            .await
            .and_then(|value| {
                serde_json::to_value(value).map_err(|_| {
                    kubiki_core::core::mutations::error(
                        &resource,
                        500,
                        "Cannot decode debug Pod identity",
                    )
                })
            });
    }
    if let ChangeRequest::Helm { request } = request {
        return PreparedHelmMutation::prepare(HelmReader::default(), request)
            .await?
            .confirm_and_commit(|review| crate::mutation_guard::confirm(window, &resource, review))
            .await;
    }
    let intent = match request {
        ChangeRequest::Manifest {
            context,
            manifest,
            target,
        } => MutationIntent::Manifest {
            context,
            manifest,
            target,
        },
        ChangeRequest::Scale {
            resource,
            resource_version,
            replicas,
        } => MutationIntent::Scale {
            resource,
            resource_version,
            replicas,
        },
        ChangeRequest::Evict {
            resource,
            resource_version,
        } => MutationIntent::Evict {
            resource,
            resource_version,
        },
        ChangeRequest::Secret { request } => MutationIntent::Secret(request),
        _ => unreachable!(),
    };
    PreparedMutation::prepare(client(&pool, &resource).await?, intent)
        .await?
        .confirm_and_commit(|review| crate::mutation_guard::confirm(window, &resource, review))
        .await
}

#[tauri::command]
pub async fn delete_resource(
    request: DeleteRequest,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, ClusterClientPool>,
    nodes: tauri::State<'_, NodeDebugManager>,
    guard: tauri::State<'_, crate::mutation_guard::MutationGuard>,
) -> Result<Value, ApiError> {
    let resource = match &request {
        DeleteRequest::Resource { resource, .. } | DeleteRequest::DebugPod { resource } => {
            resource.clone()
        }
    };
    let _gate = guard.acquire(&resource)?;
    match request {
        DeleteRequest::Resource {
            resource,
            resource_version,
        } => {
            PreparedMutation::prepare(
                client(&pool, &resource).await?,
                MutationIntent::Delete {
                    resource: resource.clone(),
                    resource_version,
                },
            )
            .await?
            .confirm_and_commit(|review| crate::mutation_guard::confirm(window, &resource, review))
            .await
        }
        DeleteRequest::DebugPod { resource } => {
            nodes
                .remove_other(
                    client(&pool, &resource).await?,
                    resource.clone(),
                    |review| crate::mutation_guard::confirm(window, &resource, review),
                )
                .await?;
            Ok(json!({"deleted": true}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consent_and_arbitrary_commands_cannot_be_supplied_by_renderer() {
        let resource = json!({"context":"prod","group":"","version":"v1","kind":"Pod","namespace":"team","name":"web","uid":"uid"});
        let valid = [
            json!({"operation":"manifest","context":"prod","manifest":"{}"}),
            json!({"operation":"scale","resource":resource,"resource_version":"10","replicas":0}),
            json!({"operation":"secret","request":{"resource":resource,"resource_version":"10","data":{}}}),
            json!({"operation":"evict","resource":resource,"resource_version":"10"}),
            json!({"operation":"helm","request":{"operation":"repository_update","name":null}}),
            json!({"operation":"node_debug","session_id":"id","request":{"resource":resource,"namespace":"team","image":"ubuntu:24.04"}}),
        ];
        for mut value in valid {
            assert!(serde_json::from_value::<ChangeRequest>(value.clone()).is_ok());
            value["confirmed"] = json!(true);
            assert!(serde_json::from_value::<ChangeRequest>(value).is_err());
        }
        let mut delete =
            json!({"operation":"resource","resource":resource,"resource_version":"10"});
        assert!(serde_json::from_value::<DeleteRequest>(delete.clone()).is_ok());
        delete["approved"] = json!(true);
        assert!(serde_json::from_value::<DeleteRequest>(delete).is_err());
        assert!(
            serde_json::from_value::<ChangeRequest>(
                json!({"operation":"exec","command":"delete pods --all"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<DeleteRequest>(
                json!({"operation":"delete_all","confirmed":true})
            )
            .is_err()
        );
    }
}
