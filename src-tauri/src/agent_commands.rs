use kubiki_ai::*;
use kubiki_core::cluster::client::ClusterClientPool;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri::{Manager, ipc::Channel};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

static SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSettings {
    pub runtime: crate::opencode::AgentRuntime,
    pub opencode: crate::opencode::OpenCodeSettings,
    pub codex: crate::opencode::OpenCodeSettings,
    pub claude: crate::opencode::OpenCodeSettings,
    pub mcp_policy: AgentPolicy,
    pub mcp_phase: AgentPhase,
    pub providers: Vec<ProviderProfile>,
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub options: GenerationOptions,
    pub policy: AgentPolicy,
    pub instructions: String,
    pub environment: kubiki_ai::environment::EnvironmentSettings,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    settings: AiSettings,
    credentials: HashMap<String, bool>,
}

#[cfg(test)]
mod live_policy_tests {
    use super::*;

    #[test]
    fn policy_updates_cancel_current_work_but_keep_the_native_session_and_scope() {
        let manager = AgentManager::default();
        let scope = AgentScope { context: "fixture".into(), namespaces: vec!["apps".into()], all_namespaces: false };
        let session = Session::new("existing".into(), "window".into(), scope.clone(), AgentPolicy::default(), ClusterCapabilities::default());
        let revision = session.control().unwrap().revision;
        let running = session.begin_run(revision).unwrap();
        manager.sessions.lock().unwrap().insert(session.id.clone(), Arc::new(ManagedSession {
            session: session.clone(), conversation: ConversationState::default(),
            provider: ProviderProfile { id:"local".into(),name:"Local".into(),protocol:ProviderProtocol::Ollama,base_url:"http://127.0.0.1:11434".into() },
            model:"fixture".into(), options:GenerationOptions::default(), instructions:String::new(),
            client:None,connection_generation:None,plan_review:Mutex::new(None),
            environment:Arc::new(kubiki_ai::environment::Environment::new(serde_json::Value::Null,vec![])),
        }));
        manager.update_policy(&AgentPolicy { resources:false, ..Default::default() }).unwrap();
        let control = session.control().unwrap();
        assert!(!control.invalidated);
        assert!(!control.policy.resources);
        assert!(control.revision > revision);
        assert!(*session.cancellation().borrow());
        assert_eq!(session.scope, scope);
        drop(running);
        assert!(manager.get("existing", "window").is_ok());
        assert!(session.begin_run(control.revision).is_ok());
    }

    #[test]
    fn external_connections_default_to_plan_and_explicit_denials_survive_loading() {
        let settings = AiSettings::default();
        assert_eq!(settings.mcp_phase, AgentPhase::Plan);
        let configured: AiSettings = serde_json::from_value(serde_json::json!({"mcpPolicy":{"writes":[],"logs":false,"clusterResources":false}})).unwrap();
        let policy = crate::opencode::sanitize_mcp_policy(&configured.mcp_policy);
        assert!(policy.writes.is_empty());
        assert!(!policy.logs);
        assert!(!policy.cluster_resources);
    }
}

struct ManagedSession {
    session: Session,
    conversation: ConversationState,
    provider: ProviderProfile,
    model: String,
    options: GenerationOptions,
    instructions: String,
    client: Option<kube::Client>,
    connection_generation: Option<u64>,
    plan_review: Mutex<Option<PlanReview>>,
    environment: Arc<kubiki_ai::environment::Environment>,
}

#[derive(Clone)]
pub struct AgentManager {
    sessions: Arc<Mutex<HashMap<String, Arc<ManagedSession>>>>,
    pub(crate) settings_gate: Arc<AsyncMutex<()>>,
    runs: Arc<Semaphore>,
    read_permits: Arc<Semaphore>,
}
impl Default for AgentManager {
    fn default() -> Self {
        Self {
            sessions: Arc::default(),
            settings_gate: Arc::default(),
            runs: Arc::new(Semaphore::new(2)),
            read_permits: Arc::new(Semaphore::new(2)),
        }
    }
}
impl AgentManager {
    fn update_policy(&self, policy: &AgentPolicy) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|_| "AI session registry unavailable")?;
        for managed in sessions.values() {
            managed.session.set_policy(policy.clone())?;
            *managed.plan_review.lock().map_err(|_| "Plan review unavailable")? = None;
        }
        Ok(())
    }
    pub fn stop_owner(&self, owner: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|_, s| {
                if s.session.owner == owner {
                    s.session.stop();
                    false
                } else {
                    true
                }
            });
        }
    }
    pub(crate) fn invalidate(&self) {
        if let Ok(sessions) = self.sessions.lock() {
            for s in sessions.values() {
                s.session.invalidate();
                let environment = s.environment.clone();
                tokio::spawn(async move {
                    environment.close().await;
                });
            }
        }
    }
    fn get(&self, id: &str, owner: &str) -> Result<Arc<ManagedSession>, String> {
        self.sessions
            .lock()
            .map_err(|_| "AI session registry lock failed")?
            .get(id)
            .filter(|s| s.session.owner == owner)
            .cloned()
            .ok_or_else(|| "AI conversation is unavailable; start a new one".into())
    }
}

