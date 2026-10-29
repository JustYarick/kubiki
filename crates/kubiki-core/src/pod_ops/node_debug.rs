//! Managed node debug Pods: one shared helper Pod per (window, node), UID-bound
//! exec for multiple terminals, consentless automatic cleanup on close.
use crate::{
    core::api::{ApiError, ApiErrorCode, ResourceQuery, ResourceRef, validate_query},
    pod_ops::terminal::{ExecRequest, ExecSubscription, PodTerminalManager},
};
use k8s_openapi::api::{
    authorization::v1::SelfSubjectAccessReview,
    core::v1::{Node, Pod},
};
use kube::{
    Api, Client,
    api::{DeleteParams, ListParams, PostParams, Preconditions},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, oneshot, watch};
const LABEL: &str = "kubiki.io/node-debug";
const SESSION: &str = "kubiki.io/debug-session";
const NODE_UID: &str = "kubiki.io/node-uid";
const PREFIX: &str = "kubiki-node-debug-";
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeDebugRequest {
    pub resource: ResourceRef,
    pub namespace: String,
    pub image: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeExecRequest {
    /// The Node this shell attaches to; carries the UID that addresses the lease.
    pub resource: ResourceRef,
    /// Leases are addressed by their derived session identifier.
    pub debug_session_id: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeDebugResult {
    /// Lease session identifier; reuse it to address exec writes for this Pod.
    pub session_id: String,
    pub pod: ResourceRef,
    /// True when an existing healthy helper Pod for this Node was reused.
    pub reused: bool,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeDebugPhase {
    Preparing,
    Ready,
    Closing,
    Closed,
    CleanupFailed,
}
impl NodeDebugPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Ready => "ready",
            Self::Closing => "closing",
            Self::Closed => "closed",
            Self::CleanupFailed => "cleanup_failed",
        }
    }
}
impl PartialEq<&str> for NodeDebugPhase {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeDebugState {
    pub phase: NodeDebugPhase,
    #[serde(skip)]
    execs: BTreeSet<String>,
    pub name: String,
    pub namespace: String,
    pub detail: String,
    pub error: Option<ApiError>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DebugPod {
    pub resource: ResourceRef,
    pub node: String,
    pub phase: String,
}
struct Lease {
    owner: String,
    id: String,
    request: NodeDebugRequest,
    name: String,
    /// The create outcome; a second terminal awaiting the same Pod subscribes here.
    ready: watch::Sender<Option<Result<ResourceRef, ApiError>>>,
    /// Explicit termination (End session, app close): kills every shell now.
    cancel: watch::Sender<bool>,
    /// Refcounted end of life (last shell released or an aborted prepare):
    /// only tears the lease down while no terminal is attached.
    collapse: watch::Sender<bool>,
    done: watch::Sender<bool>,
    state: Mutex<NodeDebugState>,
    client: Mutex<Option<Client>>,
    pod: Mutex<Option<ResourceRef>>,
    attempted: AtomicBool,
    terminal: PodTerminalManager,
}
async fn release_attachment(lease: &Lease, id: &str) {
    let mut state = lease.state.lock().await;
    if state.execs.remove(id) && state.execs.is_empty() && state.phase == NodeDebugPhase::Ready {
        state.phase = NodeDebugPhase::Closing;
        lease.collapse.send_replace(true);
    }
}
struct ExecReservation {
    lease: Arc<Lease>,
    terminal_id: String,
    committed: bool,
}
impl Drop for ExecReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let lease = self.lease.clone();
        let id = self.terminal_id.clone();
        tokio::spawn(async move {
            lease.terminal.stop(&lease.owner, &id).await;
            release_attachment(&lease, &id).await;
        });
    }
}

