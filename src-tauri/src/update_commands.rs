//! Desktop update boundary: separate stable/dev feeds, signed artifacts, shared
//! mutation gate, and awaited session cleanup before invoking the installer.
//! macOS, Windows (NSIS/MSI), and Linux AppImage/DEB support verified in-app installation;
//! Linux RPM builds check the same signed release feed in notify-only mode.
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
use tauri::{Manager, ipc::Channel, utils::config::BundleType};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

const STABLE_FEED: &str =
    "https://github.com/JustYarick/kubiki/releases/latest/download/latest.json";
const DEV_FEED: &str =
    "https://github.com/JustYarick/kubiki/releases/download/updates-dev/latest.json";
const RELEASES_BASE_URL: &str = "https://github.com/JustYarick/kubiki/releases/tag";
const PUBLIC_KEY: Option<&str> = option_env!("KUBIKI_UPDATER_PUBLIC_KEY");

#[derive(Default)]
pub struct DesktopUpdater(tokio::sync::Mutex<PendingUpdate>);

#[derive(Default)]
struct PendingUpdate {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateInstallMode {
    Auto,
    NotifyOnly,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: String,
    install_mode: UpdateInstallMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<String>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdateChannel {
    Stable,
    Dev,
}

impl UpdateChannel {
    fn for_version(version: &Version) -> Option<Self> {
        if !version.build.is_empty() {
            return None;
        }
        let pre = version.pre.as_str();
        if pre.is_empty() {
            Some(Self::Stable)
        } else if pre == "dev"
            || pre.strip_prefix("dev.").is_some_and(|number| {
                !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
            })
        {
            Some(Self::Dev)
        } else {
            None
        }
    }

    fn feed(self) -> &'static str {
        match self {
            Self::Stable => STABLE_FEED,
            Self::Dev => DEV_FEED,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LinuxUpdatePolicy {
    AppImageAuto,
    DebPreferAuto,
    NotifyOnly(&'static str),
}

fn classify_linux_bundle(bundle: Option<BundleType>, has_appimage_env: bool) -> LinuxUpdatePolicy {
    if has_appimage_env || matches!(bundle, Some(BundleType::AppImage)) {
        LinuxUpdatePolicy::AppImageAuto
    } else if matches!(bundle, Some(BundleType::Deb)) {
        LinuxUpdatePolicy::DebPreferAuto
    } else if matches!(bundle, Some(BundleType::Rpm)) {
        LinuxUpdatePolicy::NotifyOnly(
            "RPM installations receive update notifications only. Download the new RPM package from the release page or update via your package manager.",
        )
    } else {
        LinuxUpdatePolicy::NotifyOnly(
            "Automatic in-app installation is available for AppImage and DEB packages. Download the new release from the release page.",
        )
    }
}

fn release_page_url(version: &str) -> String {
    let clean = version.trim_start_matches('v');
    format!("{RELEASES_BASE_URL}/v{clean}")
}

#[cfg(target_os = "linux")]
fn linux_manifest_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        _ => "x86_64",
    }
}

fn channel_upgrade(current: &Version, candidate: &Version) -> bool {
    let channel = UpdateChannel::for_version(current);
    channel.is_some() && channel == UpdateChannel::for_version(candidate) && candidate > current
}

fn disabled_reason(app: &tauri::AppHandle) -> Option<String> {
    if cfg!(debug_assertions) {
        return Some("Automatic updates are disabled in development builds.".into());
    }
    if PUBLIC_KEY.is_none_or(|key| key.trim().is_empty()) {
        return Some("This build does not include an update verification key.".into());
    }
    if UpdateChannel::for_version(&app.package_info().version).is_none() {
        return Some("In-app updates support stable and dev versions only. Other preview builds and build metadata are excluded.".into());
    }
    None
}

fn require_auto_install(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(reason) = disabled_reason(app) {
        return Err(reason);
    }
    #[cfg(target_os = "linux")]
    if let LinuxUpdatePolicy::NotifyOnly(notice) = classify_linux_bundle(
        tauri::utils::platform::bundle_type(),
        app.env().appimage.is_some(),
    ) {
        return Err(notice.into());
    }
    Ok(())
}

fn build_updater(
    app: &tauri::AppHandle,
    channel: UpdateChannel,
    target_override: Option<&str>,
) -> Result<Updater, String> {
    let mut builder = app
        .updater_builder()
        .pubkey(PUBLIC_KEY.unwrap_or_default())
        .endpoints(vec![
            channel
                .feed()
                .parse()
                .map_err(|_| "Invalid update endpoint.")?,
        ])
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(15))
        .version_comparator(|current, remote| channel_upgrade(&current, &remote.version));
    if let Some(target) = target_override {
        builder = builder.target(target);
    }
    builder.build().map_err(|e| e.to_string())
}

fn update_info(
    update: &Update,
    install_mode: UpdateInstallMode,
    notice: Option<String>,
) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        install_mode,
        release_url: Some(release_page_url(&update.version)),
        notice,
    }
}