pub(crate) async fn load(app: &tauri::AppHandle) -> Result<AiSettings, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "Cannot locate AI settings directory")?
        .join("ai.json");
    tokio::task::spawn_blocking(move || match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= 1024 * 1024 => {
            let settings: AiSettings = serde_json::from_slice(&bytes).map_err(|_| "AI settings are invalid; restore a valid ai.json in the app configuration directory".to_owned())?;
            settings.policy.validate()?;
            settings.mcp_policy.validate()?;
            settings.opencode.validate()?;
            settings.codex.validate()?;
            settings.claude.validate()?;
            settings.options.validate()?;
            Ok(settings)
        }
        Ok(_) => Err("AI settings file exceeds 1 MiB".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AiSettings::default()),
        Err(_) => Err("Cannot read AI settings".into()),
    }).await.map_err(|_| "AI settings task failed")?
}

async fn store(app: &tauri::AppHandle, settings: &AiSettings) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "Cannot locate AI settings directory")?
        .join("ai.json");
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| "Cannot encode AI settings")?;
    if bytes.len() > 1024 * 1024 {
        return Err("AI settings exceed 1 MiB".into());
    }
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        std::fs::create_dir_all(path.parent().unwrap())
            .map_err(|_| "Cannot create AI settings directory")?;
        let temporary = path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Cannot write AI settings")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot persist AI settings")?;
        drop(file);
        std::fs::rename(temporary, path).map_err(|_| "Cannot replace AI settings")
    })
    .await
    .map_err(|_| "AI settings task failed")?
    .map_err(str::to_owned)
}

async fn credential(id: &str, update: Option<Option<String>>) -> Result<Option<String>, String> {
    let id = id.to_owned();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new("com.kubiki.ai", &id)
            .map_err(|_| "Cannot open the OS credential store")?;
        match update {
            Some(Some(key)) => {
                if key.len() > 8192 || key.contains(['\r', '\n']) {
                    return Err("Invalid API key".into());
                }
                entry
                    .set_password(&key)
                    .map_err(|_| "Cannot save the AI API key in the OS credential store")?;
                Ok(None)
            }
            Some(None) => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err("Cannot remove the AI API key from the OS credential store".into()),
            },
            None => match entry.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err("Cannot read the AI API key from the OS credential store".into()),
            },
        }
    })
    .await
    .map_err(|_| "AI credential task failed")?
}