#[derive(Default)]
struct Inner {
    leases: Mutex<HashMap<String, Arc<Lease>>>,
    cancelled: Mutex<VecDeque<String>>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for lease in self.leases.get_mut().values() {
            lease.cancel.send_replace(true);
        }
    }
}
#[derive(Clone, Default)]
pub struct NodeDebugManager {
    inner: Arc<Inner>,
}
fn error(request: &NodeDebugRequest, status: u16, message: impl Into<String>) -> ApiError {
    ApiError::from_status(
        status,
        message,
        "node_debug",
        Some(&request.resource.query.context),
    )
    .with_resource(&request.resource.query)
}
fn api_error(request: &NodeDebugRequest, err: kube::Error) -> ApiError {
    match err {
        kube::Error::Api(e) => error(request, e.code, e.message),
        e => ApiError::new(
            ApiErrorCode::Unavailable,
            e.to_string(),
            "node_debug",
            Some(&request.resource.query.context),
            None,
        ),
    }
}
async fn bounded<T>(
    request: &NodeDebugRequest,
    future: impl Future<Output = Result<T, kube::Error>>,
) -> Result<T, ApiError> {
    tokio::time::timeout(Duration::from_secs(20), future)
        .await
        .map_err(|_| error(request, 504, "Node debug API request timed out"))?
        .map_err(|e| api_error(request, e))
}
pub fn validate_request(request: &NodeDebugRequest) -> Result<(), ApiError> {
    validate_query(&request.resource.query)?;
    if request.resource.query.kind != "Node"
        || request
            .resource
            .uid
            .as_ref()
            .is_none_or(|uid| uid.is_empty())
        || request.resource.name.is_empty()
        || request.resource.name.len() > 253
        || !request
            .resource
            .name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.')
        || request.namespace.is_empty()
        || request.namespace.len() > 63
        || !request
            .namespace
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || request.namespace.starts_with('-')
        || request.namespace.ends_with('-')
        || request.image.is_empty()
        || request.image.len() > 300
        || request
            .image
            .bytes()
            .any(|c| c.is_ascii_whitespace() || c.is_ascii_control())
    {
        return Err(error(
            request,
            400,
            "A current Node UID, namespace and container image are required",
        ));
    }
    Ok(())
}
/// The lease identifier: the Node UID (label-value safe), so terminals on one
/// node converge onto one helper Pod while a replaced Node gets a fresh one.
pub fn derived_session_id(resource: &ResourceRef) -> String {
    session_id_for(resource.uid.as_deref().unwrap_or(""))
}
fn session_id_for(uid: &str) -> String {
    let mut sanitized: String = uid
        .bytes()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' {
                c as char
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.len() > 56 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in uid.bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x1000_0000_01b3);
        }
        sanitized.truncate(48);
        sanitized.push_str(&format!("-{hash:08x}"));
    }
    sanitized
}
fn lease_key(owner: &str, id: &str) -> String {
    format!("{owner}:{id}")
}
impl NodeDebugManager {
    /// Provision (or reuse) the helper Pod for one Node. Only the actual create
    /// asks for consent; a second terminal on the same Node attaches silently.
    pub async fn prepare<F, C, CF>(
        &self,
        owner: &str,
        request: NodeDebugRequest,
        client: F,
        confirm: C,
    ) -> Result<NodeDebugResult, ApiError>
    where
        F: Future<Output = Result<Client, ApiError>> + Send + 'static,
        C: Fn(String) -> CF + Send + Sync + 'static,
        CF: Future<Output = Result<bool, ApiError>> + Send + 'static,
    {
        validate_request(&request)?;
        let id = derived_session_id(&request.resource);
        let key = lease_key(owner, &id);
        // A healthy session on this Node is reused: no dialog, no second Pod.
        'reuse: loop {
            let existing = self.inner.leases.lock().await.get(&key).cloned();
            let Some(existing) = existing else {
                break 'reuse;
            };
            let phase = existing.state.lock().await.phase.clone();
            if !*existing.cancel.borrow() && phase == "ready" {
                let pod = existing
                    .pod
                    .lock()
                    .await
                    .clone()
                    .ok_or_else(|| error(&request, 503, "Node shell Pod is missing"))?;
                return Ok(NodeDebugResult {
                    session_id: id,
                    pod,
                    reused: true,
                });
            }
            if !*existing.cancel.borrow() && phase == "preparing" {
                // Another terminal is already provisioning this Node's Pod; the
                // consent dialog belongs to the first caller, we just share the
                // result.
                let mut rx = existing.ready.subscribe();
                let outcome = rx
                    .wait_for(|o| o.is_some())
                    .await
                    .map_err(|_| error(&request, 503, "Node shell task ended"))?
                    .clone()
                    .ok_or_else(|| error(&request, 503, "Node shell task ended"))?;
                return outcome.map(|pod| NodeDebugResult {
                    session_id: id,
                    pod,
                    reused: true,
                });
            }
            if *existing.done.borrow() {
                return Err(error(
                    &request,
                    409,
                    "The previous helper Pod could not be cleaned up. End the shell session to retry deletion before starting a new one",
                ));
            }
            // The lease is being torn down; wait for its removal, then proceed fresh.
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        {
            let mut cancelled = self.inner.cancelled.lock().await;
            if let Some(position) = cancelled.iter().position(|entry| entry == &key) {
                cancelled.swap_remove_back(position);
                return Err(error(
                    &request,
                    409,
                    "Node shell was just cancelled. Wait a moment and try again",
                ));
            }
        }
        let (ready, _) = watch::channel(None);
        let (cancel, _) = watch::channel(false);
        let (collapse, _) = watch::channel(false);
        let (done, _) = watch::channel(false);
        let name = format!("{PREFIX}{id}");
        let lease = Arc::new(Lease {
            owner: owner.into(),
            id: id.clone(),
            name: name.clone(),
            request: request.clone(),
            ready,
            cancel,
            collapse,
            done,
            state: Mutex::new(NodeDebugState {
                phase: NodeDebugPhase::Preparing,
                execs: BTreeSet::new(),
                name,
                namespace: request.namespace.clone(),
                detail: "Checking Node and cleanup permissions".into(),
                error: None,
            }),
            client: Mutex::new(None),
            pod: Mutex::new(None),
            attempted: AtomicBool::new(false),
            terminal: PodTerminalManager::default(),
        });
        {
            let mut leases = self.inner.leases.lock().await;
            if leases.contains_key(&key) {
                return Err(error(&request, 409, "Node shell already exists"));
            }
            if leases.len() >= 8 {
                return Err(error(&request, 429, "Too many managed node debug sessions"));
            }
            leases.insert(key.clone(), lease.clone());
        }
        let (first_readiness, rx) = oneshot::channel();
        let response_request = request.clone();
        let inner = Arc::downgrade(&self.inner);
        let key_for_task = key.clone();
        tokio::spawn(async move {
            let mut cancellation = lease.cancel.subscribe();
            let mut collapsing = lease.collapse.subscribe();
            let result = tokio::select! { _=cancellation.wait_for(|v|*v)=>Err(error(&request,409,"Node shell preparation cancelled")), _=collapsing.wait_for(|v|*v)=>Err(error(&request,409,"Node shell preparation cancelled")), result=async {
                let client=tokio::time::timeout(Duration::from_secs(20),client).await.map_err(|_|error(&request,504,"Node debug client timed out"))??;
                *lease.client.lock().await=Some(client.clone());
                verify_node(&request,client.clone()).await?;
                check_permissions(&request,&lease.name,client.clone()).await?;
                if let Some(resource)=adopt_existing(&request,&lease,client.clone()).await? {
                    Ok::<_,ApiError>(resource)
                } else {
                    let review = format!("Open a root shell on Node {:?} using image {}. The helper Pod is deleted automatically when the last session closes.", request.resource.name, request.image);
                    if !confirm(review).await? { return Err(crate::core::mutations::cancelled(&request.resource,"Operation cancelled. Debug Pod was not created")); }
                    verify_node(&request,client.clone()).await?;
                    provision(&lease,client.clone()).await
                }
            }=>result };
            let outcome = match result {
                Ok(resource) => {
                    *lease.pod.lock().await = Some(resource.clone());
                    lease.state.lock().await.phase = NodeDebugPhase::Ready;
                    lease.ready.send_replace(Some(Ok(resource.clone())));
                    if first_readiness.send(Ok(resource)).is_err() {
                        lease.cancel.send_replace(true);
                    }
                    let inactivity = async {
                        tokio::select! {
                            _=cancellation.wait_for(|v|*v)=>{},
                            _=collapsing.wait_for(|v|*v)=>{},
                        }
                    };
                    let _ = inactivity.await;
                    Ok(())
                }
                Err(e) => {
                    lease.ready.send_replace(Some(Err(e.clone())));
                    let _ = first_readiness.send(Err(e.clone()));
                    Err(e)
                }
            };
            lease.state.lock().await.phase = NodeDebugPhase::Closing;
            lease.terminal.stop_owner(&lease.owner).await;
            // Explicit teardown kills every remaining shell; forget their refcounts.
            lease.state.lock().await.execs.clear();
            let cleanup = cleanup(&lease).await;
            let mut state = lease.state.lock().await;
            match (&outcome, cleanup) {
                (_, Ok(())) => {
                    state.phase = NodeDebugPhase::Closed;
                    state.detail = "Debug Pod removed".into();
                }
                (_, Err(e)) => {
                    state.phase = NodeDebugPhase::CleanupFailed;
                    state.detail = "Debug Pod cleanup failed; retry deletion".into();
                    state.error = Some(e);
                }
            }
            let closed = state.phase == "closed";
            drop(state);
            // Remove the entry before announcing completion, so a re-open never
            // observes a torn-down lease.
            if closed {
                if let Some(inner) = inner.upgrade() {
                    inner.leases.lock().await.remove(&key_for_task);
                }
            }
            lease.done.send_replace(true);
        });
        rx.await
            .map_err(|_| error(&response_request, 503, "Node debug task ended unexpectedly"))?
            .map(|resource| NodeDebugResult {
                session_id: id,
                pod: resource,
                reused: false,
            })
    }
    async fn lease(&self, owner: &str, id: &str) -> Result<Arc<Lease>, ApiError> {
        self.inner
            .leases
            .lock()
            .await
            .get(&lease_key(owner, id))
            .cloned()
            .ok_or_else(|| {
                ApiError::from_status(404, "Node debug session is closed", "node_debug", None)
            })
    }
    pub async fn status(&self, owner: &str, id: &str) -> Option<NodeDebugState> {
        let lease = self.lease(owner, id).await.ok()?;
        Some(lease.state.lock().await.clone())
    }
    pub async fn attach(
        &self,
        owner: &str,
        terminal_id: &str,
        request: NodeExecRequest,
    ) -> Result<ExecSubscription, ApiError> {
        let lease = self.lease(owner, &request.debug_session_id).await?;
        if lease.id != derived_session_id(&lease.request.resource) {
            return Err(error(&lease.request, 409, "Node shell identity mismatch"));
        }
        // Phase and reservations share a lock. Closing the last shell cannot
        // observe zero attachments while another shell is opening.
        {
            let mut state = lease.state.lock().await;
            if *lease.cancel.borrow()
                || state.phase != NodeDebugPhase::Ready
                || *lease.collapse.borrow()
            {
                return Err(error(
                    &lease.request,
                    409,
                    "Debug Pod is not ready; start a new node shell",
                ));
            }
            if !state.execs.insert(terminal_id.to_owned()) {
                return Err(error(
                    &lease.request,
                    409,
                    "Terminal session already exists",
                ));
            }
        }
        let mut reservation = ExecReservation {
            lease: lease.clone(),
            terminal_id: terminal_id.into(),
            committed: false,
        };
        if request.resource.uid != lease.request.resource.uid
            || request.resource.name != lease.request.resource.name
        {
            return Err(error(
                &lease.request,
                409,
                "Exec refers to a different Node; reopen the current Node",
            ));
        }
        let resource = lease
            .pod
            .lock()
            .await
            .clone()
            .ok_or_else(|| error(&lease.request, 409, "Debug Pod has no UID"))?;
        let client = lease
            .client
            .lock()
            .await
            .clone()
            .ok_or_else(|| error(&lease.request, 503, "Node debug client is unavailable"))?;
        verify_node(&lease.request, client.clone()).await?;
        let shell = request.shell.clone();
        let exec = ExecRequest {
            resource,
            container: "debugger".into(),
            shell,
            cols: request.cols,
            rows: request.rows,
        };
        let subscription = lease
            .terminal
            .start_with_command(
                owner,
                terminal_id,
                exec.clone(),
                vec!["chroot".into(), "/host".into(), exec.shell],
                async move { Ok(client) },
            )
            .await?;
        let active = {
            let state = lease.state.lock().await;
            state.phase == NodeDebugPhase::Ready
                && state.execs.contains(terminal_id)
                && !*lease.cancel.borrow()
        };
        if !active {
            lease.terminal.stop(owner, terminal_id).await;
            return Err(error(
                &lease.request,
                409,
                "Node shell closed while attaching",
            ));
        }
        reservation.committed = true;
        Ok(subscription)
    }
    /// Drop one terminal. The helper Pod survives while the last shell stays,
    /// and the final close collapses the lease automatically.
    pub async fn release_exec(&self, owner: &str, id: &str, terminal_id: &str) {
        let Ok(lease) = self.lease(owner, id).await else {
            return;
        };
        release_attachment(&lease, terminal_id).await;
        lease.terminal.stop(owner, terminal_id).await;
    }
    /// An aborted prepare closes only a lease without live or pending attachments.
    pub async fn cancel_prepare(&self, owner: &str, id: &str) {
        let Ok(lease) = self.lease(owner, id).await else {
            return;
        };
        let mut state = lease.state.lock().await;
        if state.execs.is_empty()
            && matches!(
                state.phase,
                NodeDebugPhase::Ready | NodeDebugPhase::Preparing
            )
        {
            state.phase = NodeDebugPhase::Closing;
            lease.collapse.send_replace(true);
        }
    }

