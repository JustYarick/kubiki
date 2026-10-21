//! Legacy read-only CLI helpers. All mutations use PreparedHelmMutation and trusted consent.
use crate::core::error::KubikiError;
use crate::helm::model::{HelmRelease, HelmReleaseHistory, HelmRepo};
use tokio::process::Command;

pub struct HelmClient;

impl HelmClient {
    /// List all Helm releases across all or specific namespace
    pub async fn list_releases(namespace: Option<&str>) -> Result<Vec<HelmRelease>, KubikiError> {
        let mut cmd = Command::new("helm");
        cmd.arg("list").arg("-o").arg("json");

        if let Some(ns) = namespace {
            if ns == "all" {
                cmd.arg("-A");
            } else {
                cmd.arg("-n").arg(ns);
            }
        } else {
            cmd.arg("-A");
        }

        let output = cmd.output().await.map_err(|e| {
            KubikiError::Internal(format!(
                "Failed to execute 'helm list': {e}. Ensure helm binary is in PATH."
            ))
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(KubikiError::Internal(format!(
                "Helm command failed: {stderr}"
            )));
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        if json_str.trim().is_empty() {
            return Ok(Vec::new());
        }

        let releases: Vec<HelmRelease> = serde_json::from_str(&json_str)
            .map_err(|e| KubikiError::Internal(format!("Failed to parse Helm JSON output: {e}")))?;

        Ok(releases)
    }

    /// Retrieve the revision history of a release
    pub async fn get_history(
        release_name: &str,
        namespace: &str,
    ) -> Result<Vec<HelmReleaseHistory>, KubikiError> {
        let output = Command::new("helm")
            .arg("history")
            .arg(release_name)
            .arg("-n")
            .arg(namespace)
            .arg("-o")
            .arg("json")
            .output()
            .await
            .map_err(|e| KubikiError::Internal(format!("Failed to execute 'helm history': {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(KubikiError::Internal(format!(
                "Helm history failed: {stderr}"
            )));
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        let history: Vec<HelmReleaseHistory> = serde_json::from_str(&json_str).map_err(|e| {
            KubikiError::Internal(format!("Failed to parse Helm history JSON: {e}"))
        })?;

        Ok(history)
    }

    /// List configured Helm chart repositories
    pub async fn list_repositories() -> Result<Vec<HelmRepo>, KubikiError> {
        let output = Command::new("helm")
            .arg("repo")
            .arg("list")
            .arg("-o")
            .arg("json")
            .output()
            .await
            .map_err(|e| {
                KubikiError::Internal(format!("Failed to execute 'helm repo list': {e}"))
            })?;

        if !output.status.success() {
            // If no repos are added, helm repo list exits with status 1
            return Ok(Vec::new());
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        let repos: Vec<HelmRepo> = serde_json::from_str(&json_str).unwrap_or_default();
        Ok(repos)
    }

    /// Retrieve user values.yaml of an installed release
    pub async fn get_values(name: &str, namespace: &str) -> Result<String, KubikiError> {
        let output = Command::new("helm")
            .arg("get")
            .arg("values")
            .arg(name)
            .arg("-n")
            .arg(namespace)
            .arg("-o")
            .arg("yaml")
            .output()
            .await
            .map_err(|e| {
                KubikiError::Internal(format!("Failed to execute 'helm get values': {e}"))
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(KubikiError::Internal(format!(
                "Failed to get Helm values: {stderr}"
            )));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}
