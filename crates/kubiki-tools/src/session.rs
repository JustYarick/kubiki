use crate::*;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::{Mutex as AsyncMutex, watch};
static POLICY_REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub owner: String,
    pub scope: AgentScope,
    pub intent: AgentIntent,
    control: Arc<Mutex<Control>>,
    history: Arc<AsyncMutex<Vec<Turn>>>,
    cancel: watch::Sender<bool>,
    pub query_cursors: Arc<Mutex<CursorStore>>,
    pub working_scope: Arc<Mutex<WorkingScope>>,
    pub evidence: Arc<Mutex<EvidenceStore>>,
    pub plans: Arc<Mutex<PlanStore>>,
    memory: Arc<Mutex<ConversationMemory>>,
    approval_wait: Arc<Mutex<std::time::Duration>>,
}

#[derive(Clone)]
pub struct Control {
    pub mode: AgentMode,
    pub phase: AgentPhase,
    pub policy: AgentPolicy,
    pub policy_revision: u64,
    pub capabilities: ClusterCapabilities,
    pub revision: u64,
    pub active: bool,
    pub invalidated: bool,
}

impl Session {
    pub fn new(
        id: String,
        owner: String,
        scope: AgentScope,
        policy: AgentPolicy,
        capabilities: ClusterCapabilities,
    ) -> Self {
        let (cancel, _) = watch::channel(false);
        Self {
            id,
            owner,
            working_scope: Arc::new(Mutex::new(WorkingScope::initial(&scope))),
            scope,
            intent: AgentIntent::Chat,
            control: Arc::new(Mutex::new(Control {
                mode: AgentMode::Ask,
                phase: AgentPhase::Plan,
                policy,
                policy_revision: POLICY_REVISION.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                capabilities,
                revision: 0,
                active: false,
                invalidated: false,
            })),
            history: Arc::default(),
            query_cursors: Arc::default(),
            evidence: Arc::default(),
            plans: Arc::default(),
            memory: Arc::default(),
            approval_wait: Arc::default(),
            cancel,
        }
    }
    pub fn exclude_approval_wait(&self, wait: std::time::Duration) {
        if let Ok(mut total) = self.approval_wait.lock() {
            *total += wait;
        }
    }
    pub fn approval_wait(&self) -> std::time::Duration {
        self.approval_wait
            .lock()
            .map(|total| *total)
            .unwrap_or_default()
    }
    pub fn begin_run(&self, expected_revision: u64) -> Result<Running, String> {
        let mut state = self.control.lock().map_err(|_| "Session unavailable")?;
        if state.active || state.invalidated || state.revision != expected_revision {
            return Err("Session is active, invalidated or its permissions changed".into());
        }
        state.active = true;
        self.cancel.send_replace(false);
        Ok(Running(self.clone()))
    }
    pub async fn history_guard(&self) -> tokio::sync::MutexGuard<'_, Vec<Turn>> {
        self.history.lock().await
    }
    pub fn compact(&self, history: &mut Vec<Turn>, bytes: usize) -> Result<(), String> {
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| "Conversation memory unavailable")?;
        crate::memory::compact_history(history, bytes, &mut memory);
        Ok(())
    }
    pub fn control(&self) -> Result<Control, String> {
        self.control
            .lock()
            .map(|s| s.clone())
            .map_err(|_| "AI session lock failed".into())
    }
    pub fn mode(&self, mode: AgentMode) -> Result<(), String> {
        let mut state = self.control.lock().map_err(|_| "AI session lock failed")?;
        state.mode = mode;
        if mode == AgentMode::ReadOnly {
            state.phase = AgentPhase::Plan;
        }
        state.revision += 1;
        self.cancel.send_replace(true);
        Ok(())
    }
    pub fn phase(&self, phase: AgentPhase) -> Result<(), String> {
        let mut state = self.control.lock().map_err(|_| "AI session lock failed")?;
        if phase == AgentPhase::Action && state.mode == AgentMode::ReadOnly {
            return Err(
                "Action phase is not permitted in Read only mode; switch to Ask or Accept first"
                    .into(),
            );
        }
        state.phase = phase;
        state.revision += 1;
        self.cancel.send_replace(true);
        Ok(())
    }
    pub fn stop(&self) {
        if let Ok(mut state) = self.control.lock() {
            state.revision += 1;
        }
        self.cancel.send_replace(true);
    }
    pub fn invalidate(&self) {
        if let Ok(mut plans) = self.plans.lock() {
            plans.stale();
        }
        if let Ok(mut state) = self.control.lock() {
            state.invalidated = true;
            state.mode = AgentMode::ReadOnly;
            state.phase = AgentPhase::Plan;
            state.revision += 1;
        }
        self.cancel.send_replace(true);
    }
    pub fn begin_action(&self, revision: u64) -> Result<Running, String> {
        let mut state = self.control.lock().map_err(|_| "Session unavailable")?;
        if state.active
            || state.invalidated
            || state.revision != revision
            || state.phase != AgentPhase::Action
            || state.mode == AgentMode::ReadOnly
        {
            return Err("Action is unavailable, stale or already running".into());
        }
        state.active = true;
        self.cancel.send_replace(false);
        Ok(Running(self.clone()))
    }
    pub async fn record_execution(&self, call: ToolCall, result: Value) {
        let mut history = self.history.lock().await;
        history.push(Turn::Assistant(Completion {
            text: "User-requested execution of a reviewed plan step".into(),
            calls: vec![call.clone()],
            native: Value::Null,
            input_tokens: None,
            output_tokens: None,
        }));
        history.push(Turn::Tool { call, result });
        if let Ok(mut memory) = self.memory.lock() {
            crate::memory::compact_history(&mut history, 48_000, &mut memory);
        }
    }
    pub fn cancellation(&self) -> watch::Receiver<bool> {
        self.cancel.subscribe()
    }
    pub async fn seed_history(&self, turns: Vec<Turn>) {
        let mut history = self.history.lock().await;
        *history = turns;
    }
    pub async fn inspect_history(&self) -> Vec<Turn> {
        self.history.lock().await.clone()
    }
    /// Linearization point for dispatch. A permission change cannot authorize an
    /// old approval or a queued write. A dispatched request may still complete.
    pub fn authorize_dispatch(
        &self,
        revision: u64,
        target: &Target,
        operation: WriteOperation,
    ) -> Result<(), String> {
        let state = self.control.lock().map_err(|_| "AI session lock failed")?;
        if state.phase != AgentPhase::Action {
            return Err("Write operations are strictly prohibited during the Plan phase".into());
        }
        if state.revision != revision || state.invalidated || *self.cancel.borrow() || !state.active
        {
            return Err("AI operation was cancelled or its permissions changed".into());
        }
        state
            .policy
            .check_write(state.mode, &self.scope, target, operation)
    }
}

