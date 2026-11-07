//! Provider wire formats are adapters, never authorization boundaries.
use crate::*;
use futures::StreamExt;
use reqwest::{Client, Url};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};

#[derive(Clone)]
pub struct ProviderClient {
    profile: ProviderProfile,
    key: String,
    client: Client,
}

impl ProviderClient {
    pub fn new(profile: ProviderProfile, key: String) -> Result<Self, String> {
        validate_profile(&profile)?;
        // reqwest's rustls-no-provider requires a process provider to be set.
        // Use the desktop's existing Ring backend, including when AI starts
        // before Kubernetes or the updater. A concurrent initializer may win.
        let _ = rustls::crypto::ring::default_provider().install_default();
        Ok(Self {
            profile,
            key,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| "Cannot initialize the AI HTTP client")?,
        })
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut request = self.client.request(
            method,
            format!("{}/{}", self.profile.base_url.trim_end_matches('/'), path),
        );
        if self.profile.protocol == ProviderProtocol::Anthropic {
            request = request.header("anthropic-version", "2023-06-01");
            request = request.header("anthropic-beta", "prompt-caching-2024-07-31");
            if !self.key.is_empty() {
                request = request.header("x-api-key", &self.key);
            }
        } else if !self.key.is_empty() {
            request = request.bearer_auth(&self.key);
        }
        request
    }

    async fn json(&self, path: &str, body: Option<Value>) -> Result<Value, String> {
        let request = self.request(
            if body.is_some() {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            path,
        );
        let response = if let Some(body) = body {
            request.json(&body)
        } else {
            request
        }
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|_| "Cannot connect to the AI endpoint; check address, network and TLS")?;
        let response = checked(response, !self.key.is_empty())?;
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "AI endpoint disconnected")?;
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err("AI endpoint response exceeds 4 MiB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "AI endpoint returned invalid JSON".into())
    }

    pub fn protocol(&self) -> ProviderProtocol {
        self.profile.protocol
    }

    pub async fn resolve_context_window(&self, model: &str) -> Option<u64> {
        if let Ok(url) = Url::parse(&self.profile.base_url) {
            if url.host_str() == Some("generativelanguage.googleapis.com") {
                let base = self.profile.base_url.trim_end_matches('/');
                if let Some(native_root) = base.strip_suffix("/openai") {
                    let short = model.strip_prefix("models/").unwrap_or(model);
                    let mut req = self
                        .client
                        .get(format!("{native_root}/models/{short}"))
                        .timeout(Duration::from_secs(5));
                    if !self.key.is_empty() {
                        req = req.header("x-goog-api-key", &self.key);
                    }
                    if let Ok(resp) = req.send().await {
                        if resp.status().is_success() {
                            if let Ok(val) = resp.json::<Value>().await {
                                if let Some(ctx) = val["inputTokenLimit"].as_u64() {
                                    return Some(ctx);
                                }
                            }
                        }
                    }
                }
            }
        }
        known_model_context_window(model)
    }

    async fn enrich_google_models(&self, models: &mut [ModelInfo]) {
        let Ok(url) = Url::parse(&self.profile.base_url) else {
            return;
        };
        if url.host_str() != Some("generativelanguage.googleapis.com") {
            return;
        }
        let base = self.profile.base_url.trim_end_matches('/');
        let Some(native_root) = base.strip_suffix("/openai") else {
            return;
        };
        let mut req = self
            .client
            .get(format!("{native_root}/models?pageSize=1000"))
            .timeout(Duration::from_secs(10));
        if !self.key.is_empty() {
            req = req.header("x-goog-api-key", &self.key);
        }
        let Ok(resp) = req.send().await else {
            return;
        };
        if !resp.status().is_success() {
            return;
        }
        let Ok(value) = resp.json::<Value>().await else {
            return;
        };
        let Some(entries) = value["models"].as_array() else {
            return;
        };
        for m in models.iter_mut() {
            let short = m.id.strip_prefix("models/").unwrap_or(&m.id);
            if let Some(entry) = entries.iter().find(|e| {
                e["name"]
                    .as_str()
                    .is_some_and(|n| n == m.id || n.strip_prefix("models/") == Some(short))
            }) {
                if let Some(ctx) = entry["inputTokenLimit"].as_u64() {
                    m.context_window = Some(ctx);
                }
                if let Some(out) = entry["outputTokenLimit"].as_u64() {
                    m.max_output_tokens = Some(out);
                }
                if let Some(display) = entry["displayName"].as_str().filter(|s| !s.is_empty()) {
                    m.name = display.into();
                }
            }
        }
    }

    pub async fn models(&self) -> Result<Vec<ModelInfo>, String> {
        let mut models = Vec::new();
        let mut path: String = if self.profile.protocol == ProviderProtocol::Ollama {
            "api/tags".into()
        } else {
            "models".into()
        };
        for _ in 0..20 {
            let value = self.json(&path, None).await?;
            models.extend(parse_models(self.profile.protocol, &value)?);
            if self.profile.protocol != ProviderProtocol::Anthropic || value["has_more"] != true {
                break;
            }
            let cursor = value["last_id"]
                .as_str()
                .ok_or("Provider model pagination omitted last_id")?;
            let mut url = Url::parse("https://pagination.invalid/models").unwrap();
            url.query_pairs_mut().append_pair("after_id", cursor);
            path = format!("models?{}", url.query().unwrap());
        }
        self.enrich_google_models(&mut models).await;
        models.sort_by(|a, b| a.id.cmp(&b.id));
        models.dedup_by(|a, b| a.id == b.id);
        if models.is_empty() {
            return Err(
                "This endpoint returned no models. Check credentials and the API root".into(),
            );
        }
        Ok(models)
    }

    pub async fn model_details(&self, id: &str) -> Result<ModelInfo, String> {
        if self.profile.protocol == ProviderProtocol::Ollama {
            let value = self.json("api/show", Some(json!({"model": id}))).await?;
            return Ok(ModelInfo {
                id: id.into(),
                name: id.into(),
                context_window: value["model_info"]
                    .as_object()
                    .and_then(|m| m.iter().find(|(k, _)| k.ends_with(".context_length")))
                    .and_then(|(_, v)| v.as_u64()),
                max_output_tokens: None,
                tools: value["capabilities"]
                    .as_array()
                    .map(|v| v.iter().any(|c| c == "tools")),
            });
        }
        self.models()
            .await?
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| "The selected model is no longer advertised by this provider".into())
    }

    pub async fn complete(
        &self,
        model: &str,
        options: &GenerationOptions,
        system: &str,
        turns: &[Turn],
        tools: &[ToolDefinition],
        emit: &EventSink,
    ) -> Result<Completion, String> {
        options.validate()?;
        if model.trim().is_empty() || model.len() > 256 {
            return Err("Select a model returned by this provider".into());
        }
        let (path, body) =
            build_request(self.profile.protocol, model, options, system, turns, tools);
        let started = std::time::Instant::now();
        let mut attempt = 0u32;
        let response = loop {
            let resp = self
                .request(reqwest::Method::POST, path)
                .json(&body)
                .send()
                .await
                .map_err(|_| "Cannot connect to the AI endpoint; check address, network and TLS")?;
            if resp.status().as_u16() == 429 && attempt < 3 {
                attempt += 1;
                let retry_after = resp
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .map(|s| s.clamp(1, 15))
                    .unwrap_or(2u64 * u64::from(attempt));
                tokio::time::sleep(Duration::from_secs(retry_after)).await;
                continue;
            }
            break checked(resp, !self.key.is_empty())?;
        };
        let ndjson = self.profile.protocol == ProviderProtocol::Ollama;
        let mut parser = StreamDecoder::new(ndjson);
        let mut accumulator = Accumulator { started: Some(started), ..Default::default() };
        let mut stream = response.bytes_stream();
        let mut total = 0;
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(120), stream.next())
            .await
            .map_err(|_| "AI provider has not sent data for 120 seconds")?
        {
            let chunk = chunk.map_err(|e| {
                format!("AI stream disconnected ({e}); no further tools were executed")
            })?;
            total += chunk.len();
            if total > 4 * 1024 * 1024 {
                return Err("AI response exceeds the 4 MiB run limit".into());
            }
            for frame in parser.push(&chunk)? {
                accumulator.frame(self.profile.protocol, &frame, emit)?;
            }
        }
        for frame in parser.finish()? {
            accumulator.frame(self.profile.protocol, &frame, emit)?;
        }
        accumulator.finish(self.profile.protocol)
    }
}

