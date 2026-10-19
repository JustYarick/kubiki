use crate::informer::delta::ResourceDelta;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "category", content = "data")]
pub enum KubikiEvent {
    ResourceDelta(ResourceDelta),
    ClusterConnected { context: String, version: String },
    ClusterDisconnected { context: String, reason: String },
    PortForwardStatus {
        session_id: String,
        status: String,
        local_port: u16,
    },
    Error { message: String },
}

#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<KubikiEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(1024)
    }
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn publish(&self, event: KubikiEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<KubikiEvent> {
        self.sender.subscribe()
    }
}
