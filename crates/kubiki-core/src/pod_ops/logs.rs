use crate::core::error::KubikiError;
use futures::{AsyncBufReadExt, Stream, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};
use kube::Client;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct PodLogOptions {
    pub container: Option<String>,
    pub follow: bool,
    pub tail_lines: Option<i64>,
    pub timestamps: bool,
    pub previous: bool,
}

impl From<PodLogOptions> for LogParams {
    fn from(opts: PodLogOptions) -> Self {
        LogParams {
            container: opts.container,
            follow: opts.follow,
            tail_lines: opts.tail_lines,
            timestamps: opts.timestamps,
            previous: opts.previous,
            ..Default::default()
        }
    }
}

pub struct PodLogService;

impl PodLogService {
    /// Get a stream of log lines from a specified Pod
    pub async fn get_log_stream(
        client: Client,
        namespace: &str,
        pod_name: &str,
        opts: PodLogOptions,
    ) -> Result<impl Stream<Item = Result<String, KubikiError>>, KubikiError> {
        let pods: Api<Pod> = Api::namespaced(client, namespace);
        let lp: LogParams = opts.into();

        let raw_stream = pods.log_stream(pod_name, &lp).await.map_err(|e| {
            KubikiError::KubeApiError(format!("Failed to open pod log stream: {e}"))
        })?;

        let lines_stream = raw_stream
            .lines()
            .map_err(|e| KubikiError::KubeApiError(format!("Error reading log stream: {e}")));

        Ok(lines_stream)
    }
}
