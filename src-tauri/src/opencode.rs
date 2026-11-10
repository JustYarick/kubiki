//! Installed external CLIs own their configuration, permissions and conversation UI.
//! Legacy OpenCode IPC/type names remain stable for existing clients.
use kubiki_core::{
    cluster::client::ClusterClientPool,
    pod_ops::{
        host_terminal::{HostProcess, HostTerminalManager, HostTerminalRequest},
        terminal::ExecBatch,
    },
};
use kubiki_tools::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{Manager, ipc::Channel};
#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntime {
    #[default]
    Kubiki,
    OpenCode,
    Codex,
    Claude,
}
impl AgentRuntime {
    pub fn label(self) -> &'static str {
        match self {
            Self::Kubiki => "Kubiki",
            Self::OpenCode => "OpenCode",
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
        }
    }
    fn binary(self) -> &'static str {
        match self {
            Self::OpenCode => "opencode",
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Kubiki => "",
        }
    }
    fn settings(self, settings: &crate::agent_commands::AiSettings) -> &OpenCodeSettings {
        match self {
            Self::Codex => &settings.codex,
            Self::Claude => &settings.claude,
            _ => &settings.opencode,
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeSettings {
    pub executable: String,
    pub working_directory: String,
}
impl OpenCodeSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.executable.len() > 4096
            || self.working_directory.len() > 4096
            || self.executable.contains(['\n', '\r'])
            || self.working_directory.contains(['\n', '\r'])
        {
            return Err("Invalid agent executable or directory".into());
        }
        if !self.working_directory.is_empty() && !Path::new(&self.working_directory).is_absolute() {
            return Err("Use an absolute workspace directory".into());
        }
        Ok(())
    }
}
struct Active {
    id: String,
    owner: String,
    terminals: HostTerminalManager,
    server: kubiki_mcp::ClusterServer,
    _endpoint: kubiki_mcp::attached::AttachedEndpoint,
}
#[derive(Clone, Default)]
pub struct OpenCodeManager(
    Arc<tokio::sync::Mutex<HashMap<String, Active>>>,
    Arc<std::sync::Mutex<PendingStarts>>,
);
#[derive(Default)]
struct PendingStarts {
    active: HashMap<String, Arc<PendingLaunch>>,
    cancelled: std::collections::VecDeque<String>,
}
#[derive(Default)]
struct PendingLaunch {
    cancelled: std::sync::atomic::AtomicBool,
    stopped: tokio::sync::Notify,
    session: std::sync::Mutex<Option<Session>>,
}
impl PendingLaunch {
    fn cancel(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.stopped.notify_waiters();
        if let Ok(session) = self.session.lock() {
            if let Some(session) = session.as_ref() {
                session.invalidate();
            }
        }
    }
    async fn cancelled(&self) {
        loop {
            let stopped = self.stopped.notified();
            tokio::pin!(stopped);
            stopped.as_mut().enable();
            if self.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            stopped.await;
        }
    }
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            Err("External agent startup was cancelled".into())
        } else {
            Ok(())
        }
    }
    fn bind(&self, session: &Session) -> Result<(), String> {
        *self
            .session
            .lock()
            .map_err(|_| "External agent startup state unavailable")? = Some(session.clone());
        if let Err(error) = self.check() {
            session.invalidate();
            return Err(error);
        }
        Ok(())
    }
}
struct PendingStart {
    registry: OpenCodeManager,
    key: String,
    launch: Arc<PendingLaunch>,
}
impl Drop for PendingStart {
    fn drop(&mut self) {
        if let Ok(mut state) = self.registry.1.lock() {
            state.active.remove(&self.key);
        }
    }
}

