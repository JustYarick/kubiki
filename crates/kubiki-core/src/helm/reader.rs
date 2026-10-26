//! Bounded, context-pinned Helm reads. No command accepts arbitrary CLI arguments.
use super::model::{HelmRelease, HelmReleaseHistory, HelmRepo};
use crate::core::api::{ApiError, ApiErrorCode};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

pub const RELEASE_PAGE_SIZE: usize = 100;
const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
pub struct HelmReleasePage {
    pub context: String,
    pub namespace: Option<String>,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
    pub items: Vec<HelmRelease>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HelmDocument {
    Values,
    Manifest,
    Notes,
    Hooks,
}

impl HelmDocument {
    fn argument(self) -> &'static str {
        match self {
            Self::Values => "values",
            Self::Manifest => "manifest",
            Self::Notes => "notes",
            Self::Hooks => "hooks",
        }
    }
}

pub struct HelmReader {
    program: PathBuf,
    timeout: Duration,
}

impl Default for HelmReader {
    fn default() -> Self {
        Self::new("helm".into())
    }
}

impl HelmReader {
    /// Explicit executable injection for CLI integration tests, never supplied by IPC.
    pub fn new(program: PathBuf) -> Self {
        Self {
            program,
            timeout: Duration::from_secs(15),
        }
    }

    pub(crate) async fn run(
        &self,
        args: &[String],
        context: Option<&str>,
        empty_repositories: bool,
    ) -> Result<String, ApiError> {
        self.execute(args, context, empty_repositories, None, self.timeout)
            .await
    }

