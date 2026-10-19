use thiserror::Error;

#[derive(Error, Debug, serde::Serialize, serde::Deserialize, Clone)]
pub enum KubikiError {
    #[error("Kubeconfig error: {0}")]
    KubeconfigError(String),

    #[error("Cluster connection failed for context '{context}': {message}")]
    ClusterConnectionFailed {
        context: String,
        message: String,
    },

    #[error("Kubernetes API error: {0}")]
    KubeApiError(String),

    #[error("Resource not found: {kind}/{name} in namespace '{namespace}'")]
    NotFound {
        kind: String,
        namespace: String,
        name: String,
    },

    #[error("PTY session error: {0}")]
    PtyError(String),

    #[error("Port forward error: {0}")]
    PortForwardError(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

impl From<kube::Error> for KubikiError {
    fn from(err: kube::Error) -> Self {
        KubikiError::KubeApiError(err.to_string())
    }
}
