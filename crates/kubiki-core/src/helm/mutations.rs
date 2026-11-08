//! Helm operations with frozen inputs and a concise backend confirmation.
//! Helm CLI has no atomic compare-and-swap against external Helm clients. Never retry writes.
use super::reader::HelmReader;
use crate::core::api::{ApiError, ApiErrorCode, ResourceQuery, ResourceRef};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    future::Future,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum HelmMutation {
    Install {
        context: String,
        namespace: String,
        name: String,
        chart: String,
        chart_version: Option<String>,
        values: String,
        create_namespace: bool,
        run_hooks: bool,
        wait: bool,
    },
    Upgrade {
        context: String,
        namespace: String,
        name: String,
        expected_revision: u32,
        chart: String,
        chart_version: Option<String>,
        values: String,
        run_hooks: bool,
        wait: bool,
    },
    Rollback {
        context: String,
        namespace: String,
        name: String,
        expected_revision: u32,
        revision: u32,
        run_hooks: bool,
        wait: bool,
    },
    Uninstall {
        context: String,
        namespace: String,
        name: String,
        keep_history: bool,
        run_hooks: bool,
    },
    RepositorySet {
        name: String,
        url: String,
        previous_url: Option<String>,
    },
    RepositoryRemove {
        name: String,
        expected_url: String,
    },
    RepositoryUpdate {
        name: Option<String>,
    },
}

impl HelmMutation {
    pub fn operation(&self) -> &'static str {
        match self {
            Self::Install { .. } => "install",
            Self::Upgrade { .. } => "upgrade",
            Self::Rollback { .. } => "rollback",
            Self::Uninstall { .. } => "uninstall",
            Self::RepositorySet { .. } => "repository_set",
            Self::RepositoryRemove { .. } => "repository_remove",
            Self::RepositoryUpdate { .. } => "repository_update",
        }
    }

    pub fn resource(&self) -> ResourceRef {
        let (context, namespace, name, kind) = match self {
            Self::Install {
                context,
                namespace,
                name,
                ..
            }
            | Self::Upgrade {
                context,
                namespace,
                name,
                ..
            }
            | Self::Rollback {
                context,
                namespace,
                name,
                ..
            }
            | Self::Uninstall {
                context,
                namespace,
                name,
                ..
            } => (
                context.clone(),
                Some(namespace.clone()),
                name.clone(),
                "HelmRelease",
            ),
            Self::RepositorySet { name, .. } | Self::RepositoryRemove { name, .. } => (
                "Local Helm configuration".into(),
                None,
                name.clone(),
                "HelmRepository",
            ),
            Self::RepositoryUpdate { name } => (
                "Local Helm configuration".into(),
                None,
                name.clone().unwrap_or("all repositories".into()),
                "HelmRepository",
            ),
        };
        ResourceRef {
            query: ResourceQuery {
                context,
                group: "helm.sh".into(),
                version: "v1".into(),
                kind: kind.into(),
                namespace,
            },
            name,
            uid: None,
        }
    }
}

