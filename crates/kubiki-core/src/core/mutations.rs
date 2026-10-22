//! The desktop write boundary. A prepared operation owns its payload and can only
//! be consumed once, after backend consent. No approval flag is deserialized.
use super::{
    api::{ApiError, ApiErrorCode, ResourceRef, resource_type, validate_query},
    secret_data::SecretDataRequest,
};
use kube::{
    Api, Client,
    api::{
        ApiResource, DeleteParams, DynamicObject, Patch, PatchParams, PostParams, Preconditions,
    },
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    future::Future,
    time::{Duration, Instant},
};

pub const REVIEW_TTL: Duration = Duration::from_secs(120);
pub const MAX_REVIEW_CHARS: usize = 24_000;

pub enum MutationIntent {
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
    Secret(SecretDataRequest),
    Delete {
        resource: ResourceRef,
        resource_version: String,
    },
    Evict {
        resource: ResourceRef,
        resource_version: String,
    },
}

/// Separate from editable YAML so changing metadata cannot retarget an editor save.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestTarget {
    pub resource: ResourceRef,
    pub resource_version: String,
}

pub fn error(resource: &ResourceRef, status: u16, message: &str) -> ApiError {
    let mut error =
        ApiError::from_status(status, message, "mutation", Some(&resource.query.context))
            .with_resource(&resource.query);
    // A timed out write may have succeeded. Never automatically retry a mutation.
    error.retryable = false;
    error
}

pub fn cancelled(resource: &ResourceRef, message: &str) -> ApiError {
    ApiError::new(
        ApiErrorCode::Cancelled,
        message,
        "mutation",
        Some(&resource.query.context),
        None,
    )
    .with_resource(&resource.query)
}

pub fn identity_summary(resource: &ResourceRef, version: &str) -> String {
    // JSON quoting prevents untrusted labels/names from spoofing lines in the review.
    let api_version = if resource.query.group.is_empty() {
        resource.query.version.clone()
    } else {
        format!("{}/{}", resource.query.group, resource.query.version)
    };
    format!(
        "Context: {:?}\nAPI: {:?}\n{}: {:?}\nNamespace: {:?}\nUID: {:?}\nResource version: {:?}",
        resource.query.context,
        api_version,
        resource.query.kind,
        resource.name,
        resource.query.namespace.as_deref().unwrap_or("(cluster)"),
        resource.uid.as_deref().unwrap_or(""),
        version
    )
}

pub async fn bounded<T>(
    resource: &ResourceRef,
    future: impl Future<Output = Result<T, kube::Error>>,
) -> Result<T, ApiError> {
    tokio::time::timeout(Duration::from_secs(15), future).await
        .map_err(|_| error(resource, 504, "Kubernetes request timed out. Refresh to verify the outcome before trying again"))?
        .map_err(|source| error(resource, match source { kube::Error::Api(response) => response.code, _ => 503 }, "Kubernetes mutation request failed; check permissions, connectivity and object version"))
}

fn is_rbac_kind(kind: &str) -> bool {
    matches!(
        kind,
        "Role" | "ClusterRole" | "RoleBinding" | "ClusterRoleBinding"
    )
}

fn valid_name_segment(name: &str, kind: &str) -> bool {
    if name.is_empty() || name.len() > 253 || name == "." || name == ".." {
        return false;
    }
    // Disallow path traversal, URL escapes, whitespace, control characters
    if name.bytes().any(|c| c <= 32 || c == 127 || b"/\\%?#[]@".contains(&c)) {
        return false;
    }
    if is_rbac_kind(kind) {
        // RBAC names allow alphanumeric, '.', '-', '_', ':'
        name.bytes().all(|c| c.is_ascii_alphanumeric() || b".-_:".contains(&c))
    } else {
        // Standard names allow alphanumeric, '.', '-', and also allow ':' or '_' if present
        name.bytes().all(|c| c.is_ascii_alphanumeric() || b".-_:".contains(&c))
    }
}

