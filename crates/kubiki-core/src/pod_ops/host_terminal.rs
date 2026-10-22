//! Local shell PTYs. Blocking OS I/O stays off the async runtime; cancellation reaps children.
use crate::{
    core::api::{ApiError, ApiErrorCode},
    pod_ops::terminal::{ExecEvent, ExecMessage, ExecSubscription},
};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};
use tokio::{
    sync::{Mutex, mpsc, watch},
    task::JoinHandle,
};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HostTerminalInfo {
    pub shells: Vec<String>,
    pub default_shell: String,
    pub cwd: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HostTerminalRequest {
    pub shell: Option<String>,
    pub cols: u16,
    pub rows: u16,
}
fn error(status: u16, message: impl Into<String>) -> ApiError {
    ApiError::from_status(status, message, "host_terminal", None)
}
fn internal(message: impl Into<String>) -> ApiError {
    ApiError::new(ApiErrorCode::Internal, message, "host_terminal", None, None)
}
pub fn host_terminal_info() -> Result<HostTerminalInfo, ApiError> {
    let cwd = dirs::home_dir()
        .filter(|p| p.is_dir())
        .ok_or_else(|| internal("Home directory is unavailable"))?;
    #[cfg(unix)]
    let candidates = vec![
        std::env::var("SHELL").unwrap_or_default(),
        "/bin/bash".into(),
        "/bin/zsh".into(),
        "/usr/bin/fish".into(),
        "/bin/sh".into(),
    ];
    #[cfg(windows)]
    let candidates = vec![
        std::env::var("COMSPEC").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into()),
        format!(
            "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())
        ),
    ];
    let mut shells = Vec::new();
    for candidate in candidates {
        if Path::new(&candidate).is_absolute()
            && Path::new(&candidate).is_file()
            && !shells.contains(&candidate)
        {
            shells.push(candidate);
        }
    }
    let default_shell = shells
        .first()
        .cloned()
        .ok_or_else(|| internal("No local shell was found"))?;
    Ok(HostTerminalInfo {
        shells,
        default_shell,
        cwd: cwd.to_string_lossy().into_owned(),
    })
}
fn size(cols: u16, rows: u16) -> Result<PtySize, ApiError> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        Err(error(400, "Terminal size must be between 1 and 1000 cells"))
    } else {
        Ok(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
    }
}
enum Control {
    Input(String),
    Resize(PtySize),
}
struct Session {
    owner: String,
    cancel: Arc<AtomicBool>,
    input: mpsc::Sender<Control>,
    ack: watch::Sender<u64>,
    task: JoinHandle<()>,
}
#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<String, Session>>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for s in self.sessions.get_mut().values() {
            s.cancel.store(true, Ordering::Release);
        }
    }
}
#[derive(Clone, Default)]
pub struct HostTerminalManager {
    inner: Arc<Inner>,
}
impl HostTerminalManager {
    pub async fn start(
        &self,
        owner: &str,
        id: &str,
        request: HostTerminalRequest,
    ) -> Result<ExecSubscription, ApiError> {
        size(request.cols, request.rows)?;
        if id.is_empty()
            || id.len() > 128
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(error(400, "Invalid host terminal session ID"));
        }
        let info = host_terminal_info()?;
        let shell = request
            .shell
            .as_ref()
            .unwrap_or(&info.default_shell)
            .clone();
        if !info.shells.contains(&shell) {
            return Err(error(400, "Choose one of the available local shells"));
        }
        let mut sessions = self.inner.sessions.lock().await;
        let key = format!("{owner}:{id}");
        if sessions.contains_key(&key) {
            return Err(error(409, "Host terminal session already exists"));
        }
        if sessions.len() >= 16 {
            return Err(error(429, "Too many host terminal sessions (limit 16)"));
        }
        let (output, rx) = mpsc::channel(16);
        let (input, controls) = mpsc::channel(16);
        let (ack, acknowledgements) = watch::channel(0);
        let cancel = Arc::new(AtomicBool::new(false));
        let cancellation = cancel.clone();
        let task = tokio::task::spawn_blocking(move || {
            let sequence = Arc::new(AtomicU64::new(0));
            let result = run(
                &request,
                &info,
                &shell,
                controls,
                &output,
                sequence.clone(),
                cancellation.clone(),
            );
            if let Err(error) = result {
                send(
                    &output,
                    &sequence,
                    ExecEvent::Failed { error },
                    &cancellation,
                    None,
                );
            }
        });
        sessions.insert(
            key,
            Session {
                owner: owner.into(),
                cancel,
                input,
                ack,
                task,
            },
        );
        Ok(ExecSubscription {
            output: rx,
            acknowledgements,
        })
    }
    pub async fn write(&self, owner: &str, id: &str, data: String) -> Result<(), ApiError> {
        if data.len() > 65536 {
            return Err(error(400, "Terminal input exceeds 64 KiB"));
        }
        let sessions = self.inner.sessions.lock().await;
        let s = sessions
            .get(&format!("{owner}:{id}"))
            .ok_or_else(|| error(404, "Host terminal is closed"))?;
        s.input
            .try_send(Control::Input(data))
            .map_err(|_| error(429, "Host terminal input is busy or closed"))
    }
    pub async fn resize(
        &self,
        owner: &str,
        id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), ApiError> {
        let size = size(cols, rows)?;
        let sessions = self.inner.sessions.lock().await;
        let s = sessions
            .get(&format!("{owner}:{id}"))
            .ok_or_else(|| error(404, "Host terminal is closed"))?;
        s.input
            .try_send(Control::Resize(size))
            .map_err(|_| error(429, "Host terminal resize queue is busy or closed"))
    }
    pub async fn acknowledge(&self, owner: &str, id: &str, sequence: u64) -> Result<(), ApiError> {
        let sessions = self.inner.sessions.lock().await;
        let s = sessions
            .get(&format!("{owner}:{id}"))
            .ok_or_else(|| error(404, "Host terminal is closed"))?;
        s.ack.send_replace(sequence);
        Ok(())
    }
    pub async fn stop(&self, owner: &str, id: &str) {
        let session = self
            .inner
            .sessions
            .lock()
            .await
            .remove(&format!("{owner}:{id}"));
        if let Some(s) = session {
            s.cancel.store(true, Ordering::Release);
            let _ = s.task.await;
        }
    }
    pub async fn stop_owner(&self, owner: &str) {
        let removed: Vec<_> = {
            let mut sessions = self.inner.sessions.lock().await;
            let keys: Vec<_> = sessions
                .iter()
                .filter(|(_, s)| s.owner == owner)
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter()
                .filter_map(|k| sessions.remove(&k))
                .collect()
        };
        for s in &removed {
            s.cancel.store(true, Ordering::Release);
        }
        for s in removed {
            let _ = s.task.await;
        }
    }
    pub async fn session_count(&self) -> usize {
        self.inner.sessions.lock().await.len()
    }
}
fn send(
    output: &mpsc::Sender<ExecMessage>,
    sequence: &AtomicU64,
    event: ExecEvent,
    cancel: &AtomicBool,
    shutdown: Option<&AtomicBool>,
) -> bool {
    let mut message = ExecMessage {
        sequence: sequence.fetch_add(1, Ordering::AcqRel) + 1,
        event,
    };
    loop {
        if cancel.load(Ordering::Acquire) || shutdown.is_some_and(|s| s.load(Ordering::Acquire)) {
            return false;
        }
        match output.try_send(message) {
            Ok(()) => return true,
            Err(mpsc::error::TrySendError::Closed(_)) => return false,
            Err(mpsc::error::TrySendError::Full(m)) => message = m,
        }
        thread::sleep(Duration::from_millis(5));
    }
}
struct Process {
    child: Box<dyn Child + Send + Sync>,
    master: Option<Arc<StdMutex<Box<dyn MasterPty + Send>>>>,
    shutdown: Arc<AtomicBool>,
    reaped: bool,
    workers: Vec<thread::JoinHandle<()>>,
}
impl Drop for Process {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        if !self.reaped {
            #[cfg(unix)]
            if let Some(pid) = self.child.process_id() {
                // portable-pty creates a new session. Only signal groups of this unreaped child.
                let foreground = self
                    .master
                    .as_ref()
                    .and_then(|m| m.lock().ok())
                    .and_then(|m| m.process_group_leader());
                unsafe {
                    if let Some(group) = foreground {
                        if group > 0 && group != pid as i32 {
                            let session = libc::getsid(group);
                            // Some systems may deny getsid across sessions. The group
                            // was obtained from our own PTY, so EPERM is safe here too.
                            if session == pid as i32
                                || (session == -1
                                    && std::io::Error::last_os_error().raw_os_error()
                                        == Some(libc::EPERM))
                            {
                                libc::kill(-group, libc::SIGKILL);
                                // Let the shell reap its foreground job before killing
                                // the shell itself, rather than leaving an orphan zombie.
                                for _ in 0..20 {
                                    if libc::kill(-group, 0) == -1 {
                                        break;
                                    }
                                    thread::sleep(Duration::from_millis(10));
                                }
                            }
                        }
                    }
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
        // Unix workers use O_NONBLOCK and observe shutdown even under backpressure.
        // Join them to close every duplicated master fd before waiting for the child.
        // On macOS a dying session leader can wait for unread PTY output to drain;
        // retaining the master while stopping its reader deadlocks waitpid().
        #[cfg(unix)]
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
        #[cfg(unix)]
        self.master.take();
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
            self.reaped = true;
        }
        // ConPTY uses blocking I/O; close it after terminating the child.
        #[cfg(windows)]
        {
            self.master.take();
            self.workers.clear();
        }
    }
}
fn run(
    request: &HostTerminalRequest,
    info: &HostTerminalInfo,
    shell: &str,
    mut controls: mpsc::Receiver<Control>,
    output: &mpsc::Sender<ExecMessage>,
    sequence: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
) -> Result<(), ApiError> {
    if cancel.load(Ordering::Acquire) {
        return Ok(());
    }
    let pair = native_pty_system()
        .openpty(size(request.cols, request.rows)?)
        .map_err(|e| internal(format!("Cannot create local PTY: {e}")))?;
    #[cfg(unix)]
    {
        let fd = pair
            .master
            .as_raw_fd()
            .ok_or_else(|| internal("PTY has no file descriptor"))?;
        let result = unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 {
                -1
            } else {
                libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK)
            }
        };
        if result < 0 {
            return Err(internal(std::io::Error::last_os_error().to_string()));
        }
    }
    let mut command = CommandBuilder::new(shell);
    command.cwd(&info.cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    #[cfg(unix)]
    {
        command.arg("-l");
        command.arg("-i");
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| internal(format!("Cannot launch local shell: {e}")))?;
    drop(pair.slave);
    let shutdown = Arc::new(AtomicBool::new(false));
    let exited = Arc::new(AtomicBool::new(false));
    let mut process = Process {
        child,
        master: Some(Arc::new(StdMutex::new(pair.master))),
        shutdown: shutdown.clone(),
        reaped: false,
        workers: Vec::new(),
    };
    // Keep the sole strong reference in Process, including on setup errors.
    let master = process.master.as_ref().unwrap();
    let mut reader = master
        .lock()
        .unwrap()
        .try_clone_reader()
        .map_err(|e| internal(e.to_string()))?;
    let mut writer = master
        .lock()
        .unwrap()
        .take_writer()
        .map_err(|e| internal(e.to_string()))?;
    if !send(output, &sequence, ExecEvent::Started, &cancel, None) {
        return Ok(());
    }
    let (events, rx) = std::sync::mpsc::channel();
    let out = output.clone();
    let stop = shutdown.clone();
    let cancellation = cancel.clone();
    let reader_events = events.clone();
    let has_exited = exited.clone();
    let read_sequence = sequence.clone();
    let worker = thread::Builder::new()
        .name("kubiki-pty-read".into())
        .spawn(move || {
            let mut buffer = [0; 8192];
            loop {
                if stop.load(Ordering::Acquire) || cancellation.load(Ordering::Acquire) {
                    break;
                }
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !send(
                            &out,
                            &read_sequence,
                            ExecEvent::Output {
                                data: buffer[..n].to_vec(),
                            },
                            &cancellation,
                            Some(&stop),
                        ) {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if stop.load(Ordering::Acquire)
                            || cancellation.load(Ordering::Acquire)
                            || has_exited.load(Ordering::Acquire)
                        {
                            break;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    #[cfg(windows)]
                    Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => break,
                    #[cfg(unix)]
                    Err(e) if e.raw_os_error() == Some(libc::EIO) => break,
                    Err(e) => {
                        let _ = reader_events
                            .send(Err(internal(format!("Host terminal read failed: {e}"))));
                        break;
                    }
                }
            }
            let _ = reader_events.send(Ok(()));
        })
        .map_err(|e| internal(e.to_string()))?;
    process.workers.push(worker);
    let stop = shutdown.clone();
    let cancellation = cancel.clone();
    let input_events = events.clone();
    let resize_master = Arc::downgrade(process.master.as_ref().unwrap());
    let worker = thread::Builder::new()
        .name("kubiki-pty-write".into())
        .spawn(move || {
            loop {
                if stop.load(Ordering::Acquire) || cancellation.load(Ordering::Acquire) {
                    break;
                }
                let control = match controls.try_recv() {
                    Ok(c) => c,
                    Err(mpsc::error::TryRecvError::Empty) => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(_) => break,
                };
                let result = match control {
                    Control::Resize(size) => resize_master
                        .upgrade()
                        .ok_or_else(|| internal("Host PTY is closed"))
                        .and_then(|master| {
                            master
                                .lock()
                                .unwrap()
                                .resize(size)
                                .map_err(|e| internal(e.to_string()))
                        }),
                    Control::Input(data) => {
                        let mut bytes = data.as_bytes();
                        let mut result = Ok(());
                        while !bytes.is_empty()
                            && !stop.load(Ordering::Acquire)
                            && !cancellation.load(Ordering::Acquire)
                        {
                            match writer.write(bytes) {
                                Ok(0) => {
                                    result = Err(internal("Host terminal input closed"));
                                    break;
                                }
                                Ok(n) => bytes = &bytes[n..],
                                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                    thread::sleep(Duration::from_millis(10))
                                }
                                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                                Err(e) => {
                                    result = Err(internal(e.to_string()));
                                    break;
                                }
                            }
                        }
                        result
                    }
                };
                if let Err(error) = result {
                    let _ = input_events.send(Err(error));
                    break;
                }
            }
        })
        .map_err(|e| internal(e.to_string()))?;
    process.workers.push(worker);
    let mut status = None;
    let mut reader_done = false;
    loop {
        if cancel.load(Ordering::Acquire) || output.is_closed() {
            return Ok(());
        }
        if status.is_none() {
            if let Some(exit) = process
                .child
                .try_wait()
                .map_err(|e| internal(e.to_string()))?
            {
                process.reaped = true;
                status = Some(exit);
                exited.store(true, Ordering::Release);
            }
        }
        match rx.try_recv() {
            Ok(Ok(())) => reader_done = true,
            Ok(Err(error)) => return Err(error),
            Err(_) => {}
        }
        #[cfg(windows)]
        if status.is_some() {
            // Close ConPTY while the reader still drains final output; resize only holds a Weak.
            process.master.take();
        }
        if let (Some(status), true) = (&status, reader_done) {
            let code = status.exit_code() as i32;
            drop(process);
            send(output, &sequence, ExecEvent::Exited { code }, &cancel, None);
            return Ok(());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use portable_pty::{ChildKiller, ExitStatus};
    use std::sync::Weak;

    #[derive(Clone, Debug)]
    struct DrainSensitiveChild {
        master: Weak<StdMutex<Box<dyn MasterPty + Send>>>,
        worker_finished: Arc<AtomicBool>,
    }
    impl ChildKiller for DrainSensitiveChild {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }
    impl Child for DrainSensitiveChild {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            Ok(None)
        }
        fn wait(&mut self) -> std::io::Result<ExitStatus> {
            // Model macOS's waitpid dependency without hanging the test runner.
            assert!(
                self.worker_finished.load(Ordering::Acquire),
                "PTY I/O handles must close before wait"
            );
            assert!(
                self.master.upgrade().is_none(),
                "PTY master must close before wait"
            );
            Ok(ExitStatus::with_exit_code(0))
        }
        fn process_id(&self) -> Option<u32> {
            None
        }
    }

    #[test]
    fn cancellation_closes_all_pty_handles_before_waiting_for_child() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let master = Arc::new(StdMutex::new(pair.master));
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_finished = Arc::new(AtomicBool::new(false));
        let child = DrainSensitiveChild {
            master: Arc::downgrade(&master),
            worker_finished: worker_finished.clone(),
        };
        let stop = shutdown.clone();
        let worker = thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(1));
            }
            drop((reader, writer));
            worker_finished.store(true, Ordering::Release);
        });
        drop(Process {
            child: Box::new(child),
            master: Some(master),
            shutdown,
            reaped: false,
            workers: vec![worker],
        });
    }
}
