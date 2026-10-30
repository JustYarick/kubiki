use async_trait::async_trait;
use kubiki_ai::*;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Host(Arc<AtomicUsize>);
#[async_trait]
impl ToolExecutor for Host {
    async fn execute(
        &self,
        session: &Session,
        _: &ToolCall,
        _: &EventSink,
    ) -> Result<Value, String> {
        let state = session.control()?;
        let target = Target {
            group: "apps".into(),
            version: "v1".into(),
            kind: "Deployment".into(),
            namespace: Some("apps".into()),
            name: "web".into(),
        };
        session.authorize_dispatch(state.revision, &target, WriteOperation::Scale)?;
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"status":"accepted","operationId":"receipt-1"}))
    }
}

async fn provider(
    bodies: Vec<String>,
) -> (
    ProviderClient,
    Arc<Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let requests: Arc<Mutex<Vec<Value>>> = Arc::default();
    let retained = requests.clone();
    let task = tokio::spawn(async move {
        for body in bodies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let (start, length) = loop {
                let mut chunk = [0; 4096];
                let size = socket.read(&mut chunk).await.unwrap();
                assert!(size > 0);
                bytes.extend_from_slice(&chunk[..size]);
                if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..index]).to_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse::<usize>()
                        .unwrap();
                    break (index + 4, length);
                }
            };
            while bytes.len() < start + length {
                let mut chunk = [0; 4096];
                let size = socket.read(&mut chunk).await.unwrap();
                assert!(size > 0);
                bytes.extend_from_slice(&chunk[..size]);
            }
            retained
                .lock()
                .unwrap()
                .push(serde_json::from_slice(&bytes[start..start + length]).unwrap());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    let profile = ProviderProfile {
        id: "local".into(),
        name: "Local".into(),
        protocol: ProviderProtocol::OpenaiCompatible,
        base_url: url,
    };
    (
        ProviderClient::new(profile, String::new()).unwrap(),
        requests,
        task,
    )
}
fn call(name: &str) -> String {
    format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":name,"arguments":"{}"}}]},"finish_reason":"tool_calls"}]})
    )
}
fn final_text() -> String {
    format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"delta":{"content":"Request accepted; rollout not yet verified."},"finish_reason":"stop"}]})
    )
}
fn session() -> Session {
    Session::new(
        "s1".into(),
        "window".into(),
        AgentScope {
            context: "prod".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        },
        AgentPolicy {
            writes: vec![WriteOperation::Scale],
            ..Default::default()
        },
    )
}
fn sink() -> EventSink {
    Arc::new(|_| {})
}

#[tokio::test]
async fn model_cannot_invoke_unoffered_writes_in_read_only() {
    let (client, _, task) = provider(vec![call("scale_workload")]).await;
    let dispatched = Arc::new(AtomicUsize::new(0));
    let outcome = run(
        session(),
        0,
        client,
        "dynamic-model".into(),
        GenerationOptions::default(),
        String::new(),
        "Scale it".into(),
        Arc::new(Host(dispatched.clone())),
        sink(),
    )
    .await;
    assert!(outcome.unwrap_err().contains("not offered"));
    assert_eq!(dispatched.load(Ordering::SeqCst), 0);
    task.await.unwrap();
}

