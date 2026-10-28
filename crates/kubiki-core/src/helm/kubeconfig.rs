use crate::{cluster::kubeconfig::KubeConfigManager, core::api::ApiError};
use std::{
    fs::{DirBuilder, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A private copy pins the selected, merged configuration for the entire operation,
/// including the time a mutation spends awaiting confirmation.
pub(super) struct HelmKubeconfig {
    directory: PathBuf,
    pub path: PathBuf,
}

impl HelmKubeconfig {
    pub fn new(manager: &KubeConfigManager) -> Result<Self, ApiError> {
        let failure = || {
            ApiError::from_status(
                500,
                "Cannot prepare the selected kubeconfig for Helm",
                "helm",
                None,
            )
        };
        // read_config resolves source-relative certificate/key/token paths before merging.
        let config = manager
            .read_config()
            .map_err(|error| ApiError::from_core(error, "helm", None))?;
        let yaml = serde_yaml::to_string(&config).map_err(|_| failure())?;
        let directory = std::env::temp_dir().join(format!(
            "kubiki-helm-config-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        let mut builder = DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory).map_err(|_| failure())?;
        let snapshot = Self {
            path: directory.join("config"),
            directory,
        };
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&snapshot.path)
            .and_then(|mut file| file.write_all(yaml.as_bytes()))
            .map_err(|_| failure())?;
        Ok(snapshot)
    }
}

impl Drop for HelmKubeconfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
