use crate::core::error::KubikiError;
use k8s_openapi::api::core::v1::Pod;
use kube::Client;
use kube::api::{Api, AttachParams};

pub struct PodExecOptions {
    pub container: Option<String>,
    pub command: Vec<String>,
    pub tty: bool,
    pub stdin: bool,
    pub stdout: bool,
    pub stderr: bool,
}

impl Default for PodExecOptions {
    fn default() -> Self {
        Self {
            container: None,
            // Fallback: try bash, if absent fallback to sh
            command: vec![
                "/bin/sh".into(),
                "-c".into(),
                "test -e /bin/bash && exec /bin/bash || exec /bin/sh".into(),
            ],
            tty: true,
            stdin: true,
            stdout: true,
            stderr: false,
        }
    }
}

pub struct PodExecService;

impl PodExecService {
    /// Execute an interactive shell in a pod container and return the attached process
    pub async fn attach(
        client: Client,
        namespace: &str,
        pod_name: &str,
        opts: PodExecOptions,
    ) -> Result<kube::api::AttachedProcess, KubikiError> {
        let pods: Api<Pod> = Api::namespaced(client, namespace);

        let ap = AttachParams {
            container: opts.container,
            stdin: opts.stdin,
            stdout: opts.stdout,
            stderr: opts.stderr && !opts.tty,
            tty: opts.tty,
            max_stdin_buf_size: Some(1024 * 64),
            ..Default::default()
        };

        let attached = pods
            .exec(pod_name, opts.command, &ap)
            .await
            .map_err(|e| KubikiError::KubeApiError(format!("Failed to exec into pod: {e}")))?;

        Ok(attached)
    }
}

#[cfg(test)]
mod tests {
    use super::PodExecOptions;

    #[test]
    fn default_interactive_shell_does_not_request_multiplexed_stderr() {
        let options = PodExecOptions::default();
        assert!(options.tty);
        assert!(!options.stderr);
    }
}