#[tauri::command]
pub async fn check_app_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopUpdater>,
) -> Result<CheckResult, String> {
    if let Some(reason) = disabled_reason(&app) {
        return Ok(CheckResult::Disabled { reason });
    }
    let channel = UpdateChannel::for_version(&app.package_info().version)
        .ok_or("This version has no update channel.")?;
    let mut pending = state
        .0
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;

    #[cfg(target_os = "linux")]
    {
        let arch = linux_manifest_arch();
        let generic_target = format!("linux-{arch}");
        let deb_target = format!("linux-{arch}-deb");
        match classify_linux_bundle(
            tauri::utils::platform::bundle_type(),
            app.env().appimage.is_some(),
        ) {
            LinuxUpdatePolicy::AppImageAuto => {
                let mut update = build_updater(&app, channel, None)?
                    .check()
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(update) = &mut update {
                    update.timeout = Some(Duration::from_secs(600));
                }
                let result = match &update {
                    Some(update) => CheckResult::Available {
                        update: update_info(update, UpdateInstallMode::Auto, None),
                    },
                    None => CheckResult::UpToDate,
                };
                *pending = PendingUpdate {
                    update,
                    bytes: None,
                };
                return Ok(result);
            }
            LinuxUpdatePolicy::DebPreferAuto => {
                match build_updater(&app, channel, Some(&deb_target))?
                    .check()
                    .await
                {
                    Ok(mut update) => {
                        if let Some(update) = &mut update {
                            update.timeout = Some(Duration::from_secs(600));
                        }
                        let result = match &update {
                            Some(update) => CheckResult::Available {
                                update: update_info(update, UpdateInstallMode::Auto, None),
                            },
                            None => CheckResult::UpToDate,
                        };
                        *pending = PendingUpdate {
                            update,
                            bytes: None,
                        };
                        return Ok(result);
                    }
                    Err(
                        tauri_plugin_updater::Error::TargetNotFound(_)
                        | tauri_plugin_updater::Error::TargetsNotFound(_),
                    ) => {
                        let update = build_updater(&app, channel, Some(&generic_target))?
                            .check()
                            .await
                            .map_err(|e| e.to_string())?;
                        *pending = PendingUpdate {
                            update: None,
                            bytes: None,
                        };
                        return Ok(match &update {
                            Some(update) => CheckResult::Available {
                                update: update_info(
                                    update,
                                    UpdateInstallMode::NotifyOnly,
                                    Some("Signed DEB updater metadata is not available for this release. Download the DEB package from the release page.".into()),
                                ),
                            },
                            None => CheckResult::UpToDate,
                        });
                    }
                    Err(e) => return Err(e.to_string()),
                }
            }
            LinuxUpdatePolicy::NotifyOnly(notice) => {
                let update = build_updater(&app, channel, Some(&generic_target))?
                    .check()
                    .await
                    .map_err(|e| e.to_string())?;
                *pending = PendingUpdate {
                    update: None,
                    bytes: None,
                };
                return Ok(match &update {
                    Some(update) => CheckResult::Available {
                        update: update_info(
                            update,
                            UpdateInstallMode::NotifyOnly,
                            Some(notice.into()),
                        ),
                    },
                    None => CheckResult::UpToDate,
                });
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Keep the selected artifact pinned until the user installs or dismisses it.
        let mut update = build_updater(&app, channel, None)?
            .check()
            .await
            .map_err(|e| e.to_string())?;
        if let Some(update) = &mut update {
            update.timeout = Some(Duration::from_secs(600));
        }
        let result = match &update {
            Some(update) => CheckResult::Available {
                update: update_info(update, UpdateInstallMode::Auto, None),
            },
            None => CheckResult::UpToDate,
        };
        *pending = PendingUpdate {
            update,
            bytes: None,
        };
        Ok(result)
    }
}

#[tauri::command]
pub async fn download_app_update(
    app: tauri::AppHandle,
    version: String,
    on_progress: Channel<DownloadProgress>,
    state: tauri::State<'_, DesktopUpdater>,
) -> Result<(), String> {
    require_auto_install(&app)?;
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
    require_auto_install(&app)?;
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
                channel_upgrade(&current, &Version::parse(version).unwrap()),
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
                !channel_upgrade(&current, &Version::parse(version).unwrap()),
                "{version}"
            );
        }
        assert!(channel_upgrade(
            &Version::parse("1.9.0").unwrap(),
            &Version::parse("1.10.0").unwrap()
        ));
    }

    #[test]
    fn dev_updates_stay_in_the_dev_channel_and_compare_numbers_numerically() {
        let current = Version::parse("1.0.0-dev.9").unwrap();
        for version in [
            "1.0.0-dev.10",
            "1.0.0-dev.100",
            "1.0.1-dev.1",
            "2.0.0-dev.1",
        ] {
            assert!(
                channel_upgrade(&current, &Version::parse(version).unwrap()),
                "{version}"
            );
        }
        for version in [
            "0.9.0-dev.100",
            "1.0.0-dev",
            "1.0.0-dev.8",
            "1.0.0-dev.9",
            "1.0.0",
            "2.0.0",
            "2.0.0-alpha.1",
            "2.0.0-rc.1",
            "2.0.0-dev.test",
            "2.0.0-dev.1.2",
            "2.0.0-dev.10+build.1",
        ] {
            assert!(
                !channel_upgrade(&current, &Version::parse(version).unwrap()),
                "{version}"
            );
        }
        assert!(channel_upgrade(
            &Version::parse("1.0.0-dev").unwrap(),
            &current
        ));
    }

    #[test]
    fn unsupported_versions_have_no_channel_and_feeds_are_separate() {
        assert_eq!(
            UpdateChannel::for_version(&Version::parse("1.0.0").unwrap())
                .unwrap()
                .feed(),
            STABLE_FEED
        );
        assert_eq!(
            UpdateChannel::for_version(&Version::parse("1.0.0-dev.1").unwrap())
                .unwrap()
                .feed(),
            DEV_FEED
        );
        assert_ne!(STABLE_FEED, DEV_FEED);
        for version in [
            "1.0.0-rc.1",
            "1.0.0-test",
            "1.0.0+build.1",
            "1.0.0-dev.test",
        ] {
            let current = Version::parse(version).unwrap();
            assert_eq!(UpdateChannel::for_version(&current), None);
            assert!(!channel_upgrade(
                &current,
                &Version::parse("2.0.0").unwrap()
            ));
            assert!(!channel_upgrade(
                &current,
                &Version::parse("2.0.0-dev.1").unwrap()
            ));
        }
    }

    #[test]
    fn linux_bundle_policy_enables_auto_for_appimage_and_deb_and_notify_only_for_rpm() {
        assert_eq!(
            classify_linux_bundle(Some(BundleType::AppImage), false),
            LinuxUpdatePolicy::AppImageAuto
        );
        assert_eq!(
            classify_linux_bundle(None, true),
            LinuxUpdatePolicy::AppImageAuto
        );
        assert_eq!(
            classify_linux_bundle(Some(BundleType::Deb), false),
            LinuxUpdatePolicy::DebPreferAuto
        );
        assert!(matches!(
            classify_linux_bundle(Some(BundleType::Rpm), false),
            LinuxUpdatePolicy::NotifyOnly(msg) if msg.contains("RPM")
        ));
        assert!(matches!(
            classify_linux_bundle(None, false),
            LinuxUpdatePolicy::NotifyOnly(_)
        ));
        assert_eq!(
            release_page_url("1.5.0-dev.42"),
            "https://github.com/JustYarick/kubiki/releases/tag/v1.5.0-dev.42"
        );
        assert_eq!(
            release_page_url("v1.5.0"),
            "https://github.com/JustYarick/kubiki/releases/tag/v1.5.0"
        );
    }
}
