//! A single private stdio broker owns the controller and its per-extension hosts.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri::{Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex as AsyncMutex, oneshot},
};

type Reply = oneshot::Sender<Result<Value, String>>;
#[derive(Default)]
struct Inner {
    start: AsyncMutex<()>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    child: AsyncMutex<Option<Child>>,
    pending: Mutex<HashMap<String, Reply>>,
    generation: AtomicU64,
}
#[derive(Clone, Default)]
pub struct ExtensionManager(Arc<Inner>);
impl ExtensionManager {
    async fn send(&self, value: &Value) -> Result<(), String> {
        let mut guard = self.0.stdin.lock().await;
        let input = guard.as_mut().ok_or("Extension host is unavailable")?;
        let mut bytes = serde_json::to_vec(value).map_err(|_| "Cannot encode extension request")?;
        if bytes.len() > 30 * 1024 * 1024 {
            return Err("Extension request exceeds size limit".into());
        }
        bytes.push(b'\n');
        tokio::time::timeout(std::time::Duration::from_secs(10), input.write_all(&bytes))
            .await
            .map_err(|_| "Extension host stopped reading requests")?
            .map_err(|e| e.to_string())
    }
    async fn start(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let _guard = self.0.start.lock().await;
        if self.0.stdin.lock().await.is_some() {
            return Ok(());
        }
        let root: PathBuf = if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.kubiki-build")
        } else {
            app.path()
                .resource_dir()
                .map_err(|e| e.to_string())?
                .join("extensions-runtime")
        };
        let data = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("extensions");
        let node = root
            .join("runtime")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        if !node.is_file() || !root.join("extension-host.cjs").is_file() {
            return Err("Extension runtime is missing. Run pnpm desktop:prepare and pnpm extensions:build before desktop development.".into());
        }
        let mut command = Command::new(node);
        command
            .arg(root.join("extension-host.cjs"))
            .arg(data)
            .arg(root.join("extensions"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start extension host: {e}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Extension host stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Extension host stderr unavailable")?;
        *self.0.stdin.lock().await = child.stdin.take();
        *self.0.child.lock().await = Some(child);
        let generation = self.0.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let manager = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                // Limit the buffer even if a defective controller never sends a newline.
                let mut limited = tokio::io::AsyncReadExt::take(&mut reader, 8 * 1024 * 1024);
                match limited.read_until(b'\n', &mut line).await {
                    Ok(0) | Err(_) => break,
                    _ => {}
                }
                if line.len() >= 8 * 1024 * 1024 {
                    break;
                }
                let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                    break;
                };
                if message.get("service").is_some() {
                    let m = manager.clone();
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let id = message["id"].clone();
                        let extension = message["extensionId"].as_str().unwrap_or("").to_owned();
                        let method = message["service"].as_str().unwrap_or("").to_owned();
                        let params = message["params"].clone();
                        let response = if method == "notify" {
                            let _ = app.emit(
                                "extensions-notification",
                                json!({"extensionId":extension,"message":params["message"]}),
                            );
                            Ok(Value::Null)
                        } else {
                            tokio::task::spawn_blocking(move || {
                                credential(&extension, &method, params)
                            })
                            .await
                            .unwrap_or_else(|_| Err("Credential task failed".into()))
                        };
                        let message = match response {
                            Ok(value) => json!({"serviceResult":true,"id":id,"result":value}),
                            Err(error) => json!({"serviceResult":true,"id":id,"error":error}),
                        };
                        let _ = m.send(&message).await;
                    });
                } else if let Some(id) = message["id"].as_str() {
                    let sender = manager.0.pending.lock().ok().and_then(|mut p| p.remove(id));
                    if let Some(sender) = sender {
                        let _ = sender.send(if let Some(error) = message["error"].as_str() {
                            Err(error.to_owned())
                        } else {
                            Ok(message["result"].clone())
                        });
                    }
                }
            }
            let _restart = manager.0.start.lock().await;
            if manager.0.generation.load(Ordering::SeqCst) == generation {
                *manager.0.stdin.lock().await = None;
                if let Some(mut child) = manager.0.child.lock().await.take() {
                    let _ = child.kill().await;
                }
                if let Ok(mut pending) = manager.0.pending.lock() {
                    for (_, sender) in pending.drain() {
                        let _ = sender.send(Err(
                            "Extension controller stopped. Reopen the panel to restart it.".into(),
                        ));
                    }
                }
            }
        });
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!(
                    "Extension controller: {}",
                    line.chars().take(1000).collect::<String>()
                );
            }
        });
        Ok(())
    }
    pub async fn close(&self) {
        let _restart = self.0.start.lock().await;
        let _ = self
            .send(&json!({"id":"shutdown","method":"shutdown","params":{}}))
            .await;
        *self.0.stdin.lock().await = None;
        if let Some(mut child) = self.0.child.lock().await.take() {
            if tokio::time::timeout(std::time::Duration::from_secs(3), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
            }
        }
    }
}
fn credential(extension: &str, method: &str, params: Value) -> Result<Value, String> {
    if extension.len() > 120
        || !extension
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
    {
        return Err("Invalid extension identity".into());
    }
    let key = params["key"].as_str().ok_or("Missing credential key")?;
    if key.len() > 120
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("Invalid credential key".into());
    }
    let entry = keyring::Entry::new(&format!("com.kubiki.extension.{extension}"), key)
        .map_err(|_| "OS credential store unavailable")?;
    match method {
        "secrets.get" => match entry.get_password() {
            Ok(value) => Ok(json!(value)),
            Err(keyring::Error::NoEntry) => Ok(Value::Null),
            Err(_) => Err("OS credential store unavailable".into()),
        },
        "secrets.set" => {
            let value = params["value"].as_str().ok_or("Missing credential")?;
            if value.len() > 65536 {
                return Err("Credential too large".into());
            }
            entry
                .set_password(value)
                .map_err(|_| "Could not save credential")?;
            Ok(Value::Null)
        }
        "secrets.delete" => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(Value::Null),
            Err(_) => Err("Could not delete credential".into()),
        },
        _ => Err("Unsupported credential operation".into()),
    }
}
#[tauri::command]
pub async fn extension_request(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    manager: tauri::State<'_, ExtensionManager>,
    id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    if window.label() != "main" || id.len() > 100 || id.is_empty() {
        return Err("Invalid extension request owner".into());
    }
    const METHODS: &[&str] = &[
        "list",
        "inspect.github",
        "inspect.file",
        "install",
        "enable",
        "restart",
        "logs",
        "rollback",
        "uninstall",
        "view.open",
        "view.close",
        "call",
        "service",
    ];
    if !METHODS.contains(&method.as_str()) {
        return Err("Unsupported extension operation".into());
    }
    manager.start(&app).await?;
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = manager
            .0
            .pending
            .lock()
            .map_err(|_| "Extension request lock failed")?;
        if pending.len() >= 64 || pending.contains_key(&id) {
            return Err("Too many extension requests".into());
        }
        pending.insert(id.clone(), tx);
    }
    if let Err(error) = manager
        .send(&json!({"id":id,"method":method,"params":params}))
        .await
    {
        if let Ok(mut p) = manager.0.pending.lock() {
            p.remove(&id);
        }
        return Err(error);
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(45), rx).await;
    if let Ok(mut pending) = manager.0.pending.lock() {
        pending.remove(&id);
    }
    match result {
        Ok(Ok(reply)) => reply,
        _ => {
            let _ = manager
                .send(&json!({"method":"cancel","params":{"id":id}}))
                .await;
            Err("Extension request timed out or was cancelled".into())
        }
    }
}
#[tauri::command]
pub async fn extension_cancel(
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, ExtensionManager>,
    id: String,
) -> Result<(), String> {
    if window.label() != "main" || id.len() > 100 {
        return Err("Invalid extension request owner".into());
    }
    manager
        .send(&json!({"method":"cancel","params":{"id":id}}))
        .await
}
