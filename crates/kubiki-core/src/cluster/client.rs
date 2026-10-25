use crate::cluster::kubeconfig::KubeConfigManager;
use crate::core::error::KubikiError;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{OnceCell, RwLock};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClusterVersionInfo {
    pub git_version: String,
    pub major: String,
    pub minor: String,
    pub platform: String,
}

#[derive(Clone)]
struct ClientSlot {
    client: Arc<OnceCell<Client>>,
    fingerprint: u64,
}

#[derive(Clone, Default)]
pub struct ClusterClientPool {
    clients: Arc<RwLock<HashMap<String, ClientSlot>>>,
    config_mgr: KubeConfigManager,
    config_cache: Arc<std::sync::Mutex<Option<(u64, Kubeconfig)>>>,
}

fn context_fingerprint(config: &Kubeconfig, context_name: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    context_name.hash(&mut hasher);
    let named_ctx = config.contexts.iter().find(|c| c.name == context_name);
    if let Some(ctx) = named_ctx {
        if let Ok(json) = serde_json::to_vec(ctx) {
            json.hash(&mut hasher);
        }
        if let Some(c) = &ctx.context {
            if let Some(cluster) = config.clusters.iter().find(|cl| cl.name == c.cluster) {
                if let Ok(json) = serde_json::to_vec(cluster) {
                    json.hash(&mut hasher);
                }
            }
            if let Some(user_name) = &c.user {
                if let Some(user) = config.auth_infos.iter().find(|u| &u.name == user_name) {
                    if let Ok(json) = serde_json::to_vec(user) {
                        json.hash(&mut hasher);
                    }
                }
            }
        }
    }
    hasher.finish()
}

impl ClusterClientPool {
    pub fn new(config_mgr: KubeConfigManager) -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            config_mgr,
            config_cache: Arc::default(),
        }
    }

    /// Invalidate cached client for a specific context
    pub async fn invalidate(&self, context: &str) {
        self.clients.write().await.remove(context);
    }

    /// Invalidate all cached clients
    pub async fn invalidate_all(&self) {
        self.clients.write().await.clear();
    }

    /// Update custom kubeconfig file path and invalidate cached configurations.
    pub fn set_custom_kubeconfig_path(&self, path: Option<std::path::PathBuf>) {
        self.config_mgr.set_custom_path(path);
        if let Ok(mut cache) = self.config_cache.lock() {
            *cache = None;
        }
    }

    /// Access the underlying KubeConfigManager
    pub fn get_config_manager(&self) -> &KubeConfigManager {
        &self.config_mgr
    }

    /// Load or reuse an existing kube::Client for a specific context.
    /// If configuration has changed for this context, a fresh client is constructed.
    pub async fn get_client(&self, context: &str) -> Result<Client, KubikiError> {
        let manager = self.config_mgr.clone();
        let cache = self.config_cache.clone();
        let kubeconfig = tokio::task::spawn_blocking(move || {
            let signature = manager.configuration_signature()?;
            let mut cached = cache
                .lock()
                .map_err(|_| KubikiError::Internal("Kubeconfig cache lock failed".into()))?;
            if let Some((_, config)) = cached
                .as_ref()
                .filter(|(previous, _)| *previous == signature)
            {
                return Ok(config.clone());
            }
            let config = manager.read_config()?;
            *cached = Some((signature, config.clone()));
            Ok::<_, KubikiError>(config)
        })
        .await
        .map_err(|e| KubikiError::Internal(format!("Kubeconfig read task failed: {e}")))??;
        let fp = context_fingerprint(&kubeconfig, context);

        let slot = {
            let guard = self.clients.read().await;
            if let Some(slot) = guard.get(context) {
                if slot.fingerprint == fp {
                    Some(slot.client.clone())
                } else {
                    None
                }
            } else {
                None
            }
        };

        let slot = match slot {
            Some(s) => s,
            None => {
                let mut guard = self.clients.write().await;
                if let Some(existing) = guard.get(context) {
                    if existing.fingerprint == fp {
                        existing.client.clone()
                    } else {
                        let cell = Arc::new(OnceCell::new());
                        guard.insert(
                            context.to_owned(),
                            ClientSlot {
                                client: cell.clone(),
                                fingerprint: fp,
                            },
                        );
                        cell
                    }
                } else {
                    let cell = Arc::new(OnceCell::new());
                    guard.insert(
                        context.to_owned(),
                        ClientSlot {
                            client: cell.clone(),
                            fingerprint: fp,
                        },
                    );
                    cell
                }
            }
        };

        slot.get_or_try_init(|| self.build_client(kubeconfig, context))
            .await
            .cloned()
    }

    async fn build_client(
        &self,
        kubeconfig: Kubeconfig,
        context: &str,
    ) -> Result<Client, KubikiError> {
        let options = KubeConfigOptions {
            context: Some(context.to_string()),
            ..Default::default()
        };

        let config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|e| KubikiError::ClusterConnectionFailed {
                context: context.to_string(),
                message: format!("Failed to create client config: {e}"),
            })?;

        Client::try_from(config).map_err(|e| KubikiError::ClusterConnectionFailed {
            context: context.to_string(),
            message: format!("Failed to build K8s client: {e}"),
        })
    }

    /// Query the cluster's /version endpoint to verify connectivity
    pub async fn check_health(&self, context: &str) -> Result<ClusterVersionInfo, KubikiError> {
        let client = self.get_client(context).await?;
        let version_resp = client
            .apiserver_version()
            .await
            .map_err(KubikiError::from)?;

        Ok(ClusterVersionInfo {
            git_version: version_resp.git_version,
            major: version_resp.major,
            minor: version_resp.minor,
            platform: version_resp.platform,
        })
    }
}
