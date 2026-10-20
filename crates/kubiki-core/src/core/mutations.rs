//! The desktop write boundary. A prepared operation owns its payload and can only
//! be consumed once, after backend consent. No approval flag is deserialized.
use super::{
    api::{ApiError, ApiErrorCode, ResourceRef, validate_query},
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
    format!(
        "Context: {:?}\n{}: {:?}\nNamespace: {:?}\nUID: {:?}\nResource version: {:?}",
        resource.query.context,
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

fn validate_identity(resource: &ResourceRef, version: &str) -> Result<(), ApiError> {
    let kind = validate_query(&resource.query)?;
    if resource.uid.as_deref().is_none_or(str::is_empty)
        || version.is_empty()
        || resource.name.is_empty()
        || resource.name.len() > 253
        || resource.name.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
        || (kind.namespaced
            && resource
                .query
                .namespace
                .as_deref()
                .is_none_or(|s| s == "all" || s.is_empty()))
    {
        return Err(error(
            resource,
            400,
            "Exact resource identity, namespace, UID and resourceVersion are required",
        ));
    }
    Ok(())
}

fn resource_api(client: Client, resource: &ResourceRef) -> Result<Api<DynamicObject>, ApiError> {
    let kind = validate_query(&resource.query)?;
    let ar = ApiResource {
        group: kind.group.clone(),
        version: kind.version.clone(),
        api_version: if kind.group.is_empty() {
            kind.version.clone()
        } else {
            format!("{}/{}", kind.group, kind.version)
        },
        kind: kind.kind.clone(),
        plural: kind.plural.clone(),
    };
    Ok(match &resource.query.namespace {
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
    scale: Option<i32>,
    delete: bool,
    prepared_at: Instant,
}
impl PreparedMutation {
    pub async fn prepare(client: Client, intent: MutationIntent) -> Result<Self, ApiError> {
        let (resource, version, scale, secret, delete) = match intent {
            MutationIntent::Scale {
                resource,
                resource_version,
                replicas,
            } => {
                if !["Deployment", "StatefulSet"].contains(&resource.query.kind.as_str())
                    || !(0..=100000).contains(&replicas)
                {
                    return Err(error(
                        &resource,
                        400,
                        "Only Deployment/StatefulSet replicas in 0..100000 can be changed",
                    ));
                }
                (resource, resource_version, Some(replicas), None, false)
            }
            MutationIntent::Delete {
                resource,
                resource_version,
            } => (resource, resource_version, None, None, true),
            MutationIntent::Secret(request) => {
                request.validate()?;
                (
                    request.resource.clone(),
                    request.resource_version.clone(),
                    None,
                    Some(request),
                    false,
                )
            }
        };
        validate_identity(&resource, &version)?;
        let api = resource_api(client, &resource)?;
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
            if resource.query.kind == "Namespace" {
                diff.push_str("\n\nDeleting a Namespace removes its namespaced contents.");
            }
        }
        let operation = if delete { "DELETE" } else { "Apply" };
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
            scale,
            delete,
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
        if self.prepared_at.elapsed() > REVIEW_TTL {
            return Err(error(
                &self.resource,
                409,
                "Confirmation expired. Refresh and review again",
            ));
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
            api: resource_api(Client::new(service, "default"), &resource).unwrap(),
            resource,
            version: "10".into(),
            before: before.clone(),
            after: before,
            review: "review".into(),
            scale: Some(0),
            delete: false,
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
}
