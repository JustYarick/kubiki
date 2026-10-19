use crate::cluster::kubeconfig::KubeConfigManager;
use crate::core::error::KubikiError;
use kube::config::KubeConfigOptions;
use kube::{Client, Config};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClusterVersionInfo {
    pub git_version: String,
    pub major: String,
    pub minor: String,
    pub platform: String,
}

#[derive(Clone, Default)]
pub struct ClusterClientPool {
    clients: Arc<RwLock<HashMap<String, Client>>>,
    config_mgr: KubeConfigManager,
}

impl ClusterClientPool {
    pub fn new(config_mgr: KubeConfigManager) -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            config_mgr,
        }
    }

    /// Load or reuse an existing kube::Client for a specific context
    pub async fn get_client(&self, context: &str) -> Result<Client, KubikiError> {
        // Read lock check
        {
            let map = self.clients.read().await;
            if let Some(client) = map.get(context) {
                return Ok(client.clone());
            }
        }

        // Construct client for context
        let client = self.build_client(context).await?;

        // Write lock store
        let mut map = self.clients.write().await;
        map.insert(context.to_string(), client.clone());
        Ok(client)
    }

    async fn build_client(&self, context: &str) -> Result<Client, KubikiError> {
        let kubeconfig = self.config_mgr.read_config()?;
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
            .map_err(|e| KubikiError::ClusterConnectionFailed {
                context: context.to_string(),
                message: format!("Failed to query apiserver version: {e}"),
            })?;

        Ok(ClusterVersionInfo {
            git_version: version_resp.git_version,
            major: version_resp.major,
            minor: version_resp.minor,
            platform: version_resp.platform,
        })
    }
}
