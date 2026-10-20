//! Linux graphics policy, applied once before GTK/WebKit or worker threads start.
//! DMABUF is a presentation path, not a promise that all rendering uses the GPU.
use std::{env, fmt::Write, path::Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GraphicsMode {
    Auto,
    Compatibility,
    System,
}
impl GraphicsMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "auto" => Ok(Self::Auto),
            "compatibility" => Ok(Self::Compatibility),
            "system" => Ok(Self::System),
            _ => Err("Graphics mode must be auto, compatibility or system".into()),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Compatibility => "compatibility",
            Self::System => "system",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Options {
    pub mode: GraphicsMode,
    pub source: &'static str,
    pub report_only: bool,
}
impl Options {
    pub fn parse(args: &[String], preference: Option<&str>) -> Result<Self, String> {
        let mut mode = None;
        let mut report_only = false;
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            if arg == "--graphics-info" {
                report_only = true;
            } else if arg == "--graphics" {
                mode = Some(GraphicsMode::parse(
                    args.next().ok_or("Missing --graphics mode")?,
                )?);
            } else if let Some(value) = arg.strip_prefix("--graphics=") {
                mode = Some(GraphicsMode::parse(value)?);
            }
        }
        let (mode, source) = if let Some(mode) = mode {
            (mode, "command line")
        } else if let Some(preference) = preference {
            (GraphicsMode::parse(preference)?, "KUBIKI_GRAPHICS_MODE")
        } else {
            (GraphicsMode::Auto, "default")
        };
        Ok(Self {
            mode,
            source,
            report_only,
        })
    }
}

/** Pure policy: inherited overrides win in Auto/System; Compatibility explicitly selects the old path. */
fn overrides(
    mode: GraphicsMode,
    nvidia: bool,
    wayland: bool,
    explicit_sync: bool,
) -> Vec<(&'static str, &'static str)> {
    let mut values = Vec::new();
    if mode == GraphicsMode::Compatibility {
        values.push(("WEBKIT_DISABLE_DMABUF_RENDERER", "1"));
    }
    if mode != GraphicsMode::System && nvidia && wayland && !explicit_sync {
        // Tauri's first NVIDIA/Wayland workaround retains the faster DMABUF path.
        values.push(("__NV_DISABLE_EXPLICIT_SYNC", "1"));
    }
    values
}

fn nvidia_present(drm: &Path) -> bool {
    std::fs::read_dir(drm).is_ok_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            std::fs::read_to_string(entry.path().join("device/vendor"))
                .is_ok_and(|vendor| vendor.trim().eq_ignore_ascii_case("0x10de"))
        })
    })
}
fn wayland_backend(gdk: Option<&str>, display: bool, session: Option<&str>) -> bool {
    // An explicit X11 backend must not be misreported as native Wayland.
    if let Some(gdk) = gdk {
        return gdk.split(',').next() == Some("wayland");
    }
    display || session == Some("wayland")
}

pub struct Startup {
    pub options: Options,
    pub report: String,
}

