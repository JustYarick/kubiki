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
    pub providers: Vec<ProviderProfile>,
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub options: GenerationOptions,
    pub policy: AgentPolicy,
    pub instructions: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    settings: AiSettings,
    credentials: HashMap<String, bool>,
}

struct ManagedSession {
    session: Session,
    provider: ProviderProfile,
    model: String,
    options: GenerationOptions,
    instructions: String,
    client: Option<kube::Client>,
}

#[derive(Clone)]
pub struct AgentManager {
    sessions: Arc<Mutex<HashMap<String, Arc<ManagedSession>>>>,
    settings_gate: Arc<AsyncMutex<()>>,
    runs: Arc<Semaphore>,
}
impl Default for AgentManager {
    fn default() -> Self {
        Self {
            sessions: Arc::default(),
            settings_gate: Arc::default(),
            runs: Arc::new(Semaphore::new(2)),
        }
    }
}
impl AgentManager {
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
    fn invalidate(&self) {
        if let Ok(sessions) = self.sessions.lock() {
            for s in sessions.values() {
                s.session.invalidate();
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

async fn load(app: &tauri::AppHandle) -> Result<AiSettings, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "Cannot locate AI settings directory")?
        .join("ai.json");
    tokio::task::spawn_blocking(move || match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= 1024 * 1024 => serde_json::from_slice(&bytes).map_err(|_| "AI settings are invalid; restore a valid ai.json in the app configuration directory".to_owned()),
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
    if serde_json::to_value((&before.providers, &before.policy, &before.instructions)).ok()
        != serde_json::to_value((
            &settings.providers,
            &settings.policy,
            &settings.instructions,
        ))
        .ok()
    {
        manager.invalidate();
    }
    store(window.app_handle(), &settings).await
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSession {
    scope: AgentScope,
    provider_id: String,
    model: String,
    options: GenerationOptions,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    id: String,
    scope: AgentScope,
    mode: AgentMode,
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
    let profile = settings
        .providers
        .iter()
        .find(|p| p.id == request.provider_id)
        .ok_or("Configure an AI provider first")?
        .clone();
    let client = if request.scope.context.is_empty() {
        None
    } else {
        Some(
            tokio::time::timeout(
                std::time::Duration::from_secs(15),
                pool.get_client(&request.scope.context),
            )
            .await
            .map_err(|_| "Cluster connection timed out")?
            .map_err(|_| "Cannot connect this conversation to the selected Kubernetes context")?,
        )
    };
    let id = format!("ai-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let session = Session::new(
        id.clone(),
        window.label().into(),
        request.scope.clone(),
        settings.policy.clone(),
    );
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
            provider: profile,
            model: request.model,
            options: request.options,
            instructions: settings.instructions,
            client,
        }),
    );
    Ok(SessionView {
        id,
        scope: request.scope,
        mode: AgentMode::ReadOnly,
        policy: settings.policy,
    })
}

#[tauri::command]
pub fn ai_set_mode(
    session_id: String,
    mode: AgentMode,
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, AgentManager>,
) -> Result<(), String> {
    manager.get(&session_id, window.label())?.session.mode(mode)
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
    let journal = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate AI operation journal")?
        .join("ai/operations.jsonl");
    let host = Arc::new(crate::agent_tools::KubernetesTools {
        window,
        client: managed.client.clone(),
        journal,
    });
    let session = managed.session.clone();
    let emit: EventSink = Arc::new(move |event| {
        if on_event.send(event).is_err() {
            session.stop();
        }
    });
    run(
        managed.session.clone(),
        revision,
        provider,
        managed.model.clone(),
        managed.options.clone(),
        managed.instructions.clone(),
        message,
        host,
        emit,
    )
    .await
}
