//! Secret updates use optimistic concurrency and never include values in errors.
use super::api::{ApiError, ResourceRef, validate_query};
use base64::{Engine, engine::general_purpose::STANDARD};
use k8s_openapi::{ByteString, api::core::v1::Secret};
use kube::Client;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SecretDataRequest {
    pub resource: ResourceRef,
    pub resource_version: String,
    pub data: BTreeMap<String, String>,
}
impl SecretDataRequest {
    fn error(&self, status: u16, message: &str) -> ApiError {
        ApiError::from_status(
            status,
            message,
            "secret_data",
            Some(&self.resource.query.context),
        )
        .with_resource(&self.resource.query)
    }
    pub fn validate(&self) -> Result<BTreeMap<String, ByteString>, ApiError> {
        validate_query(&self.resource.query)?;
        if self.resource.query.kind != "Secret"
            || self
                .resource
                .query
                .namespace
                .as_deref()
                .is_none_or(|s| s.is_empty() || s == "all")
            || (self.resource.name.len() > 253
                || self.resource.name.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                        || !label
                            .bytes()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                }))
            || self.resource.uid.as_deref().is_none_or(str::is_empty)
            || self.resource_version.is_empty()
        {
            return Err(self.error(
                400,
                "An exact Secret identity and resourceVersion are required",
            ));
        }
        let mut size = 0;
        let mut result = BTreeMap::new();
        for (key, value) in &self.data {
            if key.is_empty()
                || key.len() > 253
                || !key
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            {
                return Err(self.error(400, "Invalid Secret data key"));
            }
            let decoded = STANDARD
                .decode(value)
                .map_err(|_| self.error(400, "Invalid base64 Secret data"))?;
            size += decoded.len();
            if size > 1024 * 1024 {
                return Err(self.error(400, "Secret data exceeds 1 MiB"));
            }
            result.insert(key.clone(), ByteString(decoded));
        }
        Ok(result)
    }
}
/// Headless callers must explicitly provide a trusted consent implementation.
pub async fn update_secret_data<F, Fut>(
    client: Client,
    request: SecretDataRequest,
    confirm: F,
) -> Result<Secret, ApiError>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<bool, ApiError>>,
{
    let resource = request.resource.clone();
    let result = super::mutations::PreparedMutation::prepare(
        client,
        super::mutations::MutationIntent::Secret(request),
    )
    .await?
    .confirm_and_commit(confirm)
    .await?;
    serde_json::from_value(result).map_err(|_| {
        super::mutations::error(
            &resource,
            500,
            "Cannot decode Secret response; refresh to verify saved state",
        )
    })
}
