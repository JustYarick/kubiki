use crate::core::error::KubikiError;
use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;
use kube::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

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

struct SessionHandle {
    session: PortForwardSession,
    handle: JoinHandle<()>,
    bytes_sent: Arc<AtomicU64>,
    bytes_received: Arc<AtomicU64>,
}

#[derive(Clone, Default)]
pub struct PortForwardManager {
    sessions: Arc<RwLock<HashMap<String, SessionHandle>>>,
}

impl PortForwardManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Start a local port-forwarding tunnel to a Kubernetes pod
    pub async fn start_pod_forward(
        &self,
        client: Client,
        namespace: &str,
        pod_name: &str,
        remote_port: u16,
        requested_local_port: Option<u16>,
    ) -> Result<PortForwardSession, KubikiError> {
        let bind_addr = SocketAddr::from(([127, 0, 0, 1], requested_local_port.unwrap_or(0)));
        let listener = TcpListener::bind(bind_addr).await.map_err(|e| {
            KubikiError::PortForwardError(format!("Failed to bind local TCP listener: {e}"))
        })?;

        let local_port = listener.local_addr().map_err(|e| {
            KubikiError::PortForwardError(format!("Failed to retrieve assigned local port: {e}"))
        })?.port();

        let session_id = format!("{}:{}:{}", namespace, pod_name, remote_port);

        // Cancel existing session with same key if running
        self.stop_forward(&session_id).await.ok();

        let bytes_sent = Arc::new(AtomicU64::new(0));
        let bytes_received = Arc::new(AtomicU64::new(0));

        let session = PortForwardSession {
            id: session_id.clone(),
            target_kind: ForwardTargetKind::Pod,
            namespace: namespace.to_string(),
            name: pod_name.to_string(),
            local_port,
            remote_port,
            status: ForwardStatus::Active,
            bytes_sent: 0,
            bytes_received: 0,
        };

        let ns = namespace.to_string();
        let name = pod_name.to_string();
        let sent_counter = bytes_sent.clone();
        let recv_counter = bytes_received.clone();

        let handle = tokio::spawn(async move {
            let pods: Api<Pod> = Api::namespaced(client, &ns);

            while let Ok((mut client_stream, _)) = listener.accept().await {
                let pods = pods.clone();
                let name = name.clone();
                let sent_counter = sent_counter.clone();
                let recv_counter = recv_counter.clone();

                tokio::spawn(async move {
                    if let Ok(mut pf) = pods.portforward(&name, &[remote_port]).await {
                        if let Some(mut target_stream) = pf.take_stream(remote_port) {
                            if let Ok((sent, recv)) = tokio::io::copy_bidirectional(
                                &mut client_stream,
                                &mut target_stream,
                            )
                            .await
                            {
                                sent_counter.fetch_add(sent, Ordering::Relaxed);
                                recv_counter.fetch_add(recv, Ordering::Relaxed);
                            }
                        }
                    }
                });
            }
        });

        let mut lock = self.sessions.write().await;
        lock.insert(
            session_id,
            SessionHandle {
                session: session.clone(),
                handle,
                bytes_sent,
                bytes_received,
            },
        );

        Ok(session)
    }

    /// Stop an active port-forwarding session
    pub async fn stop_forward(&self, session_id: &str) -> Result<(), KubikiError> {
        let mut lock = self.sessions.write().await;
        if let Some(session_handle) = lock.remove(session_id) {
            session_handle.handle.abort();
            Ok(())
        } else {
            Err(KubikiError::NotFound {
                kind: "PortForwardSession".into(),
                namespace: "-".into(),
                name: session_id.into(),
            })
        }
    }

    /// List all registered port-forward sessions with current byte counts
    pub async fn list_sessions(&self) -> Vec<PortForwardSession> {
        let lock = self.sessions.read().await;
        lock.values()
            .map(|s| {
                let mut session = s.session.clone();
                session.bytes_sent = s.bytes_sent.load(Ordering::Relaxed);
                session.bytes_received = s.bytes_received.load(Ordering::Relaxed);
                session
            })
            .collect()
    }
}
