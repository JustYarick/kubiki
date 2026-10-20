//! Secret updates use optimistic concurrency and never include values in errors.
use super::api::{ApiError, ResourceRef, validate_query};
use base64::{Engine, engine::general_purpose::STANDARD};
use k8s_openapi::{ByteString, api::core::v1::Secret};
use kube::{Api, Client, api::PostParams};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Deserialize, Serialize)]
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
pub async fn update_secret_data(
    client: Client,
    request: SecretDataRequest,
) -> Result<Secret, ApiError> {
    let data = request.validate()?;
    let api: Api<Secret> =
        Api::namespaced(client, request.resource.query.namespace.as_deref().unwrap());
    let sanitize = |error: kube::Error| {
        let status = match error {
            kube::Error::Api(response) => response.code,
            _ => 503,
        };
        request.error(
            status,
            "Secret update failed; check permissions, connectivity and object version",
        )
    };
    let mut current = api.get(&request.resource.name).await.map_err(sanitize)?;
    if current.metadata.uid != request.resource.uid
        || current.metadata.resource_version.as_deref() != Some(&request.resource_version)
    {
        return Err(request.error(
            409,
            "Secret changed or was recreated. Reload before editing again",
        ));
    }
    if current.immutable == Some(true) {
        return Err(request.error(422, "This Secret is immutable"));
    }
    current.data = Some(data);
    current.string_data = None;
    api.replace(&request.resource.name, &PostParams::default(), &current)
        .await
        .map_err(sanitize)
}