pub fn validate_profile(profile: &ProviderProfile) -> Result<(), String> {
    let url = Url::parse(&profile.base_url).map_err(|_| "Enter an absolute AI API URL")?;
    let local = url
        .host_str()
        .is_some_and(|h| h == "localhost" || h == "127.0.0.1" || h == "[::1]" || h == "::1");
    if profile.id.is_empty()
        || profile.id.len() > 80
        || !profile
            .id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || profile.name.trim().is_empty()
        || profile.name.len() > 120
        || profile.base_url.len() > 2048
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || url.scheme() == "http" && local)
    {
        return Err("Use HTTPS (or HTTP on loopback) without embedded credentials, query or fragment; provide a valid name and ID".into());
    }
    Ok(())
}

pub fn is_loopback_profile(profile: &ProviderProfile) -> bool {
    Url::parse(&profile.base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| ["localhost", "127.0.0.1", "[::1]", "::1"].contains(&host.as_str()))
}

fn checked(response: reqwest::Response, authenticated: bool) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    // The origin identifies a wrong provider without exposing URL paths, queries,
    // error bodies or credentials (gateways may echo any of these).
    let origin = response.url().origin().ascii_serialization();
    let hint = match response.status().as_u16() {
        401 if authenticated => {
            "Authentication failed: the configured API key was rejected. Update the saved key, or remove it if this server does not require authentication. Verify that the API root points to the intended server."
        }
        401 => {
            "Authentication required: no API key was sent. Check that the API root points to the intended server and enter its key if required. Local llama.cpp without --api-key needs no key."
        }
        403 => "Access denied. Check this provider's credentials and model permissions.",
        404 => {
            "Endpoint or model not found. Check the API root, protocol and selected model; OpenAI-compatible APIs normally include /v1 in the root."
        }
        429 => {
            "Rate limit or quota exceeded (HTTP 429). Wait a moment and retry, or check your provider's RPM/TPM quota limits."
        }
        _ => "Check the API root, model access and generation options.",
    };
    Err(format!(
        "AI endpoint {origin} returned HTTP {}. {hint}",
        response.status().as_u16()
    ))
}

pub fn known_model_context_window(id: &str) -> Option<u64> {
    let lower = id.to_ascii_lowercase();
    let short = lower.strip_prefix("models/").unwrap_or(&lower);
    if short.starts_with("gemini-") || short.contains("/gemini-") {
        Some(1_048_576)
    } else if short.starts_with("gpt-4.1") || short.contains("/gpt-4.1") {
        Some(1_047_576)
    } else if short.starts_with("gpt-5") || short.contains("/gpt-5") {
        Some(400_000)
    } else if short.starts_with("claude-3")
        || short.starts_with("claude-4")
        || short.starts_with("claude-sonnet")
        || short.starts_with("claude-opus")
        || short.starts_with("claude-haiku")
        || short.contains("/claude-")
        || short.starts_with("o3")
        || short.starts_with("o4-")
    {
        Some(200_000)
    } else if short.starts_with("gpt-4o")
        || short.starts_with("gpt-4-turbo")
        || short.starts_with("o1")
        || short.starts_with("deepseek-")
        || short.contains("/deepseek-")
        || short.starts_with("grok-")
    {
        Some(128_000)
    } else {
        None
    }
}