    pub async fn write(
        &self,
        owner: &str,
        debug: &str,
        id: &str,
        data: String,
    ) -> Result<(), ApiError> {
        self.lease(owner, debug)
            .await?
            .terminal
            .write(owner, id, data)
            .await
    }
    pub async fn resize(
        &self,
        owner: &str,
        debug: &str,
        id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), ApiError> {
        self.lease(owner, debug)
            .await?
            .terminal
            .resize(owner, id, cols, rows)
            .await
    }
    pub async fn ack(&self, owner: &str, debug: &str, id: &str, seq: u64) -> Result<(), ApiError> {
        self.lease(owner, debug)
            .await?
            .terminal
            .acknowledge(owner, id, seq)
            .await
    }
    /// Explicitly end the session: stop all shells and delete the helper Pod.
    pub async fn stop(&self, owner: &str, id: &str) -> Result<(), ApiError> {
        let lease = {
            let leases = self.inner.leases.lock().await;
            match leases.get(&lease_key(owner, id)).cloned() {
                Some(lease) => lease,
                None => {
                    let mut cancelled = self.inner.cancelled.lock().await;
                    cancelled.push_back(lease_key(owner, id));
                    if cancelled.len() > 256 {
                        cancelled.pop_front();
                    }
                    return Ok(());
                }
            }
        };
        let cleanup_was_done = *lease.done.borrow();
        lease.cancel.send_replace(true);
        let mut done = lease.done.subscribe();
        tokio::time::timeout(Duration::from_secs(70), done.wait_for(|v| *v))
            .await
            .map_err(|_| {
                error(
                    &lease.request,
                    504,
                    "Debug Pod cleanup is still pending; retry",
                )
            })?
            .map_err(|_| error(&lease.request, 503, "Cleanup worker ended"))?;
        if lease.state.lock().await.phase == "cleanup_failed" {
            if cleanup_was_done {
                cleanup(&lease).await?;
            } else {
                return Err(lease.state.lock().await.error.clone().unwrap_or_else(|| {
                    error(&lease.request, 409, "Debug Pod cleanup needs retry")
                }));
            }
        }
        self.inner.leases.lock().await.remove(&lease_key(owner, id));
        Ok(())
    }
    pub async fn stop_owner(&self, owner: &str) {
        let ids: Vec<_> = self
            .inner
            .leases
            .lock()
            .await
            .values()
            .filter(|l| l.owner == owner)
            .map(|l| l.id.clone())
            .collect();
        let _ = futures::future::join_all(ids.iter().map(|id| self.stop(owner, id))).await;
    }
    pub async fn list_other(
        &self,
        client: Client,
        context: &str,
        namespace: &str,
    ) -> Result<Vec<DebugPod>, ApiError> {
        let request = NodeDebugRequest {
            resource: ResourceRef {
                query: ResourceQuery {
                    context: context.into(),
                    group: String::new(),
                    version: "v1".into(),
                    kind: "Node".into(),
                    namespace: None,
                },
                name: "unused".into(),
                uid: Some("unused".into()),
            },
            namespace: namespace.into(),
            image: "unused".into(),
        };
        validate_request(&request)?;
        let leases: Vec<_> = self.inner.leases.lock().await.values().cloned().collect();
        let mut active = Vec::new();
        for lease in leases {
            if ["preparing", "ready", "closing"].contains(&lease.state.lock().await.phase.as_str())
            {
                active.push(lease.id.clone());
            }
        }
        let pods: Api<Pod> = Api::namespaced(client, namespace);
        let list = bounded(
            &request,
            pods.list(&ListParams::default().labels(&format!("{LABEL}=true"))),
        )
        .await?;
        Ok(list
            .items
            .into_iter()
            .filter(|p| {
                p.metadata
                    .labels
                    .as_ref()
                    .and_then(|l| l.get(SESSION))
                    .is_some_and(|id| !active.contains(id))
            })
            .filter_map(|p| {
                Some(DebugPod {
                    resource: pod_ref(&request, &p)?,
                    node: p.spec.as_ref()?.node_name.clone().unwrap_or_default(),
                    phase: p
                        .status
                        .as_ref()
                        .and_then(|s| s.phase.clone())
                        .unwrap_or_default(),
                })
            })
            .collect())
    }
    pub async fn remove_other<C, CF>(
        &self,
        client: Client,
        resource: ResourceRef,
        confirm: C,
    ) -> Result<(), ApiError>
    where
        C: FnOnce(String) -> CF,
        CF: Future<Output = Result<bool, ApiError>>,
    {
        validate_query(&resource.query)?;
        if resource.query.kind != "Pod"
            || resource.query.namespace.is_none()
            || resource.uid.is_none()
        {
            return Err(ApiError::from_status(
                400,
                "A debug Pod reference with UID is required",
                "node_debug",
                Some(&resource.query.context),
            ));
        }
        let pods: Api<Pod> = Api::namespaced(client, resource.query.namespace.as_deref().unwrap());
        let request = NodeDebugRequest {
            resource: resource.clone(),
            namespace: resource.query.namespace.clone().unwrap(),
            image: String::new(),
        };
        let pod = bounded(&request, pods.get(&resource.name)).await?;
        let labels = pod
            .metadata
            .labels
            .as_ref()
            .ok_or_else(|| error(&request, 409, "Not a Kubiki debug Pod"))?;
        let id = labels
            .get(SESSION)
            .ok_or_else(|| error(&request, 409, "Missing debug session label"))?;
        if labels.get(LABEL).map(String::as_str) != Some("true")
            || !labels.contains_key(NODE_UID)
            || resource.name != format!("{PREFIX}{id}")
            || pod.metadata.uid != resource.uid
        {
            return Err(error(&request, 409, "Debug Pod ownership or UID changed"));
        }
        let leases: Vec<_> = self
            .inner
            .leases
            .lock()
            .await
            .values()
            .filter(|l| l.id == *id)
            .cloned()
            .collect();
        for lease in leases {
            if ["preparing", "ready", "closing"].contains(&lease.state.lock().await.phase.as_str())
            {
                return Err(error(
                    &request,
                    409,
                    "This debug Pod has an active managed session",
                ));
            }
        }
        let version = pod
            .metadata
            .resource_version
            .clone()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| error(&request, 409, "Debug Pod has no resourceVersion; refresh"))?;
        let review = format!("Delete debug Pod {:?}.", resource.name);
        if !confirm(review).await? {
            return Err(crate::core::mutations::cancelled(
                &resource,
                "Operation cancelled. Nothing was deleted",
            ));
        }
        let current = bounded(&request, pods.get(&resource.name)).await?;
        if current.metadata.uid != resource.uid
            || current.metadata.resource_version.as_deref() != Some(&version)
        {
            return Err(error(
                &request,
                409,
                "Debug Pod changed during confirmation; refresh and try again",
            ));
        }
        bounded(
            &request,
            pods.delete(
                &resource.name,
                &DeleteParams {
                    preconditions: Some(Preconditions {
                        uid: resource.uid.clone(),
                        resource_version: Some(version),
                    }),
                    propagation_policy: Some(kube::api::PropagationPolicy::Background),
                    ..DeleteParams::default()
                },
            ),
        )
        .await?;
        wait_deleted(
            &request,
            &pods,
            &resource.name,
            resource.uid.as_deref().unwrap(),
        )
        .await?;
        self.inner
            .leases
            .lock()
            .await
            .retain(|_, lease| lease.id != *id);
        Ok(())
    }
}
/// A helper Pod left behind by an earlier session can be reused without a new
/// dialog when its labels, UID and image match this request exactly.
async fn adopt_existing(
    request: &NodeDebugRequest,
    lease: &Lease,
    client: Client,
) -> Result<Option<ResourceRef>, ApiError> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), &request.namespace);
    let pod = match bounded(request, pods.get(&lease.name)).await {
        Ok(pod) => pod,
        Err(e) if e.status == Some(404) => return Ok(None),
        Err(e) => return Err(e),
    };
    let labels = pod.metadata.labels.clone().unwrap_or_default();
    let matches = labels.get(LABEL).map(String::as_str) == Some("true")
        && labels.get(SESSION) == Some(&lease.id)
        && labels.get(NODE_UID) == request.resource.uid.as_ref()
        && pod
            .spec
            .as_ref()
            .and_then(|s| s.containers.iter().find(|c| c.name == "debugger"))
            .is_some_and(|c| c.image.as_deref() == Some(request.image.as_str()));
    if !matches {
        return Err(error(
            request,
            409,
            "A helper Pod with this name exists but was configured differently. Remove it first or match its image",
        ));
    }
    let phase = pod
        .status
        .as_ref()
        .and_then(|s| s.phase.clone())
        .unwrap_or_default();
    if phase == "Failed" || phase == "Succeeded" {
        return Ok(None);
    }
    let resource = pod_ref(request, &pod)
        .ok_or_else(|| error(request, 503, "Existing debug Pod has no UID"))?;
    lease.state.lock().await.detail = "Reusing the healthy helper Pod".into();
    Ok(Some(resource))
}
async fn verify_node(request: &NodeDebugRequest, client: Client) -> Result<(), ApiError> {
    let nodes: Api<Node> = Api::all(client);
    let node = bounded(request, nodes.get(&request.resource.name)).await?;
    if node.metadata.uid != request.resource.uid || node.metadata.deletion_timestamp.is_some() {
        return Err(error(
            request,
            409,
            "Node was replaced or is being deleted; reopen the current Node",
        ));
    }
    if node
        .status
        .and_then(|s| s.node_info)
        .is_none_or(|info| info.operating_system != "linux")
    {
        return Err(error(
            request,
            400,
            "Managed node shell currently requires a Linux node",
        ));
    }
    Ok(())
}
async fn check_permissions(
    request: &NodeDebugRequest,
    name: &str,
    client: Client,
) -> Result<(), ApiError> {
    let reviews: Api<SelfSubjectAccessReview> = Api::all(client);
    for (verb, resource, subresource) in [
        ("create", "pods", None),
        ("get", "pods", None),
        ("delete", "pods", None),
        ("get", "pods", Some("exec")),
    ] {
        let review=serde_json::from_value(json!({"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":{"resourceAttributes":{"namespace":request.namespace,"verb":verb,"group":"","resource":resource,"subresource":subresource,"name":if verb=="create"{None}else{Some(name)}}}})).expect("valid review");
        let review = bounded(request, reviews.create(&PostParams::default(), &review)).await?;
        if !review.status.is_some_and(|s| s.allowed) {
            return Err(error(
                request,
                403,
                format!(
                    "Node shell requires {verb} pods{} in namespace {}",
                    subresource.map(|s| format!("/{s}")).unwrap_or_default(),
                    request.namespace
                ),
            ));
        }
    }
    Ok(())
}
fn pod_ref(request: &NodeDebugRequest, pod: &Pod) -> Option<ResourceRef> {
    Some(ResourceRef {
        query: ResourceQuery {
            context: request.resource.query.context.clone(),
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: pod.metadata.namespace.clone(),
        },
        name: pod.metadata.name.clone()?,
        uid: Some(pod.metadata.uid.clone()?),
    })
}
pub fn debug_pod(request: &NodeDebugRequest, id: &str) -> Pod {
    serde_json::from_value(json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":format!("{PREFIX}{id}"),"namespace":request.namespace,"labels":{LABEL:"true",SESSION:id,NODE_UID:request.resource.uid.as_deref().unwrap_or("")}},"spec":{
        "nodeName":request.resource.name,"hostPID":true,"hostIPC":true,"hostNetwork":true,"dnsPolicy":"ClusterFirstWithHostNet","restartPolicy":"Never","automountServiceAccountToken":false,"activeDeadlineSeconds":3600,"terminationGracePeriodSeconds":0,
        "tolerations":[{"operator":"Exists"}],"volumes":[{"name":"host-root","hostPath":{"path":"/","type":"Directory"}}],
        "containers":[{"name":"debugger","image":request.image,"imagePullPolicy":"IfNotPresent","command":["/bin/sh","-c","sleep 3600"],"securityContext":{"privileged":true,"runAsUser":0,"runAsNonRoot":false},"volumeMounts":[{"name":"host-root","mountPath":"/host"}],"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"500m","memory":"256Mi"}}}]
    }})).expect("bundled debug Pod spec is valid")
}
async fn provision(lease: &Lease, client: Client) -> Result<ResourceRef, ApiError> {
    let request = &lease.request;
    let mut cancel = lease.cancel.subscribe();
    let mut collapsing = lease.collapse.subscribe();
    if *cancel.borrow() || *collapsing.borrow_and_update() {
        return Err(error(request, 409, "Node shell preparation cancelled"));
    }
    let pods: Api<Pod> = Api::namespaced(client.clone(), &request.namespace);
    lease.attempted.store(true, Ordering::Release);
    // Do not cancel POST on user cancellation: first resolve its outcome, then clean up its UID.
    let created = match bounded(
        request,
        pods.create(&PostParams::default(), &debug_pod(request, &lease.id)),
    )
    .await
    {
        Ok(created) => created,
        Err(e) if e.status == Some(409) => {
            // A racing session of ours created the Pod first; adopt it only when
            // it is verifiably this exact helper.
            let existing = bounded(request, pods.get(&lease.name)).await?;
            let labels = existing.metadata.labels.clone().unwrap_or_default();
            if labels.get(LABEL).map(String::as_str) == Some("true")
                && labels.get(SESSION) == Some(&lease.id)
                && labels.get(NODE_UID) == request.resource.uid.as_ref()
                && existing.metadata.uid.is_some()
            {
                existing
            } else {
                return Err(error(
                    request,
                    409,
                    "Debug Pod name is taken by another object",
                ));
            }
        }
        Err(e) => return Err(e),
    };
    let resource = pod_ref(request, &created)
        .ok_or_else(|| error(request, 503, "Created debug Pod response has no UID"))?;
    *lease.pod.lock().await = Some(resource.clone());
    let wait = async {
        loop {
            if *cancel.borrow() || *collapsing.borrow_and_update() {
                return Err(error(request, 409, "Node shell preparation cancelled"));
            }
            let pod = bounded(request, pods.get(&lease.name)).await?;
            if pod.metadata.uid != resource.uid {
                return Err(error(request, 409, "Debug Pod was replaced"));
            }
            let status = pod.status.unwrap_or_default();
            let waiting = status
                .container_statuses
                .as_ref()
                .and_then(|all| all.iter().find(|c| c.name == "debugger"))
                .and_then(|c| c.state.as_ref());
            lease.state.lock().await.detail = waiting
                .and_then(|s| s.waiting.as_ref())
                .and_then(|s| s.reason.clone())
                .unwrap_or_else(|| {
                    status
                        .phase
                        .clone()
                        .unwrap_or_else(|| "Waiting for debug Pod".into())
                });
            if ["Failed", "Succeeded"].contains(&status.phase.as_deref().unwrap_or("")) {
                return Err(error(
                    request,
                    409,
                    format!(
                        "Debug Pod ended before exec: {}",
                        status.message.unwrap_or_default()
                    ),
                ));
            }
            if waiting.is_some_and(|s| s.running.is_some()) {
                verify_node(request, client.clone()).await?;
                return Ok(resource);
            }
            tokio::select! {_=cancel.wait_for(|v|*v)=>return Err(error(request,409,"Node shell preparation cancelled")),_=collapsing.wait_for(|v|*v)=>return Err(error(request,409,"Node shell preparation cancelled")),_=tokio::time::sleep(Duration::from_millis(500))=>{}}
        }
    };
    tokio::time::timeout(Duration::from_secs(120), wait)
        .await
        .map_err(|_| {
            error(
                request,
                504,
                "Debug Pod did not become ready in 120s; inspect image, admission and Node status",
            )
        })?
}
/// Consentless cleanup: the create consent already covers automatic Pod deletion
/// on close, so this path must never wait for a dialog. Label, UID checks plus a
/// UID precondition refuse anything that is not exactly this session's helper.
async fn cleanup(lease: &Lease) -> Result<(), ApiError> {
    if !lease.attempted.load(Ordering::Acquire) {
        return Ok(());
    }
    if !lease.state.lock().await.execs.is_empty() {
        // A shell attached between the collapse trigger and this cleanup; keep
        // the Pod and surface the anomaly for an explicit retry.
        return Err(error(
            &lease.request,
            409,
            "A shell session re-attached before cleanup; end it first",
        ));
    }
    let client = lease
        .client
        .lock()
        .await
        .clone()
        .ok_or_else(|| error(&lease.request, 503, "No client for debug Pod cleanup"))?;
    let pods: Api<Pod> = Api::namespaced(client, &lease.request.namespace);
    let pod = match bounded(&lease.request, pods.get(&lease.name)).await {
        Ok(p) => p,
        Err(e) if e.status == Some(404) => return Ok(()),
        Err(e) => return Err(e),
    };
    let labels = pod.metadata.labels.clone().unwrap_or_default();
    if labels.get(LABEL).map(String::as_str) != Some("true")
        || labels.get(SESSION) != Some(&lease.id)
        || labels.get(NODE_UID) != lease.request.resource.uid.as_ref()
    {
        return Err(error(
            &lease.request,
            409,
            "Debug Pod labels changed; refusing to delete another object",
        ));
    }
    let uid = pod
        .metadata
        .uid
        .clone()
        .ok_or_else(|| error(&lease.request, 409, "Debug Pod has no UID for cleanup"))?;
    if lease
        .pod
        .lock()
        .await
        .as_ref()
        .is_some_and(|p| p.uid.as_ref() != Some(&uid))
    {
        return Err(error(
            &lease.request,
            409,
            "Debug Pod UID changed; refusing to delete its replacement",
        ));
    }
    match bounded(
        &lease.request,
        pods.delete(
            &lease.name,
            &DeleteParams {
                preconditions: Some(Preconditions {
                    uid: Some(uid.clone()),
                    resource_version: None,
                }),
                ..DeleteParams::default()
            },
        ),
    )
    .await
    {
        Ok(_) => wait_deleted(&lease.request, &pods, &lease.name, &uid).await,
        Err(e) if e.status == Some(404) => Ok(()),
        Err(e) => Err(e),
    }
}
async fn wait_deleted(
    request: &NodeDebugRequest,
    pods: &Api<Pod>,
    name: &str,
    uid: &str,
) -> Result<(), ApiError> {
    let wait = async {
        loop {
            match bounded(request, pods.get(name)).await {
                Err(e) if e.status == Some(404) => return Ok(()),
                Err(e) => return Err(e),
                Ok(pod) if pod.metadata.uid.as_deref() != Some(uid) => return Ok(()),
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), wait)
        .await
        .map_err(|_| {
            error(
                request,
                504,
                "Debug Pod deletion is still pending; inspect finalizers and retry cleanup",
            )
        })?
}
