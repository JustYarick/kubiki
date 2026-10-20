//! Read-only live smoke; only byte counts are printed, never Pod log contents.
//! cargo run --example logs_smoke -- <context> <namespace> <pod> <container>
use k8s_openapi::api::core::v1::Pod;
use kube::Api;
use kubiki_core::{
    ClusterClientPool, KubeConfigManager,
    core::api::{ResourceQuery, ResourceRef},
    pod_ops::log_sessions::{LogEvent, LogRequest, PodLogManager},
};
use std::time::Duration;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 {
        return Err("Usage: logs_smoke <context> <namespace> <pod> <container>".into());
    }
    let pool = ClusterClientPool::new(KubeConfigManager::new());
    let client = pool.get_client(&args[0]).await?;
    let pod: Pod = Api::namespaced(client.clone(), &args[1])
        .get(&args[2])
        .await?;
    let request = LogRequest {
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
        follow: true,
        previous: false,
        tail_lines: 10,
        since_seconds: None,
    };
    let manager = PodLogManager::default();
    let mut output = manager
        .start("smoke", "logs", request, async move { Ok(client) })
        .await
        .map_err(|e| e.message)?
        .output;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(message) = output.recv().await {
            match message.event {
                LogEvent::Output { data } if !data.is_empty() => return Ok(data.len()),
                LogEvent::Failed { error } => return Err(error.message),
                LogEvent::Completed => return Err("Stream completed with no output".to_owned()),
                _ => {}
            }
        }
        Err("Stream ended without output".to_owned())
    })
    .await;
    manager.stop_owner("smoke").await;
    let bytes = result??;
    println!(
        "PASS: live follow logs received {bytes} bytes, active_sessions={}",
        manager.session_count().await
    );
    Ok(())
}
