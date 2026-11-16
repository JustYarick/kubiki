//! Persistent loopback Streamable HTTP MCP server and 1-click client auto-configuration.
use kubiki_core::cluster::client::ClusterClientPool;
use kubiki_tools::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};
use tauri::Manager;
use tokio::sync::Mutex;

pub const DEFAULT_MCP_HTTP_PORT: u16 = 3847;
const KEYRING_ID: &str = "mcp-http-token";

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerSettings {
    pub enabled: bool,
    pub port: u16,
    pub require_auth: bool,
}

impl Default for McpServerSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_MCP_HTTP_PORT,
            require_auth: false,
        }
    }
}

impl McpServerSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.port < 1024 {
            return Err("MCP server port must be between 1024 and 65535".into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub require_auth: bool,
    pub url: String,
    pub scope: AgentScope,
    pub error: Option<String>,
    pub token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoConfigureResult {
    pub client: String,
    pub config_path: String,
    pub url: String,
}

struct RunningServer {
    port: u16,
    require_auth: bool,
    token: Option<String>,
    server: kubiki_mcp::http::HttpMcpServer,
}

/// Resolves the client for whichever cluster context is currently active in Kubiki UI.
struct DynamicConnectionExecutor {
    pool: ClusterClientPool,
    journal: PathBuf,
    consent: Arc<dyn kubiki_tools::kubernetes::Consent>,
    permits: Arc<tokio::sync::Semaphore>,
    pinned: StdMutex<Option<(String, u64)>>,
}

#[async_trait::async_trait]
impl ToolExecutor for DynamicConnectionExecutor {
    async fn execute(
        &self,
        session: &Session,
        call: &ToolCall,
        emit: &EventSink,
    ) -> Result<Value, String> {
        if session.scope.context.is_empty() {
            return Err(
                "No cluster is currently selected in Kubiki Desktop. Select a cluster in Kubiki and retry."
                    .into(),
            );
        }
        let (client, generation) = self
            .pool
            .get_client_with_generation(&session.scope.context)
            .await
            .map_err(|e| e.to_string())?;
        {
            let mut guard = self
                .pinned
                .lock()
                .map_err(|_| "Connection state unavailable")?;
            let changed = guard
                .as_ref()
                .is_some_and(|(ctx, pinned_gen)| ctx != &session.scope.context || *pinned_gen != generation);
            if changed {
                if let Ok(mut accepted) = session.accepted_operations.lock() {
                    *accepted = AcceptedOperations::default();
                }
            }
            *guard = Some((session.scope.context.clone(), generation));
        }
        let tools = kubiki_tools::kubernetes::KubernetesTools::scoped(
            session,
            self.pool.clone(),
            Some(client),
            Some(generation),
            self.consent.clone(),
            self.journal.clone(),
            self.permits.clone(),
        )?;
        tools.execute(session, call, emit).await
    }
}

#[derive(Clone)]
pub struct PersistentMcpManager {
    inner: Arc<Mutex<ManagerState>>,
    scope: Arc<StdMutex<AgentScope>>,
    policy: Arc<StdMutex<AgentPolicy>>,
    phase: Arc<StdMutex<AgentPhase>>,
    servers: Arc<StdMutex<Vec<kubiki_mcp::ClusterServer>>>,
}

#[derive(Default)]
struct ManagerState {
    enabled: bool,
    port: u16,
    require_auth: bool,
    last_error: Option<String>,
    running: Option<RunningServer>,
}

impl Default for PersistentMcpManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ManagerState {
                enabled: false,
                port: DEFAULT_MCP_HTTP_PORT,
                require_auth: false,
                last_error: None,
                running: None,
            })),
            scope: Arc::new(StdMutex::new(AgentScope::default())),
            policy: Arc::new(StdMutex::new(crate::opencode::sanitize_mcp_policy(
                &AgentPolicy::default(),
            ))),
            phase: Arc::new(StdMutex::new(AgentPhase::Plan)),
            servers: Arc::new(StdMutex::new(Vec::new())),
        }
    }
}