fn validate_identity(resource: &ResourceRef, version: &str) -> Result<(), ApiError> {
    validate_reference(resource)?;
    if resource.uid.as_deref().is_none_or(str::is_empty)
        || version.is_empty()
        || !valid_name_segment(&resource.name, &resource.query.kind)
    {
        return Err(error(
            resource,
            400,
            "Exact resource identity, namespace, UID and resourceVersion are required",
        ));
    }
    Ok(())
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
}
fn validate_reference(resource: &ResourceRef) -> Result<(), ApiError> {
    let q = &resource.query;
    if q.context.trim().is_empty()
        || !valid_name_segment(&resource.name, &q.kind)
        || !valid_segment(&q.kind)
        || !valid_segment(&q.version)
        || (!q.group.is_empty() && !valid_segment(&q.group))
        || q.namespace
            .as_deref()
            .is_some_and(|ns| !valid_segment(ns) || ns == "all")
    {
        return Err(error(
            resource,
            400,
            "An exact context, API, resource name and namespace are required",
        ));
    }
    Ok(())
}

async fn resource_api(
    client: Client,
    resource: &ResourceRef,
) -> Result<Api<DynamicObject>, ApiError> {
    validate_reference(resource)?;
    let q = &resource.query;
    let (ar, namespaced) =
        if let Some(kind) = resource_type(&q.kind).filter(|kind| kind.group == q.group) {
            validate_query(q)?;
            (
                ApiResource {
                    group: q.group.clone(),
                    version: q.version.clone(),
                    api_version: if q.group.is_empty() {
                        q.version.clone()
                    } else {
                        format!("{}/{}", q.group, q.version)
                    },
                    kind: q.kind.clone(),
                    plural: kind.plural.clone(),
                },
                kind.namespaced,
            )
        } else {
            let gvk = kube::core::GroupVersionKind::gvk(&q.group, &q.version, &q.kind);
            let (ar, capabilities) =
                bounded(resource, kube::discovery::pinned_kind(&client, &gvk)).await?;
            if !capabilities.supports_operation("get") || ar.plural.contains('/') {
                return Err(error(
                    resource,
                    400,
                    "Only standalone Kubernetes objects can be changed",
                ));
            }
            (ar, capabilities.scope == kube::discovery::Scope::Namespaced)
        };
    if namespaced != q.namespace.is_some() {
        return Err(error(
            resource,
            400,
            "The resource scope requires an exact namespace or a cluster-scoped identity",
        ));
    }
    Ok(match &q.namespace {
        Some(ns) => Api::namespaced_with(client, ns, &ar),
        None => Api::all_with(client, &ar),
    })
}