/// Called as the first operation in run(), before the Tauri/GTK runtime exists.
pub fn initialize() -> Result<Startup, String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let preference = env::var("KUBIKI_GRAPHICS_MODE").map_err(|error| match error {
        env::VarError::NotPresent => None,
        _ => Some("KUBIKI_GRAPHICS_MODE is not valid UTF-8".to_owned()),
    });
    let preference = match preference {
        Ok(value) => Some(value),
        Err(None) => None,
        Err(Some(error)) => return Err(error),
    };
    let options = Options::parse(&args, preference.as_deref())?;
    let nvidia = nvidia_present(Path::new("/sys/class/drm"));
    let wayland = wayland_backend(
        env::var("GDK_BACKEND").ok().as_deref(),
        env::var_os("WAYLAND_DISPLAY").is_some(),
        env::var("XDG_SESSION_TYPE").ok().as_deref(),
    );
    let changes = overrides(
        options.mode,
        nvidia,
        wayland,
        env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_some(),
    );
    for (key, value) in &changes {
        // SAFETY: this module is called once at process entry, before GTK or Tokio starts threads.
        unsafe {
            env::set_var(key, value);
        }
    }
    let mut report = format!(
        "Kubiki graphics\nBuild: {}\nMode: {} ({})\nNVIDIA DRM device detected: {nvidia}\nWayland backend candidate: {wayland}\n",
        if cfg!(debug_assertions) {
            "development/debug"
        } else {
            "release"
        },
        options.mode.name(),
        options.source
    );
    for key in [
        "GDK_BACKEND",
        "XDG_SESSION_TYPE",
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "__NV_DISABLE_EXPLICIT_SYNC",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
        "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
        "LIBGL_ALWAYS_SOFTWARE",
        "GDK_SCALE",
        "GDK_DPI_SCALE",
    ] {
        let value = env::var_os(key)
            .map(|value| format!("{:?}", value.to_string_lossy()))
            .unwrap_or_else(|| "unset".into());
        let origin = if changes.iter().any(|(changed, _)| *changed == key) {
            "set by Kubiki"
        } else {
            "inherited"
        };
        let _ = writeln!(report, "{key}: {value} ({origin})");
    }
    report.push_str("WebKit chooses the actual renderer; this report describes startup policy only.\nCompatibility: --graphics=compatibility. System defaults: --graphics=system.\n");
    Ok(Startup { options, report })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }
    #[test]
    fn default_and_cli_take_precedence_without_silent_invalid_fallback() {
        assert_eq!(Options::parse(&[], None).unwrap().mode, GraphicsMode::Auto);
        assert_eq!(
            Options::parse(&[], Some("compatibility")).unwrap().mode,
            GraphicsMode::Compatibility
        );
        assert_eq!(
            Options::parse(
                &args(&["--graphics=system", "--graphics-info"]),
                Some("bad")
            )
            .unwrap(),
            Options {
                mode: GraphicsMode::System,
                source: "command line",
                report_only: true
            }
        );
        assert_eq!(
            Options::parse(&args(&["--graphics", "compatibility"]), None)
                .unwrap()
                .mode,
            GraphicsMode::Compatibility
        );
        for arguments in [args(&["--graphics"]), args(&["--graphics=bad"])] {
            assert!(Options::parse(&arguments, None).is_err());
        }
        assert!(Options::parse(&[], Some("bad")).is_err());
    }
    #[test]
    fn auto_keeps_dmabuf_and_only_adds_nvidia_wayland_sync_workaround() {
        assert_eq!(
            overrides(GraphicsMode::Auto, true, true, false),
            vec![("__NV_DISABLE_EXPLICIT_SYNC", "1")]
        );
        for (nvidia, wayland) in [(false, true), (true, false), (false, false)] {
            assert!(overrides(GraphicsMode::Auto, nvidia, wayland, false).is_empty());
        }
        assert!(overrides(GraphicsMode::Auto, true, true, true).is_empty());
        assert!(overrides(GraphicsMode::System, true, true, false).is_empty());
    }
    #[test]
    fn compatibility_is_explicit_and_does_not_disable_compositing_or_select_software() {
        assert_eq!(
            overrides(GraphicsMode::Compatibility, true, true, false),
            vec![
                ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
                ("__NV_DISABLE_EXPLICIT_SYNC", "1")
            ]
        );
        assert_eq!(
            overrides(GraphicsMode::Compatibility, false, false, false),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
    }
    #[test]
    fn respects_explicit_backend_and_detects_vendor_without_external_commands() {
        assert!(!wayland_backend(Some("x11"), true, Some("wayland")));
        assert!(wayland_backend(None, true, None));
        assert!(wayland_backend(Some("wayland,x11"), false, None));
        let root = env::temp_dir().join(format!("kubiki-graphics-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("card0/device")).unwrap();
        std::fs::write(root.join("card0/device/vendor"), "0x1002\n").unwrap();
        assert!(!nvidia_present(&root));
        std::fs::write(root.join("card0/device/vendor"), "0x10de\n").unwrap();
        assert!(nvidia_present(&root));
        std::fs::remove_dir_all(root).unwrap();
        assert!(!nvidia_present(Path::new("/nonexistent-kubiki-drm")));
    }
}
