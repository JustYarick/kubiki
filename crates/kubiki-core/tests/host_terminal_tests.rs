#![cfg(unix)]
use kubiki_core::pod_ops::{
    host_terminal::{HostTerminalManager, HostTerminalRequest, host_terminal_info},
    terminal::ExecEvent,
};
use std::{path::Path, time::Duration};

struct TempFiles(Vec<std::path::PathBuf>);

impl Drop for TempFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn request() -> HostTerminalRequest {
    HostTerminalRequest {
        shell: Some("/bin/sh".into()),
        cols: 80,
        rows: 24,
    }
}
#[tokio::test]
async fn actual_pty_has_tty_stdin_utf8_resize_cwd_and_exit_code() {
    let manager = HostTerminalManager::default();
    let mut sub = manager.start("main", "tty", request()).await.unwrap();
    let mut bytes = Vec::new();
    let mut last = 0;
    let code=tokio::time::timeout(Duration::from_secs(8),async {
        while let Some(message)=sub.output.recv().await { assert_eq!(message.sequence,last+1);last=message.sequence;match message.event {
            ExecEvent::Started=> { manager.resize("main","tty",100,40).await.unwrap();manager.write("main","tty","test -t 0 && test -t 1 && printf '\\nTTY_OK\\n'; stty size; printf '\\nUTF8:%s\\n' 'привет 🌍'; printf '\\nCWD:%s\\n' \"$PWD\"; exit 7\r".into()).await.unwrap(); },
            ExecEvent::Output{data}=>bytes.extend(data),
            ExecEvent::Exited{code}=>return code,
            ExecEvent::Failed{error}=>panic!("{}",error.message),
        }}panic!("Missing exit event");
    }).await.unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("\nTTY_OK\r\n"), "TTY marker missing");
    assert!(text.contains("40 100"));
    assert!(text.contains("\nUTF8:привет 🌍\r\n"));
    assert!(text.contains(&format!("\nCWD:{}\r\n", host_terminal_info().unwrap().cwd)));
    assert_eq!(code, 7);
    manager.stop_owner("main").await;
    assert_eq!(manager.session_count().await, 0);
}
#[tokio::test]
async fn ctrl_c_interrupts_foreground_job_without_closing_shell_and_sessions_are_independent() {
    let manager = HostTerminalManager::default();
    let mut a = manager.start("main", "a", request()).await.unwrap();
    let mut b = manager.start("main", "b", request()).await.unwrap();
    assert!(matches!(
        a.output.recv().await.unwrap().event,
        ExecEvent::Started
    ));
    assert!(matches!(
        b.output.recv().await.unwrap().event,
        ExecEvent::Started
    ));
    manager
        .write(
            "main",
            "a",
            "printf '\\nSLEEP_STARTED\\n'; sleep 30\r".into(),
        )
        .await
        .unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !String::from_utf8_lossy(&bytes).contains("\nSLEEP_STARTED\r\n") {
            if let ExecEvent::Output { data } = a.output.recv().await.unwrap().event {
                bytes.extend(data);
            }
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(60)).await;
    manager.write("main", "a", "\u{3}".into()).await.unwrap();
    manager
        .write("main", "a", "printf '\\nINTERRUPT_OK\\n'; exit\r".into())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match a.output.recv().await.unwrap().event {
                ExecEvent::Output { data } => bytes.extend(data),
                ExecEvent::Exited { .. } => break,
                ExecEvent::Failed { error } => panic!("{}", error.message),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("\nINTERRUPT_OK\r\n"));
    manager.stop("main", "a").await;
    assert_eq!(manager.session_count().await, 1);
    manager
        .write(
            "main",
            "b",
            "printf '\\nOTHER_SESSION_OK\\n'; exit\r".into(),
        )
        .await
        .unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match b.output.recv().await.unwrap().event {
                ExecEvent::Output { data } => bytes.extend(data),
                ExecEvent::Exited { .. } => break,
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("\nOTHER_SESSION_OK\r\n"));
    manager.stop_owner("main").await;
}
#[tokio::test]
async fn cancel_reaps_shell_and_foreground_process_and_respects_window_ownership() {
    let base = std::env::temp_dir().join(format!(
        "kubiki-host-terminal-cancel-{}",
        std::process::id()
    ));
    let script = base.with_extension("sh");
    let pids = base.with_extension("pids");
    let _cleanup = TempFiles(vec![script.clone(), pids.clone()]);
    std::fs::write(&script, "printf '%s\\n' \"$$\" >> \"$1\"\nexec sleep 30\n").unwrap();
    let _ = std::fs::remove_file(&pids);

    let manager = HostTerminalManager::default();
    let mut sub = manager.start("main", "tty", request()).await.unwrap();
    assert!(matches!(
        sub.output.recv().await.unwrap().event,
        ExecEvent::Started
    ));
    let quoted_pids = shell_quote(&pids);
    let quoted_script = shell_quote(&script);
    manager
        .write(
            "main",
            "tty",
            format!(
                "set -m; printf '%s\\n' \"$$\" > {quoted_pids}; sh {quoted_script} {quoted_pids}\r"
            ),
        )
        .await
        .unwrap();

    // Read process IDs from a file instead of parsing terminal output: login
    // shells buffer/build prompts differently across platforms, while the
    // foreground child still gets its own process group under `set -m`.
    let (shell, job) = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            while sub.output.try_recv().is_ok() {}
            if let Ok(text) = std::fs::read_to_string(&pids) {
                let ids: Vec<i32> = text
                    .lines()
                    .filter_map(|line| line.trim().parse::<i32>().ok())
                    .collect();
                if let [shell, job, ..] = ids.as_slice() {
                    return (*shell, *job);
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("The shell and its foreground child must start within 15 seconds");
    tokio::time::sleep(Duration::from_millis(60)).await;
    manager.stop("foreign", "tty").await;
    assert_eq!(manager.session_count().await, 1);
    assert_eq!(
        manager
            .write("foreign", "tty", "exit\r".into())
            .await
            .unwrap_err()
            .status,
        Some(404)
    );
    tokio::time::timeout(Duration::from_secs(10), manager.stop_owner("main"))
        .await
        .expect("Stopping the shell and foreground job must finish within 10 seconds");
    assert_eq!(manager.session_count().await, 0);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if unsafe { libc::kill(shell, 0) } == -1 && unsafe { libc::kill(job, 0) } == -1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!("Shell {shell} or foreground job {job} still exists after cancellation")
    });
}
#[tokio::test]
async fn cancellation_is_bounded_with_a_full_output_queue_and_invalid_requests_do_not_spawn() {
    let manager = HostTerminalManager::default();
    let mut req = request();
    req.cols = 0;
    assert_eq!(
        manager
            .start("main", "bad", req)
            .await
            .err()
            .unwrap()
            .status,
        Some(400)
    );
    let mut req = request();
    req.shell = Some("/does/not/exist".into());
    assert_eq!(
        manager
            .start("main", "bad", req)
            .await
            .err()
            .unwrap()
            .status,
        Some(400)
    );
    let mut sub = manager.start("main", "busy", request()).await.unwrap();
    assert!(matches!(
        sub.output.recv().await.unwrap().event,
        ExecEvent::Started
    ));
    manager
        .write("main", "busy", "yes KUBIKI_BACKPRESSURE\r".into())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while sub.output.len() < sub.output.max_capacity() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("The output queue must be full before testing cancellation");
    assert_eq!(
        manager
            .write("main", "busy", "x".repeat(65537))
            .await
            .unwrap_err()
            .status,
        Some(400)
    );
    assert_eq!(
        manager
            .resize("main", "busy", 0, 24)
            .await
            .unwrap_err()
            .status,
        Some(400)
    );
    tokio::time::timeout(Duration::from_secs(10), manager.stop_owner("main"))
        .await
        .expect("Cancellation must finish even when the output queue is full");
    assert_eq!(manager.session_count().await, 0);
    let _sub = manager.start("main", "pending", request()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), manager.stop_owner("main"))
        .await
        .unwrap();
    assert_eq!(manager.session_count().await, 0);
}
