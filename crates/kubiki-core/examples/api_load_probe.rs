//! Read-only native informer measurement. Never issues POST, PUT, PATCH or DELETE.
//! cargo run --example api_load_probe -- CONTEXT [SECONDS]
use kube::{Client, discovery::Discovery};
use kubiki_core::{
    InformerManager, ResourceStore,
    cluster::{client::ClusterClientPool, kubeconfig::KubeConfigManager},
    core::api::{ResourceQuery, resource_types},
    informer::delta::WatchEvent,
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let context = args.get(1).ok_or("Supply an explicit context")?.clone();
    let seconds = args
        .get(2)
        .map(|s| s.parse::<u64>())
        .transpose()?
        .unwrap_or(15)
        .clamp(1, 300);
    let pool = ClusterClientPool::new(KubeConfigManager::new());
    let client = pool.get_client(&context).await?;
    let counts = Arc::new(Mutex::new(BTreeMap::<String, u64>::new()));
    let counter = counts.clone();
    let ns = client.default_namespace().to_owned();
    let observed = tower::service_fn(move |request: http::Request<kube::client::Body>| {
        let client = client.clone();
        let counter = counter.clone();
        async move {
            if request.method() != http::Method::GET {
                return Err(kube::Error::Service(
                    std::io::Error::other("Probe blocked a non-GET request").into(),
                ));
            }
            let watch = request
                .uri()
                .query()
                .is_some_and(|q| q.split('&').any(|s| s == "watch=true"));
            *counter
                .lock()
                .unwrap()
                .entry(if watch { "watch" } else { "get_or_list" }.into())
                .or_default() += 1;
            client.send(request).await
        }
    });
    let client = Client::new(observed, ns);
    let discovery = Discovery::new(client.clone()).run().await?;
    let discovery_requests = counts.lock().unwrap().clone();
    counts.lock().unwrap().clear();
    let manager = InformerManager::new(ResourceStore::new());
    let snapshots = Arc::new(Mutex::new(BTreeMap::<String, usize>::new()));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut tasks = vec![];
    let started = Instant::now();
    for kind in resource_types() {
        let Some(group) = discovery.get(&kind.group) else {
            continue;
        };
        let Some((resource, _caps)) = group.recommended_resources().into_iter().find(|(r, c)| {
            r.kind == kind.kind && c.supports_operation("list") && c.supports_operation("watch")
        }) else {
            continue;
        };
        let query = ResourceQuery {
            context: context.clone(),
            group: resource.group,
            version: resource.version,
            kind: resource.kind.clone(),
            namespace: None,
        };
        let api = client.clone();
        let kind = resource.kind.clone();
        let snapshots = snapshots.clone();
        let errors = errors.clone();
        let mut events = manager
            .start_watch(
                "probe",
                &format!("probe-{}", tasks.len()),
                query,
                async move { Ok(api) },
            )
            .await
            .map_err(|e| std::io::Error::other(e.message))?;
        tasks.push(tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event.event {
                    WatchEvent::Delta(kubiki_core::informer::delta::ResourceDelta::Restarted {
                        items,
                    }) => {
                        snapshots.lock().unwrap().insert(kind.clone(), items.len());
                    }
                    WatchEvent::Status {
                        error: Some(error), ..
                    } => {
                        errors
                            .lock()
                            .unwrap()
                            .push(format!("{kind}: {:?}", error.status));
                    }
                    _ => (),
                }
            }
        }));
    }
    let collections = tasks.len();
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    manager.stop_owner("probe").await;
    for task in tasks {
        task.await?;
    }
    let snapshots = snapshots.lock().unwrap();
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"context":context,"elapsed_seconds":started.elapsed().as_secs_f64(),"discovery_requests":discovery_requests,"collections":collections,"snapshots":snapshots.len(),"objects":snapshots.values().sum::<usize>(),"requests":*counts.lock().unwrap(),"errors":*errors.lock().unwrap(),"active_after_stop":manager.active_count().await})
        )?
    );
    Ok(())
}