/// No public constructor, Clone or Deserialize: the payload cannot be swapped
/// between review and commit, and one prepared operation cannot be replayed.
pub struct PreparedMutation {
    api: Api<DynamicObject>,
    resource: ResourceRef,
    version: String,
    before: DynamicObject,
    after: DynamicObject,
    review: String,
    /// The change description without the identity header — reused by batch reviews.
    diff: String,
    scale: Option<i32>,
    delete: bool,
    evict: bool,
    create: bool,
    prepared_at: Instant,
}
impl PreparedMutation {
    pub async fn prepare(client: Client, intent: MutationIntent) -> Result<Self, ApiError> {
        let intent = match intent {
            MutationIntent::Manifest {
                context,
                manifest,
                target,
            } => return Self::prepare_manifest(client, context, manifest, target).await,
            intent => intent,
        };
        let (resource, version, scale, secret, delete, evict) = match intent {
            MutationIntent::Manifest { .. } => unreachable!(),
            MutationIntent::Scale {
                resource,
                resource_version,
                replicas,
            } => {
                validate_query(&resource.query)?;
                if !["Deployment", "StatefulSet", "ReplicaSet"].contains(&resource.query.kind.as_str())
                    || !(0..=100000).contains(&replicas)
                {
                    return Err(error(
                        &resource,
                        400,
                        "Only Deployment/StatefulSet/ReplicaSet replicas in 0..100000 can be changed",
                    ));
                }
                (resource, resource_version, Some(replicas), None, false, false)
            }
            MutationIntent::Delete {
                resource,
                resource_version,
            } => (resource, resource_version, None, None, true, false),
            MutationIntent::Evict {
                resource,
                resource_version,
            } => {
                if resource.query.kind != "Pod" || resource.query.namespace.as_deref().unwrap_or("").is_empty() {
                    return Err(error(
                        &resource,
                        400,
                        "Only namespaced Pods can be evicted using the Eviction API",
                    ));
                }
                (resource, resource_version, None, None, false, true)
            }
            MutationIntent::Secret(request) => {
                request.validate()?;
                (
                    request.resource.clone(),
                    request.resource_version.clone(),
                    None,
                    Some(request),
                    false,
                    false,
                )
            }
        };
        validate_identity(&resource, &version)?;
        let api = resource_api(client, &resource).await?;
        let before = bounded(&resource, api.get(&resource.name)).await?;
        if before.metadata.uid != resource.uid
            || before.metadata.resource_version.as_deref() != Some(&version)
        {
            return Err(error(
                &resource,
                409,
                "Resource changed or was recreated. Refresh and review again",
            ));
        }
        let mut after = before.clone();
        let mut diff = String::new();
        if let Some(replicas) = scale {
            let old = before
                .data
                .pointer("/spec/replicas")
                .cloned()
                .unwrap_or(json!(1));
            if old == json!(replicas) {
                return Err(error(&resource, 400, "No changes to apply"));
            }
            diff = format!(
                "spec.replicas: {old} → {replicas}\nChanging replicas may create or terminate Pods."
            );
        } else if let Some(request) = secret {
            if before.data.get("immutable") == Some(&json!(true)) {
                return Err(error(&resource, 422, "This Secret is immutable"));
            }
            let old = before
                .data
                .get("data")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let new = serde_json::to_value(request.data).expect("string map serializes");
            let keys: BTreeSet<_> = old.keys().chain(new.as_object().unwrap().keys()).collect();
            for key in keys {
                if old.get(key) != new.get(key) {
                    diff.push_str(&format!(
                        "data/{key} (base64):\n  BEFORE: {}\n  AFTER:  {}\n",
                        old.get(key)
                            .map(Value::to_string)
                            .unwrap_or("(absent)".into()),
                        new.get(key)
                            .map(Value::to_string)
                            .unwrap_or("(removed)".into())
                    ));
                }
            }
            if diff.is_empty() {
                return Err(error(&resource, 400, "No changes to apply"));
            }
            after.data["data"] = new;
            if let Some(object) = after.data.as_object_mut() {
                object.remove("stringData");
            }
        }
        if delete {
            let metadata = serde_json::to_value(&before.metadata).expect("metadata serializes");
            let summary = json!({"creationTimestamp": metadata.get("creationTimestamp"), "labels": metadata.get("labels"), "owners": metadata.get("ownerReferences"), "finalizers": metadata.get("finalizers")});
            diff = format!(
                "DELETE this Kubernetes object using background garbage collection. Controllers or garbage collection may also remove dependents; Kubernetes does not provide a complete preview of those effects.\n\nObject metadata:\n{}",
                serde_json::to_string_pretty(&summary).expect("metadata serializes")
            );
            if resource.query.kind == "CustomResourceDefinition" {
                diff.push_str("\n\nDeleting a CRD deletes all custom resources defined by it across namespaces.");
            }
            if resource.query.kind == "Namespace" {
                diff.push_str("\n\nDeleting a Namespace removes its namespaced contents.");
            }
        }
        if evict {
            let metadata = serde_json::to_value(&before.metadata).expect("metadata serializes");
            let summary = json!({"creationTimestamp": metadata.get("creationTimestamp"), "labels": metadata.get("labels"), "owners": metadata.get("ownerReferences")});
            diff = format!(
                "EVICT this Pod using policy/v1 Eviction API.\nPodDisruptionBudgets (PDB) will be respected. The API will refuse eviction if a PDB is violated.\n\nPod metadata:\n{}",
                serde_json::to_string_pretty(&summary).expect("metadata serializes")
            );
        }
        let operation = if delete { "DELETE" } else if evict { "EVICT" } else { "Apply" };
        let review = format!(
            "{}\n\n{}\n\n{operation} this exact change? Cancel leaves the resource unchanged.",
            identity_summary(&resource, &version),
            diff
        );
        if review.chars().count() > MAX_REVIEW_CHARS {
            return Err(error(
                &resource,
                422,
                "Change is too large for a complete confirmation dialog (24000 characters). Split the edit into smaller changes",
            ));
        }
        Ok(Self {
            api,
            resource,
            version,
            before,
            after,
            review,
            diff,
            scale,
            delete,
            evict,
            create: false,
            prepared_at: Instant::now(),
        })
    }

