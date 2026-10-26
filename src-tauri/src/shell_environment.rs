//! Finder-launched applications do not inherit the user's terminal PATH.
//! Recover it before Tauri (and its worker threads) starts, including kubeconfig
//! credential helpers as well as Helm. Never execute Helm through a shell.
#[cfg(any(target_os = "macos", all(test, unix)))]
mod recovery {
    use std::{
        ffi::{OsStr, OsString},
        path::Path,
        process::Stdio,
        time::Duration,
    };
    use tokio::{io::AsyncReadExt, process::Command};

    pub fn merge_path(shell: Option<&OsStr>, inherited: Option<&OsStr>) -> OsString {
        let mut paths = Vec::new();
        for source in [shell, inherited].into_iter().flatten() {
            for path in std::env::split_paths(source) {
                // Empty or relative entries search the working directory.
                if path.is_absolute() && !paths.contains(&path) {
                    paths.push(path);
                }
            }
        }
        for path in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            let path = path.into();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
        std::env::join_paths(paths).expect("PATH entries cannot contain separators")
    }

    pub fn parse_path(output: &[u8]) -> Option<OsString> {
        use std::os::unix::ffi::OsStrExt;
        // Startup files may print banners. Only consume our delimited value.
        let marker = b"\0KUBIKI_PATH\0";
        let start = output
            .windows(marker.len())
            .position(|bytes| bytes == marker)?
            + marker.len();
        let end = start + output[start..].iter().position(|byte| *byte == 0)?;
        (end > start).then(|| OsStr::from_bytes(&output[start..end]).to_os_string())
    }

    pub async fn shell_path(shell: &Path, timeout: Duration) -> Option<OsString> {
        let mut child = Command::new(shell)
            .args(["-ilc", "printf '\\0KUBIKI_PATH\\0%s\\0' \"$PATH\""])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let stdout = child.stdout.take()?;
        let task = async {
            let mut output = Vec::new();
            let mut stream = stdout.take(65537);
            let (read, status) = tokio::join!(stream.read_to_end(&mut output), child.wait());
            read.ok()?;
            if !status.ok()?.success() || output.len() > 65536 {
                return None;
            }
            parse_path(&output)
        };
        tokio::time::timeout(timeout, task).await.ok().flatten()
    }
}

/// Call on the main thread, before initializing the application runtime.
#[cfg(target_os = "macos")]
pub fn initialize() {
    use std::{path::PathBuf, time::Duration};
    let shell = std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file())
        .unwrap_or_else(|| "/bin/zsh".into());
    let shell_path = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()
        .and_then(|runtime| runtime.block_on(recovery::shell_path(&shell, Duration::from_secs(3))));
    let path = recovery::merge_path(shell_path.as_deref(), std::env::var_os("PATH").as_deref());
    // SAFETY: called before Tauri or any application worker threads are started;
    // the temporary single-threaded runtime has already been dropped.
    unsafe {
        std::env::set_var("PATH", path);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn initialize() {}

#[cfg(all(test, unix))]
mod tests {
    use super::recovery::*;
    use std::{
        ffi::OsStr,
        path::{Path, PathBuf},
        time::Duration,
    };

    #[test]
    fn preserves_terminal_precedence_and_homebrew_fallbacks() {
        let path = merge_path(
            Some(OsStr::new("/custom/bin:/usr/bin:/custom/bin")),
            Some(OsStr::new("/usr/bin:/inherited/bin::relative")),
        );
        let paths: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(
            &paths[..3],
            &[
                PathBuf::from("/custom/bin"),
                "/usr/bin".into(),
                "/inherited/bin".into()
            ]
        );
        assert!(paths.contains(&"/opt/homebrew/bin".into()));
        assert!(paths.contains(&"/usr/local/bin".into()));
        assert!(paths.iter().all(|path| path.is_absolute()));
    }

    #[test]
    fn ignores_banners_and_rejects_missing_or_truncated_values() {
        assert_eq!(
            parse_path(b"Welcome!\n\0KUBIKI_PATH\0/a path/bin:/bin\0bye"),
            Some("/a path/bin:/bin".into())
        );
        assert_eq!(parse_path(b"/bin"), None);
        assert_eq!(parse_path(b"\0KUBIKI_PATH\0/bin"), None);
        assert_eq!(parse_path(b"\0KUBIKI_PATH\0\0"), None);
    }

    #[tokio::test]
    async fn reads_a_real_shell_without_modifying_the_test_environment() {
        let path = shell_path(Path::new("/bin/bash"), Duration::from_secs(3))
            .await
            .unwrap();
        assert!(std::env::split_paths(&path).any(|path| path == Path::new("/usr/bin")));
    }

    #[tokio::test]
    async fn missing_shell_falls_back_without_failing_startup() {
        assert!(
            shell_path(
                Path::new("/nonexistent/kubiki-shell"),
                Duration::from_millis(50)
            )
            .await
            .is_none()
        );
        assert!(
            std::env::split_paths(&merge_path(None, None))
                .any(|path| path == Path::new("/opt/homebrew/bin"))
        );
    }

    #[tokio::test]
    async fn stalled_startup_is_bounded_and_recovered_path_can_launch_a_tool() {
        use std::os::unix::fs::PermissionsExt;
        let folder = std::env::temp_dir().join(format!(
            "kubiki-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        let shell = folder.join("shell");
        let helm = folder.join("helm");
        std::fs::write(&shell, "#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
        std::fs::write(&helm, "#!/bin/sh\nprintf 'helm-found'\n").unwrap();
        for file in [&shell, &helm] {
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let started = std::time::Instant::now();
        assert!(
            shell_path(&shell, Duration::from_millis(50))
                .await
                .is_none()
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        let path = merge_path(Some(folder.as_os_str()), Some(OsStr::new("/usr/bin:/bin")));
        let result = tokio::process::Command::new("helm")
            .env("PATH", path)
            .output()
            .await
            .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout, b"helm-found");
        std::fs::remove_dir_all(folder).unwrap();
    }
}
