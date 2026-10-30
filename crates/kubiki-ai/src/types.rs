use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    #[default]
    ReadOnly,
    Ask,
    Accept,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    Responses,
    OpenaiCompatible,
    Anthropic,
    Ollama,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub protocol: ProviderProtocol,
    /// API root, including /v1 where required. Credentials are stored separately.
    pub base_url: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationOptions {
    pub tool_use: Option<bool>,
    pub context_tokens: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f64>,
}
impl GenerationOptions {
    pub fn validate(&self) -> Result<(), String> {
        if self
            .context_tokens
            .is_some_and(|v| !(1024..=262144).contains(&v))
        {
            return Err("Local context window must be 1024–262144 tokens or omitted".into());
        }
        if self
            .max_output_tokens
            .is_some_and(|v| !(128..=65536).contains(&v))
            || self
                .temperature
                .is_some_and(|v| !v.is_finite() || !(0.0..=2.0).contains(&v))
        {
            return Err(
                "Output tokens must be 128–65536; temperature must be 0–2 or omitted".into(),
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    /// None means the provider did not advertise this capability.
    pub tools: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Default)]
pub struct Completion {
    pub text: String,
    pub calls: Vec<ToolCall>,
    /// Provider-native assistant items (including reasoning) must survive tool turns.
    pub native: Value,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Clone, Debug)]
pub enum Turn {
    User(String),
    Assistant(Completion),
    Tool { call: ToolCall, result: Value },
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
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    Error {
        message: String,
    },
}

pub type EventSink = std::sync::Arc<dyn Fn(AgentEvent) + Send + Sync>;
