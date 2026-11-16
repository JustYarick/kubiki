//! Safe detection and argv-only launch of the user's system default terminal emulator.
use kubiki_core::pod_ops::host_terminal::HostProcess;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::{Child, Command};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemTerminal {
    pub label: String,
    pub executable: PathBuf,
    pub kind: TerminalKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum TerminalKind {
    Ghostty,
    Kitty,
    Alacritty,
    WezTerm,
    Foot,
    Ptyxis,
    GnomeTerminal,
    Konsole,
    Xfce4Terminal,
    XdgTerminalExec,
    XTerm,
    MacApp,
    WindowsTerminal,
    WindowsShell,
}

impl TerminalKind {
    fn from_name(name: &str) -> Self {
        let lower = name.to_ascii_lowercase();
        let base = lower.strip_suffix(".exe").unwrap_or(&lower);
        match base {
            "ghostty" => Self::Ghostty,
            "kitty" => Self::Kitty,
            "alacritty" => Self::Alacritty,
            "wezterm" | "wezterm-gui" => Self::WezTerm,
            "foot" | "footclient" => Self::Foot,
            "ptyxis" => Self::Ptyxis,
            "gnome-terminal" => Self::GnomeTerminal,
            "konsole" => Self::Konsole,
            "xfce4-terminal" => Self::Xfce4Terminal,
            "xdg-terminal-exec" => Self::XdgTerminalExec,
            "wt" => Self::WindowsTerminal,
            "powershell" | "pwsh" | "cmd" => Self::WindowsShell,
            _ => Self::XTerm,
        }
    }
}

pub fn validate_executable_spec(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if trimmed.len() > 4096
        || trimmed.contains(['\n', '\r', '\0'])
        || (!Path::new(trimmed).is_absolute()
            && trimmed.contains([' ', '\t', ';', '&', '|', '$', '`', '<', '>', '(', ')']))
    {
        return Err("Use a terminal binary name or absolute executable path".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() && path.components().count() > 1 {
        return Err("Use an absolute terminal executable path".into());
    }
    Ok(())
}

pub fn resolve_binary(value: &str, search_path: &OsStr) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return path.is_file().then(|| path.to_path_buf());
    }
    if path.components().count() > 1
        || trimmed.contains([' ', '\t', ';', '&', '|', '$', '`', '<', '>', '(', ')', '\n', '\r'])
    {
        return None;
    }
    std::env::split_paths(search_path)
        .map(|dir| dir.join(trimmed))
        .find(|candidate| candidate.is_file())
}

#[cfg(target_os = "linux")]
async fn probe_command_stdout(program: &str, args: &[&str], search_path: &OsStr) -> Option<String> {
    let bin = resolve_binary(program, search_path)?;
    let output = tokio::time::timeout(
        std::time::Duration::from_millis(800),
        Command::new(bin)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!text.is_empty()).then_some(text)
}

#[cfg(target_os = "linux")]
fn build_linux_terminal(path: PathBuf) -> SystemTerminal {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("terminal")
        .to_owned();
    let kind = TerminalKind::from_name(&name);
    SystemTerminal {
        label: name,
        executable: path,
        kind,
    }
}

#[cfg(target_os = "linux")]
pub async fn detect_system_terminal(
    override_exec: &str,
    search_path: &OsStr,
) -> Result<SystemTerminal, String> {
    validate_executable_spec(override_exec)?;
    let trimmed = override_exec.trim();
    if !trimmed.is_empty() {
        let resolved = resolve_binary(trimmed, search_path)
            .ok_or_else(|| format!("Configured terminal '{trimmed}' was not found"))?;
        return Ok(build_linux_terminal(resolved));
    }

    if let Ok(env_term) = std::env::var("TERMINAL") {
        if let Some(resolved) = resolve_binary(&env_term, search_path) {
            return Ok(build_linux_terminal(resolved));
        }
    }

    if let Some(resolved) = resolve_binary("xdg-terminal-exec", search_path) {
        return Ok(build_linux_terminal(resolved));
    }

    if let Some(raw) = probe_command_stdout(
        "gsettings",
        &["get", "org.gnome.desktop.default-applications.terminal", "exec"],
        search_path,
    )
    .await
    {
        let candidate = raw.trim_matches('\'').trim();
        if let Some(resolved) = resolve_binary(candidate, search_path) {
            return Ok(build_linux_terminal(resolved));
        }
    }

    for kread in ["kreadconfig6", "kreadconfig5"] {
        if let Some(candidate) = probe_command_stdout(
            kread,
            &["--group", "General", "--key", "TerminalApplication"],
            search_path,
        )
        .await
        {
            if let Some(resolved) = resolve_binary(&candidate, search_path) {
                return Ok(build_linux_terminal(resolved));
            }
        }
    }

    if let Some(resolved) = resolve_binary("x-terminal-emulator", search_path) {
        return Ok(build_linux_terminal(resolved));
    }

    for candidate in [
        "ghostty",
        "kitty",
        "alacritty",
        "wezterm",
        "foot",
        "ptyxis",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "xterm",
    ] {
        if let Some(resolved) = resolve_binary(candidate, search_path) {
            return Ok(build_linux_terminal(resolved));
        }
    }

    Err("No system terminal emulator was found. Install a terminal or set its executable in AI settings.".into())
}

#[cfg(target_os = "macos")]
pub async fn detect_system_terminal(
    override_exec: &str,
    search_path: &OsStr,
) -> Result<SystemTerminal, String> {
    validate_executable_spec(override_exec)?;
    let trimmed = override_exec.trim();
    if !trimmed.is_empty() {
        let path = Path::new(trimmed);
        if path.is_absolute() && path.exists() {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Terminal")
                .to_owned();
            let kind = if trimmed.ends_with(".app") {
                TerminalKind::MacApp
            } else {
                TerminalKind::from_name(&name)
            };
            return Ok(SystemTerminal {
                label: name,
                executable: path.to_path_buf(),
                kind,
            });
        }
        if let Some(resolved) = resolve_binary(trimmed, search_path) {
            return Ok(SystemTerminal {
                label: resolved
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("terminal")
                    .to_owned(),
                kind: TerminalKind::from_name(trimmed),
                executable: resolved,
            });
        }
        return Err(format!("Configured terminal '{trimmed}' was not found"));
    }

    let home_apps = dirs::home_dir().map(|h| h.join("Applications"));
    for app_name in [
        "Ghostty.app",
        "iTerm.app",
        "WezTerm.app",
        "Alacritty.app",
        "kitty.app",
    ] {
        for base in [
            Some(PathBuf::from("/Applications")),
            home_apps.clone(),
        ]
        .into_iter()
        .flatten()
        {
            let bundle = base.join(app_name);
            if bundle.is_dir() {
                return Ok(SystemTerminal {
                    label: app_name.trim_end_matches(".app").to_owned(),
                    executable: bundle,
                    kind: TerminalKind::MacApp,
                });
            }
        }
    }

    let terminal_app = PathBuf::from("/System/Applications/Utilities/Terminal.app");
    if terminal_app.is_dir() {
        return Ok(SystemTerminal {
            label: "Terminal".into(),
            executable: terminal_app,
            kind: TerminalKind::MacApp,
        });
    }

    Err("No macOS terminal application was found".into())
}

#[cfg(target_os = "windows")]
pub async fn detect_system_terminal(
    override_exec: &str,
    search_path: &OsStr,
) -> Result<SystemTerminal, String> {
    validate_executable_spec(override_exec)?;
    let trimmed = override_exec.trim();
    if !trimmed.is_empty() {
        let resolved = resolve_binary(trimmed, search_path)
            .ok_or_else(|| format!("Configured terminal '{trimmed}' was not found"))?;
        let name = resolved
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("terminal")
            .to_owned();
        return Ok(SystemTerminal {
            kind: TerminalKind::from_name(&name),
            label: name,
            executable: resolved,
        });
    }
    for candidate in ["wt.exe", "pwsh.exe", "powershell.exe", "cmd.exe"] {
        if let Some(resolved) = resolve_binary(candidate, search_path) {
            return Ok(SystemTerminal {
                label: candidate.to_owned(),
                kind: TerminalKind::from_name(candidate),
                executable: resolved,
            });
        }
    }
    Err("No Windows terminal executable was found".into())
}

/// Build literal argv for Unix desktop terminal emulators without shell string interpolation.
pub fn terminal_argv(kind: TerminalKind, cwd: &Path, program: &Path, args: &[String]) -> Vec<String> {
    let cwd_str = cwd.to_string_lossy().into_owned();
    let prog_str = program.to_string_lossy().into_owned();
    let mut argv = match kind {
        TerminalKind::Ghostty => vec![format!("--working-directory={cwd_str}"), "-e".into()],
        TerminalKind::Kitty => vec!["--directory".into(), cwd_str, "--".into()],
        TerminalKind::Alacritty => vec!["--working-directory".into(), cwd_str, "-e".into()],
        TerminalKind::WezTerm => vec!["start".into(), "--cwd".into(), cwd_str, "--".into()],
        TerminalKind::Foot | TerminalKind::Ptyxis => {
            vec![format!("--working-directory={cwd_str}"), "--".into()]
        }
        TerminalKind::GnomeTerminal => vec!["--working-directory".into(), cwd_str, "--".into()],
        TerminalKind::Konsole => vec!["--workdir".into(), cwd_str, "-e".into()],
        TerminalKind::Xfce4Terminal => vec!["--working-directory".into(), cwd_str, "-x".into()],
        TerminalKind::XdgTerminalExec => vec![],
        TerminalKind::XTerm => vec!["-e".into()],
        TerminalKind::WindowsTerminal => vec!["-d".into(), cwd_str],
        TerminalKind::MacApp | TerminalKind::WindowsShell => vec![],
    };
    if kind == TerminalKind::Foot {
        // foot takes `--working-directory=<dir> <cmd> <args...>` directly (no `--`).
        argv.pop();
    }
    argv.push(prog_str);
    argv.extend(args.iter().cloned());
    argv
}

#[cfg(any(target_os = "macos", test))]
pub fn posix_shell_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

pub fn spawn_in_system_terminal(
    terminal: &SystemTerminal,
    process: HostProcess,
) -> Result<Child, String> {
    let cwd = process.cwd.clone();
    let wrapped = process.with_shell_environment().map_err(|e| e.message)?;

    #[cfg(target_os = "macos")]
    if terminal.kind == TerminalKind::MacApp {
        let app_name = terminal
            .executable
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let direct_kind = match app_name {
            "Ghostty.app" => Some(TerminalKind::Ghostty),
            "WezTerm.app" => Some(TerminalKind::WezTerm),
            "Alacritty.app" => Some(TerminalKind::Alacritty),
            "kitty.app" => Some(TerminalKind::Kitty),
            _ => None,
        };
        let mut cmd = Command::new("/usr/bin/open");
        if let Some(kind) = direct_kind {
            cmd.arg("-na").arg(&terminal.executable).arg("--args");
            cmd.args(terminal_argv(kind, &cwd, &wrapped.program, &wrapped.args));
        } else {
            use std::os::unix::fs::PermissionsExt;
            let script = std::env::temp_dir().join(format!(
                "kubiki-launch-{}-{}.command",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            let mut parts = vec![posix_shell_quote(&wrapped.program.to_string_lossy())];
            parts.extend(wrapped.args.iter().map(|a| posix_shell_quote(a)));
            let content = format!(
                "#!/bin/sh\nrm -f -- \"$0\"\ncd -- {} || exit 1\nexec {}\n",
                posix_shell_quote(&cwd.to_string_lossy()),
                parts.join(" ")
            );
            std::fs::write(&script, content).map_err(|e| e.to_string())?;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            cmd.arg("-a").arg(&terminal.executable).arg(&script);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        return cmd
            .spawn()
            .map_err(|e| format!("Failed to launch {}: {e}", terminal.label));
    }

    #[cfg(target_os = "windows")]
    if terminal.kind == TerminalKind::WindowsShell {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/C", "start", "", "/D"])
            .arg(&cwd)
            .arg(&wrapped.program)
            .args(&wrapped.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        return cmd
            .spawn()
            .map_err(|e| format!("Failed to launch {}: {e}", terminal.label));
    }

    let argv = terminal_argv(terminal.kind, &cwd, &wrapped.program, &wrapped.args);
    let mut cmd = Command::new(&terminal.executable);
    cmd.current_dir(&cwd)
        .args(&argv)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in &wrapped.environment {
        cmd.env(k, v);
    }
    cmd.spawn()
        .map_err(|e| format!("Failed to launch {}: {e}", terminal.label))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_shell_metacharacters_and_relative_paths_in_terminal_override() {
        assert!(validate_executable_spec("ghostty").is_ok());
        assert!(validate_executable_spec("/usr/bin/ghostty").is_ok());
        assert!(validate_executable_spec("ghostty; rm -rf /").is_err());
        assert!(validate_executable_spec("./ghostty").is_err());
        assert!(validate_executable_spec("ghostty\n--command").is_err());
        assert!(resolve_binary("ghostty; echo bad", OsStr::new("/usr/bin")).is_none());
    }

    #[test]
    fn terminal_argv_preserves_literal_arguments_without_shell_interpolation() {
        let cwd = Path::new("/tmp/kubiki workspace");
        let prog = Path::new("/usr/bin/zsh");
        let args = vec![
            "-l".into(),
            "-i".into(),
            "-c".into(),
            "cd -- \"$1\" && shift && exec \"$@\"".into(),
            "kubiki-agent".into(),
            cwd.to_string_lossy().into_owned(),
            "/usr/local/bin/opencode".into(),
            "--prompt".into(),
            "$(echo BAD); 'quoted'".into(),
        ];

        let ghostty = terminal_argv(TerminalKind::Ghostty, cwd, prog, &args);
        assert_eq!(ghostty[0], "--working-directory=/tmp/kubiki workspace");
        assert_eq!(ghostty[1], "-e");
        assert_eq!(ghostty[2], "/usr/bin/zsh");
        assert_eq!(ghostty.last().unwrap(), "$(echo BAD); 'quoted'");

        let kitty = terminal_argv(TerminalKind::Kitty, cwd, prog, &args);
        assert_eq!(&kitty[..3], &["--directory", "/tmp/kubiki workspace", "--"]);

        let xfce = terminal_argv(TerminalKind::Xfce4Terminal, cwd, prog, &args);
        assert_eq!(xfce[2], "-x");

        let foot = terminal_argv(TerminalKind::Foot, cwd, prog, &args);
        assert_eq!(foot[0], "--working-directory=/tmp/kubiki workspace");
        assert_eq!(foot[1], "/usr/bin/zsh");
    }

    #[test]
    fn posix_shell_quote_neutralizes_special_characters() {
        assert_eq!(
            posix_shell_quote("a'b $(rm -rf) ; \"c\""),
            "'a'\\''b $(rm -rf) ; \"c\"'"
        );
    }
}
