//! Prepared Helm operations: immutable inputs, backend review and post-consent checks.
//! Helm CLI has no atomic compare-and-swap against external Helm clients. Never retry writes.
use super::reader::HelmReader;
use crate::core::{
    api::{ApiError, ApiErrorCode, ResourceQuery, ResourceRef},
    mutations::{MAX_REVIEW_CHARS, REVIEW_TTL},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
        expected_revision: u32,
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
    preview: Option<Value>,
    command: Vec<String>,
    preview_command: Option<Vec<String>>,
    review: String,
    prepared_at: Instant,
    files: Vec<(PathBuf, Vec<u8>)>,
    repo_config: Option<(PathBuf, Option<Vec<u8>>)>,
    _workspace: Workspace,
}

impl PreparedHelmMutation {
    pub async fn prepare(reader: HelmReader, request: HelmMutation) -> Result<Self, ApiError> {
        let resource = request.resource();
        let context = resource
            .query
            .namespace
            .as_ref()
            .map(|_| resource.query.context.as_str());
        let workspace = Workspace::new()?;
        let mut files = Vec::new();
        let mut before = None;
        let mut target = None;
        let mut preview = None;
        let mut preview_command = None;
        let mut repo_config = None;
        let mut command: Vec<String>;
        let mut review = format!(
            "Context: {:?}\nNamespace: {:?}\nTarget: {:?}\n",
            resource.query.context, resource.query.namespace, resource.name
        );
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
                    review.push_str(&format!("Current revision: {expected_revision}\n"));
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
                let chart_meta = reader
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
                review.push_str(&format!("Operation: {}\nChart source: {:?}\nFrozen chart metadata:\n{}\nHooks enabled: {run_hooks}\nWait for readiness: {wait}\n",if install{"INSTALL"}else{"UPGRADE"},chart,chart_meta));
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
                    review.push_str("Create namespace if absent: true\n");
                }
                let mut args = command.clone();
                args.push("--dry-run=server".into());
                let result = parse_preview(
                    &reader
                        .execute(&args, Some(context), false, None, Duration::from_secs(60))
                        .await?,
                    context,
                )?;
                let old = before.as_ref().unwrap_or(&Value::Null).clone();
                review.push_str(&release_diff(&old, &result, namespace)?);
                if install {
                    let crds = reader
                        .run(
                            &[
                                "show".into(),
                                "crds".into(),
                                artifact.to_string_lossy().into(),
                            ],
                            Some(context),
                            false,
                        )
                        .await?;
                    if !crds.trim().is_empty() {
                        review.push_str("\nChart CRDs (created only if absent; Helm does not delete them on uninstall):\n");
                        review.push_str(&manifest_diff("", &crds, namespace)?);
                    }
                }
                preview = Some(result);
                preview_command = Some(args);
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
                review.push_str(&format!("Operation: ROLLBACK\nCurrent revision: {expected_revision}\nTarget revision: {revision}\nHooks enabled: {run_hooks}\nWait: {wait}\n"));
                review.push_str(&release_diff(
                    before.as_ref().unwrap(),
                    &previous,
                    namespace,
                )?);
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
                expected_revision,
                keep_history,
                run_hooks,
            } => {
                command = HelmReader::release(context, namespace, name)?;
                before = optional_snapshot(&reader, context, namespace, name).await?;
                check_revision(before.as_ref(), *expected_revision, context)?;
                review.push_str(&format!("Operation: UNINSTALL\nCurrent revision: {expected_revision}\nKeep release history: {keep_history}\nHooks enabled: {run_hooks}\nControllers/garbage collection may remove dependent objects. Objects with resource-policy=keep and chart CRDs are retained by Helm.\n"));
                review.push_str(&release_diff(
                    before.as_ref().unwrap(),
                    &Value::Null,
                    namespace,
                )?);
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
                review.push_str(&format!("Operation: SET LOCAL REPOSITORY\nURL before: {:?}\nURL after: {:?}\nDownloads the chart index into the local Helm cache.\n",old,url));
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
                review.push_str(&format!("Operation: REMOVE LOCAL REPOSITORY\nURL: {:?}\nRemoves repository configuration and cached index. Installed releases are unaffected.\n",expected_url));
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
                review.push_str("Operation: UPDATE LOCAL REPOSITORY CACHE\nFetches and replaces cached chart indexes for:\n");
                for repo in selected {
                    review.push_str(&format!("  {:?}: {:?}\n", repo.name, repo.url));
                }
                command = vec!["repo".into(), "update".into()];
                if let Some(name) = name {
                    command.push(name.clone());
                }
            }
        }
        review.push_str("\nHelm templates, hooks and Kubernetes controllers can have effects beyond this preview. Helm CLI cannot atomically lock out other Helm clients. This backend checks the release and frozen inputs again after consent; concurrent external operations remain possible.\n\nApprove this operation? Cancel performs no release/repository change.");
        if review.chars().count() > MAX_REVIEW_CHARS {
            return Err(error(
                422,
                "Complete Helm review exceeds 24000 characters; reduce the change or use Helm CLI",
                context,
            ));
        }
        Ok(Self {
            reader,
            request,
            before,
            target,
            preview,
            command,
            preview_command,
            review,
            prepared_at: Instant::now(),
            files,
            repo_config,
            _workspace: workspace,
        })
    }
    pub fn review(&self) -> &str {
        &self.review
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
        if !confirm(self.review.clone()).await? {
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
        if self.prepared_at.elapsed() > REVIEW_TTL {
            return Err(error(
                409,
                "Helm confirmation expired; review again",
                context,
            ));
        }
        if let Some(namespace) = resource.query.namespace.as_deref() {
            let current = optional_snapshot(
                &self.reader,
                &resource.query.context,
                namespace,
                &resource.name,
            )
            .await?;
            if current != self.before {
                return Err(error(
                    409,
                    "Release changed while confirmation was open; refresh and review again",
                    context,
                ));
            }
            if let HelmMutation::Rollback { revision, .. } = self.request {
                if Some(
                    self.reader
                        .snapshot(
                            &resource.query.context,
                            namespace,
                            &resource.name,
                            Some(revision),
                        )
                        .await?,
                ) != self.target
                {
                    return Err(error(409, "Rollback target changed; refresh", context));
                }
            }
        }
        if let Some((path, bytes)) = &self.repo_config {
            if read_optional(path)? != *bytes {
                return Err(error(
                    409,
                    "Local repository configuration changed; refresh and review again",
                    context,
                ));
            }
        }
        for (path, bytes) in &self.files {
            if read_bounded(path, 64 * 1024 * 1024)? != *bytes {
                return Err(error(
                    409,
                    "Prepared chart or values changed; review again",
                    context,
                ));
            }
        }
        if let Some(args) = &self.preview_command {
            let rendered = parse_preview(
                &self
                    .reader
                    .execute(args, context, false, None, Duration::from_secs(60))
                    .await?,
                context.unwrap(),
            )?;
            if render_identity(&rendered) != render_identity(self.preview.as_ref().unwrap()) {
                return Err(error(
                    409,
                    "Chart rendering changed since preview (lookup/random/time-dependent templates); review again",
                    context,
                ));
            }
        }
        // The server dry-run can take time; narrow the external-client race again.
        if let Some(namespace) = resource.query.namespace.as_deref() {
            if optional_snapshot(
                &self.reader,
                &resource.query.context,
                namespace,
                &resource.name,
            )
            .await?
                != self.before
            {
                return Err(error(
                    409,
                    "Release changed during the final preview; review again",
                    context,
                ));
            }
        }
        if self.prepared_at.elapsed() > REVIEW_TTL {
            return Err(error(
                409,
                "Helm confirmation expired before execution; review again",
                context,
            ));
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
fn parse_preview(text: &str, context: &str) -> Result<Value, ApiError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| error(500, "Helm dry-run returned invalid JSON", Some(context)))?;
    if !value["manifest"].is_string() {
        return Err(error(
            500,
            "Helm dry-run returned no manifest",
            Some(context),
        ));
    }
    Ok(value)
}
fn render_identity(value: &Value) -> Value {
    json!({"manifest":value["manifest"],"config":value["config"],"hooks":value["hooks"].as_array().map(|hooks|hooks.iter().map(|hook|json!({"manifest":hook["manifest"],"events":hook["events"],"delete_policies":hook["delete_policies"]})).collect::<Vec<_>>())})
}
fn release_diff(before: &Value, after: &Value, namespace: &str) -> Result<String, ApiError> {
    let mut result = manifest_diff(
        before["manifest"].as_str().unwrap_or(""),
        after["manifest"].as_str().unwrap_or(""),
        namespace,
    )?;
    result.push_str("\nValues changes:\n");
    json_diff("values", &before["config"], &after["config"], &mut result);
    for (label, value) in [("Previous hooks", before), ("Proposed hooks", after)] {
        if let Some(hooks) = value["hooks"].as_array() {
            for hook in hooks {
                result.push_str(&format!(
                    "\n{label}: events={} delete_policies={}\n{}\n",
                    hook["events"],
                    hook["delete_policies"],
                    hook["manifest"].as_str().unwrap_or("")
                ));
            }
        }
    }
    Ok(result)
}
fn documents(text: &str, namespace: &str) -> Result<BTreeMap<String, Value>, ApiError> {
    let mut result = BTreeMap::new();
    for document in serde_yaml::Deserializer::from_str(text) {
        let value = Value::deserialize(document)
            .map_err(|_| error(422, "Rendered manifest is not valid YAML", None))?;
        if value.is_null() {
            continue;
        }
        let kind = value["kind"]
            .as_str()
            .ok_or_else(|| error(422, "Rendered object has no kind", None))?;
        let name = value["metadata"]["name"]
            .as_str()
            .or(value["metadata"]["generateName"].as_str())
            .ok_or_else(|| error(422, "Rendered object has no name", None))?;
        let key = format!(
            "{}/{}/{}/{}",
            value["apiVersion"].as_str().unwrap_or(""),
            kind,
            value["metadata"]["namespace"].as_str().unwrap_or(namespace),
            name
        );
        if result.insert(key, value).is_some() {
            return Err(error(422, "Duplicate rendered object identity", None));
        }
    }
    Ok(result)
}
fn manifest_diff(before: &str, after: &str, namespace: &str) -> Result<String, ApiError> {
    let a = documents(before, namespace)?;
    let b = documents(after, namespace)?;
    let mut result = String::from("\nRendered object changes:\n");
    for key in a.keys().chain(b.keys()).collect::<BTreeSet<_>>() {
        match (a.get(key), b.get(key)) {
            (None, Some(value)) => result.push_str(&format!(
                "CREATE {key}\n{}\n",
                serde_json::to_string_pretty(value).unwrap()
            )),
            (Some(value), None) => {
                if value["metadata"]["annotations"]["helm.sh/resource-policy"] == "keep" {
                    result.push_str(&format!("KEEP {key} (resource-policy=keep)\n"));
                } else {
                    result.push_str(&format!(
                        "DELETE {key}\n{}\n",
                        serde_json::to_string_pretty(value).unwrap()
                    ));
                }
            }
            (Some(old), Some(new)) if old != new => {
                result.push_str(&format!("UPDATE {key}\n"));
                json_diff("", old, new, &mut result);
            }
            _ => (),
        }
    }
    Ok(result)
}
fn json_diff(path: &str, before: &Value, after: &Value, out: &mut String) {
    if before == after {
        return;
    }
    if let (Some(a), Some(b)) = (before.as_object(), after.as_object()) {
        for key in a.keys().chain(b.keys()).collect::<BTreeSet<_>>() {
            let key = key.replace('~', "~0").replace('/', "~1");
            json_diff(
                &format!("{path}/{key}"),
                a.get(&key.replace("~1", "/").replace("~0", "~"))
                    .unwrap_or(&Value::Null),
                b.get(&key.replace("~1", "/").replace("~0", "~"))
                    .unwrap_or(&Value::Null),
                out,
            );
        }
    } else {
        out.push_str(&format!(
            "  {:?}: BEFORE {} → AFTER {}\n",
            path, before, after
        ));
    }
}