pub fn parse_models(protocol: ProviderProtocol, value: &Value) -> Result<Vec<ModelInfo>, String> {
    let entries = value[if protocol == ProviderProtocol::Ollama {
        "models"
    } else {
        "data"
    }]
    .as_array()
    .ok_or("The endpoint did not return a model catalog for this protocol")?;
    Ok(entries
        .iter()
        .filter_map(|m| {
            if m["lifecycle"] == "retired" {
                return None;
            }
            let id = m[if protocol == ProviderProtocol::Ollama {
                "name"
            } else {
                "id"
            }]
            .as_str()?;
            if id.is_empty() || id.len() > 256 {
                return None;
            }
            Some(ModelInfo {
                id: id.into(),
                name: m["display_name"]
                    .as_str()
                    .or(m["displayName"].as_str())
                    .or(m["name"].as_str())
                    .unwrap_or(id)
                    .into(),
                context_window: m["context_length"]
                    .as_u64()
                    .or(m["context_window"].as_u64())
                    .or(m["max_input_tokens"].as_u64())
                    .or(m["input_token_limit"].as_u64())
                    .or(m["inputTokenLimit"].as_u64())
                    .or(m["max_model_len"].as_u64())
                    .or(m["top_provider"]["context_length"].as_u64())
                    .or_else(|| known_model_context_window(id)),
                max_output_tokens: m["max_output_tokens"]
                    .as_u64()
                    .or(m["max_tokens"].as_u64())
                    .or(m["max_completion_tokens"].as_u64())
                    .or(m["output_token_limit"].as_u64())
                    .or(m["outputTokenLimit"].as_u64())
                    .or(m["top_provider"]["max_completion_tokens"].as_u64()),
                tools: m["capabilities"]["tools"]
                    .as_bool()
                    .or(m["capabilities"]["tools"]["supported"].as_bool())
                    .or(m["capabilities"]["tool_use"]["supported"].as_bool())
                    .or_else(|| {
                        m["supported_parameters"]
                            .as_array()
                            .map(|p| p.iter().any(|s| s == "tools"))
                    }),
            })
        })
        .collect())
}

// Native plan execution records protocol-neutral receipts. Rebuild a valid
// assistant/tool exchange when no provider-native replay item exists.
fn replay_assistant(protocol: ProviderProtocol, completion: &Completion) -> Vec<Value> {
    if completion.text.is_empty() && completion.calls.is_empty() {
        return Vec::new();
    }
    let mut items = match protocol {
        ProviderProtocol::Responses => {
            let mut items = Vec::new();
            if !completion.text.is_empty() {
                items.push(json!({"role":"assistant","content":completion.text}));
            }
            for call in &completion.calls {
                items.push(json!({"type":"function_call","call_id":call.id,"name":call.name,"arguments":call.arguments.to_string()}));
            }
            items
        }
        ProviderProtocol::Anthropic => {
            let mut content = Vec::new();
            if !completion.text.is_empty() {
                content.push(json!({"type":"text","text":completion.text}));
            }
            for call in &completion.calls {
                content.push(
                    json!({"type":"tool_use","id":call.id,"name":call.name,"input":call.arguments}),
                );
            }
            vec![json!({"role":"assistant","content":content})]
        }
        ProviderProtocol::Ollama => vec![
            json!({"role":"assistant","content":completion.text,"tool_calls":completion.calls.iter().map(|call|json!({"function":{"name":call.name,"arguments":call.arguments}})).collect::<Vec<_>>()}),
        ],
        ProviderProtocol::OpenaiCompatible => vec![
            json!({"role":"assistant","content":completion.text,"tool_calls":completion.calls.iter().map(|call|json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments.to_string()}})).collect::<Vec<_>>()}),
        ],
    };
    for item in &mut items {
        if item["tool_calls"]
            .as_array()
            .is_some_and(|calls| calls.is_empty())
        {
            item.as_object_mut().unwrap().remove("tool_calls");
        }
    }
    items
}

pub fn build_request(
    protocol: ProviderProtocol,
    model: &str,
    options: &GenerationOptions,
    system: &str,
    turns: &[Turn],
    tools: &[ToolDefinition],
) -> (&'static str, Value) {
    let mut messages = Vec::new();
    if ![ProviderProtocol::Responses, ProviderProtocol::Anthropic].contains(&protocol) {
        messages.push(json!({"role":"system", "content":system}));
    }
    for turn in turns {
        match turn {
            Turn::User(text) => messages.push(json!({"role":"user", "content":text})),
            Turn::Assistant(completion) if completion.native.is_null()=>messages.extend(replay_assistant(protocol,completion)),
            Turn::Assistant(completion) => match protocol {
                ProviderProtocol::Responses => { if let Some(items) = completion.native.as_array() { messages.extend(items.iter().cloned()); } }
                ProviderProtocol::Anthropic => messages.push(json!({"role":"assistant", "content":completion.native})),
                ProviderProtocol::Ollama => messages.push(completion.native.clone()),
                _ => messages.push(completion.native.clone()),
            },
            Turn::Tool { call, result } => match protocol {
                ProviderProtocol::Responses => messages.push(json!({"type":"function_call_output", "call_id":call.id, "output":result.to_string()})),
                ProviderProtocol::Anthropic => {
                    let block = json!({"type":"tool_result", "tool_use_id":call.id, "content":result.to_string()});
                    if let Some(last) = messages.last_mut().filter(|m| m["role"] == "user" && m["content"].is_array()) { last["content"].as_array_mut().unwrap().push(block); }
                    else { messages.push(json!({"role":"user", "content":[block]})); }
                }
                ProviderProtocol::Ollama => messages.push(json!({"role":"tool", "tool_name":call.name, "content":result.to_string()})),
                _ => messages.push(json!({"role":"tool", "tool_call_id":call.id, "content":result.to_string()})),
            },
        }
    }
    let mut definitions: Vec<_> = tools.iter().map(|t| match protocol {
        ProviderProtocol::Responses => json!({"type":"function", "name":t.name, "description":t.description,"parameters":t.parameters,"strict":false}),
        ProviderProtocol::Anthropic => json!({"name":t.name,"description":t.description,"input_schema":t.parameters}),
        _ => json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.parameters}}),
    }).collect();
    if protocol == ProviderProtocol::Anthropic {
        if let Some(last) = definitions.last_mut() {
            if let Some(map) = last.as_object_mut() {
                map.insert("cache_control".into(), json!({"type": "ephemeral"}));
            }
        }
        if let Some(last_msg) = messages.last_mut() {
            if let Some(text) = last_msg["content"].as_str().map(str::to_owned) {
                if !text.is_empty() {
                    last_msg["content"] = json!([{
                        "type": "text",
                        "text": text,
                        "cache_control": {"type": "ephemeral"}
                    }]);
                }
            } else if let Some(blocks) = last_msg["content"].as_array_mut() {
                if let Some(last_block) = blocks.last_mut().and_then(Value::as_object_mut) {
                    last_block.insert("cache_control".into(), json!({"type": "ephemeral"}));
                }
            }
        }
    }
    let (path, mut body) = match protocol {
        ProviderProtocol::Responses => (
            "responses",
            json!({"model":model,"instructions":system,"input":messages,"store":false,"stream":true,"include":["reasoning.encrypted_content"]}),
        ),
        ProviderProtocol::Anthropic => {
            let system_blocks = if !system.is_empty() {
                if let Some((prefix, working)) = system.split_once("\nWorking query defaults") {
                    json!([
                        {
                            "type": "text",
                            "text": prefix,
                            "cache_control": {"type": "ephemeral"}
                        },
                        {
                            "type": "text",
                            "text": format!("Working query defaults{working}")
                        }
                    ])
                } else {
                    json!([
                        {
                            "type": "text",
                            "text": system,
                            "cache_control": {"type": "ephemeral"}
                        }
                    ])
                }
            } else {
                json!([])
            };
            (
                "messages",
                json!({"model":model,"system":system_blocks,"messages":messages,"max_tokens":options.max_output_tokens.unwrap_or(4096),"stream":true}),
            )
        }
        ProviderProtocol::Ollama => (
            "api/chat",
            json!({"model":model,"messages":messages,"stream":true}),
        ),
        _ => (
            "chat/completions",
            json!({"model":model,"messages":messages,"stream":true,"stream_options":{"include_usage":true}}),
        ),
    };
    if !definitions.is_empty() {
        body["tools"] = json!(definitions);
    }
    if let Some(tokens) = options.max_output_tokens {
        match protocol {
            ProviderProtocol::Responses => body["max_output_tokens"] = json!(tokens),
            ProviderProtocol::Ollama => body["options"]["num_predict"] = json!(tokens),
            _ => body["max_tokens"] = json!(tokens),
        }
    }
    if protocol == ProviderProtocol::Ollama {
        if let Some(context) = options.context_tokens {
            body["options"]["num_ctx"] = json!(context);
        }
    }
    if let Some(temperature) = options.temperature {
        if protocol == ProviderProtocol::Ollama {
            body["options"]["temperature"] = json!(temperature);
        } else {
            body["temperature"] = json!(temperature);
        }
    }
    (path, body)
}