#[tokio::test]
async fn accept_executes_permitted_tool_once_and_returns_receipt_to_model() {
    let (client, requests, task) = provider(vec![call("scale_workload"), final_text()]).await;
    let session = session();
    session.mode(AgentMode::Accept).unwrap();
    session.phase(AgentPhase::Action).unwrap();
    let dispatched = Arc::new(AtomicUsize::new(0));
    run(
        session.clone(),
        2,
        client,
        "dynamic-model".into(),
        GenerationOptions::default(),
        String::new(),
        "Scale it".into(),
        Arc::new(Host(dispatched.clone())),
        sink(),
    )
    .await
    .unwrap();
    assert_eq!(dispatched.load(Ordering::SeqCst), 1);
    assert!(!session.control().unwrap().active);
    task.await.unwrap();
    let requests = requests.lock().unwrap();
    assert!(
        requests[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool" && m["content"].as_str().unwrap().contains("receipt-1"))
    );
}

#[tokio::test]
async fn stop_and_invalidation_reject_requests_prepared_before_credentials_resolve() {
    for invalidate in [false, true] {
        let session = session();
        if invalidate {
            session.invalidate();
        } else {
            session.stop();
        }
        let profile = ProviderProfile {
            id: "local".into(),
            name: "Local".into(),
            protocol: ProviderProtocol::OpenaiCompatible,
            base_url: "http://127.0.0.1:9/v1".into(),
        };
        let dispatched = Arc::new(AtomicUsize::new(0));
        let outcome = run(
            session,
            0,
            ProviderClient::new(profile, String::new()).unwrap(),
            "model".into(),
            GenerationOptions::default(),
            String::new(),
            "Question".into(),
            Arc::new(Host(dispatched.clone())),
            sink(),
        )
        .await;
        assert!(outcome.is_err());
        assert_eq!(dispatched.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn plain_chat_omits_tools_and_rejects_unsolicited_tool_calls() {
    let (client, requests, task) = provider(vec![call("scale_workload")]).await;
    let session = session();
    session.mode(AgentMode::Accept).unwrap();
    session.phase(AgentPhase::Action).unwrap();
    let dispatched = Arc::new(AtomicUsize::new(0));
    let result = run(
        session,
        2,
        client,
        "model".into(),
        GenerationOptions {
            tool_use: Some(false),
            ..Default::default()
        },
        String::new(),
        "Question".into(),
        Arc::new(Host(dispatched.clone())),
        sink(),
    )
    .await;
    assert!(result.is_err());
    task.await.unwrap();
    assert!(requests.lock().unwrap()[0].get("tools").is_none());
    assert_eq!(dispatched.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn general_chat_never_advertises_cluster_tools() {
    let (client, requests, task) = provider(vec![final_text()]).await;
    let session = Session::new(
        "general".into(),
        "window".into(),
        AgentScope::default(),
        AgentPolicy::default(),
    );
    run(
        session,
        0,
        client,
        "model".into(),
        GenerationOptions::default(),
        String::new(),
        "Explain Kubernetes".into(),
        Arc::new(Host(Arc::new(AtomicUsize::new(0)))),
        sink(),
    )
    .await
    .unwrap();
    task.await.unwrap();
    let requests = requests.lock().unwrap();
    let tools = requests[0]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["function"]["name"], "propose_manifests");
}

#[tokio::test]
async fn stream_disconnect_does_not_dispatch_partially_received_tools() {
    let fragment = format!(
        "data: {}\n\n",
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"scale_workload","arguments":"{}"}}]}}]})
    );
    let (client, _, task) = provider(vec![fragment]).await;
    let session = session();
    session.mode(AgentMode::Accept).unwrap();
    session.phase(AgentPhase::Action).unwrap();
    let dispatched = Arc::new(AtomicUsize::new(0));
    assert!(
        run(
            session,
            2,
            client,
            "model".into(),
            GenerationOptions::default(),
            String::new(),
            "Question".into(),
            Arc::new(Host(dispatched.clone())),
            sink()
        )
        .await
        .is_err()
    );
    assert_eq!(dispatched.load(Ordering::SeqCst), 0);
    task.await.unwrap();
}

struct DelayedHost {
    ready: Arc<tokio::sync::Notify>,
    proceed: Arc<tokio::sync::Notify>,
    writes: Arc<AtomicUsize>,
}
#[async_trait]
impl ToolExecutor for DelayedHost {
    async fn execute(
        &self,
        session: &Session,
        _: &ToolCall,
        _: &EventSink,
    ) -> Result<Value, String> {
        let revision = session.control()?.revision;
        self.ready.notify_one();
        self.proceed.notified().await;
        let target = Target {
            group: "apps".into(),
            version: "v1".into(),
            kind: "Deployment".into(),
            namespace: Some("apps".into()),
            name: "web".into(),
        };
        session.authorize_dispatch(revision, &target, WriteOperation::Scale)?;
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"status":"accepted"}))
    }
}

