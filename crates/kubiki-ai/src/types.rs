pub use kubiki_tools::types::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    /// Budget hint from model metadata; never a provider runtime allocation.
    pub context_budget_tokens: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f64>,
}
impl GenerationOptions {
    pub fn validate(&self) -> Result<(), String> {
        if self
            .context_budget_tokens
            .is_some_and(|v| !(1024..=262144).contains(&v))
        {
            return Err("Model context budget must be 1024–262144 tokens or omitted".into());
        }
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