fn error(status: u16, message: impl Into<String>, context: Option<&str>) -> ApiError {
    let mut error = ApiError::from_status(status, message, "helm_mutation", context);
    error.retryable = false;
    error
}
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Result<Self, ApiError> {
        let path = std::env::temp_dir().join(format!(
            "kubiki-helm-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        #[allow(unused_mut)]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .map_err(|_| error(500, "Cannot create private Helm workspace", None))?;
        Ok(Self(path))
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct PreparedHelmMutation {
    reader: HelmReader,
    request: HelmMutation,
    before: Option<Value>,
    target: Option<Value>,
    command: Vec<String>,
    summary: String,
    files: Vec<(PathBuf, Vec<u8>)>,
    repo_config: Option<(PathBuf, Option<Vec<u8>>)>,
    _workspace: Workspace,
}

impl PreparedHelmMutation {
    pub async fn prepare(reader: HelmReader, request: HelmMutation) -> Result<Self, ApiError> {
        let workspace = Workspace::new()?;
        let mut files = Vec::new();
        let mut before = None;
        let mut target = None;
        let mut repo_config = None;
        let mut command: Vec<String>;
        let mut summary = String::new();
        match &request {
            HelmMutation::Install {
                context,
                namespace,
                name,
                chart,
                chart_version,
                values,
                create_namespace: _,
                run_hooks,
                wait,
            }
            | HelmMutation::Upgrade {
                context,
                namespace,
                name,
                chart,
                chart_version,
                values,
                run_hooks,
                wait,
                ..
            } => {
                let base = HelmReader::release(context, namespace, name)?;
                before = optional_snapshot(&reader, context, namespace, name).await?;
                let install = matches!(request, HelmMutation::Install { .. });
                if install && before.is_some() {
                    return Err(error(
                        409,
                        "Release already exists; refresh and use Upgrade",
                        Some(context),
                    ));
                }
                if let HelmMutation::Upgrade {
                    expected_revision, ..
                } = &request
                {
                    check_revision(before.as_ref(), *expected_revision, context)?;
                }
                if chart.is_empty()
                    || chart.len() > 2048
                    || chart.starts_with('-')
                    || chart.chars().any(char::is_control)
                    || chart_version
                        .as_ref()
                        .is_some_and(|v| v.len() > 200 || v.chars().any(char::is_control))
                {
                    return Err(error(400, "Invalid chart reference/version", Some(context)));
                }
                if values.len() > 1024 * 1024 {
                    return Err(error(422, "Values exceed 1 MiB", Some(context)));
                }
                let parsed: serde_yaml::Value = serde_yaml::from_str(values)
                    .map_err(|_| error(400, "Values must be valid YAML", Some(context)))?;
                if !parsed.is_null() && !parsed.is_mapping() {
                    return Err(error(400, "Values must be a YAML mapping", Some(context)));
                }
                let artifact = workspace.0.join("chart.tgz");
                if chart.ends_with(".tgz") && std::path::Path::new(chart).is_file() {
                    let bytes = read_bounded(&PathBuf::from(chart), 64 * 1024 * 1024)?;
                    std::fs::write(&artifact, bytes)
                        .map_err(|_| error(500, "Cannot freeze chart archive", Some(context)))?;
                } else {
                    let download = workspace.0.join("download");
                    std::fs::create_dir(&download).map_err(|_| {
                        error(500, "Cannot create chart download workspace", Some(context))
                    })?;
                    let mut args = vec![
                        "pull".into(),
                        chart.clone(),
                        format!("--destination={}", download.display()),
                    ];
                    if let Some(version) = chart_version {
                        if !version.is_empty() {
                            args.push(format!("--version={version}"));
                        }
                    }
                    reader
                        .execute(&args, Some(context), false, None, Duration::from_secs(60))
                        .await?;
                    let entries: Vec<_> = std::fs::read_dir(&download)
                        .map_err(|_| error(500, "Cannot read downloaded chart", Some(context)))?
                        .filter_map(Result::ok)
                        .collect();
                    if entries.len() != 1
                        || !entries[0].file_type().map(|t| t.is_file()).unwrap_or(false)
                    {
                        return Err(error(
                            422,
                            "Helm did not download one packaged chart",
                            Some(context),
                        ));
                    }
                    let bytes = read_bounded(&entries[0].path(), 64 * 1024 * 1024)?;
                    std::fs::write(&artifact, bytes)
                        .map_err(|_| error(500, "Cannot freeze chart archive", Some(context)))?;
                }
                files.push((artifact.clone(), read_bounded(&artifact, 64 * 1024 * 1024)?));
                let value_file = workspace.0.join("values.yaml");
                std::fs::write(&value_file, values)
                    .map_err(|_| error(500, "Cannot freeze values", Some(context)))?;
                files.push((value_file.clone(), values.as_bytes().to_vec()));
                // Validate the frozen archive once; rendering happens only in the approved operation.
                reader
                    .run(
                        &[
                            "show".into(),
                            "chart".into(),
                            artifact.to_string_lossy().into(),
                        ],
                        Some(context),
                        false,
                    )
                    .await?;
                summary.push_str(&format!(
                    "{} release {name} using chart {chart}{}.",
                    if install { "Install" } else { "Upgrade" },
                    chart_version
                        .as_ref()
                        .filter(|version| !version.is_empty())
                        .map(|version| format!(" version {version}"))
                        .unwrap_or_default()
                ));
                command = base;
                command.extend([
                    if install {
                        "install".into()
                    } else {
                        "upgrade".into()
                    },
                    name.clone(),
                    artifact.to_string_lossy().into(),
                    format!("--values={}", value_file.display()),
                    "--output=json".into(),
                    "--timeout=300s".into(),
                ]);
                if !install {
                    command.push("--reset-values".into());
                }
                if !run_hooks {
                    command.push("--no-hooks".into());
                }
                if *wait {
                    command.push("--wait".into());
                }
                if let HelmMutation::Install {
                    create_namespace: true,
                    ..
                } = &request
                {
                    command.push("--create-namespace".into());
                    summary.push_str(" Create the namespace if it does not exist.");
                }
            }
            HelmMutation::Rollback {
                context,
                namespace,
                name,
                expected_revision,
                revision,
                run_hooks,
                wait,
            } => {
                let base = HelmReader::release(context, namespace, name)?;
                before = optional_snapshot(&reader, context, namespace, name).await?;
                check_revision(before.as_ref(), *expected_revision, context)?;
                if *revision == 0 || revision == expected_revision {
                    return Err(error(
                        400,
                        "Choose a different positive rollback revision",
                        Some(context),
                    ));
                }
                let previous = reader
                    .snapshot(context, namespace, name, Some(*revision))
                    .await?;
                summary.push_str(&format!("Roll back release {name} to revision {revision}."));
                target = Some(previous);
                command = base;
                command.extend([
                    "rollback".into(),
                    name.clone(),
                    revision.to_string(),
                    "--timeout=300s".into(),
                ]);
                if !run_hooks {
                    command.push("--no-hooks".into());
                }
                if *wait {
                    command.push("--wait".into());
                }
            }
            HelmMutation::Uninstall {
                context,
                namespace,
                name,
                keep_history,
                run_hooks,
            } => {
                command = HelmReader::release(context, namespace, name)?;
                summary.push_str(&format!(
                    "Uninstall release {name} and remove its managed Kubernetes resources."
                ));
                if *keep_history {
                    summary.push_str(" Keep the release history.");
                }
                if *run_hooks {
                    summary.push_str(" Run chart hooks.");
                }
                command.extend(["uninstall".into(), name.clone(), "--timeout=300s".into()]);
                if *keep_history {
                    command.push("--keep-history".into());
                }
                if !run_hooks {
                    command.push("--no-hooks".into());
                }
            }
            HelmMutation::RepositorySet {
                name,
                url,
                previous_url,
            } => {
                validate_repo_name(name)?;
                if url.len() > 2048
                    || !(url.starts_with("https://") || url.starts_with("http://"))
                    || url.chars().any(char::is_control)
                {
                    return Err(error(400, "Repository URL must use http or https", None));
                }
                repo_config = Some(repository_config(&reader).await?);
                let repos = reader.repositories().await?;
                let old = repos
                    .iter()
                    .find(|r| r.name == *name)
                    .map(|r| r.url.as_str());
                if old != previous_url.as_deref() {
                    return Err(error(
                        409,
                        "Repository changed or already exists; refresh",
                        None,
                    ));
                }
                summary.push_str(&format!("Configure repository {name} at {url}."));
                command = vec!["repo".into(), "add".into(), name.clone(), url.clone()];
                if old.is_some() {
                    command.push("--force-update".into());
                }
            }
            HelmMutation::RepositoryRemove { name, expected_url } => {
                validate_repo_name(name)?;
                repo_config = Some(repository_config(&reader).await?);
                let repos = reader.repositories().await?;
                if !repos
                    .iter()
                    .any(|r| r.name == *name && r.url == *expected_url)
                {
                    return Err(error(
                        409,
                        "Repository changed or disappeared; refresh",
                        None,
                    ));
                }
                summary.push_str(&format!("Remove local repository {name} ({expected_url})."));
                command = vec!["repo".into(), "remove".into(), name.clone()];
            }
            HelmMutation::RepositoryUpdate { name } => {
                if let Some(name) = name {
                    validate_repo_name(name)?;
                }
                repo_config = Some(repository_config(&reader).await?);
                let repos = reader.repositories().await?;
                let selected: Vec<_> = repos
                    .iter()
                    .filter(|r| name.as_ref().is_none_or(|name| *name == r.name))
                    .collect();
                if selected.is_empty() {
                    return Err(error(404, "No matching repositories configured", None));
                }
                summary.push_str("Refresh the chart index for repositories: ");
                for repo in selected {
                    summary.push_str(&format!("{} ", repo.name));
                }
                command = vec!["repo".into(), "update".into()];
                if let Some(name) = name {
                    command.push(name.clone());
                }
            }
        }
        Ok(Self {
            reader,
            request,
            before,
            target,
            command,
            summary,
            files,
            repo_config,
            _workspace: workspace,
        })
    }
    pub fn summary(&self) -> &str {
        &self.summary
    }
    pub async fn confirm_and_commit<F, Fut>(self, confirm: F) -> Result<Value, ApiError>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<bool, ApiError>>,
    {
        let resource = self.request.resource();
        let context = resource
            .query
            .namespace
            .as_ref()
            .map(|_| resource.query.context.as_str());
        if !confirm(self.summary.clone()).await? {
            let mut e = ApiError::new(
                ApiErrorCode::Cancelled,
                "Helm operation cancelled; nothing changed",
                "helm_mutation",
                context,
                None,
            );
            e.retryable = false;
            return Err(e);
        }
        // Uninstall follows Helm CLI semantics: remove the confirmed named release,
        // even if its cached table revision or live resource statuses have changed.
        if !matches!(self.request, HelmMutation::Uninstall { .. })
            && let Some(namespace) = resource.query.namespace.as_deref()
        {
            let current = optional_snapshot(
                &self.reader,
                &resource.query.context,
                namespace,
                &resource.name,
            )
            .await?;
            if release_identity(current.as_ref()) != release_identity(self.before.as_ref()) {
                return Err(error(
                    409,
                    "Release revision or state changed. Refresh the release before trying again.",
                    context,
                ));
            }
            if let HelmMutation::Rollback { revision, .. } = self.request {
                if release_identity(Some(
                    &self
                        .reader
                        .snapshot(
                            &resource.query.context,
                            namespace,
                            &resource.name,
                            Some(revision),
                        )
                        .await?,
                )) != release_identity(self.target.as_ref())
                {
                    return Err(error(409, "Rollback target changed; refresh", context));
                }
            }
        }
        if let Some((path, bytes)) = &self.repo_config {
            if read_optional(path)? != *bytes {
                return Err(error(
                    409,
                    "Local repository configuration changed. Open the operation again.",
                    context,
                ));
            }
        }
        for (path, bytes) in &self.files {
            if read_bounded(path, 64 * 1024 * 1024)? != *bytes {
                return Err(error(
                    409,
                    "Prepared chart or values changed. Open the operation again.",
                    context,
                ));
            }
        }
        let result = self
            .reader
            .execute(
                &self.command,
                context,
                false,
                None,
                Duration::from_secs(330),
            )
            .await;
        if let Err(mut failure) = result {
            failure.operation = "helm_mutation".into();
            failure.retryable = false;
            failure.message="Helm operation failed or timed out. Refresh the release/repository and inspect its state before retrying; part of the operation may have completed.".into();
            return Err(failure);
        }
        Ok(json!({"message":"Helm operation completed. Refresh to inspect the current state."}))
    }
}

async fn optional_snapshot(
    reader: &HelmReader,
    context: &str,
    namespace: &str,
    name: &str,
) -> Result<Option<Value>, ApiError> {
    match reader.snapshot(context, namespace, name, None).await {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.status == Some(404) => Ok(None),
        Err(e) => Err(e),
    }
}
fn check_revision(before: Option<&Value>, revision: u32, context: &str) -> Result<(), ApiError> {
    if revision == 0 || before.and_then(|v| v["version"].as_u64()) != Some(u64::from(revision)) {
        return Err(error(
            409,
            "Release revision changed or release is absent; refresh",
            Some(context),
        ));
    }
    if before
        .and_then(|v| v["info"]["status"].as_str())
        .is_none_or(|s| s.starts_with("pending-") || s == "uninstalling" || s == "uninstalled")
    {
        return Err(error(
            409,
            "Release is busy or uninstalled; inspect its state first",
            Some(context),
        ));
    }
    Ok(())
}
fn validate_repo_name(name: &str) -> Result<(), ApiError> {
    if name.is_empty()
        || name.len() > 100
        || name.starts_with('-')
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    {
        return Err(error(400, "Invalid repository name", None));
    }
    Ok(())
}
fn read_bounded(path: &PathBuf, limit: u64) -> Result<Vec<u8>, ApiError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| error(500, "Cannot read Helm input file", None))?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(error(422, "Invalid or oversized Helm input file", None));
    }
    std::fs::read(path).map_err(|_| error(500, "Cannot read Helm input file", None))
}
fn read_optional(path: &PathBuf) -> Result<Option<Vec<u8>>, ApiError> {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error(500, "Cannot read repository configuration", None)),
        Ok(_) => read_bounded(path, 1024 * 1024).map(Some),
    }
}
async fn repository_config(reader: &HelmReader) -> Result<(PathBuf, Option<Vec<u8>>), ApiError> {
    let env = reader.run(&["env".into()], None, false).await?;
    let encoded = env
        .lines()
        .find_map(|line| line.strip_prefix("HELM_REPOSITORY_CONFIG="))
        .ok_or_else(|| {
            error(
                500,
                "Helm did not report repository configuration path",
                None,
            )
        })?;
    let path: String = serde_json::from_str(encoded)
        .map_err(|_| error(500, "Invalid repository configuration path", None))?;
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(error(
            500,
            "Helm repository configuration path is not absolute",
            None,
        ));
    }
    let bytes = read_optional(&path)?;
    Ok((path, bytes))
}
/// Ignore volatile status output; only a real release revision/state transition invalidates an upgrade.
fn release_identity(value: Option<&Value>) -> Value {
    value.map(|value| json!({
        "name": value["name"], "namespace": value["namespace"], "version": value["version"],
        "first_deployed": value["info"]["first_deployed"], "status": value["info"]["status"],
    })).unwrap_or(Value::Null)
}
