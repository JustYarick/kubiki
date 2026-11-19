//! A single MCP dispatcher shared by the integrated client and standalone hosts.
use kubiki_tools::*;
use rmcp::{
    ErrorData, RoleClient, RoleServer, ServerHandler, ServiceExt,
    model::*,
    service::{NotificationContext, RequestContext, RunningService, SubscriptionContext, SubscriptionSink},
};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Clone)]
pub struct ClusterServer {
    pub session: Session,
    pub executor: Arc<dyn ToolExecutor>,
    pub emit: EventSink,
    /// Set by the trusted bootstrap, never tool arguments.
    pub host_owned: bool,
    pub dynamic_scope: Option<Arc<std::sync::Mutex<AgentScope>>>,
    gate: Arc<tokio::sync::RwLock<()>>,
    inflight: Arc<RequestLifecycle>,
    sinks: Arc<std::sync::Mutex<std::collections::HashMap<String, EventSink>>>,
    peers: Arc<std::sync::Mutex<Vec<rmcp::service::Peer<RoleServer>>>>,
    subscriptions: Arc<std::sync::Mutex<Vec<(u64, SubscriptionSink)>>>,
    next_sub_id: Arc<std::sync::atomic::AtomicU64>,
}
impl ClusterServer {
    pub fn new(
        session: Session,
        executor: Arc<dyn ToolExecutor>,
        emit: EventSink,
        host_owned: bool,
    ) -> Self {
        Self {
            session,
            executor,
            emit,
            host_owned,
            dynamic_scope: None,
            gate: Arc::new(tokio::sync::RwLock::new(())),
            inflight: Arc::default(),
            sinks: Arc::default(),
            peers: Arc::default(),
            subscriptions: Arc::default(),
            next_sub_id: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        }
    }
    fn register_peer(&self, peer: &rmcp::service::Peer<RoleServer>) {
        if let Ok(mut peers) = self.peers.lock() {
            peers.retain(|p| !p.is_transport_closed());
            let already_registered = peers.iter().any(|existing| {
                match (existing.peer_info(), peer.peer_info()) {
                    (Some(a), Some(b)) => Arc::ptr_eq(&a, &b),
                    _ => false,
                }
            });
            if !already_registered {
                if peers.len() >= 16 {
                    peers.remove(0);
                }
                peers.push(peer.clone());
            }
        }
    }
    pub fn has_live_peers(&self) -> bool {
        if self.inflight.active.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            return true;
        }
        let live_peers = self
            .peers
            .lock()
            .map(|mut list| {
                list.retain(|p| !p.is_transport_closed());
                !list.is_empty()
            })
            .unwrap_or(false);
        if live_peers {
            return true;
        }
        self.subscriptions
            .lock()
            .map(|list| !list.is_empty())
            .unwrap_or(false)
    }
    pub fn is_invalidated(&self) -> bool {
        self.inflight.closed.load(std::sync::atomic::Ordering::SeqCst)
            || self
                .session
                .control()
                .map(|c| c.invalidated)
                .unwrap_or(true)
    }
    pub fn with_dynamic_scope(mut self, scope: Arc<std::sync::Mutex<AgentScope>>) -> Self {
        self.dynamic_scope = Some(scope);
        self
    }
    fn current_scope(&self) -> AgentScope {
        self.dynamic_scope
            .as_ref()
            .and_then(|s| s.lock().ok().map(|guard| guard.clone()))
            .unwrap_or_else(|| self.session.scope.clone())
    }
    pub fn rebind_scope(&self, next: &AgentScope) {
        self.session.rebind_scope(next);
        self.notify_tools_changed();
    }
    pub fn update_capabilities(&self, capabilities: ClusterCapabilities) {
        if self.session.update_capabilities(capabilities) {
            self.notify_tools_changed();
        }
    }
    pub fn update_policy(&self, policy: AgentPolicy) -> Result<(), String> {
        let scope = self.dynamic_scope.as_ref().and_then(|s| s.lock().ok().map(|g| g.clone()));
        self.session
            .set_access_with_scope(policy, None, scope.as_ref())?;
        self.notify_tools_changed();
        Ok(())
    }
    pub fn update_phase(&self, phase: AgentPhase) -> Result<(), String> {
        self.session.phase(phase)?;
        self.notify_tools_changed();
        Ok(())
    }
    pub fn update_access(&self, policy: AgentPolicy, phase: AgentPhase) -> Result<(), String> {
        let scope = self.dynamic_scope.as_ref().and_then(|s| s.lock().ok().map(|g| g.clone()));
        self.session
            .set_access_with_scope(policy, Some(phase), scope.as_ref())?;
        self.notify_tools_changed();
        Ok(())
    }
    fn notify_tools_changed(&self) {
        let peers = self
            .peers
            .lock()
            .map(|mut list| {
                list.retain(|p| !p.is_transport_closed());
                if list.len() > 16 {
                    let drain = list.len() - 16;
                    list.drain(0..drain);
                }
                list.clone()
            })
            .unwrap_or_default();
        for peer in peers {
            tokio::spawn(async move {
                let _ = peer.notify_tool_list_changed().await;
            });
        }
        let subscriptions = self
            .subscriptions
            .lock()
            .map(|list| list.iter().map(|(_, sink)| sink.clone()).collect::<Vec<_>>())
            .unwrap_or_default();
        for sink in subscriptions {
            tokio::spawn(async move {
                let _ = sink.notify_tool_list_changed().await;
            });
        }
    }
    /// Revoke undispatched work and retain receipts before the owning runtime exits.
    pub async fn shutdown(&self) {
        self.inflight
            .closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.session.invalidate();
        loop {
            let notified = self.inflight.done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .inflight
                .active
                .load(std::sync::atomic::Ordering::SeqCst)
                == 0
            {
                break;
            }
            notified.await;
        }
    }
    pub fn definitions(&self) -> Result<Vec<ToolDefinition>, String> {
        let c = self.session.control()?;
        let mut tools = tool_definitions(&c.policy, c.mode, c.phase, &c.capabilities);
        if !self.host_owned && self.session.scope.context.is_empty() {
            tools.retain(|t| t.name == "propose_manifests");
        }
        if self.host_owned {
            tools.retain(|t| !matches!(t.name.as_str(), "ask_user" | "propose_plan" | "get_plan"));
        }
        Ok(tools)
    }
    pub async fn execute(&self, call: &ToolCall) -> Result<Value, String> {
        self.execute_request(call, None).await
    }
    async fn execute_request(
        &self,
        call: &ToolCall,
        cancellation: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<Value, String> {
        let cancellation = cancellation.unwrap_or_default();
        let control = self.session.control()?;
        if control.invalidated {
            return Err("MCP session has been invalidated".into());
        }
        let revision = control.revision;
        let is_parallel_read = parallel_read_tool(&call.name);
        #[allow(dead_code)]
        enum GateGuard<'a> {
            Read(tokio::sync::RwLockReadGuard<'a, ()>),
            Write(tokio::sync::RwLockWriteGuard<'a, ()>),
        }
        let _guard = if self.host_owned {
            if is_parallel_read {
                Some(tokio::select! { biased;
                    _ = cancellation.cancelled() => return Err("Tool request cancelled while queued".into()),
                    guard = self.gate.read() => GateGuard::Read(guard),
                })
            } else {
                Some(tokio::select! { biased;
                    _ = cancellation.cancelled() => return Err("Tool request cancelled while queued".into()),
                    guard = self.gate.write() => GateGuard::Write(guard),
                })
            }
        } else {
            None
        };
        if self.session.control()?.revision != revision {
            return Err("Session changed while the tool was queued".into());
        }
        if self
            .inflight
            .closed
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("MCP connection closed".into());
        }
        if cancellation.is_cancelled() {
            return Err("Tool request cancelled before dispatch".into());
        }
        if !self.definitions()?.iter().any(|t| t.name == call.name) {
            return Err("Tool is unavailable for this connection".into());
        }
        #[allow(dead_code)]
        enum SessionGuard {
            Run(Running),
            Read(Reading),
        }
        let _running = if self.host_owned {
            let rev = self.session.control()?.revision;
            if is_parallel_read {
                Some(SessionGuard::Read(self.session.begin_read(rev)?))
            } else {
                Some(SessionGuard::Run(self.session.begin_run(rev)?))
            }
        } else {
            self.session.clear_cancellation_for_revision(revision);
            None
        };
        let sink = self
            .sinks
            .lock()
            .map_err(|_| "Event sink unavailable")?
            .get(&call.id)
            .cloned()
            .unwrap_or_else(|| self.emit.clone());
        let mut request_session = self.session.request_scope();
        if let Some(scope_source) = &self.dynamic_scope {
            let active_scope = scope_source
                .lock()
                .map_err(|_| "Cluster scope unavailable")?
                .clone();
            if active_scope.context.is_empty()
                && !matches!(call.name.as_str(), "propose_manifests" | "cluster_info")
            {
                return Err(
                    "No cluster is currently selected in Kubiki Desktop. Select a cluster in Kubiki and retry."
                        .into(),
                );
            }
            request_session.scope = active_scope;
        }
        let mut global_cancel = self.session.cancellation();
        let execution = self.executor.execute(&request_session, call, &sink);
        tokio::pin!(execution);
        let mut result = tokio::select! { biased;
            _ = cancellation.cancelled() => {request_session.cancel_request(); execution.await},
            _ = cancelled(&mut global_cancel) => {request_session.cancel_request(); execution.await},
            result = &mut execution => result,
        }?;
        if !mutation_tool(&call.name) && self.session.control()?.revision != revision {
            return Err("Read result belongs to revoked permissions".into());
        }
        if parallel_read_tool(&call.name)
            && !matches!(call.name.as_str(), "get_evidence" | "get_plan")
            && result.get("error").is_none_or(Value::is_null)
            && result.is_object()
        {
            if let Some(id) = self.session.save_evidence(revision, &result)? {
                result["evidenceId"] = json!(id);
            }
        }
        Ok(result)
    }
}

