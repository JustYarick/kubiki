use crate::core::events::{EventBus, KubikiEvent};
use crate::informer::delta::ResourceDelta;
use crate::informer::store::ResourceStore;
use futures::StreamExt;
use kube::api::{Api, ResourceExt};
use kube::runtime::watcher::{self, Event};
use kube::{Client, Resource};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

pub struct InformerManager {
    store: ResourceStore,
    event_bus: EventBus,
    active_watchers: Arc<RwLock<HashMap<String, JoinHandle<()>>>>,
}

impl InformerManager {
    pub fn new(store: ResourceStore, event_bus: EventBus) -> Self {
        Self {
            store,
            event_bus,
            active_watchers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn store(&self) -> &ResourceStore {
        &self.store
    }

    pub fn event_bus(&self) -> &EventBus {
        &self.event_bus
    }

    /// Start watching a specific resource type in an optional namespace
    pub async fn start_watch<K>(
        &self,
        client: Client,
        namespace: Option<String>,
        kind_name: &str,
    ) where
        K: Resource<DynamicType = ()> + Clone + DeserializeOwned + Serialize + Debug + Send + Sync + 'static,
    {
        let watch_key = format!("{}:{}", kind_name, namespace.as_deref().unwrap_or("all"));

        // If watcher already running for this key, return
        let mut watchers = self.active_watchers.write().await;
        if watchers.contains_key(&watch_key) {
            return;
        }

        let mut watcher_config = watcher::Config::default();
        if let Some(ref ns) = namespace {
            if ns != "all" {
                watcher_config = watcher_config.fields(&format!("metadata.namespace={}", ns));
            }
        }

        let api: Api<K> = Api::all(client);

        let store = self.store.clone();
        let event_bus = self.event_bus.clone();
        let kind = kind_name.to_string();

        let handle = tokio::spawn(async move {
            let stream = watcher::watcher(api, watcher_config).boxed();
            tokio::pin!(stream);

            while let Some(event_res) = stream.next().await {
                match event_res {
                    Ok(Event::Apply(obj)) | Ok(Event::InitApply(obj)) => {
                        let uid = obj.meta().uid.clone().unwrap_or_default();
                        let name = obj.name_any();
                        let ns = obj.meta().namespace.clone();
                        if let Ok(data) = serde_json::to_value(&obj) {
                            let delta = ResourceDelta::Applied {
                                gvk: kind.clone(),
                                uid,
                                name,
                                namespace: ns,
                                data,
                            };
                            store.apply_delta(&delta).await;
                            event_bus.publish(KubikiEvent::ResourceDelta(delta));
                        }
                    }
                    Ok(Event::Delete(obj)) => {
                        let uid = obj.meta().uid.clone().unwrap_or_default();
                        let name = obj.name_any();
                        let ns = obj.meta().namespace.clone();
                        let delta = ResourceDelta::Deleted {
                            gvk: kind.clone(),
                            uid,
                            name,
                            namespace: ns,
                        };
                        store.apply_delta(&delta).await;
                        event_bus.publish(KubikiEvent::ResourceDelta(delta));
                    }
                    Ok(Event::Init) => {
                        // Watch stream initialized/restarted
                        tracing::debug!(kind = %kind, "Watcher initialized/restarted");
                    }
                    Ok(Event::InitDone) => {
                        tracing::debug!(kind = %kind, "Watcher initial listing complete");
                    }
                    Err(err) => {
                        tracing::warn!(kind = %kind, error = %err, "Watcher received error from K8s API");
                    }
                }
            }
        });

        watchers.insert(watch_key, handle);
    }

    /// Stop watching a specific resource type
    pub async fn stop_watch(&self, kind_name: &str, namespace: Option<&str>) {
        let watch_key = format!("{}:{}", kind_name, namespace.unwrap_or("all"));
        let mut watchers = self.active_watchers.write().await;
        if let Some(handle) = watchers.remove(&watch_key) {
            handle.abort();
        }
    }

    /// Stop all active watchers
    pub async fn stop_all(&self) {
        let mut watchers = self.active_watchers.write().await;
        for (_, handle) in watchers.drain() {
            handle.abort();
        }
    }
}
