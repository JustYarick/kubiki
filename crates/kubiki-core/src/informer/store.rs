use crate::informer::delta::{ResourceDelta, WatchScope};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

type Snapshot = HashMap<String, Value>;

#[derive(Clone)]
pub struct ResourceStore {
    enabled: bool,
    data: Arc<RwLock<HashMap<WatchScope, Snapshot>>>,
}

impl Default for ResourceStore {
    fn default() -> Self {
        Self {
            enabled: true,
            data: Arc::default(),
        }
    }
}

impl ResourceStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn disabled() -> Self {
        Self {
            enabled: false,
            data: Arc::default(),
        }
    }

    /// Replace only this subscription, atomically; other contexts/GVK/scopes are untouched.
    pub async fn apply_delta(&self, scope: &WatchScope, delta: &ResourceDelta) {
        if !self.enabled {
            return;
        }
        let mut store = self.data.write().await;
        match delta {
            ResourceDelta::Applied { data } => {
                if let Some(uid) = data["metadata"]["uid"].as_str() {
                    store
                        .entry(scope.clone())
                        .or_default()
                        .insert(uid.into(), data.clone());
                }
            }
            ResourceDelta::Deleted { uid } => {
                if let Some(snapshot) = store.get_mut(scope) {
                    snapshot.remove(uid);
                }
            }
            ResourceDelta::Restarted { items } => {
                let snapshot = items
                    .iter()
                    .filter_map(|data| {
                        data["metadata"]["uid"]
                            .as_str()
                            .map(|uid| (uid.into(), data.clone()))
                    })
                    .collect();
                store.insert(scope.clone(), snapshot);
            }
        }
    }

    /// None is not synced; Some(empty) is a complete, authoritative empty list.
    pub async fn snapshot(&self, scope: &WatchScope) -> Option<Vec<Value>> {
        self.data
            .read()
            .await
            .get(scope)
            .map(|items| items.values().cloned().collect())
    }

    pub async fn remove(&self, scope: &WatchScope) {
        self.data.write().await.remove(scope);
    }
    pub async fn clear(&self) {
        self.data.write().await.clear();
    }
}