    async fn prepare_manifest(
        client: Client,
        context: String,
        manifest: String,
        target: Option<ManifestTarget>,
    ) -> Result<Self, ApiError> {
        use super::api::ResourceQuery;
        let mut resource = ResourceRef {
            query: ResourceQuery {
                context,
                group: String::new(),
                version: String::new(),
                kind: String::new(),
                namespace: None,
            },
            name: String::new(),
            uid: None,
        };
        if manifest.len() > 1024 * 1024 {
            return Err(error(&resource, 422, "Manifest exceeds 1 MiB"));
        }
        // Exactly one named object: no List, multi-document input, subresource or generateName.
        let mut after: DynamicObject = serde_yaml::from_str(&manifest).map_err(|_| {
            error(
                &resource,
                400,
                "Expected one named Kubernetes object as YAML",
            )
        })?;
        let types = after
            .types
            .as_ref()
            .ok_or_else(|| error(&resource, 400, "apiVersion and kind are required"))?;
        let (group, version) = types
            .api_version
            .split_once('/')
            .unwrap_or(("", &types.api_version));
        resource.query.group = group.into();
        resource.query.version = version.into();
        resource.query.kind = types.kind.clone();
        resource.query.namespace = after.metadata.namespace.clone();
        resource.name = after.metadata.name.clone().unwrap_or_default();
        resource.uid = after.metadata.uid.clone();
        validate_reference(&resource)?;
        if resource.query.kind == "List" || after.metadata.generate_name.is_some() {
            return Err(error(
                &resource,
                400,
                "Lists and generated names are not supported by the object change gateway",
            ));
        }
        let mut version = after.metadata.resource_version.clone().unwrap_or_default();
        if let Some(target) = target {
            if target.resource != resource || target.resource_version != version {
                return Err(error(
                    &resource,
                    409,
                    "The YAML identity or resourceVersion differs from the object opened in the editor. Refresh and review again",
                ));
            }
        }
        let api = resource_api(client, &resource).await?;
        let current = bounded(&resource, api.get_opt(&resource.name)).await?;
        let create = current.is_none();
        let before = if let Some(before) = current {
            validate_identity(&resource, &version)?;
            if before.metadata.uid != resource.uid
                || before.metadata.resource_version.as_deref() != Some(&version)
            {
                return Err(error(
                    &resource,
                    409,
                    "Object changed or was recreated. Refresh and review again",
                ));
            }
            // Server-owned fields are restored, never trusted from an editable document.
            after.metadata.managed_fields = before.metadata.managed_fields.clone();
            after.metadata.creation_timestamp = before.metadata.creation_timestamp.clone();
            if let Some(status) = before.data.get("status") {
                after.data["status"] = status.clone();
            } else if let Some(map) = after.data.as_object_mut() {
                map.remove("status");
            }
            before
        } else {
            if resource.uid.is_some() || !version.is_empty() {
                return Err(error(
                    &resource,
                    409,
                    "The edited object no longer exists. Refusing to recreate it",
                ));
            }
            if after.data.get("status").is_some() || after.metadata.managed_fields.is_some() {
                return Err(error(
                    &resource,
                    400,
                    "Creation cannot include server-owned status or managedFields",
                ));
            }
            version = "(new object)".into();
            after.clone()
        };
        let old = serde_json::to_value(&before).expect("object serializes");
        let new = serde_json::to_value(&after).expect("object serializes");
        let mut diff = String::new();
        if create {
            diff = format!(
                "CREATE object:\n{}",
                serde_json::to_string_pretty(&new).unwrap()
            );
        } else {
            json_diff("", &old, &new, &mut diff);
        }
        if diff.is_empty() {
            return Err(error(&resource, 400, "No changes to apply"));
        }
        let review = format!(
            "{}\n\n{}\n\n{} this exact object? Changes to controllers or finalizers may create or delete dependent resources. Cancel changes nothing.",
            identity_summary(&resource, &version),
            diff,
            if create { "CREATE" } else { "UPDATE" }
        );
        if review.chars().count() > MAX_REVIEW_CHARS {
            return Err(error(
                &resource,
                422,
                "Complete change review exceeds 24000 characters. Split the change",
            ));
        }
        Ok(Self {
            api,
            resource,
            version,
            before,
            after,
            review,
            diff,
            scale: None,
            delete: false,
            evict: false,
            create,
            prepared_at: Instant::now(),
        })
    }

