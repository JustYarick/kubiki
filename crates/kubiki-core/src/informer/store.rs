use crate::informer::delta::ResourceDelta;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone, Default)]
pub struct ResourceStore {
    // kind -> (uid -> (metadata/data Value))
    data: Arc<RwLock<HashMap<String, HashMap<String, Value>>>>,
}

impl ResourceStore {
    pub fn new() -> Self {
        Self {
            data: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Apply an incoming ResourceDelta to update the local store
    pub async fn apply_delta(&self, delta: &ResourceDelta) {
        let mut store = self.data.write().await;

        match delta {
            ResourceDelta::Applied { gvk, uid, data, .. } => {
                let kind_map = store.entry(gvk.clone()).or_default();
                kind_map.insert(uid.clone(), data.clone());
            }
            ResourceDelta::Deleted { gvk, uid, .. } => {
                if let Some(kind_map) = store.get_mut(gvk) {
                    kind_map.remove(uid);
                }
            }
            ResourceDelta::Restarted { gvk, items } => {
                let mut new_kind_map = HashMap::new();
                for item in items {
                    if let Some(uid) = item
                        .get("metadata")
                        .and_then(|m| m.get("uid"))
                        .and_then(|u| u.as_str())
                    {
                        new_kind_map.insert(uid.to_string(), item.clone());
                    }
                }
                store.insert(gvk.clone(), new_kind_map);
            }
        }
    }

    /// Get all resources of a specific Kind, optionally filtered by namespace
    pub async fn get_resources(
        &self,
        kind: &str,
        namespace: Option<&str>,
    ) -> Vec<Value> {
        let store = self.data.read().await;
        let Some(kind_map) = store.get(kind) else {
            return Vec::new();
        };

        kind_map
            .values()
            .filter(|item| {
                if let Some(ns_filter) = namespace {
                    if ns_filter == "all" {
                        return true;
                    }
                    let item_ns = item
                        .get("metadata")
                        .and_then(|m| m.get("namespace"))
                        .and_then(|n| n.as_str());
                    item_ns == Some(ns_filter)
                } else {
                    true
                }
            })
            .cloned()
            .collect()
    }

    /// Count resources by Kind
    pub async fn count(&self, kind: &str) -> usize {
        let store = self.data.read().await;
        store.get(kind).map(|m| m.len()).unwrap_or(0)
    }

    /// Clear all data in the store
    pub async fn clear(&self) {
        let mut store = self.data.write().await;
        store.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_resource_store_applied_and_deleted() {
        let store = ResourceStore::new();

        let pod = json!({
            "metadata": {
                "name": "nginx",
                "namespace": "default",
                "uid": "uid-123"
            }
        });

        let delta_applied = ResourceDelta::Applied {
            gvk: "Pod".into(),
            uid: "uid-123".into(),
            name: "nginx".into(),
            namespace: Some("default".into()),
            data: pod.clone(),
        };

        store.apply_delta(&delta_applied).await;
        assert_eq!(store.count("Pod").await, 1);

        let items = store.get_resources("Pod", Some("default")).await;
        assert_eq!(items.len(), 1);

        let delta_deleted = ResourceDelta::Deleted {
            gvk: "Pod".into(),
            uid: "uid-123".into(),
            name: "nginx".into(),
            namespace: Some("default".into()),
        };

        store.apply_delta(&delta_deleted).await;
        assert_eq!(store.count("Pod").await, 0);
    }
}
