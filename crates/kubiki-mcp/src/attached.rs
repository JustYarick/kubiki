//! Local authenticated MCP bridge. The bootstrap never enters model-visible context.
use rmcp::ServiceExt;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[derive(Serialize, Deserialize)]
struct Bootstrap {
    endpoint: String,
    token: String,
}
pub struct AttachedEndpoint {
    pub bootstrap: PathBuf,
    cancel: tokio::sync::watch::Sender<bool>,
}
impl Drop for AttachedEndpoint {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}
#[cfg(unix)]
pub async fn start(server: crate::ClusterServer) -> Result<AttachedEndpoint, String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    // Unix socket path must fit sun_path on macOS as well as Linux.
    let directory = std::env::temp_dir().join(format!("kbm-{}", uuid::Uuid::new_v4().simple()));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .map_err(|e| e.to_string())?;
    let socket = directory.join("m");
    let listener = tokio::net::UnixListener::bind(&socket).map_err(|e| e.to_string())?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let bootstrap = directory.join("connection.json");
    let bytes = serde_json::to_vec(&Bootstrap {
        endpoint: socket.to_string_lossy().into(),
        token: token.clone(),
    })
    .map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&bootstrap)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    let (cancel, mut stopped) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let limits = Arc::new(tokio::sync::Semaphore::new(8));
        loop {
            let result = tokio::select! { biased; _=stopped.changed()=>break, result=listener.accept()=>result };
            let Ok((mut stream, _)) = result else { break };
            let Ok(permit) = limits.clone().try_acquire_owned() else {
                continue;
            };
            let token = token.clone();
            let server = server.clone();
            let mut stop = stopped.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let mut supplied = vec![0; token.len() + 1];
                if !matches!(
                    tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        stream.read_exact(&mut supplied)
                    )
                    .await,
                    Ok(Ok(_))
                ) || supplied != format!("{token}\n").as_bytes()
                {
                    return;
                }
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    server.clone().serve(stream),
                )
                .await;
                if let Ok(Ok(service)) = result {
                    let cancel = service.cancellation_token();
                    tokio::select! { _=stop.changed()=>{server.session.stop();cancel.cancel();}, _=service.waiting()=>{server.session.stop();} }
                }
            });
        }
        server.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    });
    Ok(AttachedEndpoint { bootstrap, cancel })
}
#[cfg(unix)]
pub async fn attach(path: &Path) -> Result<(), String> {
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    if bytes.len() > 8192 {
        return Err("Invalid MCP bootstrap".into());
    }
    let data: Bootstrap = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut stream = tokio::net::UnixStream::connect(&data.endpoint)
        .await
        .map_err(|_| "Kubiki MCP connection is no longer available")?;
    stream
        .write_all(format!("{}\n", data.token).as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let (mut reader, mut writer) = stream.into_split();
    let upstream = async {
        tokio::io::copy(&mut tokio::io::stdin(), &mut writer).await?;
        writer.shutdown().await
    };
    let downstream = async {
        let mut output = tokio::io::stdout();
        tokio::io::copy(&mut reader, &mut output).await?;
        output.flush().await
    };
    tokio::select! { result=upstream=>result.map_err(|e|e.to_string()), result=downstream=>result.map_err(|e|e.to_string()) }
}
#[cfg(windows)]
#[path = "attached_windows.rs"]
mod windows;
#[cfg(windows)]
pub use windows::{attach, start};