    pub fn review(&self) -> &str {
        &self.review
    }

    /// The consent implementation is supplied by trusted backend code, never IPC.
    pub async fn confirm_and_commit<F, Fut>(self, confirm: F) -> Result<Value, ApiError>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<bool, ApiError>>,
    {
        if !confirm(self.review.clone()).await? {
            return Err(cancelled(
                &self.resource,
                "Operation cancelled. Nothing was changed",
            ));
        }
        self.commit().await
    }

    /// Execute an already approved single mutation.
    pub async fn commit(self) -> Result<Value, ApiError> {
        self.commit_inner(true).await
    }

    /// Batch callers check the consent TTL once before the first step; re-checking
    /// it for every step would turn a slow but valid batch into N expiry errors.
    pub async fn commit_after_shared_consent(self) -> Result<Value, ApiError> {
        self.commit_inner(false).await
    }

    async fn commit_inner(self, check_ttl: bool) -> Result<Value, ApiError> {
        if check_ttl && self.prepared_at.elapsed() > REVIEW_TTL {
            return Err(error(
                &self.resource,
                409,
                "Confirmation expired. Refresh and review again",
            ));
        }
        if self.create {
            if bounded(&self.resource, self.api.get_opt(&self.resource.name))
                .await?
                .is_some()
            {
                return Err(error(
                    &self.resource,
                    409,
                    "An object appeared during confirmation. Nothing was overwritten; refresh and review again",
                ));
            }
            if check_ttl && self.prepared_at.elapsed() > REVIEW_TTL {
                return Err(error(
                    &self.resource,
                    409,
                    "Confirmation expired during the final check; review again",
                ));
            }
            // POST cannot replace an object created by another actor after this read.
            let result = bounded(
                &self.resource,
                self.api.create(&PostParams::default(), &self.after),
            )
            .await?;
            return serde_json::to_value(result).map_err(|_| {
                error(
                    &self.resource,
                    500,
                    "Cannot decode response; refresh to verify the outcome",
                )
            });
        }
        let current = bounded(&self.resource, self.api.get(&self.resource.name)).await?;
        if current.metadata.uid != self.before.metadata.uid
            || current.metadata.resource_version.as_deref() != Some(&self.version)
        {
            return Err(error(
                &self.resource,
                409,
                "Resource changed while confirmation was open. Refresh and review again",
            ));
        }
        if check_ttl && self.prepared_at.elapsed() > REVIEW_TTL {
            return Err(error(
                &self.resource,
                409,
                "Confirmation expired during the final check; review again",
            ));
        }
        if self.delete {
            let params = DeleteParams {
                preconditions: Some(Preconditions {
                    uid: self.resource.uid.clone(),
                    resource_version: Some(self.version.clone()),
                }),
                propagation_policy: Some(kube::api::PropagationPolicy::Background),
                ..DeleteParams::default()
            };
            let result = bounded(
                &self.resource,
                self.api.delete(&self.resource.name, &params),
            )
            .await?;
            let value = match result {
                either::Either::Left(object) => serde_json::to_value(object),
                either::Either::Right(status) => serde_json::to_value(status),
            };
            return value.map_err(|_| {
                error(
                    &self.resource,
                    500,
                    "Delete response could not be decoded; refresh to verify the outcome",
                )
            });
        }
        if self.evict {
            let body = serde_json::json!({
                "apiVersion": "policy/v1",
                "kind": "Eviction",
                "metadata": {
                    "name": self.resource.name,
                    "namespace": self.resource.query.namespace,
                },
                "deleteOptions": {
                    "preconditions": {
                        "uid": self.resource.uid,
                        "resourceVersion": self.version,
                    }
                }
            });
            let payload = serde_json::to_vec(&body).map_err(|e| error(&self.resource, 500, &e.to_string()))?;
            let result = bounded(
                &self.resource,
                self.api.create_subresource::<DynamicObject>("eviction", &self.resource.name, &PostParams::default(), payload)
            ).await?;
            return serde_json::to_value(result).map_err(|_| {
                error(
                    &self.resource,
                    500,
                    "Cannot decode eviction response; refresh to verify the outcome",
                )
            });
        }
        let result = if let Some(replicas) = self.scale {
            // RV is a conditional patch precondition enforced by the API server;
            // UID additionally pins the object across delete/recreate races.
            let patch = json!({"metadata":{"uid":self.resource.uid,"resourceVersion":self.version},"spec":{"replicas":replicas}});
            bounded(
                &self.resource,
                self.api.patch(
                    &self.resource.name,
                    &PatchParams::default(),
                    &Patch::Merge(patch),
                ),
            )
            .await?
        } else {
            bounded(
                &self.resource,
                self.api
                    .replace(&self.resource.name, &PostParams::default(), &self.after),
            )
            .await?
        };
        serde_json::to_value(result).map_err(|_| {
            error(
                &self.resource,
                500,
                "Cannot decode the response. Refresh to verify the saved state",
            )
        })
    }
}