fn token_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| "Cannot locate configuration directory")?
        .join("mcp-http.token"))
}

fn read_token_file(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| s.len() >= 32 && !s.contains(['\r', '\n']))
}

fn write_token_file(path: &Path, token: &str) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Cannot create configuration directory")?;
    }
    let temp = path.with_extension("token.tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&temp)
        .map_err(|_| "Cannot write MCP server token")?;
    file.write_all(token.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist MCP server token")?;
    drop(file);
    std::fs::rename(temp, path).map_err(|_| "Cannot replace MCP server token".to_owned())
}

pub(crate) async fn load_or_create_token(app: &tauri::AppHandle) -> Result<String, String> {
    let fallback_path = token_file_path(app)?;
    tokio::task::spawn_blocking(move || {
        if let Ok(entry) = keyring::Entry::new("com.kubiki.ai", KEYRING_ID) {
            if let Ok(existing) = entry.get_password() {
                if existing.len() >= 32 && !existing.contains(['\r', '\n']) {
                    return Ok(existing);
                }
            }
            if let Some(existing) = read_token_file(&fallback_path) {
                let _ = entry.set_password(&existing);
                return Ok(existing);
            }
            let generated = kubiki_mcp::http::generate_bearer_token();
            if entry.set_password(&generated).is_ok() {
                return Ok(generated);
            }
            write_token_file(&fallback_path, &generated)?;
            return Ok(generated);
        }
        if let Some(existing) = read_token_file(&fallback_path) {
            return Ok(existing);
        }
        let generated = kubiki_mcp::http::generate_bearer_token();
        write_token_file(&fallback_path, &generated)?;
        Ok(generated)
    })
    .await
    .map_err(|_| "MCP token task failed")?
}

async fn store_new_token(app: &tauri::AppHandle) -> Result<String, String> {
    let fallback_path = token_file_path(app)?;
    tokio::task::spawn_blocking(move || {
        let generated = kubiki_mcp::http::generate_bearer_token();
        let saved_keyring = keyring::Entry::new("com.kubiki.ai", KEYRING_ID)
            .and_then(|entry| entry.set_password(&generated))
            .is_ok();
        if !saved_keyring {
            write_token_file(&fallback_path, &generated)?;
        } else if fallback_path.exists() {
            let _ = write_token_file(&fallback_path, &generated);
        }
        Ok(generated)
    })
    .await
    .map_err(|_| "MCP token task failed")?
}

impl PersistentMcpManager {
    fn build_factory(
        &self,
        app: &tauri::AppHandle,
    ) -> Result<Arc<dyn Fn() -> kubiki_mcp::ClusterServer + Send + Sync>, String> {
        let pool = app.state::<ClusterClientPool>().inner().clone();
        let guard = app
            .state::<crate::mutation_guard::MutationGuard>()
            .inner()
            .clone();
        let data = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;
        let journal = data.join("ai").join("mcp-http.jsonl");
        let scope_ref = self.scope.clone();
        let policy_ref = self.policy.clone();
        let phase_ref = self.phase.clone();
        let servers_ref = self.servers.clone();

        Ok(Arc::new(move || {
            let scope = scope_ref.lock().map(|g| g.clone()).unwrap_or_default();
            let policy = policy_ref
                .lock()
                .map(|g| g.clone())
                .unwrap_or_else(|_| crate::opencode::sanitize_mcp_policy(&AgentPolicy::default()));
            let phase = phase_ref
                .lock()
                .map(|g| *g)
                .unwrap_or(AgentPhase::Plan);
            let session = Session::new(
                format!("mcp-http-{}", kubiki_mcp::http::generate_bearer_token()),
                "desktop-http".into(),
                scope,
                policy,
                ClusterCapabilities {
                    helm: true,
                    argocd: true,
                    flux: true,
                },
            );
            let _ = session.mode(AgentMode::Accept);
            let _ = session.phase(phase);
            let executor = Arc::new(DynamicConnectionExecutor {
                pool: pool.clone(),
                journal: journal.clone(),
                consent: Arc::new(crate::agent_tools::SharedHostConsent(guard.clone())),
                pinned: StdMutex::new(None),
                permits: Arc::new(tokio::sync::Semaphore::new(2)),
            });
            let server =
                kubiki_mcp::ClusterServer::new(session, executor, Arc::new(|_| {}), true)
                    .with_dynamic_scope(scope_ref.clone());
            if let Ok(mut list) = servers_ref.lock() {
                if list.len() >= 16 {
                    list.remove(0);
                }
                list.push(server.clone());
            }
            server
        }))
    }

    pub async fn reconcile(
        &self,
        app: &tauri::AppHandle,
        settings: &crate::agent_commands::AiSettings,
    ) -> Result<(), String> {
        settings.mcp_server.validate()?;
        self.update_access(&settings.mcp_policy, settings.mcp_phase)?;

        let desired = &settings.mcp_server;
        let token = if desired.enabled && desired.require_auth {
            Some(load_or_create_token(app).await?)
        } else {
            None
        };

        let previous = {
            let mut state = self.inner.lock().await;
            state.enabled = desired.enabled;
            state.port = desired.port;
            state.require_auth = desired.require_auth;
            if !desired.enabled {
                state.last_error = None;
                state.running.take()
            } else if state.running.as_ref().is_some_and(|r| {
                r.port == desired.port
                    && r.require_auth == desired.require_auth
                    && r.token == token
            }) {
                state.last_error = None;
                return Ok(());
            } else {
                state.running.take()
            }
        };

        if let Some(prev) = previous {
            self.invalidate_servers();
            prev.server.shutdown().await;
        }

        if !desired.enabled {
            return Ok(());
        }

        let factory = self.build_factory(app)?;
        match kubiki_mcp::http::start_http(desired.port, token.clone(), factory).await {
            Ok(server) => {
                let mut state = self.inner.lock().await;
                state.last_error = None;
                state.running = Some(RunningServer {
                    port: server.port,
                    require_auth: desired.require_auth,
                    token,
                    server,
                });
                Ok(())
            }
            Err(err) => {
                let mut state = self.inner.lock().await;
                state.last_error = Some(err.clone());
                Err(err)
            }
        }
    }

    fn invalidate_servers(&self) {
        if let Ok(mut list) = self.servers.lock() {
            for server in list.drain(..) {
                server.session.invalidate();
            }
        }
    }

    /// Dynamically rebinds active MCP sessions to the newly selected cluster/namespace
    /// without dropping external client connections.
    pub fn set_scope(&self, next: AgentScope) {
        let changed = if let Ok(mut current) = self.scope.lock() {
            if *current == next {
                false
            } else {
                *current = next.clone();
                true
            }
        } else {
            false
        };
        if changed {
            let servers = self
                .servers
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            for server in servers {
                server.rebind_scope(&next);
            }
        }
    }

    pub fn update_access(&self, policy: &AgentPolicy, phase: AgentPhase) -> Result<(), String> {
        let sanitized = crate::opencode::sanitize_mcp_policy(policy);
        if let Ok(mut guard) = self.policy.lock() {
            *guard = sanitized.clone();
        }
        if let Ok(mut guard) = self.phase.lock() {
            *guard = phase;
        }
        let servers = self
            .servers
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        for server in servers {
            let _ = server.update_access(sanitized.clone(), phase);
        }
        Ok(())
    }

    pub async fn stop(&self) {
        let running = {
            let mut state = self.inner.lock().await;
            state.running.take()
        };
        self.invalidate_servers();
        if let Some(r) = running {
            r.server.shutdown().await;
        }
    }

    pub async fn status(
        &self,
        app: &tauri::AppHandle,
        reveal_token: bool,
    ) -> Result<McpHttpStatus, String> {
        let (enabled, running, port, require_auth, error) = {
            let state = self.inner.lock().await;
            (
                state.enabled,
                state.running.is_some(),
                state.running.as_ref().map(|r| r.port).unwrap_or(state.port),
                state.require_auth,
                state.last_error.clone(),
            )
        };
        let scope = self.scope.lock().map(|g| g.clone()).unwrap_or_default();
        let token = if reveal_token {
            Some(load_or_create_token(app).await?)
        } else {
            None
        };
        Ok(McpHttpStatus {
            enabled,
            running,
            port,
            require_auth,
            url: format!("http://127.0.0.1:{port}/mcp"),
            scope,
            error,
            token,
        })
    }
}

pub fn merge_client_mcp_config(
    client: &str,
    existing: Option<&str>,
    url: &str,
    token: Option<&str>,
) -> Result<String, String> {
    let mut root: Value = match existing.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => serde_json::from_str(raw)
            .map_err(|_| format!("Existing {client} configuration is not valid JSON"))?,
        None => json!({}),
    };
    let obj = root
        .as_object_mut()
        .ok_or_else(|| format!("Existing {client} configuration must be a JSON object"))?;

    match client {
        "opencode" => {
            if !obj.contains_key("$schema") {
                obj.insert("$schema".into(), json!("https://opencode.ai/config.json"));
            }
            let mcp = obj
                .entry("mcp")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("opencode.json 'mcp' field must be an object")?;
            let servers = mcp
                .entry("servers")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("opencode.json 'mcp.servers' field must be an object")?;
            let mut entry = json!({
                "type": "remote",
                "url": url,
                "enabled": true,
            });
            if let Some(token) = token {
                entry["headers"] = json!({ "Authorization": format!("Bearer {token}") });
                entry["oauth"] = json!(false);
            }
            servers.insert("kubiki".into(), entry);
        }
        "claude" | "cursor" => {
            let servers = obj
                .entry("mcpServers")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("'mcpServers' field must be an object")?;
            let mut entry = if client == "claude" {
                json!({ "type": "http", "url": url })
            } else {
                json!({ "url": url })
            };
            if let Some(token) = token {
                entry["headers"] = json!({ "Authorization": format!("Bearer {token}") });
            }
            servers.insert("kubiki".into(), entry);
        }
        _ => return Err("Unsupported MCP client".into()),
    }

    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

fn client_config_path(client: &str) -> Result<PathBuf, String> {
    let home = kubiki_core::pod_ops::host_terminal::host_terminal_info()
        .map(|info| PathBuf::from(info.cwd))
        .map_err(|_| "Cannot locate user home directory".to_owned())?;
    match client {
        "opencode" => Ok(home.join(".config").join("opencode").join("opencode.json")),
        "claude" => Ok(home.join(".claude.json")),
        "cursor" => Ok(home.join(".cursor").join("mcp.json")),
        _ => Err("Unsupported MCP client".into()),
    }
}

pub(crate) async fn configure_client_file(
    client: &str,
    url: &str,
    token: Option<&str>,
) -> Result<PathBuf, String> {
    let path = client_config_path(client)?;
    let client_name = client.to_owned();
    let url = url.to_owned();
    let token = token.map(str::to_owned);
    let target_path = path.clone();
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let existing = match std::fs::read_to_string(&target_path) {
            Ok(content) => Some(content),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("Cannot read {}: {e}", target_path.display())),
        };
        let updated =
            merge_client_mcp_config(&client_name, existing.as_deref(), &url, token.as_deref())?;
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
        }
        let temp = target_path.with_extension("kubiki.tmp");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp)
            .map_err(|e| format!("Cannot write {}: {e}", temp.display()))?;
        file.write_all(updated.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Cannot persist {}: {e}", temp.display()))?;
        drop(file);
        std::fs::rename(&temp, &target_path)
            .map_err(|e| format!("Cannot replace {}: {e}", target_path.display()))?;
        Ok(target_path)
    })
    .await
    .map_err(|_| "Client auto-configuration task failed".to_owned())?
}

