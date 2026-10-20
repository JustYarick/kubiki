//! Opt-in live check. Opens /bin/sh, prints a marker, reports TTY size, and exits.
//! cargo run --example terminal_smoke -- <context> <namespace> <pod> <container>
use k8s_openapi::api::core::v1::Pod;
use kube::Api;
use kubiki_core::{
    ClusterClientPool, KubeConfigManager,
    core::api::{ResourceQuery, ResourceRef},
    pod_ops::terminal::{ExecEvent, ExecRequest, PodTerminalManager},
};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 {
        return Err("Usage: terminal_smoke <context> <namespace> <pod> <container> (executes a fixed printf/stty/exit smoke command)".into());
    }
    let pool = ClusterClientPool::new(KubeConfigManager::new());
    let client = pool.get_client(&args[0]).await?;
    let pods: Api<Pod> = Api::namespaced(client.clone(), &args[1]);
    let pod = pods.get(&args[2]).await?;
    let request = ExecRequest {
        resource: ResourceRef {
            query: ResourceQuery {
                context: args[0].clone(),
                group: String::new(),
                version: "v1".into(),
                kind: "Pod".into(),
                namespace: Some(args[1].clone()),
            },
            name: args[2].clone(),
            uid: pod.metadata.uid,
        },
        container: args[3].clone(),
        shell: "/bin/sh".into(),
        cols: 80,
        rows: 24,
    };
    let manager = PodTerminalManager::default();
    let mut output = manager
        .start("smoke", "shell", request, async move { Ok(client) })
        .await
        .map_err(|e| format!("{:?}: {}", e.code, e.message))?
        .output;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let mut bytes = Vec::new();
        while let Some(message) = output.recv().await {
            match message.event {
                ExecEvent::Started => {
                    manager
                        .resize("smoke", "shell", 100, 40)
                        .await
                        .map_err(|e| e.message)?;
                    manager
                        .write(
                            "smoke",
                            "shell",
                            "printf 'KUBIKI_EXEC_SMOKE_OK\\n'; stty size; exit\r".into(),
                        )
                        .await
                        .map_err(|e| e.message)?;
                }
                ExecEvent::Output { data } => bytes.extend(data),
                ExecEvent::Exited { code } => {
                    let text = String::from_utf8_lossy(&bytes);
                    if code != 0 || !text.contains("\nKUBIKI_EXEC_SMOKE_OK\r\n") {
                        return Err(format!("Smoke marker/exit check failed (exit {code})"));
                    }
                    return Ok((code, text.contains("40 100")));
                }
                ExecEvent::Failed { error } => {
                    return Err(format!("{:?}: {}", error.code, error.message));
                }
            }
        }
        Err("Exec ended without a final event".to_owned())
    })
    .await;
    manager.stop_owner("smoke").await;
    let (code, resized) = result??;
    println!(
        "PASS: live Pod exec, stdin/stdout marker, exit={code}, resized_tty={resized}, active_sessions={}",
        manager.active_count().await
    );
    Ok(())
}