/// Byte buffering preserves UTF-8 split across network frames. SSE data lines
/// are joined only at an event boundary; NDJSON uses individual complete lines.
pub struct StreamDecoder {
    buffer: Vec<u8>,
    data: Vec<String>,
    ndjson: bool,
}
impl StreamDecoder {
    pub fn new(ndjson: bool) -> Self {
        Self {
            buffer: vec![],
            data: vec![],
            ndjson,
        }
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > 2 * 1024 * 1024 {
            return Err("AI stream frame exceeds 2 MiB".into());
        }
        let mut frames = Vec::new();
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = self.buffer.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "AI stream contains invalid UTF-8")?
                .trim_end_matches(['\r', '\n']);
            if self.ndjson {
                if !line.is_empty() {
                    frames.push(parse_frame(line)?);
                }
            } else if line.is_empty() {
                if !self.data.is_empty() {
                    let text = self.data.join("\n");
                    self.data.clear();
                    if text == "[DONE]" {
                        frames.push(json!({"kubiki_done":true}));
                    } else {
                        frames.push(parse_frame(&text)?);
                    }
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).into());
            }
        }
        Ok(frames)
    }
    pub fn finish(&mut self) -> Result<Vec<Value>, String> {
        self.push(if self.ndjson { b"\n" } else { b"\n\n" })
    }
}
fn parse_frame(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|_| "AI stream contains invalid JSON".into())
}

