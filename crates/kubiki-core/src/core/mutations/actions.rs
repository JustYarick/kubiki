use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResourceAction {
    Restart,
    ConfigMapData {
        data: std::collections::BTreeMap<String, String>,
    },
    Cordon {
        unschedulable: bool,
    },
    Suspend {
        suspend: bool,
    },
    ArgoSync,
    ArgoRefresh {
        hard: bool,
    },
    RunCronJob {
        name: String,
    },
    Rollback {
        revision: ResourceRef,
        resource_version: String,
    },
}
impl PreparedMutation {
    pub(super) async fn prepare_action(
        client: Client,
        resource: ResourceRef,
        version: String,
        action: ResourceAction,
    ) -> Result<Self, ApiError> {
        validate_identity(&resource, &version)?;
        let api = resource_api(client.clone(), &resource).await?;
        let before = bounded(&resource, api.get(&resource.name)).await?;
        verify_version(&resource, &version, &before)?;
        let mut after = serde_json::to_value(&before).expect("object serializes");
        let mut target = Some(ManifestTarget {
            resource: resource.clone(),
            resource_version: version.clone(),
        });
        let mut sources = Vec::new();
        let (operation, summary, warnings) = match action {
            ResourceAction::ConfigMapData { data }
                if resource.query.group.is_empty() && resource.query.kind == "ConfigMap" =>
            {
                if before.data.get("immutable") == Some(&json!(true)) {
                    return Err(error(&resource, 422, "This ConfigMap is immutable"));
                }
                if data.keys().any(|key| {
                    key.is_empty()
                        || key.len() > 253
                        || !key
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                }) {
                    return Err(error(&resource, 400, "Invalid ConfigMap data key"));
                }
                let new = serde_json::to_value(data).expect("data serializes");
                let old = before
                    .data
                    .get("data")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let keys: BTreeSet<_> = old.keys().chain(new.as_object().unwrap().keys()).collect();
                let summary = keys
                    .into_iter()
                    .filter(|key| old.get(*key) != new.get(*key))
                    .map(|key| {
                        format!(
                            "{key:?}: {}",
                            if !old.contains_key(key) {
                                "added"
                            } else if new.get(key).is_none() {
                                "removed"
                            } else {
                                "updated"
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                after["data"] = new;
                ("UPDATE_CONFIG_MAP", summary, vec![])
            }
            ResourceAction::Restart
                if resource.query.group == "apps"
                    && ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"]
                        .contains(&resource.query.kind.as_str()) =>
            {
                after["spec"]["template"]["metadata"]["annotations"]["kubectl.kubernetes.io/restartedAt"] =
                    json!(chrono::Utc::now().to_rfc3339());
                (
                    "RESTART",
                    "Restart workload Pods by updating the Pod template restart annotation.".into(),
                    vec![ReviewWarning::Dependents],
                )
            }
            ResourceAction::Cordon { unschedulable }
                if resource.query.group.is_empty() && resource.query.kind == "Node" =>
            {
                after["spec"]["unschedulable"] = json!(unschedulable);
                (
                    if unschedulable { "CORDON" } else { "UNCORDON" },
                    format!(
                        "Allow scheduling: {} → {}. Existing Pods are not evicted by this step.",
                        !before
                            .data
                            .pointer("/spec/unschedulable")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        !unschedulable
                    ),
                    vec![],
                )
            }
            ResourceAction::Suspend { suspend }
                if resource.query.group == "batch" && resource.query.kind == "CronJob" =>
            {
                after["spec"]["suspend"] = json!(suspend);
                (
                    if suspend { "SUSPEND" } else { "RESUME" },
                    format!(
                        "Suspend scheduled Jobs: {} → {suspend}.",
                        before
                            .data
                            .pointer("/spec/suspend")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    ),
                    vec![],
                )
            }
            ResourceAction::ArgoSync
                if resource.query.group == "argoproj.io"
                    && resource.query.kind == "Application" =>
            {
                after["operation"] = json!({"sync":{"prune":true}});
                (
                    "SYNC",
                    "Request Argo CD synchronization with pruning enabled.".into(),
                    vec![ReviewWarning::ArgoPrune],
                )
            }
            ResourceAction::ArgoRefresh { hard }
                if resource.query.group == "argoproj.io"
                    && resource.query.kind == "Application" =>
            {
                after["metadata"]["annotations"]["argocd.argoproj.io/refresh"] =
                    json!(if hard { "hard" } else { "normal" });
                (
                    "REFRESH",
                    format!(
                        "Request {} Argo CD refresh.",
                        if hard { "hard" } else { "normal" }
                    ),
                    vec![],
                )
            }
            ResourceAction::RunCronJob { name }
                if resource.query.group == "batch" && resource.query.kind == "CronJob" =>
            {
                let spec = after
                    .pointer("/spec/jobTemplate/spec")
                    .cloned()
                    .ok_or_else(|| error(&resource, 422, "CronJob has no Job template"))?;
                let template_metadata = after.pointer("/spec/jobTemplate/metadata");
                let mut metadata = json!({
                    "name": name,
                    "namespace": resource.query.namespace,
                });
                if let Some(labels) = template_metadata.and_then(|value| value.get("labels")) {
                    if labels.is_object() {
                        metadata["labels"] = labels.clone();
                    }
                }
                let mut annotations = template_metadata
                    .and_then(|value| value.get("annotations"))
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                annotations.insert("cronjob.kubernetes.io/instantiate".into(), json!("manual"));
                metadata["annotations"] = Value::Object(annotations);
                sources.push(ResourcePrecondition {
                    api: api.clone(),
                    resource: resource.clone(),
                    version: version.clone(),
                });
                after = json!({
                    "apiVersion": "batch/v1",
                    "kind": "Job",
                    "metadata": metadata,
                    "spec": spec,
                });
                target = None;
                (
                    "RUN_JOB",
                    format!(
                        "Create Job {name:?} from the current template of CronJob {:?}.",
                        resource.name
                    ),
                    vec![ReviewWarning::Dependents],
                )
            }
            ResourceAction::Rollback {
                revision,
                resource_version,
            } if resource.query.group == "apps" && resource.query.kind == "Deployment" => {
                if revision.query.context != resource.query.context
                    || revision.query.namespace != resource.query.namespace
                    || revision.query.group != "apps"
                    || revision.query.kind != "ReplicaSet"
                {
                    return Err(error(
                        &resource,
                        400,
                        "Rollback requires a ReplicaSet from this Deployment's context and namespace",
                    ));
                }
                validate_identity(&revision, &resource_version)?;
                let revision_api = resource_api(client.clone(), &revision).await?;
                let source = bounded(&revision, revision_api.get(&revision.name)).await?;
                verify_version(&revision, &resource_version, &source)?;
                if !source
                    .metadata
                    .owner_references
                    .as_ref()
                    .is_some_and(|owners| {
                        owners.iter().any(|owner| {
                            Some(owner.uid.as_str()) == resource.uid.as_deref()
                                && owner.kind == "Deployment"
                                && owner.controller == Some(true)
                        })
                    })
                {
                    return Err(error(
                        &resource,
                        409,
                        "Revision is not owned by this Deployment",
                    ));
                }
                after["spec"]["template"] = source
                    .data
                    .pointer("/spec/template")
                    .cloned()
                    .ok_or_else(|| error(&resource, 422, "Revision has no Pod template"))?;
                let summary = format!(
                    "Restore Pod template from ReplicaSet {:?}, UID {:?}, resource version {:?}.",
                    revision.name, revision.uid, resource_version
                );
                sources.push(ResourcePrecondition {
                    api: revision_api,
                    resource: revision,
                    version: resource_version,
                });
                ("ROLLBACK", summary, vec![ReviewWarning::Dependents])
            }
            _ => {
                return Err(error(
                    &resource,
                    400,
                    "Action is not supported for this API group and resource kind",
                ));
            }
        };
        let manifest = serde_yaml::to_string(&after)
            .map_err(|_| error(&resource, 500, "Cannot encode action"))?;
        let mut prepared = Self::prepare_manifest_with_review(
            client,
            resource.query.context.clone(),
            manifest,
            target,
            false,
        )
        .await?;
        prepared.details = MutationReview::single(
            ReviewKind::Action,
            operation,
            &prepared.resource,
            summary.clone(),
            None,
            warnings,
        );
        prepared.review = format!(
            "{}\n\n{operation}: {summary}\n\nConfirm this operation? Cancel leaves the cluster unchanged.",
            identity_summary(&prepared.resource, &prepared.version)
        );
        prepared.preconditions = sources;
        Ok(prepared)
    }
}