/// One step of a batch mutation. `critical` stops the remaining steps when it fails.
pub struct BatchIntent {
    pub intent: MutationIntent,
    pub critical: bool,
}

impl BatchIntent {
    pub fn new(intent: MutationIntent) -> Self {
        Self {
            intent,
            critical: false,
        }
    }

    pub fn critical(intent: MutationIntent) -> Self {
        Self {
            intent,
            critical: true,
        }
    }
}

/// Hard cap so one confirmation cannot hide an unbounded operation.
pub const MAX_BATCH_STEPS: usize = 1000;
/// Diff budget per manifest-like step inside a batch review.
const BATCH_DIFF_BUDGET: usize = 4_000;
/// Keep room for the footer and the last identity line.
const BATCH_REVIEW_MARGIN: usize = 2_000;

struct PreparedBatchStep {
    action: &'static str,
    critical: bool,
    mutation: PreparedMutation,
}

/// A prepared multi-step operation that is confirmed once and committed sequentially.
/// The single consent covers every step; callers must not re-enter the guard per step.
pub struct PreparedBatch {
    primary: ResourceRef,
    steps: Vec<PreparedBatchStep>,
    review: String,
    prepared_at: Instant,
}

impl PreparedBatch {
    pub async fn prepare(
        client: Client,
        primary: ResourceRef,
        intents: Vec<BatchIntent>,
    ) -> Result<Self, ApiError> {
        if intents.is_empty() {
            return Err(error(
                &primary,
                400,
                "A batch operation needs at least one step",
            ));
        }
        if intents.len() > MAX_BATCH_STEPS {
            return Err(error(
                &primary,
                422,
                "Too many steps in one batch; split the operation",
            ));
        }
        let mut steps = Vec::with_capacity(intents.len());
        for BatchIntent { intent, critical } in intents {
            let action = match &intent {
                MutationIntent::Manifest { .. } => "APPLY",
                MutationIntent::Scale { .. } => "SCALE",
                MutationIntent::Secret(_) => "UPDATE",
                MutationIntent::Delete { .. } => "DELETE",
                MutationIntent::Evict { .. } => "EVICT",
            };
            let mutation = PreparedMutation::prepare(client.clone(), intent).await?;
            steps.push(PreparedBatchStep {
                action,
                critical,
                mutation,
            });
        }
        let review = Self::build_review(&primary, &steps)?;
        Ok(Self {
            primary,
            steps,
            review,
            prepared_at: Instant::now(),
        })
    }

