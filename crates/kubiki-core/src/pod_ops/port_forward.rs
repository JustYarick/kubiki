//! Window-owned loopback tunnels. Every spawned connection belongs to its listener.
use crate::core::api::{ApiError, ApiErrorCode, ResourceRef, validate_query};
use k8s_openapi::{
    api::core::v1::{Pod, Service},
    apimachinery::pkg::util::intstr::IntOrString,
};
use kube::{
    Api, Client,
    api::{ListParams, Portforwarder},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, oneshot},
    task::{AbortHandle, JoinSet},
};

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
pub struct ForwardRequest {
    pub resource: ResourceRef,
    pub remote_port: u16,
    pub local_port: u16,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PortForwardSession {
    pub id: String,
    pub resource: ResourceRef,
    pub target_kind: ForwardTargetKind,
    pub namespace: String,
    pub name: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub pod_name: String,
    pub pod_uid: String,
    pub pod_port: u16,
    pub status: ForwardStatus,
    pub last_error: Option<ApiError>,
    pub started_at: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
}
struct Handle {
    snapshot: Arc<StdMutex<PortForwardSession>>,
    task: AbortHandle,
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<(String, String), Handle>>,
}
#[derive(Clone, Default)]
pub struct PortForwardManager {
    inner: Arc<Inner>,
}
// kube-rs Portforwarder has no Drop cancellation. Guard every successful upgrade.
struct Forward(Portforwarder);
impl Drop for Forward {
    fn drop(&mut self) {
        self.0.abort();
    }
}
fn error(request: &ForwardRequest, status: u16, message: impl Into<String>) -> ApiError {
    ApiError::from_status(
        status,
        message,
        "port_forward",
        Some(&request.resource.query.context),
    )
    .with_resource(&request.resource.query)
}
fn api_error(request: &ForwardRequest, err: kube::Error) -> ApiError {
    match err {
        kube::Error::Api(response) => error(request, response.code, response.message),
        kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(
            status,
        )) => error(
            request,
            status.as_u16(),
            format!(
                "Port-forward WebSocket rejected ({status}); check pods/portforward permissions and API proxy support"
            ),
        ),
        err => ApiError::new(
            ApiErrorCode::Unavailable,
            err.to_string(),
            "port_forward",
            Some(&request.resource.query.context),
            None,
        )
        .with_resource(&request.resource.query),
    }
}
pub fn validate_request(request: &ForwardRequest) -> Result<(), ApiError> {
    validate_query(&request.resource.query)?;
    let r = &request.resource;
    if !["Pod", "Service"].contains(&r.query.kind.as_str())
        || r.query.group != ""
        || r.query.version != "v1"
        || r.query.namespace.is_none()
        || r.uid.as_ref().is_none_or(|uid| uid.is_empty())
        || r.name.is_empty()
        || r.name.len() > 253
        || !r
            .name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.')
        || request.remote_port == 0
    {
        return Err(error(
            request,
            400,
            "A Pod or Service reference with namespace, UID and TCP port 1–65535 is required",
        ));
    }
    Ok(())
}
fn running(pod: &Pod) -> bool {
    pod.metadata.deletion_timestamp.is_none()
        && pod.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running")
}
fn ready(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .is_some_and(|c| c.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
}
pub fn service_target_port(service: &Service, pod: &Pod, port: u16) -> Result<u16, String> {
    let spec = service.spec.as_ref().ok_or("Service has no spec")?;
    let selected = spec
        .ports
        .as_ref()
        .and_then(|ports| ports.iter().find(|p| p.port == i32::from(port)))
        .ok_or("Service port not found")?;
    if selected.protocol.as_deref().unwrap_or("TCP") != "TCP" {
        return Err("Port forwarding supports TCP only".into());
    }
    let value = match selected.target_port.as_ref() {
        None => i32::from(port),
        Some(IntOrString::Int(value)) => *value,
        Some(IntOrString::String(name)) => {
            let spec = pod.spec.as_ref().ok_or("Pod has no spec")?;
            spec.containers
                .iter()
                .chain(
                    spec.init_containers
                        .iter()
                        .flatten()
                        .filter(|c| c.restart_policy.as_deref() == Some("Always")),
                )
                .flat_map(|c| c.ports.iter().flatten())
                .find(|p| {
                    p.name.as_ref() == Some(name) && p.protocol.as_deref().unwrap_or("TCP") == "TCP"
                })
                .map(|p| p.container_port)
                .ok_or_else(|| {
                    format!("Named targetPort {name} is not declared on the selected Pod")
                })?
        }
    };
    u16::try_from(value)
        .ok()
        .filter(|p| *p > 0)
        .ok_or_else(|| "Invalid Service targetPort".into())
}
async fn verify_target(client: &Client, request: &ForwardRequest) -> Result<(), ApiError> {
    let ns = request.resource.query.namespace.as_deref().unwrap();
    let uid = if request.resource.query.kind == "Pod" {
        Api::<Pod>::namespaced(client.clone(), ns)
            .get(&request.resource.name)
            .await
            .map_err(|e| api_error(request, e))?
            .metadata
            .uid
    } else {
        Api::<Service>::namespaced(client.clone(), ns)
            .get(&request.resource.name)
            .await
            .map_err(|e| api_error(request, e))?
            .metadata
            .uid
    };
    if uid != request.resource.uid {
        return Err(error(
            request,
            409,
            "Resource was recreated; reopen it before forwarding",
        ));
    }
    Ok(())
}
async fn resolve(client: &Client, request: &ForwardRequest) -> Result<(Pod, u16), ApiError> {
    let ns = request.resource.query.namespace.as_deref().unwrap();
    let pods: Api<Pod> = Api::namespaced(client.clone(), ns);
    if request.resource.query.kind == "Pod" {
        let pod = pods
            .get(&request.resource.name)
            .await
            .map_err(|e| api_error(request, e))?;
        if pod.metadata.uid != request.resource.uid {
            return Err(error(
                request,
                409,
                "Pod was recreated; reopen it before forwarding",
            ));
        }
        if !running(&pod) {
            return Err(error(
                request,
                409,
                "Pod must be Running and not terminating",
            ));
        }
        return Ok((pod, request.remote_port));
    }
    let service = Api::<Service>::namespaced(client.clone(), ns)
        .get(&request.resource.name)
        .await
        .map_err(|e| api_error(request, e))?;
    if service.metadata.uid != request.resource.uid {
        return Err(error(
            request,
            409,
            "Service was recreated; reopen it before forwarding",
        ));
    }
    let spec = service
        .spec
        .as_ref()
        .ok_or_else(|| error(request, 400, "Service has no spec"))?;
    let service_port = spec
        .ports
        .as_ref()
        .and_then(|ports| {
            ports
                .iter()
                .find(|p| p.port == i32::from(request.remote_port))
        })
        .ok_or_else(|| error(request, 400, "Service port not found"))?;
    if service_port.protocol.as_deref().unwrap_or("TCP") != "TCP" {
        return Err(error(request, 400, "Port forwarding supports TCP only"));
    }
    let selector = spec.selector.as_ref().filter(|s| !s.is_empty()).ok_or_else(|| error(request, 400, "Service without a selector (including ExternalName) cannot be forwarded; choose a Pod"))?;
    let selector = selector
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(",");
    let mut candidates = pods
        .list(
            &ListParams::default()
                .labels(&selector)
                .fields("status.phase=Running"),
        )
        .await
        .map_err(|e| api_error(request, e))?
        .items;
    candidates.retain(running);
    candidates.sort_by(|a, b| {
        ready(b)
            .cmp(&ready(a))
            .then_with(|| a.metadata.name.cmp(&b.metadata.name))
    });
    for pod in candidates {
        if let Ok(port) = service_target_port(&service, &pod, request.remote_port) {
            return Ok((pod, port));
        }
    }
    Err(error(
        request,
        400,
        "No Running Pod with a matching TCP targetPort for this Service",
    ))
}
async fn open(
    client: &Client,
    request: &ForwardRequest,
    pod_name: &str,
    pod_uid: &str,
    port: u16,
) -> Result<Forward, ApiError> {
    verify_target(client, request).await?;
    let pods: Api<Pod> = Api::namespaced(
        client.clone(),
        request.resource.query.namespace.as_deref().unwrap(),
    );
    let verify = || async {
        let pod = pods
            .get(pod_name)
            .await
            .map_err(|e| api_error(request, e))?;
        if pod.metadata.uid.as_deref() != Some(pod_uid) || !running(&pod) {
            return Err(error(
                request,
                409,
                "Selected Pod changed or stopped; restart the tunnel",
            ));
        }
        Ok(())
    };
    verify().await?;
    let forward = Forward(
        pods.portforward(pod_name, &[port])
            .await
            .map_err(|e| api_error(request, e))?,
    );
    verify().await?;
    Ok(forward)
}
impl PortForwardManager {
    pub fn new() -> Self {
        Self::default()
    }
    pub async fn start(
        &self,
        owner: &str,
        id: &str,
        client: Client,
        request: ForwardRequest,
    ) -> Result<PortForwardSession, ApiError> {
        validate_request(&request)?;
        if id.is_empty()
            || id.len() > 128
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(error(&request, 400, "Invalid tunnel ID"));
        }
        let key = (owner.to_owned(), id.to_owned());
        let mut sessions = self.inner.sessions.lock().await;
        if sessions.contains_key(&key) {
            return Err(error(&request, 409, "Tunnel ID already exists"));
        }
        if sessions.len() >= 64
            || sessions
                .keys()
                .filter(|(window, _)| window == owner)
                .count()
                >= 16
        {
            return Err(error(&request, 429, "Too many port forwards"));
        }
        let snapshot = Arc::new(StdMutex::new(PortForwardSession {
            id: id.into(),
            resource: request.resource.clone(),
            target_kind: if request.resource.query.kind == "Pod" {
                ForwardTargetKind::Pod
            } else {
                ForwardTargetKind::Service
            },
            namespace: request.resource.query.namespace.clone().unwrap(),
            name: request.resource.name.clone(),
            local_port: request.local_port,
            remote_port: request.remote_port,
            pod_name: String::new(),
            pod_uid: String::new(),
            pod_port: 0,
            status: ForwardStatus::Starting,
            last_error: None,
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            bytes_sent: 0,
            bytes_received: 0,
        }));
        let shared = snapshot.clone();
        let (ready_tx, ready_rx) = oneshot::channel();
        let operation = request.clone();
        let task = tokio::spawn(async move {
            let setup = async {
                let (pod, port) = resolve(&client, &request).await?;
                let name = pod
                    .metadata
                    .name
                    .ok_or_else(|| error(&request, 400, "Pod name missing"))?;
                let uid = pod
                    .metadata
                    .uid
                    .ok_or_else(|| error(&request, 400, "Pod UID missing"))?;
                let listener =
                    TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, request.local_port))
                        .await
                        .map_err(|e| {
                            error(&request, 409, format!("Cannot bind local port: {e}"))
                        })?;
                // Fail early on RBAC/upgrade errors. No artificial 'Active' before the API accepted it.
                let mut forward = open(&client, &request, &name, &uid, port).await?;
                let mut probe = forward
                    .0
                    .take_stream(port)
                    .ok_or_else(|| error(&request, 500, "Port-forward probe missing"))?;
                let remote_error = forward
                    .0
                    .take_error(port)
                    .ok_or_else(|| error(&request, 500, "Port-forward error stream missing"))?;
                let check = async {
                    let mut byte = [0u8];
                    tokio::select! {
                        result = probe.read(&mut byte) => match result {
                            Ok(0) => Err(error(&request, 503, "Port-forward connection closed during startup")),
                            Ok(_) => Ok(()),
                            Err(e) => Err(error(&request, 503, e.to_string())),
                        },
                        result = remote_error => match result { Some(message) => Err(error(&request, 502, message)), None => Err(error(&request, 503, "Port-forward connection closed during startup")) },
                    }
                };
                if let Ok(result) = tokio::time::timeout(Duration::from_millis(120), check).await {
                    result?;
                }
                drop(probe);
                drop(forward);
                let local_port = listener
                    .local_addr()
                    .map_err(|e| error(&request, 500, e.to_string()))?
                    .port();
                {
                    let mut s = shared.lock().unwrap();
                    s.local_port = local_port;
                    s.pod_name = name;
                    s.pod_uid = uid;
                    s.pod_port = port;
                    s.status = ForwardStatus::Active;
                }
                Ok::<_, ApiError>(listener)
            };
            let listener = match tokio::time::timeout(Duration::from_secs(20), setup).await {
                Ok(Ok(listener)) => listener,
                result => {
                    let failure = match result {
                        Ok(Err(error)) => error,
                        _ => error(&request, 504, "Port-forward startup timed out"),
                    };
                    let _ = ready_tx.send(Err(failure));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(shared.lock().unwrap().clone()));
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept(), if connections.len() < 32 => match accepted {
                        Ok((socket, _)) => { let client = client.clone(); let request = request.clone(); let shared = shared.clone(); connections.spawn(async move { connection(socket, client, request, shared).await; }); },
                        Err(e) => { let mut s = shared.lock().unwrap(); s.status = ForwardStatus::Failed(e.to_string()); s.last_error = Some(error(&request, 503, e.to_string())); break; }
                    },
                    _ = connections.join_next(), if !connections.is_empty() => {},
                }
            }
            // JoinSet Drop aborts every child; Forward Drop aborts kube-rs background tasks.
        });
        sessions.insert(
            key,
            Handle {
                snapshot,
                task: task.abort_handle(),
            },
        );
        drop(sessions);
        match ready_rx.await {
            Ok(Ok(session)) => Ok(session),
            result => {
                self.stop(owner, id).await;
                Err(match result {
                    Ok(Err(error)) => error,
                    _ => error(&operation, 409, "Port-forward startup was cancelled"),
                })
            }
        }
    }
    pub async fn stop(&self, owner: &str, id: &str) {
        self.inner
            .sessions
            .lock()
            .await
            .remove(&(owner.into(), id.into()));
    }
    pub async fn stop_owner(&self, owner: &str) {
        self.inner
            .sessions
            .lock()
            .await
            .retain(|(window, _), _| window != owner);
    }
    pub async fn list(&self, owner: &str) -> Vec<PortForwardSession> {
        self.inner
            .sessions
            .lock()
            .await
            .iter()
            .filter(|((window, _), _)| window == owner)
            .map(|(_, handle)| handle.snapshot.lock().unwrap().clone())
            .collect()
    }
}
async fn connection(
    mut socket: TcpStream,
    client: Client,
    request: ForwardRequest,
    shared: Arc<StdMutex<PortForwardSession>>,
) {
    let session = shared.lock().unwrap().clone();
    let result = async {
        let mut forward = tokio::time::timeout(Duration::from_secs(15), open(&client, &request, &session.pod_name, &session.pod_uid, session.pod_port)).await.map_err(|_| error(&request, 504, "Opening port-forward timed out"))??;
        let mut stream = forward.0.take_stream(session.pod_port).ok_or_else(|| error(&request, 500, "Port-forward stream missing"))?;
        let remote_error = forward.0.take_error(session.pod_port).ok_or_else(|| error(&request, 500, "Port-forward error stream missing"))?;
        shared.lock().unwrap().last_error = None;
        let (local_read, local_write) = socket.split(); let (remote_read, remote_write) = tokio::io::split(&mut stream);
        let copy = async { tokio::try_join!(pump(local_read, remote_write, &shared, true), pump(remote_read, local_write, &shared, false)).map(|_| ()) };
        tokio::pin!(copy);
        tokio::select! {
            result = &mut copy => result.map_err(|e| error(&request, 502, e.to_string())),
            result = remote_error => match result { Some(message) => Err(error(&request, 502, message)), None => copy.await.map_err(|e| error(&request, 502, e.to_string())) },
        }
    }.await;
    if let Err(error) = result {
        shared.lock().unwrap().last_error = Some(error);
    }
}
async fn pump(
    mut reader: impl AsyncRead + Unpin,
    mut writer: impl AsyncWrite + Unpin,
    shared: &StdMutex<PortForwardSession>,
    sent: bool,
) -> std::io::Result<()> {
    let mut buffer = [0u8; 16384];
    loop {
        let size = reader.read(&mut buffer).await?;
        if size == 0 {
            writer.shutdown().await?;
            return Ok(());
        }
        writer.write_all(&buffer[..size]).await?;
        let mut s = shared.lock().unwrap();
        if sent {
            s.bytes_sent += size as u64;
        } else {
            s.bytes_received += size as u64;
        }
    }
}
