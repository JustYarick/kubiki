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
        let response = checked(response)?;
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
        let response = self
            .request(reqwest::Method::POST, path)
            .json(&body)
            .send()
            .await
            .map_err(|_| "Cannot connect to the AI endpoint; check address, network and TLS")?;
        let response = checked(response)?;
        let ndjson = self.profile.protocol == ProviderProtocol::Ollama;
        let mut parser = StreamDecoder::new(ndjson);
        let mut accumulator = Accumulator::default();
        let mut stream = response.bytes_stream();
        let mut total = 0;
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(120), stream.next())
            .await
            .map_err(|_| "AI provider has not sent data for 120 seconds")?
        {
            let chunk =
                chunk.map_err(|e| format!("AI stream disconnected ({e}); no further tools were executed"))?;
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

fn checked(response: reqwest::Response) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    // Never expose provider error bodies: some gateways echo prompts or credentials.
    Err(format!(
        "AI endpoint returned HTTP {}. Check credentials, model access, API root and generation options",
        response.status().as_u16()
    ))
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
                    .or(m["name"].as_str())
                    .unwrap_or(id)
                    .into(),
                context_window: m["context_length"]
                    .as_u64()
                    .or(m["context_window"].as_u64())
                    .or(m["max_input_tokens"].as_u64())
                    .or(m["top_provider"]["context_length"].as_u64()),
                max_output_tokens: m["max_output_tokens"]
                    .as_u64()
                    .or(m["max_tokens"].as_u64())
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
    let definitions: Vec<_> = tools.iter().map(|t| match protocol {
        ProviderProtocol::Responses => json!({"type":"function", "name":t.name, "description":t.description,"parameters":t.parameters,"strict":false}),
        ProviderProtocol::Anthropic => json!({"name":t.name,"description":t.description,"input_schema":t.parameters}),
        _ => json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.parameters}}),
    }).collect();
    let (path, mut body) = match protocol {
        ProviderProtocol::Responses => (
            "responses",
            json!({"model":model,"instructions":system,"input":messages,"store":false,"stream":true,"include":["reasoning.encrypted_content"]}),
        ),
        ProviderProtocol::Anthropic => (
            "messages",
            json!({"model":model,"system":system,"messages":messages,"max_tokens":options.max_output_tokens.unwrap_or(4096),"stream":true}),
        ),
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
    calls: BTreeMap<u64, (String, String, String)>,
    native: Value,
    input: Option<u64>,
    output: Option<u64>,
    done: bool,
    truncated: bool,
    in_thinking: bool,
}
impl Accumulator {
    fn delta(&mut self, text: &str, emit: &EventSink) {
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
                    self.input = value["message"]["usage"]["input_tokens"].as_u64();
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
                        let index = call["index"].as_u64().ok_or("Tool call has no index")?;
                        let entry = self.calls.entry(index).or_default();
                        if let Some(id) = call["id"].as_str() {
                            entry.0.push_str(id);
                        }
                        if let Some(name) = call["function"]["name"].as_str() {
                            entry.1.push_str(name);
                        }
                        if let Some(args) = call["function"]["arguments"].as_str() {
                            entry.2.push_str(args);
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
            for (index, (id, name, args)) in &self.calls {
                if id.is_empty() || name.is_empty() {
                    return Err("Provider returned an incomplete tool call".into());
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
                calls.push(ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    arguments,
                });
            }
            if protocol == ProviderProtocol::OpenaiCompatible {
                self.native = json!({"role":"assistant","content":if self.text.is_empty() {Value::Null} else {json!(self.text)},"tool_calls":calls.iter().map(|c| json!({"id":c.id,"type":"function","function":{"name":c.name,"arguments":c.arguments.to_string()}})).collect::<Vec<_>>()});
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
        stream.frame(ProviderProtocol::Responses, &json!({"type":"response.completed","response":{"output":native,"usage":{"input_tokens":9,"output_tokens":2}}}), &sink()).unwrap();
        let completion = stream.finish(ProviderProtocol::Responses).unwrap();
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
            json!({"type":"message_start","message":{"usage":{"input_tokens":10}}}),
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
            stream.frame(ProviderProtocol::Ollama, &frame, &sink()).unwrap();
        }
        let completion = stream.finish(ProviderProtocol::Ollama).unwrap();
        assert_eq!(completion.text, "<think>Checking pod diagnostics</think>\nThe pod has failed.");
    }
}