    fn build_review(
        primary: &ResourceRef,
        steps: &[PreparedBatchStep],
    ) -> Result<String, ApiError> {
        let step_count = steps.len();
        let mut review = format!(
            "Batch operation in context {:?}: {step_count} {}. All steps are confirmed together.\n",
            primary.query.context,
            if step_count == 1 { "step" } else { "steps" }
        );
        if steps.iter().any(|step| step.action == "EVICT") {
            review.push_str("Evictions use policy/v1 and respect PodDisruptionBudgets. ");
        }
        if steps.iter().any(|step| step.action == "DELETE") {
            review.push_str("Controllers or garbage collection may also remove dependents. ");
        }
        review.push_str("Failures are reported per step.\n\n");
        let mut diff_used = 0usize;
        let mut omitted = 0usize;
        let soft_limit = MAX_REVIEW_CHARS.saturating_sub(BATCH_REVIEW_MARGIN);
        for (index, step) in steps.iter().enumerate() {
            let resource = &step.mutation.resource;
            let namespace = resource.query.namespace.as_deref().unwrap_or("(cluster)");
            let line = format!(
                "{}. {} {} {} (namespace: {})\n",
                index + 1,
                step.action,
                resource.query.kind,
                resource.name,
                namespace
            );
            // Even compact lines need a ceiling: a drain can touch hundreds of pods.
            // Stop at a clean prefix instead of skipping arbitrary rows in the middle.
            if review.chars().count() + line.chars().count() > soft_limit {
                omitted = steps.len() - index;
                break;
            }
            review.push_str(&line);
            // Eviction/delete payloads are fixed by the API, so a compact line is enough.
            // Manifest-like steps carry a real diff the user must be able to review.
            if matches!(step.action, "EVICT" | "DELETE") {
                if step.action == "DELETE" {
                    match resource.query.kind.as_str() {
                        "CustomResourceDefinition" => review.push_str(
                            "    Deleting a CRD deletes all custom resources defined by it across namespaces.\n",
                        ),
                        "Namespace" => review.push_str(
                            "    Deleting a Namespace removes its namespaced contents.\n",
                        ),
                        _ => {}
                    }
                }
                continue;
            }
            if review.chars().count() >= soft_limit || diff_used >= BATCH_DIFF_BUDGET * 3 {
                continue;
            }
            let mut added = 0usize;
            let mut truncated = false;
            for line in step.mutation.diff.lines() {
                let chunk = format!("    {line}\n");
                if added + chunk.chars().count() > BATCH_DIFF_BUDGET
                    || review.chars().count() + chunk.chars().count() > soft_limit
                {
                    truncated = true;
                    break;
                }
                review.push_str(&chunk);
                added += chunk.chars().count();
            }
            if truncated {
                review.push_str("    … (diff truncated)\n");
            }
            diff_used += added;
        }
        if omitted > 0 {
            review.push_str(&format!(
                "\n… {omitted} more step(s) are included in this batch but not listed here.\n"
            ));
        }
        review.push_str(&format!(
            "\nConfirm all {step_count} {}? Cancel leaves the cluster unchanged.",
            if step_count == 1 { "step" } else { "steps" }
        ));
        if review.chars().count() > MAX_REVIEW_CHARS {
            return Err(error(
                primary,
                422,
                "Batch review is too large for a complete confirmation dialog; split the operation",
            ));
        }
        Ok(review)
    }

    pub fn review(&self) -> &str {
        &self.review
    }

    /// One consent for the whole batch, then each step commits without re-prompting.
    pub async fn confirm_and_commit<F, Fut>(self, confirm: F) -> Result<Value, ApiError>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<bool, ApiError>>,
    {
        if !confirm(self.review.clone()).await? {
            return Err(cancelled(
                &self.primary,
                "Batch cancelled. Nothing was changed",
            ));
        }
        if self.prepared_at.elapsed() > REVIEW_TTL {
            return Err(error(
                &self.primary,
                409,
                "Confirmation expired. Refresh and review again",
            ));
        }
        let mut results = Vec::with_capacity(self.steps.len());
        let mut succeeded: u64 = 0;
        let mut failed: u64 = 0;
        let mut stopped = false;
        for step in self.steps {
            let action = step.action;
            let critical = step.critical;
            let kind = step.mutation.resource.query.kind.clone();
            let name = step.mutation.resource.name.clone();
            let namespace = step.mutation.resource.query.namespace.clone();
            match step.mutation.commit_after_shared_consent().await {
                Ok(_) => {
                    succeeded += 1;
                    results.push(json!({
                        "action": action,
                        "kind": kind,
                        "name": name,
                        "namespace": namespace,
                        "ok": true,
                    }));
                }
                Err(error) => {
                    failed += 1;
                    results.push(json!({
                        "action": action,
                        "kind": kind,
                        "name": name,
                        "namespace": namespace,
                        "ok": false,
                        "code": error.code,
                        "message": error.message,
                    }));
                    if critical {
                        stopped = true;
                        break;
                    }
                }
            }
        }
        Ok(json!({
            "steps": results,
            "succeeded": succeeded,
            "failed": failed,
            "stopped": stopped,
        }))
    }
}

