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
        Self {
            custom_path: Some(path),
        }
    }

    /// Returns the resolved path to kubeconfig file, or first existing path if multiple are configured
    pub fn get_config_path(&self) -> Result<PathBuf, KubikiError> {
        if let Some(ref path) = self.custom_path {
            return Ok(path.clone());
        }

        if let Ok(env_path) = std::env::var("KUBECONFIG") {
            for path in std::env::split_paths(&env_path) {
                if path.exists() {
                    return Ok(path);
                }
            }
        }

        let home = dirs::home_dir().ok_or_else(|| {
            KubikiError::KubeconfigError("Could not determine user home directory".into())
        })?;

        let default_path = home.join(".kube").join("config");
        Ok(default_path)
    }

    /// Metadata of all merged files determines when cached parsing must be refreshed.
    pub(crate) fn configuration_signature(&self) -> Result<u64, KubikiError> {
        use std::hash::{Hash, Hasher};
        let paths = if let Some(path) = &self.custom_path {
            vec![path.clone()]
        } else if let Some(paths) = std::env::var_os("KUBECONFIG").filter(|v| !v.is_empty()) {
            std::env::split_paths(&paths).collect()
        } else {
            vec![self.get_config_path()?]
        };
        let mut signature = std::collections::hash_map::DefaultHasher::new();
        for path in paths {
            path.hash(&mut signature);
            match std::fs::metadata(&path) {
                Ok(metadata) => {
                    metadata.len().hash(&mut signature);
                    metadata.modified().ok().hash(&mut signature);
                }
                Err(error) => error.kind().hash(&mut signature),
            }
        }
        Ok(signature.finish())
    }

    /// Read and parse kubeconfig.
    /// When custom_path is set, reads that single file.
    /// Otherwise, uses kube::config::Kubeconfig::read() which supports merging multiple files from KUBECONFIG.
    pub fn read_config(&self) -> Result<Kubeconfig, KubikiError> {
        if let Some(ref path) = self.custom_path {
            if !path.exists() {
                return Err(KubikiError::KubeconfigError(format!(
                    "Kubeconfig file not found at {}",
                    path.display()
                )));
            }
            Kubeconfig::read_from(path).map_err(|e| {
                KubikiError::KubeconfigError(format!("Failed to parse kubeconfig: {e}"))
            })
        } else {
            Kubeconfig::read().map_err(|e| {
                KubikiError::KubeconfigError(format!("Failed to read kubeconfig: {e}"))
            })
        }
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

    #[test]
    fn test_multi_file_kubeconfig_merges_contexts() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let dir = std::env::temp_dir().join(format!(
            "kubiki-multi-kcfg-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(dir.clone());

        let file_a = dir.join("kcfg_a");
        let file_b = dir.join("kcfg_b");

        let yaml_a = r#"
apiVersion: v1
kind: Config
current-context: audit-a
clusters:
- cluster: { server: "https://127.0.0.1:6443" }
  name: cluster-a
contexts:
- context: { cluster: cluster-a, user: user-a }
  name: audit-a
users:
- name: user-a
  user: { token: "token-a" }
"#;

        let yaml_b = r#"
apiVersion: v1
kind: Config
current-context: audit-b
clusters:
- cluster: { server: "https://127.0.0.1:6444" }
  name: cluster-b
contexts:
- context: { cluster: cluster-b, user: user-b }
  name: audit-b
users:
- name: user-b
  user: { token: "token-b" }
"#;

        std::fs::write(&file_a, yaml_a).unwrap();
        std::fs::write(&file_b, yaml_b).unwrap();

        let joined = std::env::join_paths([&file_a, &file_b]).unwrap();
        unsafe {
            std::env::set_var("KUBECONFIG", joined);
        }

        let mgr = KubeConfigManager::new();
        let contexts = mgr.list_contexts().unwrap();
        let names: Vec<_> = contexts.into_iter().map(|c| c.name).collect();
        assert!(names.contains(&"audit-a".to_string()));
        assert!(names.contains(&"audit-b".to_string()));

        unsafe {
            std::env::remove_var("KUBECONFIG");
        }
    }
}
