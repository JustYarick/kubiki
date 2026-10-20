//! Stable IPC error and resource-query contract shared by desktop commands.
use crate::core::error::KubikiError;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ResourceType {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ResourceQuery {
    pub context: String,
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ResourceRef {
    #[serde(flatten)]
    pub query: ResourceQuery,
    pub name: String,
    pub uid: Option<String>,
}

pub fn resource_types() -> &'static [ResourceType] {
    static TYPES: OnceLock<Vec<ResourceType>> = OnceLock::new();
    TYPES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../shared/resource-types.json"))
            .expect("bundled resource catalog must be valid")
    })
}

pub fn resource_type(kind: &str) -> Option<&'static ResourceType> {
    resource_types()
        .iter()
        .find(|resource| resource.kind == kind)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApiErrorCode {
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Timeout,
    RateLimited,
    Unavailable,
    InvalidRequest,
    Unsupported,
    BridgeUnavailable,
    Internal,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ApiError {
    pub code: ApiErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub retryable: bool,
    pub operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<ResourceQuery>,
}

impl ApiError {
    pub fn new(
        code: ApiErrorCode,
        message: impl Into<String>,
        operation: &str,
        context: Option<&str>,
        status: Option<u16>,
    ) -> Self {
        let retryable = matches!(
            code,
            ApiErrorCode::Timeout
                | ApiErrorCode::RateLimited
                | ApiErrorCode::Unavailable
                | ApiErrorCode::BridgeUnavailable
        );
        Self {
            code,
            message: message.into(),
            status,
            retryable,
            operation: operation.into(),
            context: context.map(str::to_owned),
            resource: None,
        }
    }

    pub fn with_resource(mut self, query: &ResourceQuery) -> Self {
        self.resource = Some(query.clone());
        self
    }

    pub fn from_status(
        status: u16,
        message: impl Into<String>,
        operation: &str,
        context: Option<&str>,
    ) -> Self {
        let code = match status {
            400 | 422 => ApiErrorCode::InvalidRequest,
            401 => ApiErrorCode::Unauthorized,
            403 => ApiErrorCode::Forbidden,
            404 => ApiErrorCode::NotFound,
            409 => ApiErrorCode::Conflict,
            408 | 504 => ApiErrorCode::Timeout,
            429 => ApiErrorCode::RateLimited,
            502 | 503 => ApiErrorCode::Unavailable,
            _ => ApiErrorCode::Internal,
        };
        Self::new(code, message, operation, context, Some(status))
    }

    pub fn from_core(error: KubikiError, operation: &str, context: Option<&str>) -> Self {
        match error {
            KubikiError::KubeApiResponse { code, message, .. } => {
                Self::from_status(code, message, operation, context)
            }
            KubikiError::KubeconfigError(message) => Self::new(
                ApiErrorCode::InvalidRequest,
                message,
                operation,
                context,
                None,
            ),
            error => Self::from_kubectl(&error.to_string(), operation, context),
        }
    }

    pub fn from_kubectl(message: &str, operation: &str, context: Option<&str>) -> Self {
        let lower = message.to_lowercase();
        if [
            "deadline exceeded",
            "i/o timeout",
            "request timed out",
            "timed out waiting",
        ]
        .iter()
        .any(|reason| lower.contains(reason))
        {
            return Self::from_status(504, message, operation, context);
        }
        let reason = lower
            .split("error from server (")
            .nth(1)
            .and_then(|part| part.split(')').next());
        let status = match reason {
            Some("unauthorized") => Some(401),
            Some("forbidden") => Some(403),
            Some("notfound") => Some(404),
            Some("conflict" | "alreadyexists") => Some(409),
            Some("badrequest") => Some(400),
            Some("invalid") => Some(422),
            Some("timeout" | "servertimeout") => Some(504),
            Some("toomanyrequests") => Some(429),
            Some("serviceunavailable") => Some(503),
            _ => None,
        };
        if let Some(status) = status {
            return Self::from_status(status, message, operation, context);
        }
        if [
            "connection refused",
            "unable to connect to the server",
            "no such host",
            "network is unreachable",
        ]
        .iter()
        .any(|reason| lower.contains(reason))
        {
            return Self::from_status(503, message, operation, context);
        }
        Self::from_status(500, message, operation, context)
    }
}

pub fn validate_query(query: &ResourceQuery) -> Result<&'static ResourceType, ApiError> {
    let fail = |code, message| {
        ApiError::new(code, message, "resources", Some(&query.context), Some(400))
            .with_resource(query)
    };
    if query.context.trim().is_empty() {
        return Err(fail(
            ApiErrorCode::InvalidRequest,
            "A Kubernetes context is required".to_owned(),
        ));
    }
    let resource = resource_type(&query.kind).ok_or_else(|| {
        fail(
            ApiErrorCode::Unsupported,
            format!("Unsupported resource kind: {}", query.kind),
        )
    })?;
    if query.group != resource.group || query.version != resource.version {
        return Err(fail(
            ApiErrorCode::Unsupported,
            format!("Unsupported API group/version for {}", query.kind),
        ));
    }
    if !resource.namespaced && query.namespace.is_some() {
        return Err(fail(
            ApiErrorCode::InvalidRequest,
            "Cluster-scoped resources cannot have a namespace".to_owned(),
        ));
    }
    Ok(resource)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn kubectl_errors_match_the_http_contract_fixtures() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/kubectl-errors.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let error = ApiError::from_kubectl(
                fixture["message"].as_str().unwrap(),
                "resources",
                Some("production"),
            );
            let payload = serde_json::to_value(error).unwrap();
            for key in ["code", "message", "status", "retryable"] {
                assert_eq!(payload[key], fixture[key], "{fixture}");
            }
            assert_eq!(payload["context"], "production");
            assert_eq!(payload["operation"], "resources");
        }
    }

    #[test]
    fn preserves_kube_api_status_instead_of_flattening_it_to_a_string() {
        let source = kube::Error::Api(kube::error::ErrorResponse {
            status: "Failure".into(),
            code: 403,
            reason: "Forbidden".into(),
            message: "Access denied".into(),
        });
        let error =
            ApiError::from_core(KubikiError::from(source), "namespaces", Some("production"));
        assert_eq!(error.code, ApiErrorCode::Forbidden);
        assert_eq!(error.status, Some(403));
        assert!(!error.retryable);
    }

    #[test]
    fn validates_group_version_scope_and_context_and_serializes_refs() {
        assert_eq!(resource_types().len(), 18);
        let mut query = ResourceQuery {
            context: "production".into(),
            group: "apps".into(),
            version: "v1".into(),
            kind: "Deployment".into(),
            namespace: Some("backend".into()),
        };
        assert_eq!(validate_query(&query).unwrap().plural, "deployments");
        let reference = ResourceRef {
            query: query.clone(),
            name: "web".into(),
            uid: Some("original".into()),
        };
        assert_eq!(
            serde_json::to_value(reference).unwrap(),
            json!({ "context": "production", "group": "apps", "version": "v1", "kind": "Deployment", "namespace": "backend", "name": "web", "uid": "original" })
        );
        query.group = "wrong.example".into();
        assert_eq!(
            validate_query(&query).unwrap_err().code,
            ApiErrorCode::Unsupported
        );
        query = ResourceQuery {
            context: "production".into(),
            group: "".into(),
            version: "v1".into(),
            kind: "Node".into(),
            namespace: Some("backend".into()),
        };
        assert_eq!(
            validate_query(&query).unwrap_err().code,
            ApiErrorCode::InvalidRequest
        );
        query.namespace = None;
        assert!(validate_query(&query).is_ok());
        query.context.clear();
        assert_eq!(
            validate_query(&query).unwrap_err().code,
            ApiErrorCode::InvalidRequest
        );
    }
}
