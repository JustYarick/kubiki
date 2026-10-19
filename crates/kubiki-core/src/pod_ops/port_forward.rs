use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum ForwardTargetKind {
    Pod,
    Service,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum ForwardStatus {
    Starting,
    Active,
    Stopped,
    Failed(String),
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PortForwardSession {
    pub id: String,
    pub target_kind: ForwardTargetKind,
    pub namespace: String,
    pub name: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub status: ForwardStatus,
    pub bytes_sent: u64,
    pub bytes_received: u64,
}