#[tokio::test]
async fn downgrade_invalidates_authorization_while_a_tool_waits_for_review() {
    let (client, _, server) = provider(vec![call("scale_workload")]).await;
    let session = session();
    session.mode(AgentMode::Accept).unwrap();
    session.phase(AgentPhase::Action).unwrap();
    let ready = Arc::new(tokio::sync::Notify::new());
    let proceed = Arc::new(tokio::sync::Notify::new());
    let writes = Arc::new(AtomicUsize::new(0));
    let host = Arc::new(DelayedHost {
        ready: ready.clone(),
        proceed: proceed.clone(),
        writes: writes.clone(),
    });
    let running = tokio::spawn(run(
        session.clone(),
        2,
        client,
        "model".into(),
        GenerationOptions::default(),
        String::new(),
        "Scale".into(),
        host,
        sink(),
    ));
    tokio::time::timeout(std::time::Duration::from_secs(5), ready.notified())
        .await
        .unwrap();
    session.mode(AgentMode::ReadOnly).unwrap();
    proceed.notify_one();
    assert!(running.await.unwrap().is_err());
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    server.await.unwrap();
}

struct AskHost;
#[async_trait]
impl ToolExecutor for AskHost {
    async fn execute(
        &self,
        _: &Session,
        call: &ToolCall,
        _: &EventSink,
    ) -> Result<Value, String> {
        assert_eq!(call.name, "ask_user");
        Ok(json!({"status": "awaiting_user_selection"}))
    }
}

#[tokio::test]
async fn ask_user_completes_turn_without_subsequent_model_call() {
    let call_json = json!({
        "id": "chatcmpl-test",
        "choices": [{
            "delta": {
                "role": "assistant",
                "tool_calls": [{
                    "index": 0,
                    "id": "call-1",
                    "type": "function",
                    "function": {
                        "name": "ask_user",
                        "arguments": serde_json::to_string(&json!({
                            "question": "Should I apply the change?",
                            "options": ["Yes", "No"]
                        })).unwrap()
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }]
    });
    let fragment = format!("data: {}\n\ndata: [DONE]\n\n", serde_json::to_string(&call_json).unwrap());
    let (client, _, task) = provider(vec![fragment]).await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let events_sink = events.clone();
    let sink: EventSink = Arc::new(move |event| {
        events_sink.lock().unwrap().push(event);
    });
    let s = session();
    let revision = s.control().unwrap().revision;
    run(
        s,
        revision,
        client,
        "model".into(),
        GenerationOptions::default(),
        String::new(),
        "Hi".into(),
        Arc::new(AskHost),
        sink,
    )
    .await
    .unwrap();
    let completed_tools = events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, AgentEvent::ToolCompleted { .. }))
        .count();
    assert_eq!(completed_tools, 1);
    task.await.unwrap();
}

#[tokio::test]
async fn history_compaction_compresses_older_turns_when_context_budget_is_approached() {
    let s = session();
    let mut initial_turns = Vec::new();
    for i in 0..25 {
        initial_turns.push(Turn::User(format!("User query {i} regarding deployment details with lots of extra padding content for sizing purposes {}", "x".repeat(100))));
        initial_turns.push(Turn::Assistant(Completion {
            text: format!("Assistant analysis {i} for pod logs and cluster health check with extra padding content {}", "y".repeat(100)),
            calls: vec![],
            native: json!({}),
            input_tokens: Some(100),
            output_tokens: Some(50),
        }));
    }
    s.seed_history(initial_turns).await;
    let (client, _, task) = provider(vec![final_text()]).await;
    let revision = s.control().unwrap().revision;
    run(
        s.clone(),
        revision,
        client,
        "model".into(),
        GenerationOptions {
            context_tokens: Some(1024),
            ..Default::default()
        },
        String::new(),
        "Latest question".into(),
        Arc::new(Host(Arc::new(AtomicUsize::new(0)))),
        sink(),
    )
    .await
    .unwrap();
    let history = s.inspect_history().await;
    let first = &history[0];
    match first {
        Turn::User(summary) => assert!(summary.contains("Context Summary"), "Expected compacted context summary"),
        _ => panic!("Expected Turn::User with context summary"),
    }
    task.await.unwrap();
}