#[derive(Default)]
struct Accumulator {
    text: String,
    calls: BTreeMap<u64, (String, String, String, Option<Value>)>,
    native: Value,
    input: Option<u64>,
    output: Option<u64>,
    done: bool,
    truncated: bool,
    in_thinking: bool,
    started: Option<std::time::Instant>,
    first_token_ms: Option<u64>,
    resolved_model: Option<String>,
    cached_input: Option<u64>,
    reasoning_output: Option<u64>,
}
impl Accumulator {
    fn delta(&mut self, text: &str, emit: &EventSink) {
        if self.first_token_ms.is_none() && !text.is_empty() { self.first_token_ms = self.started.map(|at| at.elapsed().as_millis() as u64); }
        self.text.push_str(text);
        emit(AgentEvent::TextDelta { text: text.into() });
    }
    fn frame(
        &mut self,
        protocol: ProviderProtocol,
        value: &Value,
        emit: &EventSink,
    ) -> Result<(), String> {
        if value.get("error").is_some()
            || value["type"] == "error"
            || value["type"] == "response.failed"
        {
            return Err(
                "The provider reported an error during generation; no further tools were executed"
                    .into(),
            );
        }
        if let Some(model)=value["model"].as_str().or_else(||value["response"]["model"].as_str()).or_else(||value["message"]["model"].as_str()).filter(|s| s.len()<=512) { self.resolved_model=Some(model.into()); }
        let usage=value.get("usage").or_else(||value.pointer("/response/usage")).or_else(||value.pointer("/message/usage"));
        if let Some(usage)=usage {
            if let Some(n)=usage.pointer("/input_tokens_details/cached_tokens").or_else(||usage.pointer("/prompt_tokens_details/cached_tokens")).or_else(||usage.get("cache_read_input_tokens")).and_then(Value::as_u64) {self.cached_input=Some(n);}
            if let Some(n)=usage.pointer("/output_tokens_details/reasoning_tokens").or_else(||usage.pointer("/completion_tokens_details/reasoning_tokens")).and_then(Value::as_u64) {self.reasoning_output=Some(n);}
        }
        match protocol {
            ProviderProtocol::Responses => {
                if value["type"] == "response.output_text.delta" {
                    if let Some(text) = value["delta"].as_str() {
                        self.delta(text, emit);
                    }
                }
                if value["type"] == "response.completed" {
                    self.native = value["response"]["output"].clone();
                    self.done = true;
                    self.input = value["response"]["usage"]["input_tokens"].as_u64();
                    self.output = value["response"]["usage"]["output_tokens"].as_u64();
                }
                if value["type"] == "response.incomplete" {
                    self.truncated = true;
                }
            }
            ProviderProtocol::Anthropic => match value["type"].as_str().unwrap_or("") {
                "message_start" => {
                    self.input = value["message"]["usage"]["input_tokens"].as_u64().map(|n| n.saturating_add(value["message"]["usage"]["cache_read_input_tokens"].as_u64().unwrap_or(0)).saturating_add(value["message"]["usage"]["cache_creation_input_tokens"].as_u64().unwrap_or(0)));
                    self.native = json!([]);
                }
                "content_block_start" => {
                    let index = value["index"]
                        .as_u64()
                        .ok_or("Missing Anthropic block index")?
                        as usize;
                    let blocks = self
                        .native
                        .as_array_mut()
                        .ok_or("Missing Anthropic message_start")?;
                    while blocks.len() <= index {
                        blocks.push(Value::Null);
                    }
                    blocks[index] = value["content_block"].clone();
                    if blocks[index]["type"] == "tool_use" {
                        self.calls.insert(
                            index as u64,
                            (
                                blocks[index]["id"].as_str().unwrap_or("").into(),
                                blocks[index]["name"].as_str().unwrap_or("").into(),
                                String::new(),
                                None,
                            ),
                        );
                    }
                }
                "content_block_delta" => {
                    let index = value["index"].as_u64().ok_or("Missing block index")?;
                    if let Some(text) = value["delta"]["text"].as_str() {
                        self.delta(text, emit);
                        if let Some(block) = self.native.get_mut(index as usize) {
                            let current = block["text"].as_str().unwrap_or("").to_owned();
                            block["text"] = json!(current + text);
                        }
                    }
                    if let Some(args) = value["delta"]["partial_json"].as_str() {
                        self.calls
                            .get_mut(&index)
                            .ok_or("Tool arguments without tool block")?
                            .2
                            .push_str(args);
                    }
                    for field in ["thinking", "signature"] {
                        if let Some(text) = value["delta"][field].as_str() {
                            if let Some(block) = self.native.get_mut(index as usize) {
                                let previous = block[field].as_str().unwrap_or("").to_owned();
                                block[field] = json!(previous + text);
                            }
                        }
                    }
                }
                "message_delta" => {
                    self.output = value["usage"]["output_tokens"].as_u64();
                    self.truncated = value["delta"]["stop_reason"] == "max_tokens";
                }
                "message_stop" => self.done = true,
                _ => {}
            },
            ProviderProtocol::Ollama => {
                if let Some(thinking) = value["message"]["thinking"].as_str() {
                    if !thinking.is_empty() {
                        if !self.in_thinking {
                            self.in_thinking = true;
                            self.delta("<think>", emit);
                        }
                        self.delta(thinking, emit);
                    }
                }
                if let Some(text) = value["message"]["content"].as_str() {
                    if !text.is_empty() {
                        if self.in_thinking {
                            self.in_thinking = false;
                            self.delta("</think>\n", emit);
                        }
                        self.delta(text, emit);
                    }
                }
                if let Some(calls) = value["message"]["tool_calls"].as_array() {
                    if self.in_thinking {
                        self.in_thinking = false;
                        self.delta("</think>\n", emit);
                    }
                    let blocks = if let Some(blocks) = self.native.as_array_mut() {
                        blocks
                    } else {
                        self.native = json!([]);
                        self.native.as_array_mut().unwrap()
                    };
                    blocks.extend(calls.iter().cloned());
                }
                if value["done"] == true {
                    if self.in_thinking {
                        self.in_thinking = false;
                        self.delta("</think>\n", emit);
                    }
                    self.done = true;
                    self.truncated = value["done_reason"] == "length";
                    self.input = value["prompt_eval_count"].as_u64();
                    self.output = value["eval_count"].as_u64();
                }
            }
            ProviderProtocol::OpenaiCompatible => {
                if value["kubiki_done"] == true {
                    self.done = true;
                }
                if let Some(reasoning) = value["choices"][0]["delta"]["reasoning_content"]
                    .as_str()
                    .or_else(|| value["choices"][0]["delta"]["thinking"].as_str())
                {
                    if !reasoning.is_empty() {
                        if !self.in_thinking {
                            self.in_thinking = true;
                            self.delta("<think>", emit);
                        }
                        self.delta(reasoning, emit);
                    }
                }
                if let Some(text) = value["choices"][0]["delta"]["content"].as_str() {
                    if !text.is_empty() {
                        if self.in_thinking {
                            self.in_thinking = false;
                            self.delta("</think>\n", emit);
                        }
                        self.delta(text, emit);
                    }
                }
                if let Some(calls) = value["choices"][0]["delta"]["tool_calls"].as_array() {
                    if self.in_thinking {
                        self.in_thinking = false;
                        self.delta("</think>\n", emit);
                    }
                    for call in calls {
                        let call_id = call["id"].as_str().filter(|s| !s.is_empty());
                        let call_name =
                            call["function"]["name"].as_str().filter(|s| !s.is_empty());
                        let index = if let Some(idx) = call["index"].as_u64() {
                            idx
                        } else if let Some(id) = call_id {
                            if let Some((&existing_idx, _)) = self.calls.iter().find(
                                |(_, (existing_id, existing_name, _, _))| {
                                    existing_id == id
                                        && (call_name.is_none() || existing_name.is_empty())
                                },
                            ) {
                                existing_idx
                            } else if let Some((&last_idx, (existing_id, existing_name, _, _))) =
                                self.calls.iter().next_back()
                            {
                                if existing_id.is_empty() && existing_name.is_empty() {
                                    last_idx
                                } else {
                                    last_idx + 1
                                }
                            } else {
                                0
                            }
                        } else if call_name.is_some() {
                            if let Some((&last_idx, (_, existing_name, _, _))) =
                                self.calls.iter().next_back()
                            {
                                if existing_name.is_empty() {
                                    last_idx
                                } else {
                                    last_idx + 1
                                }
                            } else {
                                0
                            }
                        } else {
                            self.calls.keys().next_back().copied().unwrap_or(0)
                        };
                        let entry = self.calls.entry(index).or_default();
                        if let Some(id) = call_id {
                            if entry.0 != id {
                                entry.0.push_str(id);
                            }
                        }
                        if let Some(name) = call_name {
                            if entry.1 != name {
                                entry.1.push_str(name);
                            }
                        }
                        if let Some(args) = call["function"]["arguments"].as_str() {
                            entry.2.push_str(args);
                        } else if let Some(args_obj) =
                            call["function"].get("arguments").filter(|v| v.is_object())
                        {
                            entry.2.push_str(&args_obj.to_string());
                        }
                        if let Some(extra) = call.get("extra_content") {
                            entry.3 = Some(extra.clone());
                        }
                    }
                }
                if let Some(reason) = value["choices"][0]["finish_reason"].as_str() {
                    if self.in_thinking {
                        self.in_thinking = false;
                        self.delta("</think>\n", emit);
                    }
                    self.done = true;
                    self.truncated = reason == "length" || reason == "content_filter";
                }
                if value.get("usage").is_some() {
                    self.input = value["usage"]["prompt_tokens"].as_u64();
                    self.output = value["usage"]["completion_tokens"].as_u64();
                }
            }
        }
        Ok(())
    }
    fn finish(mut self, protocol: ProviderProtocol) -> Result<Completion, String> {
        if self.in_thinking {
            self.in_thinking = false;
            self.text.push_str("</think>\n");
        }
        if !self.done || self.truncated {
            return Err("The AI response was interrupted or reached its output limit. No tools from this response were executed".into());
        }
        let mut calls = Vec::new();
        if protocol == ProviderProtocol::Responses {
            for item in self
                .native
                .as_array()
                .ok_or("Missing completed response items")?
            {
                if item["type"] == "function_call" {
                    calls.push(ToolCall {
                        id: item["call_id"]
                            .as_str()
                            .ok_or("Missing tool call ID")?
                            .into(),
                        name: item["name"].as_str().ok_or("Missing tool name")?.into(),
                        arguments: serde_json::from_str(
                            item["arguments"].as_str().ok_or("Missing arguments")?,
                        )
                        .map_err(|_| "Invalid tool arguments")?,
                    });
                }
            }
        } else if protocol == ProviderProtocol::Ollama {
            for (i, item) in self
                .native
                .as_array()
                .unwrap_or(&Vec::new())
                .iter()
                .enumerate()
            {
                calls.push(ToolCall {
                    id: format!("ollama-{i}"),
                    name: item["function"]["name"]
                        .as_str()
                        .ok_or("Missing tool name")?
                        .into(),
                    arguments: item["function"]["arguments"].clone(),
                });
            }
            self.native = json!({"role":"assistant", "content":self.text, "tool_calls":self.native.as_array().cloned().unwrap_or_default()});
        } else {
            let mut seen_ids = std::collections::HashSet::new();
            let mut tool_calls_native = Vec::new();
            for (index, (id, name, args, extra)) in &self.calls {
                if name.is_empty()
                    || (id.is_empty() && protocol != ProviderProtocol::OpenaiCompatible)
                {
                    return Err("Provider returned an incomplete tool call".into());
                }
                let mut call_id = if id.is_empty() {
                    format!("call-{index}")
                } else {
                    id.clone()
                };
                if protocol == ProviderProtocol::OpenaiCompatible
                    && !seen_ids.insert(call_id.clone())
                {
                    call_id = format!("{call_id}-{index}");
                    seen_ids.insert(call_id.clone());
                }
                let arguments: Value = if args.is_empty() && protocol == ProviderProtocol::Anthropic
                {
                    self.native[*index as usize]["input"].clone()
                } else {
                    serde_json::from_str(if args.is_empty() { "{}" } else { args })
                        .map_err(|_| "Provider returned invalid tool arguments")?
                };
                if protocol == ProviderProtocol::Anthropic {
                    self.native[*index as usize]["input"] = arguments.clone();
                }
                if protocol == ProviderProtocol::OpenaiCompatible {
                    let mut tc = json!({
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": arguments.to_string()
                        }
                    });
                    if let Some(extra) = extra {
                        tc["extra_content"] = extra.clone();
                    }
                    tool_calls_native.push(tc);
                }
                calls.push(ToolCall {
                    id: call_id,
                    name: name.clone(),
                    arguments,
                });
            }
            if protocol == ProviderProtocol::OpenaiCompatible {
                self.native = json!({"role":"assistant","content":if self.text.is_empty() {Value::Null} else {json!(self.text)},"tool_calls":tool_calls_native});
                if calls.is_empty() {
                    self.native.as_object_mut().unwrap().remove("tool_calls");
                }
            }
        }
        if calls.len() > 20 {
            return Err("Provider requested too many tools in one response".into());
        }
        let mut ids = std::collections::HashSet::new();
        if calls
            .iter()
            .any(|c| !ids.insert(&c.id) || !c.arguments.is_object())
        {
            return Err("Provider returned duplicate IDs or invalid tool arguments".into());
        }
        Ok(Completion {
            text: self.text,
            calls,
            native: self.native,
            input_tokens: self.input,
            output_tokens: self.output,
            resolved_model:self.resolved_model, cached_input_tokens:self.cached_input, reasoning_output_tokens:self.reasoning_output, first_token_ms:self.first_token_ms,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sink() -> EventSink {
        std::sync::Arc::new(|_| {})
    }

    #[test]
    fn sse_preserves_unicode_split_between_network_chunks_and_multiple_data_lines() {
        let bytes = "data: {\"text\":\n".to_owned() + "data: \"привет\"}\r\n\r\ndata: [DONE]\n\n";
        let mut decoder = StreamDecoder::new(false);
        let mut frames = vec![];
        for byte in bytes.as_bytes() {
            frames.extend(decoder.push(&[*byte]).unwrap());
        }
        frames.extend(decoder.finish().unwrap());
        assert_eq!(
            frames,
            vec![json!({"text":"привет"}), json!({"kubiki_done":true})]
        );
    }

    #[test]
    fn compatible_stream_assembles_tool_arguments_before_execution() {
        let mut stream = Accumulator::default();
        for frame in [
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"get_resource","arguments":"{\"kind\":"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Pod\"}"}}]},"finish_reason":"tool_calls"}]}),
        ] {
            stream
                .frame(ProviderProtocol::OpenaiCompatible, &frame, &sink())
                .unwrap();
        }
        let completion = stream.finish(ProviderProtocol::OpenaiCompatible).unwrap();
        assert_eq!(completion.calls[0].arguments, json!({"kind":"Pod"}));
        assert_eq!(
            completion.native["tool_calls"][0]["function"]["arguments"],
            "{\"kind\":\"Pod\"}"
        );
    }

    #[test]
    fn gemini_openai_compatible_stream_handles_unindexed_tool_calls_and_preserves_thought_signature() {
        let mut stream = Accumulator::default();
        for frame in [
            json!({
                "choices": [{
                    "index": 0,
                    "delta": {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "function-call-101",
                                "type": "function",
                                "function": {
                                    "name": "diagnose_resource",
                                    "arguments": "{\"kind\":\"Pod\",\"name\":\"web\",\"namespace\":\"default\"}"
                                },
                                "extra_content": {
                                    "google": {
                                        "thought_signature": "opaque-gemini-thought-sig"
                                    }
                                }
                            },
                            {
                                "id": "function-call-102",
                                "type": "function",
                                "function": {
                                    "name": "get_events_timeline",
                                    "arguments": "{\"namespace\":\"default\"}"
                                }
                            }
                        ]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
        ] {
            stream
                .frame(ProviderProtocol::OpenaiCompatible, &frame, &sink())
                .unwrap();
        }
        let completion = stream.finish(ProviderProtocol::OpenaiCompatible).unwrap();
        assert_eq!(completion.calls.len(), 2);
        assert_eq!(completion.calls[0].id, "function-call-101");
        assert_eq!(completion.calls[0].name, "diagnose_resource");
        assert_eq!(
            completion.calls[0].arguments,
            json!({"kind":"Pod","name":"web","namespace":"default"})
        );
        assert_eq!(completion.calls[1].id, "function-call-102");
        assert_eq!(completion.calls[1].name, "get_events_timeline");
        assert_eq!(
            completion.native["tool_calls"][0]["extra_content"]["google"]["thought_signature"],
            "opaque-gemini-thought-sig"
        );
    }

    #[test]
    fn incomplete_streams_and_output_limits_never_produce_executable_tools() {
        let mut stream = Accumulator::default();
        stream.frame(ProviderProtocol::OpenaiCompatible, &json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"apply_manifest","arguments":"{}"}}]}}]}), &sink()).unwrap();
        assert!(stream.finish(ProviderProtocol::OpenaiCompatible).is_err());
        let mut stream = Accumulator::default();
        stream.frame(ProviderProtocol::Ollama, &json!({"done":true,"done_reason":"length","message":{"tool_calls":[{"function":{"name":"apply_manifest","arguments":{}}}]}}), &sink()).unwrap();
        assert!(stream.finish(ProviderProtocol::Ollama).is_err());
    }

    #[test]
    fn responses_replays_native_reasoning_and_tool_calls_without_store() {
        let native = json!([
            {"type":"reasoning","id":"r1","encrypted_content":"opaque-signed-state","summary":[]},
            {"type":"function_call","id":"fc1","call_id":"c1","name":"get_resource","arguments":"{}"}
        ]);
        let mut stream = Accumulator::default();
        stream.frame(ProviderProtocol::Responses, &json!({"type":"response.completed","response":{"model":"actual-model","output":native,"usage":{"input_tokens":9,"output_tokens":2,"input_tokens_details":{"cached_tokens":5},"output_tokens_details":{"reasoning_tokens":1}}}}), &sink()).unwrap();
        let completion = stream.finish(ProviderProtocol::Responses).unwrap();
        assert_eq!(completion.resolved_model.as_deref(), Some("actual-model"));
        assert_eq!(completion.cached_input_tokens, Some(5));
        assert_eq!(completion.reasoning_output_tokens, Some(1));
        let call = completion.calls[0].clone();
        let (_, body) = build_request(
            ProviderProtocol::Responses,
            "dynamic-model",
            &GenerationOptions::default(),
            "system",
            &[
                Turn::User("question".into()),
                Turn::Assistant(completion),
                Turn::Tool {
                    call,
                    result: json!({"status":"accepted"}),
                },
            ],
            &[],
        );
        assert_eq!(body["store"], false);
        assert_eq!(body["input"][1]["encrypted_content"], "opaque-signed-state");
        assert_eq!(body["input"][3]["call_id"], "c1");
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn anthropic_stream_preserves_tool_blocks_and_combines_results() {
        let mut stream = Accumulator::default();
        for frame in [
            json!({"type":"message_start","message":{"model":"actual-claude","usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":30}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Inspecting"}}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"a","name":"get_resource","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"kind\":\"Pod\"}"}}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"b","name":"get_events","input":{"namespace":"apps"}}}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}),
            json!({"type":"message_stop"}),
        ] {
            stream
                .frame(ProviderProtocol::Anthropic, &frame, &sink())
                .unwrap();
        }
        let completion = stream.finish(ProviderProtocol::Anthropic).unwrap();
        assert_eq!(completion.input_tokens, Some(140));
        assert_eq!(completion.cached_input_tokens, Some(100));
        assert_eq!(completion.resolved_model.as_deref(), Some("actual-claude"));
        assert_eq!(completion.native[1]["input"]["kind"], "Pod");
        assert_eq!(completion.calls[1].arguments["namespace"], "apps");
        let calls = completion.calls.clone();
        let (_, body) = build_request(
            ProviderProtocol::Anthropic,
            "dynamic-model",
            &GenerationOptions::default(),
            "system",
            &[
                Turn::User("question".into()),
                Turn::Assistant(completion),
                Turn::Tool {
                    call: calls[0].clone(),
                    result: json!({}),
                },
                Turn::Tool {
                    call: calls[1].clone(),
                    result: json!({}),
                },
            ],
            &[],
        );
        assert_eq!(body["messages"][2]["content"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn anthropic_request_caches_static_system_prefix_and_last_tool_definition() {
        let tools = vec![
            ToolDefinition {
                name: "get_resource".into(),
                description: "Read a resource".into(),
                parameters: json!({"type":"object"}),
            },
            ToolDefinition {
                name: "diagnose_resource".into(),
                description: "Diagnose a resource".into(),
                parameters: json!({"type":"object"}),
            },
        ];
        let system = "Static system prompt\nUser instructions: be concise\nWorking query defaults (session-owned hints, not extra access):{\"workingNamespace\":\"apps\"}";
        let (_, body) = build_request(
            ProviderProtocol::Anthropic,
            "claude-sonnet",
            &GenerationOptions::default(),
            system,
            &[Turn::User("Check pod".into())],
            &tools,
        );
        let sys_blocks = body["system"].as_array().unwrap();
        assert_eq!(sys_blocks.len(), 2);
        assert_eq!(
            sys_blocks[0]["text"],
            "Static system prompt\nUser instructions: be concise"
        );
        assert_eq!(sys_blocks[0]["cache_control"], json!({"type":"ephemeral"}));
        assert!(sys_blocks[1]["text"]
            .as_str()
            .unwrap()
            .starts_with("Working query defaults"));
        assert!(sys_blocks[1].get("cache_control").is_none());

        let req_tools = body["tools"].as_array().unwrap();
        assert!(req_tools[0].get("cache_control").is_none());
        assert_eq!(req_tools[1]["cache_control"], json!({"type":"ephemeral"}));
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"],
            json!({"type":"ephemeral"})
        );
    }

    #[test]
    fn model_catalogs_are_dynamic_and_unknown_capabilities_stay_unknown() {
        let openai = parse_models(
            ProviderProtocol::Responses,
            &json!({"data":[{"id":"unreleased-dynamic-id"}]}),
        )
        .unwrap();
        assert_eq!(openai[0].id, "unreleased-dynamic-id");
        assert_eq!(openai[0].tools, None);
        let router = parse_models(ProviderProtocol::OpenaiCompatible, &json!({"data":[{"id":"vendor/new-model","context_length":12345,"supported_parameters":["tools"]}]})).unwrap();
        assert_eq!(router[0].context_window, Some(12345));
        assert_eq!(router[0].tools, Some(true));
        let local = parse_models(
            ProviderProtocol::Ollama,
            &json!({"models":[{"name":"custom:latest","details":{"parameter_size":"4B"}}]}),
        )
        .unwrap();
        assert_eq!(local[0].id, "custom:latest");
        assert_eq!(local[0].tools, None);
        assert!(parse_models(ProviderProtocol::Anthropic, &json!({"models":[]})).is_err());
        let anthropic=parse_models(ProviderProtocol::Anthropic,&json!({"data":[{"id":"next-model","max_input_tokens":200000,"max_tokens":32000,"capabilities":{"tools":{"supported":true}}},{"id":"old-model","lifecycle":"retired"}]})).unwrap();
        assert_eq!(anthropic.len(), 1);
        assert_eq!(anthropic[0].context_window, Some(200000));
        assert_eq!(anthropic[0].max_output_tokens, Some(32000));
        assert_eq!(anthropic[0].tools, Some(true));
    }

    #[test]
    fn local_generation_settings_use_ollama_options_without_leaking_to_cloud_requests() {
        let options = GenerationOptions {
            context_tokens: Some(8192),
            context_budget_tokens: Some(4096),
            max_output_tokens: Some(1024),
            temperature: Some(0.3),
            tool_use: Some(true),
        };
        let (_, local) = build_request(
            ProviderProtocol::Ollama,
            "local-model",
            &options,
            "system",
            &[Turn::User("question".into())],
            &[],
        );
        assert_eq!(
            local["options"],
            json!({"num_ctx":8192,"num_predict":1024,"temperature":0.3})
        );
        let (_, cloud) = build_request(
            ProviderProtocol::Responses,
            "cloud-model",
            &options,
            "system",
            &[Turn::User("question".into())],
            &[],
        );
        assert!(cloud.get("options").is_none());
        assert!(cloud.get("context_budget_tokens").is_none());
        assert!(local.get("context_budget_tokens").is_none());
        assert_eq!(cloud["max_output_tokens"], 1024);
    }

    #[test]
    fn endpoint_validation_rejects_credential_transfer_and_allows_local_servers() {
        for (url, ok) in [
            ("http://localhost:11434", true),
            ("http://127.0.0.1:1234/v1", true),
            ("https://provider.example/v1", true),
            ("http://remote.example/v1", false),
            ("https://user:pass@provider.example", false),
            ("https://provider.example?api_key=secret", false),
            ("file:///tmp/key", false),
        ] {
            let profile = ProviderProfile {
                id: "test".into(),
                name: "Test".into(),
                protocol: ProviderProtocol::Ollama,
                base_url: url.into(),
            };
            assert_eq!(validate_profile(&profile).is_ok(), ok, "{url}");
        }
    }

    #[test]
    fn ollama_stream_wraps_thinking_in_think_tags_and_preserves_content() {
        let mut stream = Accumulator::default();
        for frame in [
            json!({"message":{"content":"","thinking":"Checking pod "},"done":false}),
            json!({"message":{"content":"","thinking":"diagnostics"},"done":false}),
            json!({"message":{"content":"The pod has failed.","thinking":""},"done":false}),
            json!({"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":25}),
        ] {
            stream
                .frame(ProviderProtocol::Ollama, &frame, &sink())
                .unwrap();
        }
        let completion = stream.finish(ProviderProtocol::Ollama).unwrap();
        assert_eq!(
            completion.text,
            "<think>Checking pod diagnostics</think>\nThe pod has failed."
        );
    }
    #[test]
    fn native_execution_receipts_replay_valid_assistant_tool_pairs_for_all_protocols() {
        let call = ToolCall {
            id: "native-step-1".into(),
            name: "scale_workload".into(),
            arguments: json!({"replicas":3}),
        };
        let turns = vec![
            Turn::User("Execute reviewed plan".into()),
            Turn::Assistant(Completion {
                text: "Executed a reviewed step".into(),
                calls: vec![call.clone()],
                native: Value::Null,
                ..Default::default()
            }),
            Turn::Tool {
                call,
                result: json!({"status":"accepted","operationId":"receipt"}),
            },
            Turn::User("What changed?".into()),
        ];
        for protocol in [
            ProviderProtocol::Responses,
            ProviderProtocol::OpenaiCompatible,
            ProviderProtocol::Anthropic,
            ProviderProtocol::Ollama,
        ] {
            let (_, body) = build_request(
                protocol,
                "model",
                &GenerationOptions::default(),
                "system",
                &turns,
                &[],
            );
            let items = body[if protocol == ProviderProtocol::Responses {
                "input"
            } else {
                "messages"
            }]
            .as_array()
            .unwrap();
            assert!(
                items.iter().all(|item| !item.is_null()),
                "Invalid null assistant replay: {protocol:?}"
            );
            let text = body.to_string();
            assert!(text.contains("scale_workload") && text.contains("receipt"));
            match protocol {
                ProviderProtocol::Responses => {
                    assert!(items.iter().any(|item| item["type"] == "function_call"
                        && item["call_id"] == "native-step-1"))
                }
                ProviderProtocol::Anthropic => {
                    assert!(
                        items
                            .iter()
                            .any(|item| item["content"].as_array().is_some_and(|cs| cs
                                .iter()
                                .any(|c| c["type"] == "tool_use" && c["id"] == "native-step-1")))
                    )
                }
                ProviderProtocol::OpenaiCompatible => assert!(
                    items
                        .iter()
                        .any(|item| item["tool_calls"][0]["id"] == "native-step-1")
                ),
                ProviderProtocol::Ollama => assert!(
                    items.iter().any(
                        |item| item["tool_calls"][0]["function"]["arguments"]["replicas"] == 3
                    )
                ),
            }
        }
    }
}
