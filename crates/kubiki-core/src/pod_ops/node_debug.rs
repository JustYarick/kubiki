//! Managed node debug Pods: explicit provisioning, UID-bound exec, cancellation and cleanup.
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
    collections::{HashMap, VecDeque},
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
    pub debug_session_id: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeDebugState {
    pub phase: String,
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
    cancel: watch::Sender<bool>,
    done: watch::Sender<bool>,
    state: Mutex<NodeDebugState>,
    client: Mutex<Option<Client>>,
    pod: Mutex<Option<ResourceRef>>,
    attempted: AtomicBool,
    terminal: PodTerminalManager,
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
impl NodeDebugManager {
    pub async fn prepare<F, C, CF>(
        &self,
        owner: &str,
        id: &str,
        request: NodeDebugRequest,
        client: F,
        confirm: C,
    ) -> Result<ResourceRef, ApiError>
    where
        F: Future<Output = Result<Client, ApiError>> + Send + 'static,
        C: FnOnce(String) -> CF + Send + 'static,
        CF: Future<Output = Result<bool, ApiError>> + Send + 'static,
    {
        validate_request(&request)?;
        if id.is_empty()
            || id.len() > 36
            || !id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err(error(&request, 400, "Invalid debug session ID"));
        }
        let (cancel, _) = watch::channel(false);
        let (done, _) = watch::channel(false);
        let name = format!("{PREFIX}{id}");
        let lease = Arc::new(Lease {
            owner: owner.into(),
            id: id.into(),
            name: name.clone(),
            request: request.clone(),
            cancel,
            done,
            state: Mutex::new(NodeDebugState {
                phase: "preparing".into(),
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
            let key = format!("{owner}:{id}");
            if self.inner.cancelled.lock().await.contains(&key) {
                return Err(error(
                    &request,
                    409,
                    "Node shell preparation cancelled before registration",
                ));
            }
            if leases.contains_key(&key) {
                return Err(error(&request, 409, "Debug session already exists"));
            }
            if leases.len() >= 8 {
                return Err(error(&request, 429, "Too many managed node debug sessions"));
            }
            leases.insert(key, lease.clone());
        }
        let (ready, rx) = oneshot::channel();
        let response_request = request.clone();
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            let mut cancellation = lease.cancel.subscribe();
            let result = tokio::select! { _=cancellation.wait_for(|v|*v)=>Err(error(&request,409,"Node shell preparation cancelled")), result=async {
                let client=tokio::time::timeout(Duration::from_secs(20),client).await.map_err(|_|error(&request,504,"Node debug client timed out"))??;
                *lease.client.lock().await=Some(client.clone());
                verify_node(&request,client.clone()).await?;
                check_permissions(&request,&lease.name,client.clone()).await?;
                let review = format!("CREATE privileged node-debug Pod\n{}\n\nManifest to create:\n{}\n\nThis grants root host access (hostPID/IPC/network, privileged, /host mount). Confirming also authorizes automatic deletion of this exact owned helper Pod by UID when the session ends or its window closes.\n\nCreate this Pod and authorize its cleanup?", crate::core::mutations::identity_summary(&request.resource, "(Node UID checked before create)"), serde_json::to_string_pretty(&debug_pod(&request, &lease.id)).expect("Pod serializes"));
                let reviewed_at = std::time::Instant::now();
                if !confirm(review).await? { return Err(crate::core::mutations::cancelled(&request.resource,"Operation cancelled. Debug Pod was not created")); }
                if reviewed_at.elapsed() > crate::core::mutations::REVIEW_TTL { return Err(error(&request,409,"Confirmation expired. Start and review again")); }
                verify_node(&request,client.clone()).await?;

                Ok::<_,ApiError>(client)
            }=>result };
            let provision = match result {
                Ok(client) => provision(&lease, client).await,
                Err(e) => Err(e),
            };
            match provision {
                Ok(resource) => {
                    *lease.pod.lock().await = Some(resource.clone());
                    lease.state.lock().await.phase = "ready".into();
                    if ready.send(Ok(resource)).is_err() {
                        lease.cancel.send_replace(true);
                    }
                    let _ = cancellation.wait_for(|v| *v).await;
                }
                Err(e) => {
                    let _ = ready.send(Err(e));
                }
            }
            lease.state.lock().await.phase = "closing".into();
            lease.terminal.stop_owner(&lease.owner).await;
            let cleanup = cleanup(&lease).await;
            let mut state = lease.state.lock().await;
            match cleanup {
                Ok(()) => {
                    state.phase = "closed".into();
                    state.detail = "Debug Pod removed".into();
                }
                Err(e) => {
                    state.phase = "cleanup_failed".into();
                    state.detail = "Debug Pod cleanup failed; retry deletion".into();
                    state.error = Some(e);
                }
            }
            let closed = state.phase == "closed";
            drop(state);
            lease.done.send_replace(true);
            if closed {
                if let Some(inner) = inner.upgrade() {
                    inner
                        .leases
                        .lock()
                        .await
                        .remove(&format!("{}:{}", lease.owner, lease.id));
                }
            }
        });
        rx.await
            .map_err(|_| error(&response_request, 503, "Node debug task ended unexpectedly"))?
    }
    async fn lease(&self, owner: &str, id: &str) -> Result<Arc<Lease>, ApiError> {
        self.inner
            .leases
            .lock()
            .await
            .get(&format!("{owner}:{id}"))
            .cloned()
            .ok_or_else(|| {
                ApiError::from_status(404, "Node debug session is closed", "node_debug", None)
            })
    }
    pub async fn status(&self, owner: &str, id: &str) -> Option<NodeDebugState> {
        let lease = self
            .inner
            .leases
            .lock()
            .await
            .get(&format!("{owner}:{id}"))
            .cloned()?;
        let state = lease.state.lock().await.clone();
        Some(state)
    }
    pub async fn attach(
        &self,
        owner: &str,
        id: &str,
        request: NodeExecRequest,
    ) -> Result<ExecSubscription, ApiError> {
        let lease = self.lease(owner, &request.debug_session_id).await?;
        if *lease.cancel.borrow() || lease.state.lock().await.phase != "ready" {
            return Err(error(
                &lease.request,
                409,
                "Debug Pod is not ready; start a new node shell",
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
        lease
            .terminal
            .start_with_command(
                owner,
                id,
                exec.clone(),
                vec!["chroot".into(), "/host".into(), exec.shell],
                async move { Ok(client) },
            )
            .await
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
    pub async fn stop(&self, owner: &str, id: &str) -> Result<(), ApiError> {
        let lease = {
            let leases = self.inner.leases.lock().await;
            match leases.get(&format!("{owner}:{id}")).cloned() {
                Some(lease) => lease,
                None => {
                    let mut cancelled = self.inner.cancelled.lock().await;
                    cancelled.push_back(format!("{owner}:{id}"));
                    if cancelled.len() > 256 {
                        cancelled.pop_front();
                    }
                    return Ok(());
                }
            }
        };
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
            cleanup(&lease).await?;
        }
        self.inner
            .leases
            .lock()
            .await
            .remove(&format!("{owner}:{id}"));
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
    where C: FnOnce(String) -> CF, CF: Future<Output = Result<bool, ApiError>> {
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
        let version = pod.metadata.resource_version.clone().filter(|v| !v.is_empty())
            .ok_or_else(|| error(&request,409,"Debug Pod has no resourceVersion; refresh"))?;
        let review = format!("DELETE debug Pod\n{}\n\nPod to delete:\n{}\n\nDeletion uses background garbage collection; dependents may also be removed. This action cannot be undone.\n\nDelete this Pod?", crate::core::mutations::identity_summary(&resource, &version), serde_json::to_string_pretty(&pod).expect("Pod serializes"));
        let reviewed_at = std::time::Instant::now();
        if !confirm(review).await? { return Err(crate::core::mutations::cancelled(&resource,"Operation cancelled. Nothing was deleted")); }
        if reviewed_at.elapsed() > crate::core::mutations::REVIEW_TTL { return Err(error(&request,409,"Confirmation expired. Refresh and review again")); }
        let current = bounded(&request, pods.get(&resource.name)).await?;
        if current.metadata.uid != resource.uid || current.metadata.resource_version.as_deref() != Some(&version) {
            return Err(error(&request,409,"Debug Pod changed during confirmation; refresh and review again"));
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
async fn provision(lease: &Lease, client: Client) -> Result<ResourceRef, ApiError> {
    let request = &lease.request;
    let mut cancel = lease.cancel.subscribe();
    if *cancel.borrow() {
        return Err(error(request, 409, "Node shell preparation cancelled"));
    }
    let pods: Api<Pod> = Api::namespaced(client.clone(), &request.namespace);
    lease.attempted.store(true, Ordering::Release);
    // Do not cancel POST on user cancellation: first resolve its outcome, then clean up its UID.
    let created = bounded(
        request,
        pods.create(&PostParams::default(), &debug_pod(request, &lease.id)),
    )
    .await?;
    let resource = pod_ref(request, &created)
        .ok_or_else(|| error(request, 503, "Created debug Pod response has no UID"))?;
    *lease.pod.lock().await = Some(resource.clone());
    let wait = async {
        loop {
            if *cancel.borrow() {
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
            tokio::select! {_=cancel.wait_for(|v|*v)=>return Err(error(request,409,"Node shell preparation cancelled")),_=tokio::time::sleep(Duration::from_millis(500))=>{}}
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
async fn cleanup(lease: &Lease) -> Result<(), ApiError> {
    if !lease.attempted.load(Ordering::Acquire) {
        return Ok(());
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
    let labels = pod.metadata.labels.unwrap_or_default();
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
