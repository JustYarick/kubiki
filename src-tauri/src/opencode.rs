//! The installed OpenCode owns its configuration, permissions and conversation UI.
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
            return Err("Invalid OpenCode executable or directory".into());
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
    _endpoint: kubiki_mcp::attached::AttachedEndpoint,
}
#[derive(Clone, Default)]
pub struct OpenCodeManager(Arc<tokio::sync::Mutex<HashMap<String, Active>>>);
impl OpenCodeManager {
    pub async fn stop_all(&self) {
        let entries = std::mem::take(&mut *self.0.lock().await);
        for entry in entries.into_values() {
            entry.terminals.stop(&entry.owner, &entry.id).await;
        }
    }
    pub async fn stop_owner(&self, owner: &str) {
        if let Some(entry) = self.0.lock().await.remove(owner) {
            entry.terminals.stop(owner, &entry.id).await;
        }
    }
}
fn executable(value: &str) -> Result<PathBuf, String> {
    let value = if value.trim().is_empty() {
        if cfg!(windows) {
            "opencode.exe"
        } else {
            "opencode"
        }
    } else {
        value.trim()
    };
    let path = Path::new(value);
    if path.is_absolute() && path.is_file() {
        return Ok(path.into());
    }
    if path.components().count() > 1 {
        return Err("Use an absolute path to OpenCode".into());
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|p| p.join(value))
        .find(|p| p.is_file())
        .ok_or_else(|| {
            "OpenCode was not found. Install it or set its executable path in AI settings.".into()
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
    settings.validate()?;
    let path = executable(&settings.executable)?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        tokio::process::Command::new(&path)
            .arg("--version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "OpenCode version check timed out")?
    .map_err(|e| e.to_string())?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || !version.starts_with("opencode v2.") {
        return Err("This integration requires OpenCode V2".into());
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
#[tauri::command]
pub async fn start_opencode(
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
        return Err("Invalid OpenCode terminal session ID".into());
    }
    let gate = window
        .state::<crate::agent_commands::AgentManager>()
        .settings_gate
        .clone();
    let _configuration = gate.lock().await;
    let settings = crate::agent_commands::load(window.app_handle()).await?;
    if settings.runtime != AgentRuntime::OpenCode {
        return Err("Select OpenCode in AI settings first".into());
    }
    if request.scope.context.is_empty() {
        return Err("Select a cluster before starting OpenCode".into());
    }
    if request.prompt.as_ref().is_some_and(|p| p.len() > 24000) {
        return Err("Initial request is too large".into());
    }
    let install = ai_test_opencode(settings.opencode.clone()).await?;
    let pool = window.state::<ClusterClientPool>().inner().clone();
    let mut policy = settings.mcp_policy;
    policy.confirm_reads = false;
    policy.always_ask.clear();
    policy.rules.clear();
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
        policy,
        ClusterCapabilities {
            helm: true,
            argocd: true,
            flux: true,
        },
    );
    session.mode(AgentMode::Accept)?;
    session.phase(AgentPhase::Action)?;
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
    let endpoint = kubiki_mcp::attached::start(kubiki_mcp::ClusterServer::new(
        session,
        executor,
        Arc::new(|_| {}),
        true,
    ))
    .await?;
    let root = if settings.opencode.working_directory.is_empty() {
        data.join("opencode/workspaces")
    } else {
        PathBuf::from(&settings.opencode.working_directory)
    };
    let cwd = root.join(workspace_key);
    tokio::fs::create_dir_all(&cwd)
        .await
        .map_err(|e| e.to_string())?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let overlay = serde_json::json!({"mcp":{"servers":{"kubiki":{"type":"local","command":[executable,"--kubiki-mcp-attach",endpoint.bootstrap],"codemode":false}}}});
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
        if existing.as_object().is_none_or(|m| m.len() != 1)
            || existing["mcp"]["servers"]
                .as_object()
                .is_none_or(|m| m.len() != 1 || !m.contains_key("kubiki"))
        {
            return Err("Choose a dedicated Kubiki workspace; existing OpenCode project configuration will not be replaced".into());
        }
    }
    if cwd.join("opencode.jsonc").exists() || cwd.join(".opencode").exists() {
        return Err(
            "Choose a dedicated Kubiki workspace to preserve existing project configuration".into(),
        );
    }
    tokio::fs::write(&marker, b"Kubiki managed OpenCode workspace v1\n")
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&overlay).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())?;
    let mut args = vec!["--standalone".into()];
    if let Some(prompt) = request.prompt.filter(|p| !p.trim().is_empty()) {
        args.push("--prompt".into());
        args.push(prompt);
    }
    let terminals = window.state::<HostTerminalManager>().inner().clone();
    let registry = window.state::<OpenCodeManager>().inner().clone();
    registry.stop_owner(window.label()).await;
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
    let owner = window.label().to_owned();
    registry.0.lock().await.insert(
        owner.clone(),
        Active {
            id: session_id.clone(),
            owner: owner.clone(),
            terminals: terminals.clone(),
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

#[cfg(test)]
mod tests {
    use super::*;
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
    fn installation_requires_an_executable_path_not_a_shell_command() {
        assert!(executable("opencode; echo wrong").is_err());
        assert!(executable("./opencode").is_err());
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