fn json_diff(path: &str, before: &Value, after: &Value, out: &mut String) {
    if before == after {
        return;
    }
    if let (Some(a), Some(b)) = (before.as_object(), after.as_object()) {
        for key in a.keys().chain(b.keys()).collect::<BTreeSet<_>>() {
            let next = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
            match (a.get(key), b.get(key)) {
                (Some(old), Some(new)) => json_diff(&next, old, new, out),
                (old, new) => out.push_str(&format!(
                    "{:?}: BEFORE {} → AFTER {}\n",
                    next,
                    old.map(Value::to_string).unwrap_or("(absent)".into()),
                    new.map(Value::to_string).unwrap_or("(removed)".into())
                )),
            }
        }
    } else {
        out.push_str(&format!(
            "{:?}: BEFORE {} → AFTER {}\n",
            path, before, after
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn expired_review_cannot_write_even_if_approved() {
        let resource: ResourceRef=serde_json::from_value(json!({"context":"test","group":"apps","version":"v1","kind":"Deployment","namespace":"default","name":"web","uid":"uid"})).unwrap();
        let service = tower::service_fn(|_: http::Request<kube::client::Body>| async {
            panic!("Expired confirmation must not contact Kubernetes");
            #[allow(unreachable_code)]
            Ok::<_, std::convert::Infallible>(http::Response::new(kube::client::Body::empty()))
        });
        let before:DynamicObject=serde_json::from_value(json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","uid":"uid","resourceVersion":"10"},"spec":{"replicas":1}})).unwrap();
        let plan = PreparedMutation {
            api: resource_api(Client::new(service, "default"), &resource)
                .await
                .unwrap(),
            resource,
            version: "10".into(),
            before: before.clone(),
            after: before,
            review: "review".into(),
            diff: "review".into(),
            scale: Some(0),
            delete: false,
            evict: false,
            create: false,
            prepared_at: Instant::now() - REVIEW_TTL - Duration::from_secs(1),
        };
        assert_eq!(
            plan.confirm_and_commit(|_| async { Ok(true) })
                .await
                .unwrap_err()
                .status,
            Some(409)
        );
    }

    fn test_client() -> Client {
        let service = tower::service_fn(|_: http::Request<kube::client::Body>| async {
            panic!("Batch validation must not contact Kubernetes");
            #[allow(unreachable_code)]
            Ok::<_, std::convert::Infallible>(http::Response::new(kube::client::Body::empty()))
        });
        Client::new(service, "default")
    }

    #[tokio::test]
    async fn empty_batch_is_rejected_before_any_cluster_call() {
        let resource: ResourceRef = serde_json::from_value(json!({
            "context": "test",
            "group": "",
            "version": "v1",
            "kind": "Node",
            "namespace": null,
            "name": "node-1",
            "uid": "node-uid"
        }))
        .unwrap();
        let error = match PreparedBatch::prepare(test_client(), resource, Vec::new()).await {
            Ok(_) => panic!("empty batch must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.status, Some(400));
    }

    #[tokio::test]
    async fn batch_step_cap_is_enforced() {
        let resource: ResourceRef = serde_json::from_value(json!({
            "context": "test",
            "group": "",
            "version": "v1",
            "kind": "Pod",
            "namespace": "team",
            "name": "web",
            "uid": "pod-uid"
        }))
        .unwrap();
        let intents = (0..=MAX_BATCH_STEPS)
            .map(|_| {
                BatchIntent::new(MutationIntent::Evict {
                    resource: resource.clone(),
                    resource_version: "1".into(),
                })
            })
            .collect();
        let error = match PreparedBatch::prepare(test_client(), resource, intents).await {
            Ok(_) => panic!("oversized batch must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.status, Some(422));
    }

    #[test]
    fn rbac_names_with_colons_are_valid() {
        let rbac_res: ResourceRef = serde_json::from_value(json!({
            "context": "test",
            "group": "rbac.authorization.k8s.io",
            "version": "v1",
            "kind": "ClusterRole",
            "namespace": null,
            "name": "system:discovery",
            "uid": "rbac-uid"
        })).unwrap();
        assert!(validate_reference(&rbac_res).is_ok());
        assert!(validate_identity(&rbac_res, "123").is_ok());

        let invalid_path: ResourceRef = serde_json::from_value(json!({
            "context": "test",
            "group": "rbac.authorization.k8s.io",
            "version": "v1",
            "kind": "ClusterRole",
            "namespace": null,
            "name": "../escape",
            "uid": "rbac-uid"
        })).unwrap();
        assert!(validate_reference(&invalid_path).is_err());
    }
}
