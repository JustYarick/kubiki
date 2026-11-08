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
use std::{collections::BTreeSet, future::Future, time::Duration};

mod review;
pub use review::{MutationReview, ReviewKind, ReviewStep, ReviewWarning};
mod actions;
pub use actions::ResourceAction;

pub const MAX_YAML_REVIEW_CHARS: usize = 24_000;

pub enum MutationIntent {
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
    Secret(SecretDataRequest),
    Delete {
        resource: ResourceRef,
        resource_version: String,
    },
    Evict {
        resource: ResourceRef,
        resource_version: String,
    },
    /// Drop one entry from `metadata.finalizers`. The object is re-read server-side
    /// so the review pins the live state, not a stale renderer copy.
    RemoveFinalizer {
        resource: ResourceRef,
        finalizer: String,
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
    if name
        .bytes()
        .any(|c| c <= 32 || c == 127 || b"/\\%?#[]@".contains(&c))
    {
        return false;
    }
    if is_rbac_kind(kind) {
        // RBAC names allow alphanumeric, '.', '-', '_', ':'
        name.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-_:".contains(&c))
    } else {
        // Standard names allow alphanumeric, '.', '-', and also allow ':' or '_' if present
        name.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-_:".contains(&c))
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
pub struct ResourcePrecondition {
    api: Api<DynamicObject>,
    resource: ResourceRef,
    version: String,
}
impl ResourcePrecondition {
    pub async fn prepare(
        client: Client,
        resource: ResourceRef,
        version: String,
    ) -> Result<Self, ApiError> {
        validate_identity(&resource, &version)?;
        let condition = Self {
            api: resource_api(client, &resource).await?,
            resource,
            version,
        };
        condition.check(true).await?;
        Ok(condition)
    }
    async fn check(&self, exact_version: bool) -> Result<(), ApiError> {
        let current = bounded(&self.resource, self.api.get(&self.resource.name)).await?;
        if current.metadata.uid != self.resource.uid
            || exact_version && current.metadata.resource_version.as_deref() != Some(&self.version)
        {
            return Err(error(
                &self.resource,
                409,
                "Source resource changed or was recreated. Refresh and try again",
            ));
        }
        Ok(())
    }
}
fn verify_version(
    resource: &ResourceRef,
    version: &str,
    current: &DynamicObject,
) -> Result<(), ApiError> {
    if current.metadata.uid != resource.uid
        || current.metadata.resource_version.as_deref() != Some(version)
    {
        return Err(error(
            resource,
            409,
            "Resource changed or was recreated. Refresh and try again",
        ));
    }
    Ok(())
}
fn deletion_warnings(resource: &ResourceRef, delete: bool, evict: bool) -> Vec<ReviewWarning> {
    let mut warnings = Vec::new();
    if evict {
        warnings.push(ReviewWarning::PodDisruptionBudget);
    }
    if delete {
        warnings.push(ReviewWarning::Dependents);
        if resource.query.kind == "CustomResourceDefinition" {
            warnings.push(ReviewWarning::CrdDeletion);
        }
        if resource.query.kind == "Namespace" {
            warnings.push(ReviewWarning::NamespaceDeletion);
        }
    }
    warnings
}

enum PreparedAction {
    Replace,
    Create,
    Scale(i32),
    Delete,
    Evict,
    RemoveFinalizer(String),
}

pub struct PreparedMutation {
    api: Api<DynamicObject>,
    resource: ResourceRef,
    version: String,
    before: DynamicObject,
    after: DynamicObject,
    review: String,
    action: PreparedAction,
    details: MutationReview,
    preconditions: Vec<ResourcePrecondition>,
}
impl PreparedMutation {
    pub async fn prepare(client: Client, intent: MutationIntent) -> Result<Self, ApiError> {
        let intent = match intent {
            MutationIntent::Action {
                resource,
                resource_version,
                action,
            } => return Self::prepare_action(client, resource, resource_version, action).await,
            MutationIntent::Manifest {
                context,
                manifest,
                target,
            } => return Self::prepare_manifest(client, context, manifest, target).await,
            intent => intent,
        };
        let (resource, version, scale, secret, delete, evict) = match intent {
            MutationIntent::Manifest { .. } | MutationIntent::Action { .. } => unreachable!(),
            MutationIntent::RemoveFinalizer {
                resource,
                finalizer,
            } => {
                return Self::prepare_remove_finalizer(client, resource, finalizer).await;
            }
            MutationIntent::Scale {
                resource,
                resource_version,
                replicas,
            } => {
                validate_query(&resource.query)?;
                if !["Deployment", "StatefulSet", "ReplicaSet"]
                    .contains(&resource.query.kind.as_str())
                    || !(0..=100000).contains(&replicas)
                {
                    return Err(error(
                        &resource,
                        400,
                        "Only Deployment/StatefulSet/ReplicaSet replicas in 0..100000 can be changed",
                    ));
                }
                (
                    resource,
                    resource_version,
                    Some(replicas),
                    None,
                    false,
                    false,
                )
            }
            MutationIntent::Delete {
                resource,
                resource_version,
            } => (resource, resource_version, None, None, true, false),
            MutationIntent::Evict {
                resource,
                resource_version,
            } => {
                if resource.query.kind != "Pod"
                    || resource.query.namespace.as_deref().unwrap_or("").is_empty()
                {
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
                "Resource changed or was recreated. Refresh and try again",
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
            diff = format!("Scale from {old} to {replicas} replicas.");
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
            let changed = keys
                .into_iter()
                .filter(|key| old.get(*key) != new.get(*key))
                .count();
            if changed == 0 {
                return Err(error(&resource, 400, "No changes to apply"));
            }
            diff = format!("Update Secret data ({changed} changed keys).");
            after.data["data"] = new;
            if let Some(object) = after.data.as_object_mut() {
                object.remove("stringData");
            }
        }
        if delete {
            diff = format!(
                "Delete this {} and its dependent resources.",
                resource.query.kind
            );
        }
        if evict {
            diff = "Evict this Pod. Kubernetes will enforce PodDisruptionBudgets.".into();
        }
        let review = diff.clone();
        let warnings = deletion_warnings(&resource, delete, evict);
        let details = MutationReview::single(
            ReviewKind::Action,
            if delete {
                "DELETE"
            } else if evict {
                "EVICT"
            } else if scale.is_some() {
                "SCALE"
            } else {
                "UPDATE_SECRET"
            },
            &resource,
            diff.clone(),
            None,
            warnings,
        );
        Ok(Self {
            api,
            resource,
            version,
            before,
            after,
            review,
            details,
            preconditions: Vec::new(),
            action: if delete {
                PreparedAction::Delete
            } else if evict {
                PreparedAction::Evict
            } else if let Some(n) = scale {
                PreparedAction::Scale(n)
            } else {
                PreparedAction::Replace
            },
        })
    }

    /// Re-read the object, verify the finalizer exists, and produce a one-entry
    /// removal review. Commit is a merge patch with UID/RV preconditions; no retries.
    async fn prepare_remove_finalizer(
        client: Client,
        resource: ResourceRef,
        finalizer: String,
    ) -> Result<Self, ApiError> {
        if finalizer.len() > 200 {
            return Err(error(
                &resource,
                400,
                "The finalizer name is too long to be real",
            ));
        }
        validate_reference(&resource)?;
        if resource.uid.as_deref().is_none_or(str::is_empty) {
            return Err(error(
                &resource,
                400,
                "Exact resource identity and UID are required",
            ));
        }
        let api = resource_api(client, &resource).await?;
        let before = bounded(&resource, api.get(&resource.name)).await?;
        if before.metadata.uid != resource.uid {
            return Err(error(
                &resource,
                409,
                "Resource changed or was recreated. Refresh and remove again",
            ));
        }
        let version = before.metadata.resource_version.clone().unwrap_or_default();
        validate_identity(&resource, &version)?;
        let existing = before.metadata.finalizers.clone().unwrap_or_default();
        if !existing.iter().any(|name| name == &finalizer) {
            return Err(error(
                &resource,
                400,
                "This finalizer is already absent from the object",
            ));
        }
        let remaining: Vec<String> = existing
            .iter()
            .filter(|name| name.as_str() != finalizer.as_str())
            .cloned()
            .collect();
        let mut after = before.clone();
        after.metadata.finalizers = Some(remaining);
        let review = format!("Remove finalizer {finalizer:?} from this object.");
        let details = MutationReview::single(
            ReviewKind::Action,
            "REMOVE_FINALIZER",
            &resource,
            review.clone(),
            None,
            vec![ReviewWarning::Dependents],
        );
        Ok(Self {
            api,
            resource,
            version,
            before,
            after,
            review,
            details,
            preconditions: Vec::new(),
            action: PreparedAction::RemoveFinalizer(finalizer),
        })
    }

    async fn prepare_manifest(
        client: Client,
        context: String,
        manifest: String,
        target: Option<ManifestTarget>,
    ) -> Result<Self, ApiError> {
        Self::prepare_manifest_with_review(client, context, manifest, target, true).await
    }
    async fn prepare_manifest_with_review(
        client: Client,
        context: String,
        manifest: String,
        target: Option<ManifestTarget>,
        detailed: bool,
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
                    "The YAML identity or resourceVersion differs from the object opened in the editor. Refresh and try again",
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
                    "Object changed or was recreated. Refresh and try again",
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
        if !detailed {
            if !create && old == new {
                return Err(error(&resource, 400, "No changes to apply"));
            }
            diff = "Prepared resource action".into();
        } else if create {
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
        let review = if detailed {
            format!(
                "{}\n\n{}\n\n{} this exact object? Changes to controllers or finalizers may create or delete dependent resources. Cancel changes nothing.",
                identity_summary(&resource, &version),
                diff,
                if create { "CREATE" } else { "UPDATE" }
            )
        } else {
            "Apply this resource action.".into()
        };
        if detailed && review.chars().count() > MAX_YAML_REVIEW_CHARS {
            return Err(error(
                &resource,
                422,
                "Complete change review exceeds 24000 characters. Split the change",
            ));
        }
        let details = MutationReview::single(
            if detailed {
                ReviewKind::Yaml
            } else {
                ReviewKind::Action
            },
            if create { "CREATE" } else { "UPDATE" },
            &resource,
            if create {
                "Create this Kubernetes object.".into()
            } else {
                "Apply the edited Kubernetes configuration.".into()
            },
            detailed.then(|| diff.clone()),
            vec![ReviewWarning::Dependents],
        );
        Ok(Self {
            api,
            resource,
            version,
            before,
            after,
            review,
            details,
            preconditions: Vec::new(),
            action: if create {
                PreparedAction::Create
            } else {
                PreparedAction::Replace
            },
        })
    }

    pub fn details(&self) -> MutationReview {
        self.details.clone()
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

    /// Execute an already confirmed mutation; consent does not expire.
    pub async fn commit(self) -> Result<Value, ApiError> {
        self.commit_guarded(|| Ok(())).await
    }

    /// Recheck revocable backend authorization after the final live reads and
    /// immediately before the mutation request. The callback cannot be supplied
    /// through IPC. Ordinary manual consent keeps the existing commit path.
    pub async fn commit_guarded<F>(self, authorize: F) -> Result<Value, ApiError>
    where
        F: FnOnce() -> Result<(), ApiError>,
    {
        for condition in &self.preconditions {
            condition.check(true).await?;
        }
        if matches!(self.action, PreparedAction::Create) {
            if bounded(&self.resource, self.api.get_opt(&self.resource.name))
                .await?
                .is_some()
            {
                return Err(error(
                    &self.resource,
                    409,
                    "An object appeared during confirmation. Nothing was overwritten; refresh and try again",
                ));
            }
            // POST cannot replace an object created by another actor after this read.
            authorize()?;
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
                "Resource changed while confirmation was open. Refresh and try again",
            ));
        }
        authorize()?;
        if matches!(self.action, PreparedAction::Delete) {
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
        if let PreparedAction::RemoveFinalizer(finalizer) = &self.action {
            // A merge patch replaces the whole finalizers array while UID and
            // resourceVersion act as the optimistic-concurrency precondition.
            let remaining = self.after.metadata.finalizers.clone().unwrap_or_default();
            debug_assert!(
                !remaining.iter().any(|name| name == finalizer),
                "prepare guarantees the removed finalizer cannot reappear in the patch"
            );
            let patch = json!({
                "metadata": {
                    "uid": self.resource.uid,
                    "resourceVersion": self.version,
                    // Overwrite metadata.finalizers even when it was empty before.
                    "finalizers": remaining,
                }
            });
            let accepted = bounded(
                &self.resource,
                self.api.patch(
                    &self.resource.name,
                    &PatchParams::default(),
                    &Patch::Merge(patch),
                ),
            )
            .await?;
            // The patch response lags a controller that re-adds the finalizer
            // right away. One re-read decides the verdict; a 404 there means
            // the object finished deleting, which is also a success.
            match bounded(&self.resource, self.api.get(&self.resource.name)).await {
                Ok(fresh) => {
                    return serde_json::to_value(fresh).map_err(|_| {
                        error(
                            &self.resource,
                            500,
                            "Cannot decode the response. Refresh to verify the finalizer state",
                        )
                    });
                }
                Err(err) if err.status == Some(404) => {
                    return serde_json::to_value(accepted).map_err(|_| {
                        error(
                            &self.resource,
                            500,
                            "Cannot decode the response. Refresh to verify the finalizer state",
                        )
                    });
                }
                Err(err) => return Err(err),
            }
        }
        if matches!(self.action, PreparedAction::Evict) {
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
            let payload = serde_json::to_vec(&body)
                .map_err(|e| error(&self.resource, 500, &e.to_string()))?;
            let result = bounded(
                &self.resource,
                self.api.create_subresource::<DynamicObject>(
                    "eviction",
                    &self.resource.name,
                    &PostParams::default(),
                    payload,
                ),
            )
            .await?;
            return serde_json::to_value(result).map_err(|_| {
                error(
                    &self.resource,
                    500,
                    "Cannot decode eviction response; refresh to verify the outcome",
                )
            });
        }
        let result = if let PreparedAction::Scale(replicas) = self.action {
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

mod batch;
pub use batch::{BatchIntent, MAX_BATCH_STEPS, PreparedBatch};

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
        }))
        .unwrap();
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
        }))
        .unwrap();
        assert!(validate_reference(&invalid_path).is_err());
    }
}