    pub(crate) async fn execute(
        &self,
        args: &[String],
        context: Option<&str>,
        empty_repositories: bool,
        input: Option<&str>,
        timeout: Duration,
    ) -> Result<String, ApiError> {
        let operation = "helm";
        let mut command = Command::new(&self.program);
        command
            .args(args)
            .kill_on_drop(true)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        let mut attempts = 0;
        let mut child = loop {
            match command.spawn() {
                Ok(child) => break child,
                #[cfg(unix)]
                Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) && attempts < 10 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                Err(error) => {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        return Err(ApiError::new(
                            ApiErrorCode::BridgeUnavailable,
                            "Helm is not installed or is not available in PATH. Install Helm and restart Kubiki.",
                            operation,
                            context,
                            Some(503),
                        ));
                    }
                    return Err(ApiError::from_status(
                        500,
                        format!("Could not start Helm: {error}"),
                        operation,
                        context,
                    ));
                }
            }
        };
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let stdin = child.stdin.take();
        let read = async |stream: Box<dyn tokio::io::AsyncRead + Unpin + Send>, limit: u64| {
            let mut bytes = Vec::new();
            stream
                .take(limit + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|error| {
                    ApiError::from_status(
                        500,
                        format!("Could not read Helm output: {error}"),
                        operation,
                        context,
                    )
                })?;
            if bytes.len() as u64 > limit {
                return Err(ApiError::from_status(
                    413,
                    "Helm output exceeds the display limit. Use the Helm CLI for this release.",
                    operation,
                    context,
                ));
            }
            Ok(bytes)
        };
        let task = async {
            let (out, err, status, _) = tokio::try_join!(
                read(Box::new(stdout), OUTPUT_LIMIT),
                read(Box::new(stderr), 65536),
                async {
                    child.wait().await.map_err(|error| {
                        ApiError::from_status(
                            500,
                            format!("Could not wait for Helm: {error}"),
                            operation,
                            context,
                        )
                    })
                },
                async {
                    if let (Some(mut stream), Some(input)) = (stdin, input) {
                        // A child rejecting its arguments can close stdin immediately.
                        let _ = stream.write_all(input.as_bytes()).await;
                        let _ = stream.shutdown().await;
                    }
                    Ok::<(), ApiError>(())
                }
            )?;
            Ok::<_, ApiError>((out, err, status))
        };
        let (out, err, status) = tokio::time::timeout(timeout, task).await.map_err(|_| {
            ApiError::from_status(
                504,
                "Helm request timed out. Check cluster connectivity and retry.",
                operation,
                context,
            )
        })??;
        if !status.success() {
            let message = String::from_utf8_lossy(&err).trim().to_owned();
            if empty_repositories
                && message.trim_start_matches("Error: ") == "no repositories to show"
            {
                return Ok("[]".into());
            }
            let message = if message.is_empty() {
                format!("Helm exited with {status}")
            } else {
                message
            };
            let lower = message.to_lowercase();
            let code = if lower.contains("forbidden") {
                Some(403)
            } else if lower.contains("unauthorized") || lower.contains("provide credentials") {
                Some(401)
            } else if lower.contains("release: not found") || lower.contains("release: not loaded")
            {
                Some(404)
            } else {
                None
            };
            return Err(match code {
                Some(code) => ApiError::from_status(code, message, operation, context),
                None => ApiError::from_kubectl(&message, operation, context),
            });
        }
        String::from_utf8(out).map_err(|_| {
            ApiError::from_status(500, "Helm returned invalid UTF-8", operation, context)
        })
    }

    pub(crate) fn context(context: &str) -> Result<String, ApiError> {
        if context.trim().is_empty()
            || context.len() > 4096
            || context.chars().any(char::is_control)
        {
            return Err(ApiError::from_status(
                400,
                "A valid Kubernetes context is required",
                "helm",
                Some(context),
            ));
        }
        Ok(format!("--kube-context={context}"))
    }

    pub(crate) fn namespace(namespace: &str, context: &str) -> Result<(), ApiError> {
        if namespace.is_empty()
            || namespace.len() > 63
            || !namespace
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || namespace.starts_with('-')
            || namespace.ends_with('-')
        {
            return Err(ApiError::from_status(
                400,
                "Invalid Helm namespace",
                "helm",
                Some(context),
            ));
        }
        Ok(())
    }

    pub(crate) fn release(
        context: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Vec<String>, ApiError> {
        let ctx = Self::context(context)?;
        Self::namespace(namespace, context)?;
        if name.is_empty()
            || name.len() > 53
            || !name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.')
            || !name.as_bytes()[0].is_ascii_alphanumeric()
            || !name.as_bytes()[name.len() - 1].is_ascii_alphanumeric()
            || name
                .split('.')
                .any(|part| part.is_empty() || part.starts_with('-') || part.ends_with('-'))
        {
            return Err(ApiError::from_status(
                400,
                "Invalid Helm release name",
                "helm",
                Some(context),
            ));
        }
        Ok(vec![ctx, format!("--namespace={namespace}")])
    }

    pub async fn releases(
        &self,
        context: &str,
        namespace: Option<&str>,
        offset: usize,
    ) -> Result<HelmReleasePage, ApiError> {
        let mut args = vec![
            Self::context(context)?,
            "list".into(),
            "--output=json".into(),
            format!("--max={}", RELEASE_PAGE_SIZE + 1),
            format!("--offset={offset}"),
        ];
        if offset > 1_000_000 {
            return Err(ApiError::from_status(
                400,
                "Invalid release offset",
                "helm",
                Some(context),
            ));
        }
        if let Some(ns) = namespace {
            Self::namespace(ns, context)?;
            args.push(format!("--namespace={ns}"));
        } else {
            args.push("--all-namespaces".into());
        }
        // Explicit status flags work in both Helm 3 and Helm 4 (which removed --all).
        args.extend(
            [
                "--deployed",
                "--failed",
                "--pending",
                "--uninstalled",
                "--superseded",
                "--uninstalling",
            ]
            .map(str::to_owned),
        );
        let text = self.run(&args, Some(context), false).await?;
        let mut items: Vec<HelmRelease> = parse_list(&text, Some(context))?;
        if namespace.is_some_and(|ns| items.iter().any(|item| item.namespace != ns)) {
            return Err(ApiError::from_status(
                500,
                "Helm returned releases outside the requested namespace",
                "helm",
                Some(context),
            ));
        }
        let has_more = items.len() > RELEASE_PAGE_SIZE;
        items.truncate(RELEASE_PAGE_SIZE);
        Ok(HelmReleasePage {
            context: context.into(),
            namespace: namespace.map(str::to_owned),
            offset,
            limit: RELEASE_PAGE_SIZE,
            has_more,
            items,
        })
    }

    pub async fn history(
        &self,
        context: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Vec<HelmReleaseHistory>, ApiError> {
        let mut args = Self::release(context, namespace, name)?;
        args.extend([
            "history".into(),
            name.into(),
            "--output=json".into(),
            "--max=256".into(),
        ]);
        parse_list(&self.run(&args, Some(context), false).await?, Some(context))
    }

    pub async fn content(
        &self,
        context: &str,
        namespace: &str,
        name: &str,
        revision: u32,
        document: HelmDocument,
    ) -> Result<String, ApiError> {
        let mut args = Self::release(context, namespace, name)?;
        if revision == 0 {
            return Err(ApiError::from_status(
                400,
                "A positive release revision is required",
                "helm",
                Some(context),
            ));
        }
        args.extend([
            "get".into(),
            document.argument().into(),
            name.into(),
            format!("--revision={revision}"),
        ]);
        if matches!(document, HelmDocument::Values) {
            args.push("--output=yaml".into());
        }
        self.run(&args, Some(context), false).await
    }

    pub async fn repositories(&self) -> Result<Vec<HelmRepo>, ApiError> {
        parse_list(
            &self
                .run(
                    &["repo".into(), "list".into(), "--output=json".into()],
                    None,
                    true,
                )
                .await?,
            None,
        )
    }

    pub async fn snapshot(
        &self,
        context: &str,
        namespace: &str,
        name: &str,
        revision: Option<u32>,
    ) -> Result<serde_json::Value, ApiError> {
        let mut args = Self::release(context, namespace, name)?;
        args.extend(["status".into(), name.into(), "--output=json".into()]);
        if let Some(revision) = revision {
            if revision == 0 {
                return Err(ApiError::from_status(
                    400,
                    "Invalid revision",
                    "helm",
                    Some(context),
                ));
            }
            args.push(format!("--revision={revision}"));
        }
        let value: serde_json::Value =
            serde_json::from_str(&self.run(&args, Some(context), false).await?).map_err(|_| {
                ApiError::from_status(500, "Invalid Helm release snapshot", "helm", Some(context))
            })?;
        if value["name"] != name
            || value["namespace"] != namespace
            || value["version"].as_u64().is_none()
            || !value["info"].is_object()
        {
            return Err(ApiError::from_status(
                500,
                "Helm snapshot identity mismatch",
                "helm",
                Some(context),
            ));
        }
        Ok(value)
    }

    pub async fn search_charts(&self, query: &str) -> Result<serde_json::Value, ApiError> {
        if query.len() > 200 || query.starts_with('-') || query.chars().any(char::is_control) {
            return Err(ApiError::from_status(
                400,
                "Invalid chart search",
                "helm",
                None,
            ));
        }
        let args = vec![
            "search".into(),
            "repo".into(),
            query.into(),
            "--output=json".into(),
            "--versions".into(),
        ];
        let value: serde_json::Value = serde_json::from_str(&self.run(&args, None, false).await?)
            .map_err(|_| {
            ApiError::from_status(500, "Invalid Helm chart search response", "helm", None)
        })?;
        if !value.is_array() {
            return Err(ApiError::from_status(
                500,
                "Invalid Helm chart search response",
                "helm",
                None,
            ));
        }
        Ok(value)
    }
}

fn parse_list<T: serde::de::DeserializeOwned>(
    text: &str,
    context: Option<&str>,
) -> Result<Vec<T>, ApiError> {
    if text.trim().is_empty() || text.trim() == "null" {
        return Ok(Vec::new());
    }
    serde_json::from_str(text).map_err(|_| {
        ApiError::from_status(500, "Helm returned an invalid JSON list", "helm", context)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_release_targets_and_documents() {
        for name in ["--help", "x/y", "name;rm", "", "a..b", "a.-b"] {
            assert!(HelmReader::release("prod", "default", name).is_err());
        }
        assert!(HelmReader::release("prod", "--all-namespaces", "web").is_err());
        assert!(HelmReader::release("", "default", "web").is_err());
        assert!(HelmReader::release("context with spaces", "default", "web.v2").is_ok());
        assert!(serde_json::from_str::<HelmDocument>("\"uninstall\"").is_err());
    }
}
