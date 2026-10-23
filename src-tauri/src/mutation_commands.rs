//! The only renderer entry points that may create, change or delete Kubernetes objects.
//! Requests contain intent only. Consent is obtained in the native backend, never from IPC.
use kubiki_core::{
    cluster::client::ClusterClientPool,
    core::{
        api::{ApiError, ResourceQuery, ResourceRef},
        mutations::{
            BatchIntent, ManifestTarget, MutationIntent, PreparedBatch, PreparedMutation,
            ResourceAction, ResourcePrecondition,
        },
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
    Action {
        resource: ResourceRef,
        resource_version: String,
        action: ResourceAction,
    },
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
    /// Drop one entry from metadata.finalizers, reviewed against the live object.
    RemoveFinalizer {
        resource: ResourceRef,
        finalizer: String,
    },
    /// One user action, one confirmation. Every step commits after the shared approval.
    Batch {
        primary: ResourceRef,
        steps: Vec<BatchStep>,
    },
    Helm {
        request: HelmMutation,
    },
    NodeDebug {
        request: NodeDebugRequest,
    },
}

/// A batch step. `critical` stops the remaining steps when this one fails.
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum BatchStep {
    Action {
        resource: ResourceRef,
        resource_version: String,
        action: ResourceAction,
        #[serde(default)]
        critical: bool,
    },
    Manifest {
        context: String,
        manifest: String,
        target: Option<ManifestTarget>,
        #[serde(default)]
        critical: bool,
    },
    Scale {
        resource: ResourceRef,
        resource_version: String,
        replicas: i32,
        #[serde(default)]
        critical: bool,
    },
    Secret {
        request: kubiki_core::core::secret_data::SecretDataRequest,
        #[serde(default)]
        critical: bool,
    },
    Evict {
        resource: ResourceRef,
        resource_version: String,
        #[serde(default)]
        critical: bool,
    },
    Delete {
        resource: ResourceRef,
        resource_version: String,
        #[serde(default)]
        critical: bool,
    },
    /// Expand server-side into cordon (when needed) plus one eviction per pod.
    /// The renderer does not have to load every pod to drain a node correctly.
    Drain {
        resource: ResourceRef,
        resource_version: String,
        #[serde(default)]
        critical: bool,
    },
}

impl BatchStep {
    fn context(&self) -> &str {
        match self {
            Self::Manifest { context, .. } => context,
            Self::Action { resource, .. }
            | Self::Scale { resource, .. }
            | Self::Evict { resource, .. }
            | Self::Delete { resource, .. }
            | Self::Drain { resource, .. } => &resource.query.context,
            Self::Secret { request, .. } => &request.resource.query.context,
        }
    }

    fn split(self) -> (MutationIntent, bool) {
        match self {
            Self::Action {
                resource,
                resource_version,
                action,
                critical,
            } => (
                MutationIntent::Action {
                    resource,
                    resource_version,
                    action,
                },
                critical,
            ),
            Self::Manifest {
                context,
                manifest,
                target,
                critical,
            } => (
                MutationIntent::Manifest {
                    context,
                    manifest,
                    target,
                },
                critical,
            ),
            Self::Scale {
                resource,
                resource_version,
                replicas,
                critical,
            } => (
                MutationIntent::Scale {
                    resource,
                    resource_version,
                    replicas,
                },
                critical,
            ),
            Self::Secret { request, critical } => (MutationIntent::Secret(request), critical),
            Self::Evict {
                resource,
                resource_version,
                critical,
            } => (
                MutationIntent::Evict {
                    resource,
                    resource_version,
                },
                critical,
            ),
            Self::Delete {
                resource,
                resource_version,
                critical,
            } => (
                MutationIntent::Delete {
                    resource,
                    resource_version,
                },
                critical,
            ),
            // Drain expands into concrete steps before any mutation is prepared.
            Self::Drain { .. } => unreachable!("drain steps are expanded before preparation"),
        }
    }
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
            Self::Action { resource, .. } | Self::Scale { resource, .. } => resource.clone(),
            Self::Evict { resource, .. } | Self::RemoveFinalizer { resource, .. } => {
                resource.clone()
            }
            Self::Batch { primary, .. } => primary.clone(),
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

/// Prepare every step against one context, confirm once, then commit sequentially.
async fn run_batch(
    window: tauri::WebviewWindow,
    pool: &ClusterClientPool,
    primary: ResourceRef,
    steps: Vec<BatchStep>,
) -> Result<Value, ApiError> {
    let batch_client = client(pool, &primary).await?;
    let mut intents = Vec::with_capacity(steps.len());
    let mut preconditions = Vec::new();
    for step in steps {
        if step.context() != primary.query.context {
            return Err(kubiki_core::core::mutations::error(
                &primary,
                400,
                "Every batch step must target the same context as the primary resource",
            ));
        }
        match step {
            BatchStep::Drain {
                resource,
                resource_version,
                critical,
            } => {
                preconditions.push(
                    ResourcePrecondition::prepare(
                        batch_client.clone(),
                        resource.clone(),
                        resource_version.clone(),
                    )
                    .await?,
                );
                intents.extend(
                    kubiki_core::core::drain::expand_drain(
                        &batch_client,
                        resource,
                        resource_version,
                        critical,
                    )
                    .await?,
                );
            }
            other => {
                let (intent, critical) = other.split();
                intents.push(if critical {
                    BatchIntent::critical(intent)
                } else {
                    BatchIntent::new(intent)
                });
            }
        }
    }
    if intents.is_empty() {
        return Ok(json!({
            "steps": [],
            "succeeded": 0,
            "failed": 0,
            "stopped": false,
        }));
    }
    let batch = PreparedBatch::prepare(batch_client, primary.clone(), intents)
        .await?
        .with_preconditions(preconditions);
    let details = batch.details();
    batch
        .confirm_and_commit(|review| {
            crate::mutation_guard::confirm_details(window, &primary, review, Some(details))
        })
        .await
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
    if let ChangeRequest::Batch { primary, steps } = request {
        return run_batch(window, &pool, primary, steps).await;
    }
    if let ChangeRequest::NodeDebug { request } = request {
        return crate::node_commands::prepare_node_debug(request, window, pool, nodes)
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
        ChangeRequest::Action {
            resource,
            resource_version,
            action,
        } => MutationIntent::Action {
            resource,
            resource_version,
            action,
        },
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
        ChangeRequest::RemoveFinalizer {
            resource,
            finalizer,
        } => MutationIntent::RemoveFinalizer {
            resource,
            finalizer,
        },
        ChangeRequest::Secret { request } => MutationIntent::Secret(request),
        _ => unreachable!(),
    };
    let prepared = PreparedMutation::prepare(client(&pool, &resource).await?, intent).await?;
    let details = prepared.details();
    prepared
        .confirm_and_commit(|review| {
            crate::mutation_guard::confirm_details(window, &resource, review, Some(details))
        })
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
            let prepared = PreparedMutation::prepare(
                client(&pool, &resource).await?,
                MutationIntent::Delete {
                    resource: resource.clone(),
                    resource_version,
                },
            )
            .await?;
            let details = prepared.details();
            prepared
                .confirm_and_commit(|review| {
                    crate::mutation_guard::confirm_details(window, &resource, review, Some(details))
                })
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
    fn batch_accepts_many_steps_but_no_renderer_approval() {
        let request = json!({
            "operation": "batch",
            "primary": {"context":"prod","group":"","version":"v1","kind":"Node","namespace":null,"name":"node-1","uid":"node-uid"},
            "steps": [
                {"operation":"manifest","context":"prod","manifest":"{}","critical":true},
                {"operation":"evict","resource":{"context":"prod","group":"","version":"v1","kind":"Pod","namespace":"team","name":"web","uid":"pod-uid"},"resource_version":"10"},
                {"operation":"drain","resource":{"context":"prod","group":"","version":"v1","kind":"Node","namespace":null,"name":"node-1","uid":"node-uid"},"resource_version":"10"}
            ]
        });
        let parsed = serde_json::from_value::<ChangeRequest>(request.clone()).unwrap();
        match parsed {
            ChangeRequest::Batch { steps, .. } => assert_eq!(steps.len(), 3),
            _ => panic!("batch request must stay a batch"),
        }
        let mut approved = request.clone();
        approved["confirmed"] = json!(true);
        assert!(serde_json::from_value::<ChangeRequest>(approved).is_err());
        let mut step_approved = request;
        step_approved["steps"][0]["approved"] = json!(true);
        assert!(serde_json::from_value::<ChangeRequest>(step_approved).is_err());
    }

    #[test]
    fn consent_and_arbitrary_commands_cannot_be_supplied_by_renderer() {
        let resource = json!({"context":"prod","group":"","version":"v1","kind":"Pod","namespace":"team","name":"web","uid":"uid"});
        let valid = [
            json!({"operation":"manifest","context":"prod","manifest":"{}"}),
            json!({"operation":"scale","resource":resource,"resource_version":"10","replicas":0}),
            json!({"operation":"secret","request":{"resource":resource,"resource_version":"10","data":{}}}),
            json!({"operation":"evict","resource":resource,"resource_version":"10"}),
            json!({"operation":"remove_finalizer","resource":resource,"finalizer":"example.com/foo"}),
            json!({"operation":"helm","request":{"operation":"repository_update","name":null}}),
            json!({"operation":"node_debug","request":{"resource":resource,"namespace":"team","image":"ubuntu:24.04"}}),
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