async fn provider_key(profile: &ProviderProfile) -> Result<String, String> {
    match credential(&profile.id, None).await {
        Ok(key) => Ok(key.unwrap_or_default()),
        Err(_) if kubiki_ai::provider::is_loopback_profile(profile) => Ok(String::new()),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn ai_get_settings(
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<SettingsView, String> {
    let _gate = manager.settings_gate.lock().await;
    let settings = load(window.app_handle()).await?;
    let mut credentials = HashMap::new();
    for provider in &settings.providers {
        // A locked/unavailable keyring does not prevent configuring local providers.
        credentials.insert(
            provider.id.clone(),
            credential(&provider.id, None)
                .await
                .ok()
                .flatten()
                .is_some(),
        );
    }
    Ok(SettingsView {
        settings,
        credentials,
    })
}

#[tauri::command]
pub async fn ai_save_settings(
    settings: AiSettings,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<(), String> {
    settings.policy.validate()?;
    settings.mcp_policy.validate()?;
    settings.opencode.validate()?;
    settings.codex.validate()?;
    settings.claude.validate()?;
    settings.options.validate()?;
    if settings.providers.len() > 30 || settings.instructions.len() > 8000 {
        return Err("At most 30 providers and 8000 bytes of instructions are supported".into());
    }
    let mut ids = std::collections::HashSet::new();
    for profile in &settings.providers {
        kubiki_ai::provider::validate_profile(profile)?;
        if !ids.insert(&profile.id) {
            return Err("Provider IDs must be unique".into());
        }
    }
    if settings
        .default_provider
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
    {
        return Err("Select an existing default provider".into());
    }
    if settings
        .default_model
        .as_ref()
        .is_some_and(|s| s.is_empty() || s.len() > 256)
    {
        return Err("Invalid default model".into());
    }
    let _gate = manager.settings_gate.lock().await;
    let before = load(window.app_handle()).await?;
    // Reusing a key for a new endpoint requires re-entry. A changed URL is never
    // silently allowed to receive credentials saved for another destination.
    for profile in &before.providers {
        if settings
            .providers
            .iter()
            .find(|p| p.id == profile.id)
            .is_none_or(|p| p.base_url != profile.base_url || p.protocol != profile.protocol)
        {
            credential(&profile.id, Some(None)).await?;
        }
    }
    if serde_json::to_value((
        &before.providers,
        &before.instructions,
        &before.environment,
        &before.runtime,
        &before.opencode,
        &before.codex,
        &before.claude,
    ))
    .ok()
        != serde_json::to_value((
            &settings.providers,
            &settings.instructions,
            &settings.environment,
            &settings.runtime,
            &settings.opencode,
            &settings.codex,
            &settings.claude,
        ))
        .ok()
    {
        manager.invalidate();
    }
    store(window.app_handle(), &settings).await?;
    if serde_json::to_value(&before.policy).ok() != serde_json::to_value(&settings.policy).ok() {
        manager.update_policy(&settings.policy)?;
    }
    if before.runtime != settings.runtime
        || before.opencode != settings.opencode
        || before.codex != settings.codex
        || before.claude != settings.claude
    {
        window
            .state::<crate::opencode::OpenCodeManager>()
            .stop_all()
            .await;
    } else if serde_json::to_value((&before.mcp_policy, &before.policy)).ok()
        != serde_json::to_value((&settings.mcp_policy, &settings.policy)).ok()
        || before.mcp_phase != settings.mcp_phase
    {
        window
            .state::<crate::opencode::OpenCodeManager>()
            .update_policy(&settings.mcp_policy, settings.mcp_phase)
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_set_credential(
    provider_id: String,
    api_key: Option<String>,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<(), String> {
    let _gate = manager.settings_gate.lock().await;
    let settings = load(window.app_handle()).await?;
    if !settings.providers.iter().any(|p| p.id == provider_id) {
        return Err("Save the provider endpoint before its API key".into());
    }
    manager.invalidate();
    credential(&provider_id, Some(api_key.filter(|s| !s.is_empty()))).await?;
    Ok(())
}

#[tauri::command]
pub async fn ai_list_models(
    provider_id: String,
    model_id: Option<String>,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<Vec<ModelInfo>, String> {
    let (profile, key) = {
        let _gate = manager.settings_gate.lock().await;
        let settings = load(window.app_handle()).await?;
        let profile = settings
            .providers
            .into_iter()
            .find(|p| p.id == provider_id)
            .ok_or("Unknown AI provider")?;
        let key = provider_key(&profile).await?;
        (profile, key)
    };
    let client = ProviderClient::new(profile, key)?;
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        if let Some(id) = model_id {
            client.model_details(&id).await.map(|model| vec![model])
        } else {
            client.models().await
        }
    })
    .await
    .map_err(|_| "Model discovery timed out")?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSession {
    #[serde(default)]
    intent: AgentIntent,
    scope: AgentScope,
    provider_id: String,
    model: String,
    options: GenerationOptions,
    capabilities: Option<ClusterCapabilities>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    id: String,
    scope: AgentScope,
    mode: AgentMode,
    phase: AgentPhase,
    policy: AgentPolicy,
}

#[tauri::command]
pub async fn ai_create_session(
    request: CreateSession,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
    pool: tauri::State<'_, ClusterClientPool>,
) -> Result<SessionView, String> {
    request.options.validate()?;
    if request.model.is_empty()
        || request.model.len() > 256
        || request.scope.context.len() > 253
        || request.scope.namespaces.len() > 100
        || request.scope.namespaces.iter().any(|s| {
            s.is_empty()
                || s.len() > 63
                || !s
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
    {
        return Err("Invalid AI model or conversation scope".into());
    }
    let _gate = manager.settings_gate.lock().await;
    let settings = load(window.app_handle()).await?;
    if settings.runtime != crate::opencode::AgentRuntime::Kubiki {
        return Err("An external agent is selected in settings".into());
    }
    let profile = settings
        .providers
        .iter()
        .find(|p| p.id == request.provider_id)
        .ok_or("Configure an AI provider first")?
        .clone();
    let connection = if request.scope.context.is_empty() {
        None
    } else {
        Some(
            tokio::time::timeout(
                std::time::Duration::from_secs(15),
                pool.get_client_with_generation(&request.scope.context),
            )
            .await
            .map_err(|_| "Cluster connection timed out")?
            .map_err(|_| "Cannot connect this conversation to the selected Kubernetes context")?,
        )
    };
    let connection_generation = connection.as_ref().map(|(_, generation)| *generation);
    let client = connection.map(|(client, _)| client);
    let mut capabilities = request.capabilities.unwrap_or_default();
    if let Some(ref client) = client {
        capabilities.helm = true;
        if !capabilities.argocd || !capabilities.flux {
            if let Ok(Ok(discovery)) = tokio::time::timeout(
                std::time::Duration::from_secs(4),
                kube::Discovery::new(client.clone())
                    .filter(&[
                        "argoproj.io",
                        "helm.toolkit.fluxcd.io",
                        "kustomize.toolkit.fluxcd.io",
                        "source.toolkit.fluxcd.io",
                    ])
                    .run(),
            )
            .await
            {
                for group in discovery.groups() {
                    let name = group.name();
                    if name == "argoproj.io" {
                        capabilities.argocd = true;
                    }
                    if name.ends_with(".toolkit.fluxcd.io") || name == "fluxcd.io" {
                        capabilities.flux = true;
                    }
                }
            }
        }
    }
    let id = format!("ai-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let mut session = Session::new(
        id.clone(),
        window.label().into(),
        request.scope.clone(),
        settings.policy.clone(),
        capabilities,
    );
    if request.intent == AgentIntent::Investigate && request.options.tool_use == Some(false) {
        return Err("Investigation requires a tool-capable model".into());
    }
    session.intent = request.intent;
    let installed_skills = kubiki_ai::environment::global_skills().await?;
    let environment = Arc::new(kubiki_ai::environment::Environment::new(
        settings.environment.clone(),
        installed_skills,
    ));
    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "AI session registry lock failed")?;
    if sessions.len() >= 50 {
        return Err("Close an AI conversation before creating more (maximum 50)".into());
    }
    sessions.insert(
        id.clone(),
        Arc::new(ManagedSession {
            session,
            conversation: ConversationState::default(),
            provider: profile,
            model: request.model,
            options: request.options,
            instructions: settings.instructions,
            client,
            connection_generation,
            plan_review: Mutex::new(None),
            environment,
        }),
    );
    Ok(SessionView {
        id,
        scope: request.scope,
        mode: AgentMode::Ask,
        phase: AgentPhase::Plan,
        policy: settings.policy,
    })
}

#[tauri::command]
pub fn ai_set_mode(
    session_id: String,
    mode: AgentMode,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<SessionView, String> {
    let managed = manager.get(&session_id, window.label())?;
    managed.session.mode(mode)?;
    let control = managed.session.control()?;
    Ok(SessionView {
        id: session_id,
        scope: managed.session.scope.clone(),
        mode: control.mode,
        phase: control.phase,
        policy: control.policy,
    })
}

#[tauri::command]
pub fn ai_set_phase(
    session_id: String,
    phase: AgentPhase,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<SessionView, String> {
    let managed = manager.get(&session_id, window.label())?;
    managed.session.phase(phase)?;
    let control = managed.session.control()?;
    Ok(SessionView {
        id: session_id,
        scope: managed.session.scope.clone(),
        mode: control.mode,
        phase: control.phase,
        policy: control.policy,
    })
}

#[tauri::command]
pub fn ai_stop(
    session_id: String,
    close: Option<bool>,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<(), String> {
    let managed = manager.get(&session_id, window.label())?;
    managed.session.stop();
    if close == Some(true) {
        manager
            .sessions
            .lock()
            .map_err(|_| "AI registry lock failed")?
            .remove(&session_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_send_message(
    session_id: String,
    message: String,
    on_event: Channel<AgentEvent>,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<(), String> {
    let _permit = manager.runs.clone().try_acquire_owned().map_err(
        |_| "Two AI conversations are already running. Stop one before starting another",
    )?;
    let managed = manager.get(&session_id, window.label())?;
    let revision = managed.session.control()?.revision;
    let key = provider_key(&managed.provider).await?;
    let provider = ProviderClient::new(managed.provider.clone(), key)?;
    let host = tool_host(&managed, window, &manager, revision).await?;
    let session = managed.session.clone();
    let emit: EventSink = Arc::new(move |event| {
        if on_event.send(event).is_err() {
            session.stop();
        }
    });
    let skills = managed.environment.skills.clone();
    let selection = message.clone();
    let skill_instructions = tokio::task::spawn_blocking(move || {
        kubiki_ai::skills::selected_instructions(&skills, &selection)
    })
    .await
    .map_err(|_| "Cannot read selected skill instructions")??;
    let instructions = format!("{}\n{}", managed.instructions, skill_instructions);
    run(
        managed.session.clone(),
        managed.conversation.clone(),
        revision,
        provider,
        managed.model.clone(),
        managed.options.clone(),
        instructions,
        message,
        host,
        emit,
    )
    .await
}

/// Local policy preview. No Kubernetes/provider access and no permission changes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyPreviewRequest {
    policy: AgentPolicy,
    scope: AgentScope,
    target: Target,
    mode: AgentMode,
    phase: AgentPhase,
    operation: Option<WriteOperation>,
}
#[tauri::command]
pub fn ai_preview_policy(request: PolicyPreviewRequest) -> Result<serde_json::Value, String> {
    request.policy.validate()?;
    let builtin = kubiki_core::core::api::resource_type(&request.target.kind)
        .is_some_and(|r| r.group == request.target.group);
    Ok(
        serde_json::json!({"explanation":request.policy.explain_access(request.mode,request.phase,&request.scope,&request.target,builtin,request.operation),"issues":request.policy.validate_rules()}),
    )
}

async fn tool_host(
    managed: &Arc<ManagedSession>,
    window: tauri::WebviewWindow,
    manager: &AgentManager,
    revision: u64,
) -> Result<Arc<crate::agent_tools::IntegratedTools>, String> {
    let journal = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate AI operation journal")?
        .join("ai/operations.jsonl");
    let budget = Arc::new(kubiki_core::core::read_budget::ReadBudget::new(
        128,
        16 * 1024 * 1024,
        4 * 1024 * 1024,
        std::time::Duration::from_secs(180),
    ));
    let read_cache = Arc::new(kubiki_core::core::read_cache::ReadCache::default());
    let pool = window.state::<ClusterClientPool>().inner().clone();
    let invalidated_session = managed.session.clone();
    let callback: Arc<dyn Fn() + Send + Sync> = Arc::new(move || invalidated_session.invalidate());
    let write_rejected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let rejected_signal = write_rejected.clone();
    let guarded_session = managed.session.clone();
    let before_write: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
        let valid = guarded_session.control().is_ok_and(|state| {
            state.active
                && !state.invalidated
                && state.revision == revision
                && state.phase == AgentPhase::Action
                && state.mode != AgentMode::ReadOnly
                && !*guarded_session.cancellation().borrow()
        });
        if !valid {
            rejected_signal.store(true, Ordering::SeqCst);
        }
        valid
    });
    let pinned_client = managed.client.clone().map(|client| {
        let pinned = pool.pin_client(
            client,
            managed.session.scope.context.clone(),
            managed
                .connection_generation
                .expect("cluster sessions have a generation"),
            callback,
            before_write,
        );
        read_cache.wrap(budget.wrap(pinned))
    });
    let cluster = Arc::new(crate::agent_tools::KubernetesTools {
        consent: Arc::new(crate::agent_tools::DesktopConsent(window)),
        pool,
        client: pinned_client,
        connection_generation: managed.connection_generation,
        budget: budget.clone(),
        write_rejected,
        read_permits: manager.read_permits.clone(),
        journal,
        accepted_operations: managed.session.accepted_operations.clone(),
    });
    let mcp = kubiki_mcp::McpExecutor::connect(kubiki_mcp::ClusterServer::new(
        managed.session.clone(),
        cluster.clone(),
        Arc::new(|_| {}),
        false,
    ))
    .await?;
    Ok(Arc::new(crate::agent_tools::IntegratedTools {
        cluster,
        mcp,
        conversation: managed.conversation.clone(),
        environment: managed.environment.clone(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewPlanRequest {
    session_id: String,
    plan_id: String,
    version: u32,
    step_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutePlanRequest {
    session_id: String,
    review_token: String,
}
fn step_call(step: &PlanStep) -> Result<ToolCall, String> {
    let (name,mut arguments)=match step.action {
        PlanAction::Apply=>("apply_manifest",serde_json::json!({"yaml":step.yaml.as_ref().ok_or("Missing plan YAML")?})),
        PlanAction::Scale|PlanAction::Restart|PlanAction::Delete=>{
            let target=step.target.as_ref().ok_or("Missing plan target")?;
            let mut args=serde_json::to_value(target).map_err(|_|"Cannot encode plan target")?;
            if step.action==PlanAction::Scale {args["replicas"]=serde_json::json!(step.replicas.ok_or("Missing planned replica count")?);}
            (match step.action{PlanAction::Scale=>"scale_workload",PlanAction::Restart=>"restart_workload",_=>"delete_resource"},args)
        }
        _=>return Err("Read/manual steps are not executable mutations; complete investigation and propose concrete changes first".into()),
    };
    if let Some(uid) = &step.expected_uid {
        arguments["expectedUid"] = serde_json::json!(uid);
    }
    Ok(ToolCall {
        id: format!(
            "plan-step-{}-{}",
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
            step.id
        ),
        name: name.into(),
        arguments,
    })
}
#[tauri::command]
pub async fn ai_review_plan(
    request: ReviewPlanRequest,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<serde_json::Value, String> {
    if request.step_ids.is_empty() || request.step_ids.len() > 16 {
        return Err("Select 1–16 concrete plan steps".into());
    }
    let _permit = manager
        .runs
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Two AI operations are already running")?;
    let managed = manager.get(&request.session_id, window.label())?;
    let state = managed.session.control()?;
    let _running = managed.session.begin_action(state.revision)?;
    let plan = managed
        .session
        .plans
        .lock()
        .map_err(|_| "Plan registry unavailable")?
        .current(&request.plan_id, request.version)?;
    if plan.session_id != managed.session.id
        || plan.policy_revision != state.policy_revision
        || plan.scope != managed.session.scope
    {
        return Err("Plan scope or policy revision is stale".into());
    }
    if !matches!(plan.status, PlanStatus::Draft | PlanStatus::Ready) {
        return Err("This plan was already attempted; refresh evidence and create a new version before another change".into());
    }
    let selected = request
        .step_ids
        .iter()
        .collect::<std::collections::BTreeSet<_>>();
    if selected.len() != request.step_ids.len()
        || selected
            .iter()
            .any(|id| !plan.steps.iter().any(|s| &s.id == *id))
    {
        return Err("Unknown or duplicate plan step".into());
    }
    let host = tool_host(&managed, window, &manager, state.revision).await?;
    let mut steps = Vec::new();
    let mut previews = Vec::new();
    let mut targets = std::collections::BTreeSet::new();
    for step in plan.steps.iter().filter(|s| selected.contains(&s.id)) {
        if step
            .depends_on
            .iter()
            .chain(&step.depends_on_accepted)
            .any(|id| !selected.contains(id))
        {
            return Err("All dependencies must be selected; manual/read dependencies require a revised plan after investigation".into());
        }
        let call = step_call(step)?;
        let mut cancellation = managed.session.cancellation();
        let (call, target, operation) = tokio::select! {biased; _=cancellation.changed()=>return Err("Plan review cancelled".into()), result=tokio::time::timeout(std::time::Duration::from_secs(20),host.review_plan_call(&managed.session,call))=>result.map_err(|_|"Plan review timed out")??};
        if step.target.as_ref().is_some_and(|t| t != &target) {
            return Err("Plan target differs from the YAML resource; revise the plan".into());
        }
        if !targets.insert(serde_json::to_string(&target).unwrap()) {
            return Err("Use one change per resource in a plan; combine changes or review a subsequent plan".into());
        }
        previews.push(serde_json::json!({"stepId":step.id,"target":target,"operation":operation,"call":call,"risk":step.risk,"verification":step.verification}));
        steps.push(ReviewedStep {
            id: step.id.clone(),
            call,
            target,
            operation,
            depends_on: step.depends_on.clone(),
            depends_on_accepted: step.depends_on_accepted.clone(),
        });
    }
    if managed.session.control()?.revision != state.revision
        || *managed.session.cancellation().borrow()
    {
        return Err("Plan review was cancelled or permissions changed".into());
    }
    let token = format!(
        "review-{}-{}",
        managed.session.id,
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let ready = managed
        .session
        .plans
        .lock()
        .map_err(|_| "Plan registry unavailable")?
        .set_status(&plan.id, plan.version, PlanStatus::Ready)?;
    *managed
        .plan_review
        .lock()
        .map_err(|_| "Plan review unavailable")? = Some(PlanReview {
        token: token.clone(),
        plan_id: plan.id,
        version: plan.version,
        revision: state.revision,
        at: std::time::Instant::now(),
        steps,
    });
    Ok(
        serde_json::json!({"reviewToken":token,"plan":ready,"steps":previews,"expiresInSeconds":300,"executed":false,"mode":state.mode,"warning":"Selected operations only. Ask requires separate native confirmation for each change. No automatic rollback or ambiguous retry."}),
    )
}
#[tauri::command]
pub async fn ai_execute_plan(
    request: ExecutePlanRequest,
    on_event: Channel<AgentEvent>,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<serde_json::Value, String> {
    let _permit = manager
        .runs
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Two AI operations are already running")?;
    let managed = manager.get(&request.session_id, window.label())?;
    let revision = managed.session.control()?.revision;
    let _running = managed.session.begin_action(revision)?;
    let review = PlanReview::consume(
        &mut *managed
            .plan_review
            .lock()
            .map_err(|_| "Plan review unavailable")?,
        &request.review_token,
    )?;
    if review.revision != revision || review.at.elapsed() > std::time::Duration::from_secs(300) {
        return Err("Plan review expired or mode/phase changed; review again".into());
    }
    let host = tool_host(&managed, window, &manager, revision).await?;
    let session = managed.session.clone();
    let emit: EventSink = Arc::new(move |event| {
        if on_event.send(event).is_err() {
            session.stop();
        }
    });
    execute_reviewed_plan(&managed.session, review, host, emit).await
}

#[tauri::command]
pub fn ai_get_evidence(
    session_id: String,
    evidence_id: String,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<serde_json::Value, String> {
    let managed = manager.get(&session_id, window.label())?;
    if managed.session.control()?.invalidated {
        return Err("Session permissions changed; refresh evidence in a new conversation".into());
    }
    let result = managed
        .session
        .evidence
        .lock()
        .map_err(|_| "Evidence unavailable")?
        .get(&evidence_id)?;
    Ok(
        serde_json::json!({"evidenceId":evidence_id,"historical":true,"data":result,"warning":"Previously projected evidence; not fresh verification. Its relevance to a claim still requires review."}),
    )
}

#[tauri::command]
pub async fn ai_test_provider(
    profile: ProviderProfile,
    api_key: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<Vec<ModelInfo>, String> {
    kubiki_ai::provider::validate_profile(&profile)?;
    let key = if let Some(key) = api_key {
        key
    } else {
        let settings = load(window.app_handle()).await?;
        if settings.providers.iter().any(|saved| {
            saved.id == profile.id
                && saved.base_url == profile.base_url
                && saved.protocol == profile.protocol
        }) {
            provider_key(&profile).await?
        } else {
            String::new()
        }
    };
    if key.len() > 8192 || key.contains(['\r', '\n']) {
        return Err("Invalid API key".into());
    }
    let client = ProviderClient::new(profile, key)?;
    tokio::time::timeout(std::time::Duration::from_secs(30), client.models())
        .await
        .map_err(|_| "Connection test timed out")?
}

#[tauri::command]
pub async fn ai_list_skills() -> Result<Vec<kubiki_ai::skills::SkillInfo>, String> {
    kubiki_ai::environment::global_skills().await
}