impl OpenCodeManager {
    fn begin(&self, owner: &str, id: &str) -> Result<PendingStart, String> {
        let key = format!("{owner}\0{id}");
        let mut state = self
            .1
            .lock()
            .map_err(|_| "External agent startup registry unavailable")?;
        if state.cancelled.contains(&key) {
            return Err("External agent startup was cancelled".into());
        }
        if state.active.contains_key(&key) || state.active.len() >= 32 {
            return Err("Too many pending OpenCode launches".into());
        }
        let launch = Arc::new(PendingLaunch::default());
        state.active.insert(key.clone(), launch.clone());
        Ok(PendingStart {
            registry: self.clone(),
            key,
            launch,
        })
    }
    pub fn cancel_start(&self, owner: &str, id: &str) {
        if id.is_empty()
            || id.len() > 128
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return;
        }
        let key = format!("{owner}\0{id}");
        let launch = if let Ok(mut state) = self.1.lock() {
            if !state.cancelled.contains(&key) {
                if state.cancelled.len() >= 256 {
                    state.cancelled.pop_front();
                }
                state.cancelled.push_back(key.clone());
            }
            state.active.get(&key).cloned()
        } else {
            None
        };
        if let Some(launch) = launch {
            launch.cancel();
        }
    }
    fn cancel_pending(&self, owner: Option<&str>) {
        let pending = self
            .1
            .lock()
            .map(|s| {
                s.active
                    .iter()
                    .filter(|(key, _)| owner.is_none_or(|o| key.starts_with(&format!("{o}\0"))))
                    .map(|(_, v)| v.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for pending in pending {
            pending.cancel();
        }
    }

    pub async fn stop_all(&self) {
        self.cancel_pending(None);
        let entries = std::mem::take(&mut *self.0.lock().await);
        for entry in entries.into_values() {
            entry.terminals.stop(&entry.owner, &entry.id).await;
        }
    }
    pub async fn stop_owner(&self, owner: &str) {
        self.cancel_pending(Some(owner));
        if let Some(entry) = self.0.lock().await.remove(owner) {
            entry.terminals.stop(owner, &entry.id).await;
        }
    }
    pub async fn update_policy(&self, policy: &AgentPolicy, phase: AgentPhase) -> Result<(), String> {
        let sanitized = sanitize_mcp_policy(policy);
        let servers = self
            .0
            .lock()
            .await
            .values()
            .map(|entry| entry.server.clone())
            .collect::<Vec<_>>();
        for server in servers {
            server.update_access(sanitized.clone(), phase)?;
        }
        Ok(())
    }
}

pub fn sanitize_mcp_policy(policy: &AgentPolicy) -> AgentPolicy {
    let mut sanitized = policy.clone();
    sanitized.confirm_reads = false;
    sanitized.always_ask.clear();
    sanitized.rules.clear();
    sanitized
}
fn executable_for(runtime: AgentRuntime, value: &str) -> Result<PathBuf, String> {
    let default = format!(
        "{}{}",
        runtime.binary(),
        if cfg!(windows) { ".exe" } else { "" }
    );
    let value = if value.trim().is_empty() {
        default.as_str()
    } else {
        value.trim()
    };
    let path = Path::new(value);
    if path.is_absolute() && path.is_file() {
        return Ok(path.into());
    }
    if path.components().count() > 1 {
        return Err("Use an absolute executable path".into());
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|p| p.join(value))
        .find(|p| p.is_file())
        .ok_or_else(|| {
            format!(
                "{} was not found. Install it or set its executable path in AI settings.",
                runtime.label()
            )
        })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    executable: String,
    version: String,
}
#[tauri::command]
pub async fn ai_test_opencode(settings: OpenCodeSettings) -> Result<Installation, String> {
    ai_test_external_agent(AgentRuntime::OpenCode, settings).await
}
#[tauri::command]
pub async fn ai_test_external_agent(
    runtime: AgentRuntime,
    settings: OpenCodeSettings,
) -> Result<Installation, String> {
    if runtime == AgentRuntime::Kubiki {
        return Err("Select an external agent".into());
    }
    settings.validate()?;
    let path = executable_for(runtime, &settings.executable)?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        tokio::process::Command::new(&path)
            .arg("--version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Agent version check timed out")?
    .map_err(|e| e.to_string())?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let recognized = match runtime {
        AgentRuntime::OpenCode => version.starts_with("opencode v2."),
        AgentRuntime::Codex => version.starts_with("codex-cli "),
        AgentRuntime::Claude => version.contains("Claude Code"),
        AgentRuntime::Kubiki => false,
    };
    if !output.status.success() || !recognized {
        return Err(format!(
            "{} version check failed (OpenCode requires V2)",
            runtime.label()
        ));
    }
    Ok(Installation {
        executable: path.to_string_lossy().into(),
        version,
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub scope: AgentScope,
    pub cols: u16,
    pub rows: u16,
    pub prompt: Option<String>,
}
/// All command errors occur before the PTY process is scheduled. IPC failures
/// without this envelope remain ambiguous and must not replay the initial task.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeStartFailure {
    code: &'static str,
    message: String,
    process_started: bool,
}
#[tauri::command]
pub async fn start_opencode(
    session_id: String,
    request: StartRequest,
    on_event: Channel<ExecBatch>,
    ack_timeout_secs: Option<u64>,
    window: tauri::WebviewWindow,
) -> Result<(), OpenCodeStartFailure> {
    start_opencode_inner(session_id, request, on_event, ack_timeout_secs, window)
        .await
        .map_err(|message| OpenCodeStartFailure {
            code: "opencode_start_failed",
            message,
            process_started: false,
        })
}
async fn start_opencode_inner(
    session_id: String,
    request: StartRequest,
    on_event: Channel<ExecBatch>,
    ack_timeout_secs: Option<u64>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("Invalid external agent terminal session ID".into());
    }
    let registry = window.state::<OpenCodeManager>().inner().clone();
    let pending = registry.begin(window.label(), &session_id)?;
    let gate = window
        .state::<crate::agent_commands::AgentManager>()
        .settings_gate
        .clone();
    let _configuration = tokio::select! {biased;
        _=pending.launch.cancelled()=>return Err("External agent startup was cancelled".into()),
        guard=gate.lock()=>guard,
    };
    pending.launch.check()?;
    let settings = crate::agent_commands::load(window.app_handle()).await?;
    if settings.runtime == AgentRuntime::Kubiki {
        return Err("Select an external agent in AI settings first".into());
    }
    if request.scope.context.is_empty() {
        return Err("Select a cluster before starting the external agent".into());
    }
    if request.prompt.as_ref().is_some_and(|p| p.len() > 24000) {
        return Err("Initial request is too large".into());
    }
    let install = tokio::select! {biased;
        _=pending.launch.cancelled()=>return Err("External agent startup was cancelled".into()),
        install=ai_test_external_agent(settings.runtime, settings.runtime.settings(&settings).clone())=>install?,
    };
    pending.launch.check()?;
    let pool = window.state::<ClusterClientPool>().inner().clone();
    let external_settings = settings.runtime.settings(&settings).clone();
    let policy = sanitize_mcp_policy(&settings.mcp_policy);
    policy.validate()?;
    use std::hash::{Hash, Hasher};
    let mut key = std::collections::hash_map::DefaultHasher::new();
    (
        window.label(),
        &request.scope.context,
        &request.scope.namespaces,
        request.scope.all_namespaces,
    )
        .hash(&mut key);
    let workspace_key = format!("{:016x}", key.finish());
    let session = Session::new(
        format!("opencode-{session_id}"),
        window.label().into(),
        request.scope,
        policy.clone(),
        ClusterCapabilities {
            helm: true,
            argocd: true,
            flux: true,
        },
    );
    pending.launch.bind(&session)?;
    session.mode(AgentMode::Accept)?;
    session.phase(settings.mcp_phase)?;
    let data = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let executor = Arc::new(kubiki_mcp::ConnectionExecutor {
        pool,
        journal: data.join("ai").join(format!("opencode-{session_id}.jsonl")),
        consent: Arc::new(crate::agent_tools::DesktopHostConsent(window.clone())),
        generation: std::sync::Mutex::new(None),
        permits: Arc::new(tokio::sync::Semaphore::new(2)),
    });
    let server = kubiki_mcp::ClusterServer::new(session, executor, Arc::new(|_| {}), true);
    let endpoint = kubiki_mcp::attached::start(server.clone()).await?;
    let root = if external_settings.working_directory.is_empty() {
        data.join(format!("{}/workspaces", settings.runtime.binary()))
    } else {
        PathBuf::from(&external_settings.working_directory)
    };
    let cwd = root.join(workspace_key);
    tokio::fs::create_dir_all(&cwd)
        .await
        .map_err(|e| e.to_string())?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if settings.runtime == AgentRuntime::OpenCode {
        let mut plan_permissions = vec![
            serde_json::json!({"action":"shell","resource":"*","effect":"deny"}),
            serde_json::json!({"action":"external_directory","resource":"*","effect":"deny"}),
        ];
        // OpenCode's Plan permissions also remove these tools from its model catalog.
        for tool in tool_definitions(
            &policy,
            AgentMode::Accept,
            AgentPhase::Action,
            &ClusterCapabilities::all(),
        ) {
            if mutation_tool(&tool.name) {
                plan_permissions.push(serde_json::json!({"action":format!("kubiki_{}",tool.name),"resource":"*","effect":"deny"}));
            }
        }
        let default_agent = match settings.mcp_phase {
            AgentPhase::Plan => "plan",
            AgentPhase::Action => "build",
        };
        let overlay = serde_json::json!({
            "default_agent": default_agent,
            "agents":{"plan":{"permissions":plan_permissions}},
            "instructions":[".kubiki-instructions.md"],
            "mcp":{"servers":{"kubiki":{"type":"local","command":[executable,"--kubiki-mcp-attach",endpoint.bootstrap],"codemode":true}}}
        });
        let config_path = cwd.join("opencode.json");
        let marker = cwd.join(".kubiki-workspace");
        if config_path.exists() && !marker.is_file() {
            return Err("Choose a dedicated Kubiki workspace; existing OpenCode project configuration will not be replaced".into());
        }
        if config_path.exists() {
            let existing: serde_json::Value = serde_json::from_slice(
                &tokio::fs::read(&config_path)
                    .await
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|_| "Workspace opencode.json is not valid JSON")?;
            if existing.as_object().is_none_or(|m| {
                m.keys().any(|key| {
                    !["mcp", "default_agent", "agents", "instructions"].contains(&key.as_str())
                })
            }) || existing["mcp"]["servers"]
                .as_object()
                .is_none_or(|m| m.len() != 1 || !m.contains_key("kubiki"))
            {
                return Err("Choose a dedicated Kubiki workspace; existing OpenCode project configuration will not be replaced".into());
            }
        }
        if cwd.join("opencode.jsonc").exists() || cwd.join(".opencode").exists() {
            return Err(
                "Choose a dedicated Kubiki workspace to preserve existing project configuration"
                    .into(),
            );
        }
        let instructions = cwd.join(".kubiki-instructions.md");
        const HEADER: &str = "# Kubiki cluster workspace\n";
        if instructions.exists()
            && !tokio::fs::read_to_string(&instructions)
                .await
                .map_err(|e| e.to_string())?
                .starts_with(HEADER)
        {
            return Err("Existing workspace instructions are not managed by Kubiki".into());
        }
        tokio::fs::write(&instructions, format!("{HEADER}Use the kubiki namespace in Code Mode for Kubernetes investigation. Search this namespace once for diagnose_resource, then call the exact returned path with the supplied GVK, namespace, name and UID. All permitted Kubernetes read tools remain discoverable; expand evidence for complex problems. If the namespace/tool is unavailable, report the MCP connection problem and stop. Do not inspect host configuration, environment variables, credentials or bootstrap files, probe local sockets, or substitute shell/curl for cluster tools. Plan is for investigation; switch to Build only for requested changes.\n{INVESTIGATION_GUIDANCE}\n")).await.map_err(|e|e.to_string())?;
        tokio::fs::write(&marker, b"Kubiki managed OpenCode workspace v2\n")
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::write(
            &config_path,
            serde_json::to_vec_pretty(&overlay).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    let args = external_arguments(
        settings.runtime,
        &executable,
        &endpoint.bootstrap,
        request.prompt.as_deref(),
    )?;
    let terminals = window.state::<HostTerminalManager>().inner().clone();
    if let Some(previous) = registry.0.lock().await.remove(window.label()) {
        previous.terminals.stop(window.label(), &previous.id).await;
    }
    pending.launch.check()?;
    let mut subscription = terminals
        .start_process(
            window.label(),
            &session_id,
            HostTerminalRequest {
                shell: None,
                cols: request.cols,
                rows: request.rows,
            },
            HostProcess {
                program: install.executable.into(),
                args,
                cwd,
                environment: vec![],
            },
        )
        .await
        .map_err(|e| e.message)?;
    if pending.launch.check().is_err() {
        terminals.stop(window.label(), &session_id).await;
        // A process may already have spawned; return success to keep delivery ambiguous.
        return Ok(());
    }
    let owner = window.label().to_owned();
    registry.0.lock().await.insert(
        owner.clone(),
        Active {
            id: session_id.clone(),
            owner: owner.clone(),
            terminals: terminals.clone(),
            server,
            _endpoint: endpoint,
        },
    );
    tauri::async_runtime::spawn(async move {
        crate::exec_stream::forward(
            &mut subscription,
            &session_id,
            &on_event,
            ack_timeout_secs,
            "host_terminal",
            None,
        )
        .await;
        terminals.stop(&owner, &session_id).await;
        let mut active = registry.0.lock().await;
        if active.get(&owner).is_some_and(|a| a.id == session_id) {
            active.remove(&owner);
        }
    });
    Ok(())
}

/// Session-only overrides: never rewrite the user's Codex/Claude configuration.
fn external_arguments(
    runtime: AgentRuntime,
    executable: &Path,
    bootstrap: &Path,
    prompt: Option<&str>,
) -> Result<Vec<String>, String> {
    let command = executable.to_str().ok_or("Executable path is not UTF-8")?;
    let bootstrap = bootstrap.to_str().ok_or("MCP path is not UTF-8")?;
    let args = serde_json::json!(["--kubiki-mcp-attach", bootstrap]);
    let mut result = match runtime {
        AgentRuntime::OpenCode => vec!["--standalone".into()],
        AgentRuntime::Codex => vec![
            "-c".into(),
            format!(
                "mcp_servers.kubiki={{command={},args={args},enabled=true}}",
                serde_json::json!(command)
            ),
            "-c".into(),
            "features.mcp_tool_list_changed=true".into(),
        ],
        AgentRuntime::Claude => vec![
            "--mcp-config".into(),
            serde_json::json!({"mcpServers":{"kubiki":{"type":"stdio","command":command,"args":args}}}).to_string(),
        ],
        AgentRuntime::Kubiki => return Err("Not an external agent".into()),
    };
    if let Some(prompt) = prompt.filter(|p| !p.trim().is_empty()) {
        result.push(
            if runtime == AgentRuntime::OpenCode {
                "--prompt"
            } else {
                "--"
            }
            .into(),
        );
        result.push(prompt.into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_argv_is_session_scoped_and_preserves_literal_prompts() {
        let path = Path::new("/path with spaces/kubiki");
        let bootstrap = Path::new("/tmp/session file.json");
        let prompt = "--dangerously-skip-permissions $(echo unexpected)";
        for runtime in [AgentRuntime::Codex, AgentRuntime::Claude] {
            let args = external_arguments(runtime, path, bootstrap, Some(prompt)).unwrap();
            assert_eq!(args[args.len() - 2], "--");
            assert_eq!(args.last().unwrap(), prompt);
            assert!(
                !args
                    .iter()
                    .any(|a| a == "--dangerously-skip-permissions" || a == "--yolo")
            );
            if runtime == AgentRuntime::Claude {
                let config: serde_json::Value = serde_json::from_str(&args[1]).unwrap();
                assert_eq!(
                    config["mcpServers"]["kubiki"]["command"],
                    path.to_str().unwrap()
                );
                assert_eq!(
                    config["mcpServers"]["kubiki"]["args"][1],
                    bootstrap.to_str().unwrap()
                );
            } else {
                assert!(args[1].starts_with("mcp_servers.kubiki={command="));
                assert!(args[1].contains("--kubiki-mcp-attach"));
            }
        }
        let opencode_args =
            external_arguments(AgentRuntime::OpenCode, path, bootstrap, Some(prompt)).unwrap();
        assert_eq!(
            opencode_args,
            vec!["--standalone", "--prompt", prompt]
        );
    }
    #[test]
    fn opencode_default_agent_defaults_to_plan_unless_action_configured() {
        let plan_phase = AgentPhase::Plan;
        let action_phase = AgentPhase::Action;
        let default_for_plan = match plan_phase {
            AgentPhase::Plan => "plan",
            AgentPhase::Action => "build",
        };
        let default_for_action = match action_phase {
            AgentPhase::Plan => "plan",
            AgentPhase::Action => "build",
        };
        assert_eq!(default_for_plan, "plan");
        assert_eq!(default_for_action, "build");
    }
    #[test]
    fn each_external_agent_has_independent_settings() {
        let mut settings = crate::agent_commands::AiSettings::default();
        settings.codex.executable = "/usr/bin/codex".into();
        settings.claude.executable = "/usr/bin/claude".into();
        for runtime in [AgentRuntime::Codex, AgentRuntime::Claude] {
            settings.runtime = runtime;
            let restored: crate::agent_commands::AiSettings =
                serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
            assert!(restored.runtime == runtime);
            assert_eq!(
                runtime.settings(&restored).executable,
                runtime.settings(&settings).executable
            );
        }
        assert!(settings.opencode.executable.is_empty());
    }
    #[test]
    fn old_settings_default_to_kubiki_and_keep_environment_inert() {
        let settings:crate::agent_commands::AiSettings=serde_json::from_value(serde_json::json!({"environment":{"commandsEnabled":true,"mcpServers":[{"command":"do-not-launch"}]}})).unwrap();
        assert!(settings.runtime == AgentRuntime::Kubiki);
        assert_eq!(settings.environment["commandsEnabled"], true);
        assert!(settings.mcp_policy.writes.is_empty());
    }
    #[test]
    fn exposure_and_kubiki_permissions_are_independent() {
        let mut settings = crate::agent_commands::AiSettings::default();
        settings.runtime = AgentRuntime::OpenCode;
        settings.policy.always_ask = vec!["get_resource".into()];
        settings.policy.logs = true;
        assert!(!settings.mcp_policy.logs);
        assert!(settings.mcp_policy.always_ask.is_empty());
        let restored: crate::agent_commands::AiSettings =
            serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
        assert!(restored.runtime == AgentRuntime::OpenCode);
        assert!(restored.policy.logs);
    }
    #[test]
    fn codex_external_arguments_enable_mcp_tool_list_changed_and_kubiki_server() {
        let path = Path::new("/usr/bin/kubiki");
        let bootstrap = Path::new("/tmp/bootstrap.json");
        let args = external_arguments(AgentRuntime::Codex, path, bootstrap, None).unwrap();
        assert_eq!(args[0], "-c");
        assert!(args[1].starts_with("mcp_servers.kubiki={command="));
        assert_eq!(args[2], "-c");
        assert_eq!(args[3], "features.mcp_tool_list_changed=true");
    }
    #[test]
    fn sanitize_mcp_policy_never_expands_explicit_denials() {
        let legacy = AgentPolicy::default();
        let normalized = sanitize_mcp_policy(&legacy);
        assert!(!normalized.logs);
        assert!(!normalized.cluster_resources);
        assert!(normalized.writes.is_empty());
        let count_external = |p: &AgentPolicy| {
            tool_definitions(
                p,
                AgentMode::Accept,
                AgentPhase::Action,
                &ClusterCapabilities::all(),
            )
            .into_iter()
            .filter(|t| !matches!(t.name.as_str(), "ask_user" | "get_plan" | "propose_plan"))
            .count()
        };
        let full = AgentPolicy { logs:true, cluster_resources:true, writes:vec![WriteOperation::Create,WriteOperation::Update,WriteOperation::Delete,WriteOperation::Scale,WriteOperation::Restart], ..Default::default() };
        assert_eq!(count_external(&sanitize_mcp_policy(&full)), 31);

        let mut read_only = full.clone();
        read_only.read_only = true;
        assert_eq!(count_external(&sanitize_mcp_policy(&read_only)), 27);

        let mut explicit_no_writes = full.clone();
        explicit_no_writes.writes.clear();
        let preserved = sanitize_mcp_policy(&explicit_no_writes);
        assert!(preserved.writes.is_empty());
        assert_eq!(count_external(&preserved), 27);
    }
    #[test]
    fn installation_requires_an_executable_path_not_a_shell_command() {
        assert!(executable_for(AgentRuntime::OpenCode, "opencode; echo wrong").is_err());
        assert!(executable_for(AgentRuntime::OpenCode, "./opencode").is_err());
        assert!(
            OpenCodeSettings {
                executable: "opencode\n--auto".into(),
                working_directory: String::new()
            }
            .validate()
            .is_err()
        );
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;
    #[test]
    fn cancellation_before_start_is_retained_and_pending_registry_is_cleaned() {
        let manager = OpenCodeManager::default();
        manager.cancel_start("window", "first");
        assert!(manager.begin("window", "first").is_err());
        {
            let _pending = manager.begin("window", "second").unwrap();
            assert_eq!(manager.1.lock().unwrap().active.len(), 1);
        }
        assert!(manager.1.lock().unwrap().active.is_empty());
        for index in 0..300 {
            manager.cancel_start("window", &format!("{index}"));
        }
        assert_eq!(manager.1.lock().unwrap().cancelled.len(), 256);
        manager.cancel_start("window", &"x".repeat(129));
        manager.cancel_start("window", "invalid/id");
        assert_eq!(manager.1.lock().unwrap().cancelled.len(), 256);
    }
    #[tokio::test]
    async fn stopping_pending_start_revokes_its_cluster_session_and_not_another_window() {
        let manager = OpenCodeManager::default();
        let first = manager.begin("one", "same-id").unwrap();
        let other = manager.begin("two", "same-id").unwrap();
        let session = Session::new(
            "session".into(),
            "one".into(),
            AgentScope::default(),
            AgentPolicy::default(),
            ClusterCapabilities::default(),
        );
        first.launch.bind(&session).unwrap();
        manager.cancel_start("one", "same-id");
        first.launch.cancelled().await;
        assert!(first.launch.check().is_err());
        assert!(session.control().unwrap().invalidated);
        assert!(other.launch.check().is_ok());
    }
    #[test]
    fn startup_error_envelope_proves_no_process_was_started() {
        let value = serde_json::to_value(OpenCodeStartFailure {
            code: "opencode_start_failed",
            message: "Missing executable".into(),
            process_started: false,
        })
        .unwrap();
        assert_eq!(value["processStarted"], false);
        assert_eq!(value["code"], "opencode_start_failed");
    }
}
