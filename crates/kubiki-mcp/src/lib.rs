//! A single MCP dispatcher shared by the integrated client and standalone hosts.
use kubiki_tools::*;
use rmcp::{
    ErrorData, RoleClient, RoleServer, ServerHandler, ServiceExt,
    model::*,
    service::{RequestContext, RunningService},
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
    gate: Arc<tokio::sync::Mutex<()>>,
    inflight: Arc<RequestLifecycle>,
    sinks: Arc<std::sync::Mutex<std::collections::HashMap<String, EventSink>>>,
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
            gate: Arc::default(),
            inflight: Arc::default(),
            sinks: Arc::default(),
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
        if self.session.scope.context.is_empty() {
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
        let revision = self.session.control()?.revision;
        let _guard = if self.host_owned {
            Some(tokio::select! { biased;
                _ = cancellation.cancelled() => return Err("Tool request cancelled while queued".into()),
                guard = self.gate.lock() => guard,
            })
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
        let _running = if self.host_owned {
            Some(self.session.begin_run(self.session.control()?.revision)?)
        } else {
            None
        };
        let sink = self
            .sinks
            .lock()
            .map_err(|_| "Event sink unavailable")?
            .get(&call.id)
            .cloned()
            .unwrap_or_else(|| self.emit.clone());
        let request_session = self.session.request_scope();
        let mut global_cancel = self.session.cancellation();
        let execution = self.executor.execute(&request_session, call, &sink);
        tokio::pin!(execution);
        let mut result = tokio::select! { biased;
            _ = cancellation.cancelled() => {request_session.cancel_request(); execution.await},
            _ = cancelled(&mut global_cancel) => {request_session.cancel_request(); execution.await},
            result = &mut execution => result,
        }?;
        if parallel_read_tool(&call.name) && !matches!(call.name.as_str(), "get_evidence"|"get_plan") && result.get("error").is_none() && result.is_object() {
            if let Ok(mut evidence) = self.session.evidence.lock() {
                if let Some(id) = evidence.save(&result) { result["evidenceId"] = json!(id); }
            }
        }
        Ok(result)
    }
}
impl ServerHandler for ClusterServer {
    fn get_info(&self) -> ServerConfig {
        {
            let mut config = ServerConfig::default();
            config.capabilities = ServerCapabilities::builder().enable_tools().build();
            config.instructions = Some(INVESTIGATION_GUIDANCE.into());
            config
        }
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = self
            .definitions()
            .map_err(|e| ErrorData::internal_error(e, None))?
            .into_iter()
            .map(|t| {
                let mut tool = Tool::new(
                    t.name.clone(),
                    t.description,
                    t.parameters.as_object().cloned().unwrap_or_default(),
                );
                let mut annotations = ToolAnnotations::new();
                annotations.read_only_hint = Some(!mutation_tool(&t.name));
                annotations.destructive_hint = Some(mutation_tool(&t.name));
                annotations.idempotent_hint = Some(false);
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

/// Creates a fresh bounded executor for each external call using the same core pool.
pub struct ConnectionExecutor {
    pub pool: kubiki_core::cluster::client::ClusterClientPool,
    pub journal: std::path::PathBuf,
    pub consent: Arc<dyn kubiki_tools::kubernetes::Consent>,
    pub permits: Arc<tokio::sync::Semaphore>,
    pub generation: std::sync::Mutex<Option<u64>>,
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
                session.invalidate();
                return Err("Cluster connection changed; reconnect the agent".into());
            }
            *pinned = Some(generation);
        }
        let tools = kubiki_tools::kubernetes::KubernetesTools::scoped(
            session,
            self.pool.clone(),
            Some(client),
            Some(generation),
            self.consent.clone(),
            self.journal.clone(),
            self.permits.clone(),
        )?;
        tools.execute(session, call, emit).await
    }
}

pub mod attached;

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
}
