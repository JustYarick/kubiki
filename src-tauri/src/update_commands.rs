//! Desktop update boundary: trusted stable feed, signed artifacts, shared
//! mutation gate, and awaited session cleanup before invoking the installer.
use crate::mutation_guard::MutationGuard;
use kubiki_core::{
    InformerManager,
    pod_ops::{
        host_terminal::HostTerminalManager, node_debug::NodeDebugManager,
        port_forward::PortForwardManager, terminal::PodTerminalManager,
    },
};
use semver::Version;
use serde::Serialize;
use std::time::Duration;
use tauri::{Manager, ipc::Channel};
use tauri_plugin_updater::{Update, UpdaterExt};

const STABLE_FEED: &str =
    "https://github.com/JustYarick/kubiki/releases/latest/download/latest.json";
const PUBLIC_KEY: Option<&str> = option_env!("KUBIKI_UPDATER_PUBLIC_KEY");

#[derive(Default)]
pub struct DesktopUpdater(tokio::sync::Mutex<PendingUpdate>);

#[derive(Default)]
struct PendingUpdate {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CheckResult {
    Disabled { reason: String },
    UpToDate,
    Available { update: UpdateInfo },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

fn stable_upgrade(current: &Version, candidate: &Version) -> bool {
    candidate.pre.is_empty() && candidate.build.is_empty() && candidate > current
}

fn disabled_reason(app: &tauri::AppHandle) -> Option<String> {
    if cfg!(debug_assertions) {
        return Some("Automatic updates are disabled in development builds.".into());
    }
    if PUBLIC_KEY.is_none_or(|key| key.trim().is_empty()) {
        return Some("This build does not include an update verification key.".into());
    }
    if !app.package_info().version.pre.is_empty() || !app.package_info().version.build.is_empty() {
        return Some("Automatic updates are disabled in preview builds.".into());
    }
    // Package-manager installations must retain their package ownership. Never
    // replace a deb/rpm installation with an AppImage.
    #[cfg(target_os = "linux")]
    if app.env().appimage.is_none() {
        return Some("Update this installation with your package manager, or install the AppImage to use in-app updates.".into());
    }
    None
}

fn require_enabled(app: &tauri::AppHandle) -> Result<(), String> {
    disabled_reason(app).map_or(Ok(()), Err)
}

#[tauri::command]
pub async fn check_app_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopUpdater>,
) -> Result<CheckResult, String> {
    if let Some(reason) = disabled_reason(&app) {
        return Ok(CheckResult::Disabled { reason });
    }
    let mut pending = state
        .0
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    // Keep the selected artifact pinned until the user installs or dismisses it.
    let mut update = app
        .updater_builder()
        .pubkey(PUBLIC_KEY.unwrap_or_default())
        .endpoints(vec![
            STABLE_FEED
                .parse()
                .map_err(|_| "Invalid update endpoint.")?,
        ])
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(15))
        .version_comparator(|current, remote| stable_upgrade(&current, &remote.version))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(update) = &mut update {
        update.timeout = Some(Duration::from_secs(600));
    }
    let result = match &update {
        Some(update) => CheckResult::Available {
            update: UpdateInfo {
                version: update.version.clone(),
                current_version: update.current_version.clone(),
                notes: update.body.clone().unwrap_or_default(),
            },
        },
        None => CheckResult::UpToDate,
    };
    *pending = PendingUpdate {
        update,
        bytes: None,
    };
    Ok(result)
}

#[tauri::command]
pub async fn download_app_update(
    app: tauri::AppHandle,
    version: String,
    on_progress: Channel<DownloadProgress>,
    state: tauri::State<'_, DesktopUpdater>,
) -> Result<(), String> {
    require_enabled(&app)?;
    let mut pending = state
        .0
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    let update = pending
        .update
        .as_ref()
        .filter(|update| update.version == version)
        .ok_or("The selected update has expired. Check for updates again.")?;
    let mut downloaded = 0;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = on_progress.send(DownloadProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // Tauri verifies the signature during download. No bytes are retained on error.
    pending.bytes = Some(bytes);
    Ok(())
}

#[tauri::command]
pub async fn install_app_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    version: String,
    state: tauri::State<'_, DesktopUpdater>,
    mutations: tauri::State<'_, MutationGuard>,
) -> Result<(), String> {
    require_enabled(&app)?;
    let mut pending = state
        .0
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    let update = pending
        .update
        .as_ref()
        .filter(|update| update.version == version)
        .ok_or("The selected update has expired. Check for updates again.")?;
    let bytes = pending
        .bytes
        .as_ref()
        .ok_or("Download the update before installing it.")?;
    let _gate = mutations.acquire_for_update()?;
    let owner = window.label();
    // Window destruction cleanup is asynchronous; it is too late for installers
    // that terminate the process. Await each native manager here instead.
    app.state::<crate::extension_commands::ExtensionManager>()
        .close()
        .await;
    app.state::<InformerManager>().stop_owner(owner).await;
    app.state::<PodTerminalManager>().stop_owner(owner).await;
    app.state::<NodeDebugManager>().stop_owner(owner).await;
    app.state::<HostTerminalManager>().stop_owner(owner).await;
    app.state::<PortForwardManager>().stop_owner(owner).await;
    tracing::info!(version = %update.version, "Installing desktop update");
    update.install(bytes).map_err(|error| {
        tracing::error!(%error, "Desktop update installation failed");
        format!("Installation failed: {error}. Reconnect the cluster to restore sessions before continuing.")
    })?;
    pending.bytes = None;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_new_stable_versions_only() {
        let current = Version::parse("0.1.0").unwrap();
        for version in ["0.1.1", "0.2.0", "1.0.0", "10.0.0"] {
            assert!(
                stable_upgrade(&current, &Version::parse(version).unwrap()),
                "{version}"
            );
        }
        for version in [
            "0.0.9",
            "0.1.0",
            "0.2.0-dev.1",
            "0.2.0-test",
            "1.0.0-alpha",
            "1.0.0-beta.1",
            "1.0.0-rc.1",
            "1.0.0+dev",
        ] {
            assert!(
                !stable_upgrade(&current, &Version::parse(version).unwrap()),
                "{version}"
            );
        }
        assert!(stable_upgrade(
            &Version::parse("1.9.0").unwrap(),
            &Version::parse("1.10.0").unwrap()
        ));
    }
}