#[tauri::command]
pub async fn ai_mcp_http_status(
    reveal_token: Option<bool>,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PersistentMcpManager>,
) -> Result<McpHttpStatus, String> {
    manager
        .status(window.app_handle(), reveal_token.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn ai_mcp_http_regenerate_token(
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PersistentMcpManager>,
    agent_manager: tauri::State<'_, crate::agent_commands::AgentManager>,
) -> Result<McpHttpStatus, String> {
    let _gate = agent_manager.settings_gate.lock().await;
    let settings = crate::agent_commands::load(window.app_handle()).await?;
    let _ = store_new_token(window.app_handle()).await?;
    manager.reconcile(window.app_handle(), &settings).await?;
    manager.status(window.app_handle(), true).await
}

#[tauri::command]
pub async fn ai_mcp_set_scope(
    scope: AgentScope,
    manager: tauri::State<'_, PersistentMcpManager>,
) -> Result<(), String> {
    manager.set_scope(scope);
    Ok(())
}

#[tauri::command]
pub async fn ai_mcp_auto_configure(
    client: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, PersistentMcpManager>,
    agent_manager: tauri::State<'_, crate::agent_commands::AgentManager>,
) -> Result<AutoConfigureResult, String> {
    let _gate = agent_manager.settings_gate.lock().await;
    let mut settings = crate::agent_commands::load(window.app_handle()).await?;
    if !settings.mcp_server.enabled {
        settings.mcp_server.enabled = true;
        crate::agent_commands::store(window.app_handle(), &settings).await?;
    }
    manager.reconcile(window.app_handle(), &settings).await?;
    let status = manager
        .status(window.app_handle(), settings.mcp_server.require_auth)
        .await?;
    let token = if settings.mcp_server.require_auth {
        status.token.as_deref()
    } else {
        None
    };
    let path = configure_client_file(&client, &status.url, token).await?;
    Ok(AutoConfigureResult {
        client,
        config_path: path.to_string_lossy().into_owned(),
        url: status.url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_opencode_claude_and_cursor_configs_without_clobbering_user_keys() {
        let existing = r#"{"theme":"dark","mcp":{"servers":{"other":{"type":"local","command":["echo"]}}}}"#;
        let merged = merge_client_mcp_config(
            "opencode",
            Some(existing),
            "http://127.0.0.1:3847/mcp",
            None,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["mcp"]["servers"]["other"]["type"], "local");
        assert_eq!(parsed["mcp"]["servers"]["kubiki"]["type"], "remote");
        assert_eq!(
            parsed["mcp"]["servers"]["kubiki"]["url"],
            "http://127.0.0.1:3847/mcp"
        );
        assert!(parsed["mcp"]["servers"]["kubiki"].get("headers").is_none());

        let with_auth = merge_client_mcp_config(
            "opencode",
            Some(&merged),
            "http://127.0.0.1:3847/mcp",
            Some("kubiki_secret_token"),
        )
        .unwrap();
        let parsed_auth: Value = serde_json::from_str(&with_auth).unwrap();
        assert_eq!(
            parsed_auth["mcp"]["servers"]["kubiki"]["headers"]["Authorization"],
            "Bearer kubiki_secret_token"
        );
        assert_eq!(parsed_auth["mcp"]["servers"]["kubiki"]["oauth"], false);

        let claude =
            merge_client_mcp_config("claude", None, "http://127.0.0.1:3847/mcp", None).unwrap();
        let parsed_claude: Value = serde_json::from_str(&claude).unwrap();
        assert_eq!(
            parsed_claude["mcpServers"]["kubiki"]["url"],
            "http://127.0.0.1:3847/mcp"
        );
    }
}
