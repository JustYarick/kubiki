use crate::core::error::KubikiError;
use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct KubeContextInfo {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    pub is_current: bool,
}

#[derive(Clone, Debug, Default)]
pub struct KubeConfigManager {
    custom_path: Option<PathBuf>,
}

impl KubeConfigManager {
    pub fn new() -> Self {
        Self { custom_path: None }
    }

    pub fn with_custom_path(path: PathBuf) -> Self {
        Self { custom_path: Some(path) }
    }

    /// Returns the resolved path to kubeconfig file
    pub fn get_config_path(&self) -> Result<PathBuf, KubikiError> {
        if let Some(ref path) = self.custom_path {
            return Ok(path.clone());
        }

        if let Ok(env_path) = std::env::var("KUBECONFIG") {
            let first = env_path.split(':').next().unwrap_or(&env_path);
            let path = PathBuf::from(first);
            if path.exists() {
                return Ok(path);
            }
        }

        let home = dirs::home_dir().ok_or_else(|| {
            KubikiError::KubeconfigError("Could not determine user home directory".into())
        })?;

        let default_path = home.join(".kube").join("config");
        Ok(default_path)
    }

    /// Read and parse kubeconfig
    pub fn read_config(&self) -> Result<Kubeconfig, KubikiError> {
        let path = self.get_config_path()?;
        if !path.exists() {
            return Err(KubikiError::KubeconfigError(format!(
                "Kubeconfig file not found at {}",
                path.display()
            )));
        }

        Kubeconfig::read_from(&path).map_err(|e| {
            KubikiError::KubeconfigError(format!("Failed to parse kubeconfig: {e}"))
        })
    }

    /// List all contexts found in kubeconfig
    pub fn list_contexts(&self) -> Result<Vec<KubeContextInfo>, KubikiError> {
        let config = self.read_config()?;
        let current_context = config.current_context.as_deref().unwrap_or_default();

        let mut contexts = Vec::new();
        for named_context in config.contexts {
            let is_current = named_context.name == current_context;
            let ctx = named_context.context.unwrap_or_default();

            contexts.push(KubeContextInfo {
                name: named_context.name,
                cluster: ctx.cluster,
                user: ctx.user.unwrap_or_default(),
                namespace: ctx.namespace,
                is_current,
            });
        }

        // Sort contexts alphabetically by name
        contexts.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(contexts)
    }

    /// Get current active context name
    pub fn get_current_context(&self) -> Result<Option<String>, KubikiError> {
        let config = self.read_config()?;
        Ok(config.current_context)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_sample_kubeconfig() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: dev-cluster
clusters:
- cluster:
    server: https://127.0.0.1:6443
  name: dev-cluster
contexts:
- context:
    cluster: dev-cluster
    namespace: default
    user: developer
  name: dev-cluster
- context:
    cluster: prod-cluster
    namespace: production
    user: admin
  name: prod-cluster
users:
- name: developer
  user:
    token: fake-token
"#;
        let config: Kubeconfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.current_context.as_deref(), Some("dev-cluster"));
        assert_eq!(config.contexts.len(), 2);
    }
}
