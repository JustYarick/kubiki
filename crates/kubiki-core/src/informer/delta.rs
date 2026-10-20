use crate::core::api::{ApiError, ResourceQuery};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Each subscription owns an exact scope, even when namespace scopes overlap.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
pub struct WatchScope {
    pub subscription_id: String,
    pub query: ResourceQuery,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum ResourceDelta {
    Applied { data: Value },
    Deleted { uid: String },
    Restarted { items: Vec<Value> },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WatchPhase {
    Connecting,
    Syncing,
    Live,
    Reconnecting,
    Failed,
    Stopped,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", content = "payload")]
pub enum WatchEvent {
    Delta(ResourceDelta),
    Status {
        phase: WatchPhase,
        error: Option<ApiError>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WatchMessage {
    pub sequence: u64,
    pub event: WatchEvent,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WatchBatch {
    pub subscription_id: String,
    pub query: ResourceQuery,
    pub messages: Vec<WatchMessage>,
}
