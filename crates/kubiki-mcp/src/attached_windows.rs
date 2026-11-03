use super::*;
use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};
pub async fn start(server: crate::ClusterServer) -> Result<AttachedEndpoint, String> {
    let directory = std::env::temp_dir().join(format!("kbm-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let endpoint = format!("\\\\.\\pipe\\kubiki-mcp-{}", uuid::Uuid::new_v4().simple());
    let token = uuid::Uuid::new_v4().simple().to_string();
    let bootstrap = directory.join("connection.json");
    let listener = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&endpoint)
        .map_err(|e| e.to_string())?;
    tokio::fs::write(
        &bootstrap,
        serde_json::to_vec(&Bootstrap {
            endpoint: endpoint.clone(),
            token: token.clone(),
        })
        .map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())?;
    let (cancel, mut stopped) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let mut listener = listener;
        let limits = Arc::new(tokio::sync::Semaphore::new(8));
        loop {
            if tokio::select! {_=stopped.changed()=>break,result=listener.connect()=>result}
                .is_err()
            {
                break;
            }
            let mut stream = listener;
            listener = match ServerOptions::new().create(&endpoint) {
                Ok(next) => next,
                Err(_) => break,
            };
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
                if let Ok(Ok(service)) = tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    server.clone().serve(stream),
                )
                .await
                {
                    let cancel = service.cancellation_token();
                    tokio::select! {_=stop.changed()=>{server.session.stop();cancel.cancel();},_=service.waiting()=>{server.session.stop();}}
                }
            });
        }
        server.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    });
    Ok(AttachedEndpoint { bootstrap, cancel })
}
pub async fn attach(path: &Path) -> Result<(), String> {
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    if bytes.len() > 8192 {
        return Err("Invalid MCP bootstrap".into());
    }
    let data: Bootstrap = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let connect = async {
        loop {
            match ClientOptions::new().open(&data.endpoint) {
                Ok(stream) => break Ok(stream),
                Err(error) if error.raw_os_error() == Some(231) => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await
                }
                Err(error) => break Err(error),
            }
        }
    };
    let mut stream = tokio::time::timeout(std::time::Duration::from_secs(5), connect)
        .await
        .map_err(|_| "Kubiki MCP connection timed out")?
        .map_err(|e| e.to_string())?;
    stream
        .write_all(format!("{}\n", data.token).as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    relay(stream).await
}
