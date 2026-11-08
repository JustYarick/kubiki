use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    ReadOnly,
    #[default]
    Ask,
    Accept,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentPhase {
    #[default]
    Plan,
    #[serde(alias = "action")]
    Tooling,
}

impl AgentPhase {
    #[allow(non_upper_case_globals)]
    pub const Action: AgentPhase = AgentPhase::Tooling;
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentScope {
    pub context: String,
    pub namespaces: Vec<String>,
    pub all_namespaces: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    #[serde(default)]
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentIntent {
    #[default]
    Chat,
    Investigate,
    Create,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanKind {
    #[default]
    Remediation,
    Investigation,
    Deployment,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanAction {
    Inspect,
    Manual,
    Scale,
    Restart,
    Apply,
    Delete,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanStep {
    pub id: String,
    pub title: String,
    pub action: PlanAction,
    pub target: Option<Target>,
    pub expected_uid: Option<String>,
    pub replicas: Option<u32>,
    pub yaml: Option<String>,
    pub reason: String,
    pub verification: String,
    pub risk: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub depends_on_accepted: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Partial,
    #[default]
    Draft,
    Ready,
    Running,
    Completed,
    Failed,
    Cancelled,
    Stale,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanArtifact {
    pub schema_version: u32,
    pub session_id: String,
    pub kind: PlanKind,
    pub diagnosis: String,
    pub uncertainty: String,
    pub steps: Vec<PlanStep>,
    pub id: String,
    pub version: u32,
    pub title: String,
    pub body_markdown: String,
    #[serde(default)]
    pub target_scope: Option<String>,
    pub scope: AgentScope,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    #[serde(default)]
    pub proposed_actions: Vec<String>,
    #[serde(default)]
    pub status: PlanStatus,
    #[serde(default)]
    pub policy_revision: u64,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    Status {
        status: String,
    },
    TextDelta {
        text: String,
    },
    ToolStarted {
        call: ToolCall,
    },
    ToolCompleted {
        id: String,
        result: Value,
    },
    PlanUpdated {
        plan: PlanArtifact,
    },
    Context {
        estimated_input_tokens: u64,
        budget_tokens: u64,
        reserved_output_tokens: u64,
    },
    GenerationMetrics {
        id: String, model: String, phase: AgentPhase,
        system_tokens: u64, tool_tokens: u64, history_tokens: u64,
        input_tokens: Option<u64>, output_tokens: Option<u64>,
        duration_ms: u64, tool_count: usize,
        resolved_model: Option<String>, cached_input_tokens: Option<u64>, reasoning_output_tokens: Option<u64>, first_token_ms: Option<u64>,
    },
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    Error {
        message: String,
    },
}

pub type EventSink = std::sync::Arc<dyn Fn(AgentEvent) + Send + Sync>;
