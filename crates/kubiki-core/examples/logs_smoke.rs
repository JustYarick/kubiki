//! Read-only live smoke; only byte counts are printed, never Pod log contents.
//! cargo run --example logs_smoke -- <context> <namespace> <pod> <container>
use k8s_openapi::api::core::v1::Pod;
use kube::Api;
use kubiki_core::{
    ClusterClientPool, KubeConfigManager,
    core::api::{ResourceQuery, ResourceRef},
    pod_ops::logs::LogSliceRequest,
};
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
    let request = LogSliceRequest {
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
        previous: false,
        tail_lines: Some(10),
        since_time: None,
        since_seconds: None,
    };
    let text = tokio::time::timeout(std::time::Duration::from_secs(30), request.read(client))
        .await
        .map_err(|_| "Timed out reading the log slice".to_owned())?
        .map_err(|e| e.message)?;
    println!("Slice: {} bytes, {} lines", text.len(), text.lines().count());
    Ok(())
}