#[async_trait]
pub trait ToolExecutor: Send + Sync {
    async fn additional_tools(&self, _session: &Session) -> Result<Vec<ToolDefinition>, String> {
        Ok(vec![])
    }
    fn requires_action(&self, name: &str) -> bool {
        mutation_tool(name)
    }

    fn accepted_uid(&self, _operation_id: &str) -> Option<String> {
        None
    }
    async fn verify_change(
        &self,
        _session: &Session,
        _call: &ToolCall,
        _target: &Target,
        _uid: &str,
        _emit: &EventSink,
    ) -> Result<Value, String> {
        Ok(json!({"verification":"unavailable"}))
    }
    async fn execute(
        &self,
        session: &Session,
        call: &ToolCall,
        emit: &EventSink,
    ) -> Result<Value, String>;
}

/// Only explicit read tools may be reordered. Scope changes, proposals and writes
/// are barriers; mixed batches preserve the model's dispatch order.
pub fn mutation_tool(name: &str) -> bool {
    matches!(
        name,
        "apply_manifest"
            | "scale_workload"
            | "restart_workload"
            | "delete_resource"
            | "sync_argocd_app"
            | "reconcile_flux_resource"
    )
}

pub fn parallel_read_tool(name: &str) -> bool {
    matches!(
        name,
        "verify_workload"
            | "get_evidence"
            | "get_plan"
            | "get_resource"
            | "list_resources"
            | "summarize_resources"
            | "list_namespaces"
            | "resource_catalog"
            | "get_pod_diagnostics"
            | "get_workload_diagnostics"
            | "get_service_diagnostics"
            | "get_pvc_diagnostics"
            | "get_node_diagnostics"
            | "get_config_diagnostics"
            | "get_events"
            | "get_events_timeline"
            | "get_logs"
            | "get_metrics"
            | "list_helm_releases"
            | "get_helm_release"
            | "list_argocd_apps"
            | "get_argocd_app"
            | "list_flux_resources"
            | "get_flux_resource"
    )
}
pub struct Running(Session);
impl Drop for Running {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.control.lock() {
            state.active = false;
        }
    }
}

pub async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}
