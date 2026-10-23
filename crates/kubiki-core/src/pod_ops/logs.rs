//! One-shot Pod log reads that back the polling log viewer. No follow streams:
//! each call returns a bounded slice of text for an exact request.
use crate::core::api::{ApiError, ApiErrorCode, ResourceRef, validate_query};
use k8s_openapi::api::core::v1::Pod;
use kube::{Api, Client, api::LogParams};
use serde::{Deserialize, Serialize};

/// Hard ceiling for one slice; the API server stops writing at this size.
pub const MAX_SLICE_BYTES: i64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LogSliceRequest {
    pub resource: ResourceRef,
    pub container: String,
    /// Snapshot of a terminated container instance; not a pollable stream.
    pub previous: bool,
    /// Initial load: keep the last N lines (0..=10000). Omit for an unbounded read.
    pub tail_lines: Option<i64>,
    /// Poll resume: return lines written after this RFC3339 timestamp.
    pub since_time: Option<String>,
    /// Relative window for an initial load, mutually exclusive with since_time.
    pub since_seconds: Option<i64>,
}

fn error(request: &LogSliceRequest, status: u16, message: impl Into<String>) -> ApiError {
    ApiError::from_status(
        status,
        message,
        "logs",
        Some(&request.resource.query.context),
    )
    .with_resource(&request.resource.query)
}

fn api_error(request: &LogSliceRequest, err: kube::Error) -> ApiError {
    match err {
        kube::Error::Api(response) => error(request, response.code, response.message),
        err => ApiError::new(
            ApiErrorCode::Unavailable,
            err.to_string(),
            "logs",
            Some(&request.resource.query.context),
            None,
        )
        .with_resource(&request.resource.query),
    }
}

fn valid_name(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.')
}

impl LogSliceRequest {
    pub fn validate(&self) -> Result<(), ApiError> {
        validate_query(&self.resource.query)?;
        let (tail_lines, since_seconds, since_time) = (
            self.tail_lines,
            self.since_seconds,
            self.since_time.as_deref(),
        );
        if self.resource.query.kind != "Pod"
            || self.resource.query.namespace.is_none()
            || self
                .resource
                .uid
                .as_ref()
                .is_none_or(|uid| uid.is_empty())
            || !valid_name(&self.resource.name, 253)
            || !valid_name(&self.container, 63)
            || tail_lines.is_some_and(|t| !(0..=10000).contains(&t))
            || since_seconds.is_some_and(|s| !(1..=604800).contains(&s))
            || since_seconds.is_some() && since_time.is_some()
            || since_time.is_some_and(|t| Self::parse_since_time(t).is_err())
        {
            return Err(error(
                self,
                400,
                "Logs require a Pod UID/container, tail 0–10000, and one of since 1–604800 seconds or an RFC3339 sinceTime; previous logs apply to one snapshot",
            ));
        }
        Ok(())
    }

    fn parse_since_time(value: &str) -> Result<chrono::DateTime<chrono::Utc>, ()> {
        if value.len() > 64 {
            return Err(());
        }
        chrono::DateTime::parse_from_rfc3339(value)
            .map(|t| t.with_timezone(&chrono::Utc))
            .map_err(|_| ())
    }

    /// Read one slice: GET the Pod for the UID/container preconditions, then the log body.
    pub async fn read(self, client: Client) -> Result<String, ApiError> {
        self.validate()?;
        let pods: Api<Pod> = Api::namespaced(
            client,
            self.resource.query.namespace.as_deref().unwrap(),
        );
        let pod = pods
            .get(&self.resource.name)
            .await
            .map_err(|e| api_error(&self, e))?;
        if pod.metadata.uid != self.resource.uid {
            return Err(error(
                &self,
                409,
                "Pod was recreated; open the current Pod to read its logs",
            ));
        }
        let spec = pod
            .spec
            .ok_or_else(|| error(&self, 400, "Pod has no container spec"))?;
        if !spec
            .containers
            .iter()
            .map(|c| &c.name)
            .chain(spec.init_containers.iter().flatten().map(|c| &c.name))
            .chain(spec.ephemeral_containers.iter().flatten().map(|c| &c.name))
            .any(|name| name == &self.container)
        {
            return Err(error(
                &self,
                400,
                "Container does not belong to the selected Pod",
            ));
        }
        let since_time = match &self.since_time {
            Some(value) => Some(Self::parse_since_time(value).map_err(|_| error(
                &self,
                400,
                "sinceTime must be an RFC3339 timestamp",
            ))?),
            None => None,
        };
        // Kubernetes logs has no UID precondition: the GET detects known recreations first.
        pods.logs(
            &self.resource.name,
            &LogParams {
                container: Some(self.container.clone()),
                previous: self.previous,
                tail_lines: self.tail_lines,
                since_seconds: self.since_seconds,
                since_time,
                timestamps: true,
                limit_bytes: Some(MAX_SLICE_BYTES),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| api_error(&self, e))
    }
}