fn tool_metadata(name: &str) -> (&'static str, ToolAnnotations) {
    match name {
        "cluster_info" => (
            "Cluster Info & Triage",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "get_resource" => (
            "Get Resource",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "list_resources" => (
            "List Resources",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "summarize_resources" => (
            "Summarize Resources",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "get_neighborhood" => (
            "Get Resource Neighborhood",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "diagnose_resource" => (
            "Diagnose Resource",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "get_events" => (
            "Get Kubernetes Events",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "get_logs" => (
            "Get Pod Logs",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "get_metrics" => (
            "Get Resource Metrics",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "helm" => (
            "Helm Inspection & Preview",
            ToolAnnotations::new().read_only(true).open_world(true),
        ),
        "gitops" => (
            "GitOps Inspection (Argo CD / Flux)",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "verify_workload" => (
            "Verify Workload Rollout",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "get_evidence" => (
            "Get Collected Evidence",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "propose_manifests" => (
            "Propose & Dry-Run Manifests",
            ToolAnnotations::new().read_only(true).open_world(false),
        ),
        "set_working_scope" => (
            "Set Working Scope",
            ToolAnnotations::new()
                .read_only(false)
                .destructive(false)
                .idempotent(true)
                .open_world(false),
        ),
        "scale_workload" => (
            "Scale Workload",
            ToolAnnotations::new()
                .read_only(false)
                .destructive(false)
                .idempotent(true)
                .open_world(false),
        ),
        "restart_workload" => (
            "Restart Workload",
            ToolAnnotations::new()
                .read_only(false)
                .destructive(false)
                .idempotent(false)
                .open_world(false),
        ),
        "apply_manifest" => (
            "Apply Manifest",
            ToolAnnotations::new()
                .read_only(false)
                .destructive(true)
                .idempotent(true)
                .open_world(false),
        ),
        "delete_resource" => (
            "Delete Resource",
            ToolAnnotations::new()
                .read_only(false)
                .destructive(true)
                .idempotent(false)
                .open_world(false),
        ),
        _ => (
            "Kubiki Tool",
            ToolAnnotations::new()
                .read_only(!mutation_tool(name))
                .open_world(false),
        ),
    }
}

impl ServerHandler for ClusterServer {
    fn get_info(&self) -> ServerConfig {
        let mut config = ServerConfig::default();
        config.server_info = Implementation::new("kubiki-mcp", env!("CARGO_PKG_VERSION"))
            .with_title("Kubiki Kubernetes MCP");
        config.capabilities = ServerCapabilities::builder()
            .enable_tools()
            .enable_tool_list_changed()
            .enable_resources()
            .enable_prompts()
            .build();
        config.instructions = Some(INVESTIGATION_GUIDANCE.into());
        config
    }
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, ErrorData> {
        context.peer.set_peer_info(request.clone());
        self.register_peer(&context.peer);
        self.negotiate_initialize(&request)
    }
    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        self.register_peer(&context.peer);
    }
    fn accepted_subscription_filter(
        &self,
        requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        Some(requested.clone())
    }
    async fn listen(&self, context: SubscriptionContext) -> Result<(), ErrorData> {
        let id = self
            .next_sub_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut subs) = self.subscriptions.lock() {
            if subs.len() >= 16 {
                subs.remove(0);
            }
            subs.push((id, context.sink().clone()));
        }
        context.cancelled().await;
        if let Ok(mut subs) = self.subscriptions.lock() {
            subs.retain(|(existing, _)| *existing != id);
        }
        Ok(())
    }
    async fn list_resources(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        self.register_peer(&context.peer);
        Ok(ListResourcesResult {
            resources: vec![
                Resource::new("kubiki://session/info", "session-info")
                    .with_title("Active Kubiki Session & Policy Summary")
                    .with_description(
                        "Current Kubernetes context, namespace scope, working scope, policy summary and detected cluster capabilities.",
                    )
                    .with_mime_type("application/json"),
            ],
            ..Default::default()
        })
    }
    async fn list_resource_templates(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        self.register_peer(&context.peer);
        Ok(ListResourceTemplatesResult {
            resource_templates: vec![
                ResourceTemplate::new("kubiki://evidence/{id}", "evidence")
                    .with_title("Collected Evidence Snapshot")
                    .with_description(
                        "Policy-projected historical tool evidence captured earlier in this session (revoked automatically on policy change).",
                    )
                    .with_mime_type("application/json"),
            ],
            ..Default::default()
        })
    }
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        self.register_peer(&context.peer);
        if request.uri == "kubiki://session/info" {
            let control = self
                .session
                .control()
                .map_err(|e| ErrorData::internal_error(e, None))?;
            let scope = self.current_scope();
            let working = self
                .session
                .working_scope
                .lock()
                .map_err(|_| ErrorData::internal_error("Working scope unavailable", None))?
                .clone();
            let payload = json!({
                "context": scope.context,
                "allowedScope": scope,
                "workingScope": working,
                "mode": control.mode,
                "phase": control.phase,
                "capabilities": control.capabilities,
                "policy": control.policy.prompt_summary(),
            });
            return Ok(ReadResourceResult::new(vec![
                ResourceContents::text(payload.to_string(), request.uri)
                    .with_mime_type("application/json"),
            ])
            .into());
        }
        if let Some(id) = request.uri.strip_prefix("kubiki://evidence/") {
            let data = self
                .session
                .evidence
                .lock()
                .map_err(|_| ErrorData::internal_error("Evidence store unavailable", None))?
                .get(id)
                .map_err(|e| ErrorData::resource_not_found(e, None))?;
            return Ok(ReadResourceResult::new(vec![
                ResourceContents::text(data.to_string(), request.uri)
                    .with_mime_type("application/json"),
            ])
            .into());
        }
        Err(ErrorData::resource_not_found(
            format!("Unknown resource URI: {}", request.uri),
            None,
        ))
    }
    async fn list_prompts(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        self.register_peer(&context.peer);
        let prompts = vec![
            Prompt::new(
                "investigate-resource",
                Some("Structured root-cause investigation for a Kubernetes Pod, Workload, Service, PVC or Node."),
                Some(vec![
                    PromptArgument::new("kind").with_description("Kubernetes kind (e.g. Pod, Deployment, Service, PersistentVolumeClaim, Node)").with_required(true),
                    PromptArgument::new("name").with_description("Resource name").with_required(true),
                    PromptArgument::new("namespace").with_description("Namespace (omit for cluster-scoped kinds like Node)").with_required(false),
                    PromptArgument::new("group").with_description("API group (e.g. '' for core, 'apps' for Deployment)").with_required(false),
                    PromptArgument::new("version").with_description("API version (default: v1)").with_required(false),
                ]),
            )
            .with_title("Investigate Kubernetes Resource"),
            Prompt::new(
                "triage-namespace",
                Some("Fast health triage across a namespace or all permitted namespaces ('*')."),
                Some(vec![
                    PromptArgument::new("namespace").with_description("Namespace to triage, or '*' for all permitted namespaces").with_required(false),
                ]),
            )
            .with_title("Triage Namespace Health"),
            Prompt::new(
                "debug-node-pressure",
                Some("Diagnose Node NotReady, MemoryPressure, DiskPressure, scheduling failures and heavy Pods on a Node."),
                Some(vec![
                    PromptArgument::new("node").with_description("Node name").with_required(true),
                ]),
            )
            .with_title("Debug Node Pressure & Heavy Pods"),
            Prompt::new(
                "debug-rollout-regression",
                Some("Investigate a degraded Deployment/StatefulSet/DaemonSet rollout including template revision diff and child Pod failures."),
                Some(vec![
                    PromptArgument::new("kind").with_description("Deployment, StatefulSet or DaemonSet").with_required(true),
                    PromptArgument::new("name").with_description("Workload name").with_required(true),
                    PromptArgument::new("namespace").with_description("Namespace").with_required(true),
                ]),
            )
            .with_title("Debug Rollout Regression"),
        ];
        Ok(ListPromptsResult {
            prompts,
            ..Default::default()
        })
    }
    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, ErrorData> {
        self.register_peer(&context.peer);
        let arg = |key: &str| -> Option<String> {
            request
                .arguments
                .as_ref()
                .and_then(|m| m.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let (description, prompt_text) = match request.name.as_str() {
            "investigate-resource" => {
                let kind = arg("kind").ok_or_else(|| ErrorData::invalid_params("kind is required", None))?;
                let name = arg("name").ok_or_else(|| ErrorData::invalid_params("name is required", None))?;
                let namespace = arg("namespace");
                let group = arg("group").unwrap_or_else(|| {
                    match kind.as_str() {
                        "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" => "apps".into(),
                        "Job" | "CronJob" => "batch".into(),
                        "Ingress" | "NetworkPolicy" => "networking.k8s.io".into(),
                        _ => "".into(),
                    }
                });
                let version = arg("version").unwrap_or_else(|| "v1".into());
                let ns_note = namespace
                    .as_deref()
                    .map(|n| format!("in namespace `{n}`"))
                    .unwrap_or_else(|| "(cluster-scoped)".into());
                (
                    "Root-cause investigation workflow",
                    format!(
                        "Investigate Kubernetes {kind} `{name}` {ns_note} (group=`{group}`, version=`{version}`):\n\
1. Call `cluster_info(view='session')` if unsure of active context/policy.\n\
2. Call `diagnose_resource` on `{kind}/{name}` with default sections (health, neighborhood, events, logs).\n\
3. If configuration or missing ConfigMaps/Secrets are suspected, call `diagnose_resource` with `sections=['config']`.\n\
4. Follow exact `ownerReferences` and UIDs; check `get_events(mode='timeline')` and `get_logs` (with `tailLines` up to 5000 and `mode='lines'` + `contains`/`contextLines` if needed).\n\
5. Report observed facts, root cause, omitted/unknown policy-filtered fields, and concrete remediation steps."
                    ),
                )
            }
            "triage-namespace" => {
                let ns = arg("namespace").unwrap_or_else(|| "*".into());
                (
                    "Cluster/namespace health triage workflow",
                    format!(
                        "Triage Kubernetes health for namespace `{ns}`:\n\
1. Call `cluster_info(view='problems', namespace='{ns}')` for an immediate bounded overview of unhealthy Pods, degraded workloads, non-Bound PVCs, unhealthy Nodes and Warning Events.\n\
2. Use `summarize_resources(kind='Pod', namespace='{ns}', groupBy='reason')` and `groupBy='nodeName'` to spot systemic scheduling/eviction/node clusters.\n\
3. If GitOps or Helm is active in `cluster_info(view='session')`, inspect `gitops(action='list')` or `helm(action='list')` / `helm(action='storage')`.\n\
4. Deep-dive the top 1–3 root failures with `diagnose_resource`."
                    ),
                )
            }
            "debug-node-pressure" => {
                let node = arg("node").ok_or_else(|| ErrorData::invalid_params("node is required", None))?;
                (
                    "Node pressure and heavy-Pod investigation workflow",
                    format!(
                        "Investigate Node `{node}`:\n\
1. In parallel, call:\n\
   - `diagnose_resource(group='', version='v1', kind='Node', namespace=null, name='{node}', sections=['health','events','metrics'])`\n\
   - `get_metrics(kind='Node', namespace=null, name='{node}')` (returns host usage, capacity/allocatable, topPodsByMemoryRequest & topPodsByCpuRequest)\n\
   - `list_resources(group='', version='v1', kind='Pod', namespace='*', fieldSelector='spec.nodeName={node}', profile='scheduling', pageSize=50)`\n\
2. Check `get_metrics(..., historyMinutes=60)` to see whether Prometheus or session history shows a ramp-up.\n\
3. Check `get_events(namespace='*', mode='timeline', name='{node}', involvedKind='Node')` and Evicted/Pending Pods (`summarize_resources(kind='Pod', namespace='*', groupBy='reason')`).\n\
4. Identify the heaviest Pods and their owning controllers before recommending cordon/eviction."
                    ),
                )
            }
            "debug-rollout-regression" => {
                let kind = arg("kind").ok_or_else(|| ErrorData::invalid_params("kind is required", None))?;
                let name = arg("name").ok_or_else(|| ErrorData::invalid_params("name is required", None))?;
                let namespace = arg("namespace").ok_or_else(|| ErrorData::invalid_params("namespace is required", None))?;
                (
                    "Rollout regression investigation workflow",
                    format!(
                        "Investigate rollout regression for {kind} `{namespace}/{name}`:\n\
1. Call `diagnose_resource(group='apps', version='v1', kind='{kind}', namespace='{namespace}', name='{name}', sections=['health','diff','events','logs'])`.\n\
2. Inspect `revisionDiff` to see exact image, resource, probe, env-name or volume changes between the current and previous revisions.\n\
3. If ConfigMap/Secret changes are involved, run `diagnose_resource(..., sections=['config'])`.\n\
4. Summarize root cause and whether rollback or config fix is indicated."
                    ),
                )
            }
            other => {
                return Err(ErrorData::invalid_params(
                    format!("Unknown prompt: {other}"),
                    None,
                ));
            }
        };
        Ok(GetPromptResult::new(vec![PromptMessage::new_text(Role::User, prompt_text)])
            .with_description(description)
            .into())
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        self.register_peer(&context.peer);
        let tools = self
            .definitions()
            .map_err(|e| ErrorData::internal_error(e, None))?
            .into_iter()
            .map(|t| {
                let (title, annotations) = tool_metadata(&t.name);
                let mut tool = Tool::new(
                    t.name.clone(),
                    t.description,
                    t.parameters.as_object().cloned().unwrap_or_default(),
                );
                tool.title = Some(title.into());
                tool.annotations = Some(annotations);
                tool
            })
            .collect();
        Ok(ListToolsResult {
            tools,
            ..Default::default()
        })
    }
    async fn call_tool(
        &self,
        req: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let original = if !self.host_owned {
            context
                .meta
                .0
                .get("kubiki/callId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else {
            None
        };
        let call = ToolCall {
            id: original.unwrap_or_else(|| format!("mcp-{}", context.id)),
            name: req.name.to_string(),
            arguments: Value::Object(req.arguments.unwrap_or_default()),
        };
        // Signal cancellation without dropping a write future: dispatched writes must retain receipts.
        let server = self.clone();
        let request_cancel = context.ct.clone();
        // The task retains a dispatched write even if the MCP service disconnects.
        server
            .inflight
            .active
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let registration = ActiveRequest(server.inflight.clone());
        let work = tokio::spawn(async move {
            let _registration = registration;
            server.execute_request(&call, Some(request_cancel)).await
        });
        let value = work
            .await
            .map_err(|_| ErrorData::internal_error("Tool execution task failed", None))?;
        Ok(match value {
            Ok(value) => CallToolResult::structured(value),
            Err(error) => CallToolResult::structured_error(json!({"error":error})),
        }
        .into())
    }
}

pub struct McpExecutor {
    server: ClusterServer,
    client: RunningService<RoleClient, ()>,
    service: RunningService<RoleServer, ClusterServer>,
}
impl McpExecutor {
    pub async fn connect(server: ClusterServer) -> Result<Self, String> {
        let (client_io, server_io) = tokio::io::duplex(256 * 1024);
        let (c, s) = tokio::join!(().serve(client_io), server.clone().serve(server_io));
        Ok(Self {
            server,
            client: c.map_err(|e| e.to_string())?,
            service: s.map_err(|e| e.to_string())?,
        })
    }
}
impl Drop for McpExecutor {
    fn drop(&mut self) {
        self.service.cancellation_token().cancel();
        self.client.cancellation_token().cancel();
    }
}
#[async_trait::async_trait]
impl ToolExecutor for McpExecutor {
    fn accepted_uid(&self, id: &str) -> Option<String> {
        self.server.executor.accepted_uid(id)
    }
    async fn verify_change(
        &self,
        session: &Session,
        call: &ToolCall,
        target: &Target,
        uid: &str,
        emit: &EventSink,
    ) -> Result<Value, String> {
        self.server
            .executor
            .verify_change(session, call, target, uid, emit)
            .await
    }
    async fn execute(
        &self,
        _: &Session,
        call: &ToolCall,
        emit: &EventSink,
    ) -> Result<Value, String> {
        self.server
            .sinks
            .lock()
            .map_err(|_| "Event sink unavailable")?
            .insert(call.id.clone(), emit.clone());
        let _registration = SinkRegistration(self.server.sinks.clone(), call.id.clone());
        let mut req = CallToolRequestParams::new(call.name.clone()).with_arguments(
            call.arguments
                .as_object()
                .cloned()
                .ok_or("Tool arguments must be an object")?,
        );
        req.meta = Some(RequestMetaObject(MetaObject(serde_json::Map::from_iter([
            ("kubiki/callId".into(), json!(call.id)),
        ]))));
        let result = self
            .client
            .peer()
            .call_tool(req)
            .await
            .map_err(|e| e.to_string())?;
        let value = result
            .structured_content
            .ok_or("MCP returned no structured result")?;
        if result.is_error == Some(true) {
            return Err(value["error"].as_str().unwrap_or("MCP tool failed").into());
        }
        Ok(value)
    }
}

struct SinkRegistration(
    Arc<std::sync::Mutex<std::collections::HashMap<String, EventSink>>>,
    String,
);
impl Drop for SinkRegistration {
    fn drop(&mut self) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(&self.1);
        }
    }
}

/// Creates a fresh bounded executor for each external call using the same core pool and discovery cache.
pub struct ConnectionExecutor {
    pub pool: kubiki_core::cluster::client::ClusterClientPool,
    pub journal: std::path::PathBuf,
    pub consent: Arc<dyn kubiki_tools::kubernetes::Consent>,
    pub permits: Arc<tokio::sync::Semaphore>,
    pub generation: std::sync::Mutex<Option<u64>>,
    pub cache: Arc<kubiki_core::core::read_cache::ReadCache>,
}
#[async_trait::async_trait]
impl ToolExecutor for ConnectionExecutor {
    async fn execute(
        &self,
        session: &Session,
        call: &ToolCall,
        emit: &EventSink,
    ) -> Result<Value, String> {
        let (client, generation) = self
            .pool
            .get_client_with_generation(&session.scope.context)
            .await
            .map_err(|e| e.to_string())?;
        {
            let mut pinned = self
                .generation
                .lock()
                .map_err(|_| "Connection state unavailable")?;
            if pinned.is_some_and(|expected| expected != generation) {
                self.cache.clear();
                session.invalidate();
                return Err("Cluster connection changed; reconnect the agent".into());
            }
            *pinned = Some(generation);
        }
        let tools = kubiki_tools::kubernetes::KubernetesTools::scoped_with_cache(
            session,
            self.pool.clone(),
            Some(client),
            Some(generation),
            self.consent.clone(),
            self.journal.clone(),
            self.permits.clone(),
            self.cache.clone(),
        )?;
        tools.execute(session, call, emit).await
    }
}

pub mod attached;
pub mod http;

#[derive(Default)]
struct RequestLifecycle {
    active: std::sync::atomic::AtomicUsize,
    closed: std::sync::atomic::AtomicBool,
    done: tokio::sync::Notify,
}
struct ActiveRequest(Arc<RequestLifecycle>);
impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.0
            .active
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        self.0.done.notify_waiters();
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    use rmcp::service::PeerRequestOptions;
    struct Blocking {
        started: Arc<tokio::sync::Notify>,
        finish: Arc<tokio::sync::Notify>,
    }
    #[async_trait::async_trait]
    impl ToolExecutor for Blocking {
        async fn execute(
            &self,
            session: &Session,
            call: &ToolCall,
            _: &EventSink,
        ) -> Result<Value, String> {
            if call.arguments["name"] == "A" {
                self.started.notify_one();
            }
            let mut cancelled_request = session.cancellation();
            tokio::select! {
                _=cancelled(&mut cancelled_request)=>Err("This request was cancelled".into()),
                _=self.finish.notified()=>Ok(json!({"completed":call.arguments["name"]})),
            }
        }
    }
    async fn cancelling_b_does_not_stop_a(host_owned: bool) {
        let session = Session::new(
            "cancel-test".into(),
            "host".into(),
            AgentScope {
                context: "fixture".into(),
                namespaces: vec!["apps".into()],
                all_namespaces: false,
            },
            AgentPolicy::default(),
            ClusterCapabilities::default(),
        );
        let _run = if host_owned {
            None
        } else {
            Some(session.begin_run(0).unwrap())
        };
        let started = Arc::new(tokio::sync::Notify::new());
        let finish = Arc::new(tokio::sync::Notify::new());
        let server = ClusterServer::new(
            session,
            Arc::new(Blocking {
                started: started.clone(),
                finish: finish.clone(),
            }),
            Arc::new(|_| {}),
            host_owned,
        );
        let (c, s) = tokio::io::duplex(65536);
        let (client, service) = tokio::join!(().serve(c), server.clone().serve(s));
        let client = client.unwrap();
        let service = service.unwrap();
        let peer = client.peer().clone();
        let first = tokio::spawn(async move {
            peer.call_tool(
                CallToolRequestParams::new("get_resource")
                    .with_arguments(serde_json::from_value(json!({"name":"A"})).unwrap()),
            )
            .await
        });
        started.notified().await;
        let second:ClientRequest=serde_json::from_value(json!({"method":"tools/call","params":{"name":"get_resource","arguments":{"name":"B"}}})).unwrap();
        let second = client
            .peer()
            .send_request_with_option(second, PeerRequestOptions::no_options())
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while server
                .inflight
                .active
                .load(std::sync::atomic::Ordering::SeqCst)
                != 2
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let revision = server.session.control().unwrap().revision;
        second.cancel(Some("Cancel only B".into())).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while server
                .inflight
                .active
                .load(std::sync::atomic::Ordering::SeqCst)
                != 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(server.session.control().unwrap().revision, revision);
        assert!(!*server.session.cancellation().borrow());
        assert!(!first.is_finished());
        finish.notify_one();
        let first = first.await.unwrap().unwrap();
        assert_ne!(first.is_error, Some(true));
        assert_eq!(first.structured_content.unwrap()["completed"], "A");
        let _ = client.cancel().await;
        let _ = service.cancel().await;
    }
    #[tokio::test]
    async fn queued_cancellation_does_not_stop_running_host_request() {
        cancelling_b_does_not_stop_a(true).await;
    }
    #[tokio::test]
    async fn parallel_embedded_cancellation_is_request_local() {
        cancelling_b_does_not_stop_a(false).await;
    }
    #[tokio::test]
    async fn rebind_scope_cancels_inflight_reads_and_allows_subsequent_calls() {
        let session = Session::new(
            "rebind-test".into(),
            "host".into(),
            AgentScope {
                context: "fixture".into(),
                namespaces: vec!["apps".into()],
                all_namespaces: false,
            },
            AgentPolicy::default(),
            ClusterCapabilities::default(),
        );
        let started = Arc::new(tokio::sync::Notify::new());
        let finish = Arc::new(tokio::sync::Notify::new());
        let server = ClusterServer::new(
            session,
            Arc::new(Blocking {
                started: started.clone(),
                finish: finish.clone(),
            }),
            Arc::new(|_| {}),
            false,
        );
        let initial_revision = server.session.control().unwrap().revision;
        let mut rx = server.session.cancellation();
        assert!(!*rx.borrow());

        server.rebind_scope(&AgentScope {
            context: "staging".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        });
        assert!(server.session.control().unwrap().revision > initial_revision);
        assert!(*rx.borrow_and_update());

        // Subsequent parallel calls on the rebound scope clear the stale cancel and succeed.
        let (c, s) = tokio::io::duplex(65536);
        let (client, service) = tokio::join!(().serve(c), server.clone().serve(s));
        let client = client.unwrap();
        let service = service.unwrap();
        let peer = client.peer().clone();
        let call = tokio::spawn(async move {
            peer.call_tool(
                CallToolRequestParams::new("get_resource")
                    .with_arguments(serde_json::from_value(json!({"name": "A"})).unwrap()),
            )
            .await
        });
        started.notified().await;
        finish.notify_one();
        let res = call.await.unwrap().unwrap();
        assert_ne!(res.is_error, Some(true));
        let _ = client.cancel().await;
        let _ = service.cancel().await;
    }
}
