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
        ClusterCapabilities::all(),
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
        ClusterCapabilities::default(),
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
    async fn execute(&self, _: &Session, call: &ToolCall, _: &EventSink) -> Result<Value, String> {
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
    let fragment = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        serde_json::to_string(&call_json).unwrap()
    );
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
            text: format!("Assistant analysis {i} for pod logs and cluster health check with extra padding content {}", "y".repeat(3000)),
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
            context_tokens: Some(16_384),
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
        Turn::User(summary) => assert!(
            summary.contains("Context Summary"),
            "Expected compacted context summary"
        ),
        _ => panic!("Expected Turn::User with context summary"),
    }
    task.await.unwrap();
}

#[tokio::test]
async fn deep_diagnostics_tools_are_offered_in_plan_and_action_phases() {
    let policy = AgentPolicy {
        resources: true,
        events: true,
        ..Default::default()
    };

    // Plan phase in Read-only mode
    let plan_tools = tool_definitions(
        &policy,
        AgentMode::ReadOnly,
        AgentPhase::Plan,
        &ClusterCapabilities::all(),
    );
    let plan_tool_names: Vec<String> = plan_tools.iter().map(|t| t.name.clone()).collect();

    assert!(plan_tool_names.contains(&"get_pod_diagnostics".to_string()));
    assert!(plan_tool_names.contains(&"get_workload_diagnostics".to_string()));
    assert!(plan_tool_names.contains(&"get_service_diagnostics".to_string()));
    assert!(plan_tool_names.contains(&"get_pvc_diagnostics".to_string()));
    assert!(plan_tool_names.contains(&"propose_plan".to_string()));
    assert!(plan_tool_names.contains(&"get_events_timeline".to_string()));
    assert!(!plan_tool_names.contains(&"apply_manifest".to_string()));

    // Action phase in Ask mode
    let action_tools = tool_definitions(
        &policy,
        AgentMode::Ask,
        AgentPhase::Action,
        &ClusterCapabilities::all(),
    );
    let action_tool_names: Vec<String> = action_tools.iter().map(|t| t.name.clone()).collect();

    assert!(action_tool_names.contains(&"get_pod_diagnostics".to_string()));
    assert!(action_tool_names.contains(&"get_workload_diagnostics".to_string()));
    assert!(action_tool_names.contains(&"get_service_diagnostics".to_string()));
    assert!(action_tool_names.contains(&"get_pvc_diagnostics".to_string()));
    assert!(action_tool_names.contains(&"propose_plan".to_string()));
    assert!(action_tool_names.contains(&"get_events_timeline".to_string()));
    assert!(!action_tool_names.contains(&"apply_manifest".to_string()));
}

#[tokio::test]
async fn gitops_and_helm_tools_are_gated_by_policy_and_phase() {
    let mut policy = AgentPolicy {
        helm: OptionalToolMode::Enabled,
        argocd: OptionalToolMode::Enabled,
        flux: OptionalToolMode::Enabled,
        ..Default::default()
    };

    // Plan phase in Read-only mode: read tools available, write/sync tools omitted
    let plan_tools = tool_definitions(
        &policy,
        AgentMode::ReadOnly,
        AgentPhase::Plan,
        &ClusterCapabilities::all(),
    );
    let plan_names: Vec<String> = plan_tools.iter().map(|t| t.name.clone()).collect();

    assert!(plan_names.contains(&"list_helm_releases".to_string()));
    assert!(plan_names.contains(&"get_helm_release".to_string()));
    assert!(plan_names.contains(&"list_argocd_apps".to_string()));
    assert!(plan_names.contains(&"get_argocd_app".to_string()));
    assert!(plan_names.contains(&"list_flux_resources".to_string()));
    assert!(plan_names.contains(&"get_flux_resource".to_string()));
    assert!(!plan_names.contains(&"sync_argocd_app".to_string()));
    assert!(!plan_names.contains(&"reconcile_flux_resource".to_string()));

    // Native writes exclude GitOps CRDs, so these operations must not be advertised.
    let action_tools = tool_definitions(
        &policy,
        AgentMode::Ask,
        AgentPhase::Action,
        &ClusterCapabilities::all(),
    );
    let action_names: Vec<String> = action_tools.iter().map(|t| t.name.clone()).collect();

    assert!(!action_names.contains(&"sync_argocd_app".to_string()));
    assert!(!action_names.contains(&"reconcile_flux_resource".to_string()));

    // Auto mode with selective cluster capabilities
    policy.helm = OptionalToolMode::Auto;
    policy.argocd = OptionalToolMode::Auto;
    policy.flux = OptionalToolMode::Auto;

    let partial_caps = ClusterCapabilities {
        helm: true,
        argocd: true,
        flux: false, // Flux not installed
    };
    let auto_tools = tool_definitions(&policy, AgentMode::Ask, AgentPhase::Action, &partial_caps);
    let auto_names: Vec<String> = auto_tools.iter().map(|t| t.name.clone()).collect();

    assert!(auto_names.contains(&"list_helm_releases".to_string()));
    assert!(auto_names.contains(&"list_argocd_apps".to_string()));
    assert!(!auto_names.contains(&"list_flux_resources".to_string()));
    assert!(!auto_names.contains(&"get_flux_resource".to_string()));
    assert!(!auto_names.contains(&"reconcile_flux_resource".to_string()));

    // Disabled in policy: tools should not be offered even if capability is true
    policy.helm = OptionalToolMode::Disabled;
    policy.argocd = OptionalToolMode::Disabled;
    policy.flux = OptionalToolMode::Disabled;

    let disabled_tools = tool_definitions(
        &policy,
        AgentMode::Ask,
        AgentPhase::Action,
        &ClusterCapabilities::all(),
    );
    let disabled_names: Vec<String> = disabled_tools.iter().map(|t| t.name.clone()).collect();

    assert!(!disabled_names.contains(&"list_helm_releases".to_string()));
    assert!(!disabled_names.contains(&"list_argocd_apps".to_string()));
    assert!(!disabled_names.contains(&"list_flux_resources".to_string()));
    assert!(!disabled_names.contains(&"sync_argocd_app".to_string()));
    assert!(!disabled_names.contains(&"reconcile_flux_resource".to_string()));
}

#[test]
fn action_catalog_requires_operation_grants_in_ask_and_accept() {
    for mode in [AgentMode::Ask, AgentMode::Accept] {
        let mut policy = AgentPolicy::default();
        let names = |policy: &AgentPolicy| {
            tool_definitions(
                policy,
                mode,
                AgentPhase::Action,
                &ClusterCapabilities::all(),
            )
            .into_iter()
            .map(|t| t.name)
            .collect::<Vec<_>>()
        };
        let mutations = [
            "apply_manifest",
            "scale_workload",
            "restart_workload",
            "delete_resource",
        ];
        assert!(
            names(&policy)
                .iter()
                .all(|n| !mutations.contains(&n.as_str()))
        );
        policy.writes = vec![WriteOperation::Scale];
        let granted = names(&policy);
        assert!(granted.iter().any(|n| n == "scale_workload"));
        assert!(!granted.iter().any(|n| {
            ["apply_manifest", "restart_workload", "delete_resource"].contains(&n.as_str())
        }));
        policy.rules.push(ResourceRule {
            group: "apps".into(),
            kind: "Deployment".into(),
            namespace: "apps".into(),
            name: "web".into(),
            read: DataAccess::Content,
            writes: vec![WriteOperation::Update],
        });
        assert!(names(&policy).iter().any(|n| n == "apply_manifest"));
        policy.writes = vec![WriteOperation::Create, WriteOperation::Update];
        let granted = names(&policy);
        assert!(
            !granted
                .iter()
                .any(|n| ["sync_argocd_app", "reconcile_flux_resource"].contains(&n.as_str()))
        );
    }
}

#[tokio::test]
async fn asking_a_question_defers_companion_calls_and_keeps_provider_history_complete() {
    let fragment = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"delta":{"tool_calls":[
        {"index":0,"id":"question","type":"function","function":{"name":"ask_user","arguments":"{}"}},
        {"index":1,"id":"deferred","type":"function","function":{"name":"get_resource","arguments":"{}"}}
    ]},"finish_reason":"tool_calls"}]})
    );
    let (client, requests, task) = provider(vec![fragment, final_text()]).await;
    let session = session();
    let revision = session.control().unwrap().revision;
    run(
        session.clone(),
        revision,
        client.clone(),
        "model".into(),
        GenerationOptions::default(),
        String::new(),
        "Investigate".into(),
        Arc::new(AskHost),
        sink(),
    )
    .await
    .unwrap();
    let history = session.inspect_history().await;
    let deferred = history
        .iter()
        .find_map(|turn| match turn {
            Turn::Tool { call, result } if call.id == "deferred" => Some(result),
            _ => None,
        })
        .unwrap();
    assert_eq!(deferred["executed"], false);
    run(
        session,
        revision,
        client,
        "model".into(),
        GenerationOptions::default(),
        String::new(),
        "Continue".into(),
        Arc::new(AskHost),
        sink(),
    )
    .await
    .unwrap();
    task.await.unwrap();
    let requests = requests.lock().unwrap();
    let tools: Vec<_> = requests[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .collect();
    assert_eq!(tools.len(), 2);
}

struct UncertainHost(Arc<AtomicUsize>);
#[async_trait]
impl ToolExecutor for UncertainHost {
    async fn execute(&self, _: &Session, _: &ToolCall, _: &EventSink) -> Result<Value, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"status":"uncertain","operationId":"op-first"}))
    }
}
#[tokio::test]
async fn an_uncertain_write_stops_the_batch_without_replaying_or_dispatching_companions() {
    let fragment = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"delta":{"tool_calls":[
        {"index":0,"id":"first","type":"function","function":{"name":"scale_workload","arguments":"{}"}},
        {"index":1,"id":"second","type":"function","function":{"name":"scale_workload","arguments":"{}"}}
    ]},"finish_reason":"tool_calls"}]})
    );
    let (provider, _, task) = provider(vec![fragment]).await;
    let session = session();
    session.mode(AgentMode::Accept).unwrap();
    session.phase(AgentPhase::Action).unwrap();
    let revision = session.control().unwrap().revision;
    let calls = Arc::new(AtomicUsize::new(0));
    assert!(
        run(
            session.clone(),
            revision,
            provider,
            "model".into(),
            GenerationOptions::default(),
            String::new(),
            "Scale workloads".into(),
            Arc::new(UncertainHost(calls.clone())),
            sink()
        )
        .await
        .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let history = session.inspect_history().await;
    assert!(history.iter().any(|turn|matches!(turn,Turn::Tool {call,result} if call.id=="first" && result["operationId"]=="op-first")));
    assert!(history.iter().any(|turn|matches!(turn,Turn::Tool {call,result} if call.id=="second" && result["executed"]==false)));
    task.await.unwrap();
}

struct LongApprovalHost;
#[async_trait]
impl ToolExecutor for LongApprovalHost {
    async fn execute(
        &self,
        session: &Session,
        _: &ToolCall,
        _: &EventSink,
    ) -> Result<Value, String> {
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(3600)).await;
        session.exclude_approval_wait(std::time::Duration::from_secs(3600));
        tokio::time::resume();
        Ok(json!({"status":"accepted","operationId":"after-human-review"}))
    }
}
#[tokio::test]
async fn a_long_human_approval_wait_does_not_expire_post_write_generation() {
    let (provider, _, task) = provider(vec![call("scale_workload"), final_text()]).await;
    let session = session();
    session.mode(AgentMode::Ask).unwrap();
    session.phase(AgentPhase::Action).unwrap();
    let revision = session.control().unwrap().revision;
    run(
        session,
        revision,
        provider,
        "model".into(),
        GenerationOptions::default(),
        String::new(),
        "Scale after review".into(),
        Arc::new(LongApprovalHost),
        sink(),
    )
    .await
    .unwrap();
    task.await.unwrap();
}

struct RemediationHost;
#[async_trait]
impl ToolExecutor for RemediationHost {
    async fn execute(&self, _: &Session, call: &ToolCall, _: &EventSink) -> Result<Value, String> {
        if call.name == "get_resource" {
            return Ok(json!({"resource":{"metadata":{"name":"web"}}}));
        }
        assert_eq!(call.name, "propose_plan");
        Ok(
            json!({"planArtifact":{"id":"plan-tested","kind":"remediation","bodyMarkdown":"do-not-duplicate-plan-body","steps":[{"id":"check","verification":"Observe Ready condition"}]}}),
        )
    }
}
#[tokio::test]
async fn investigate_requires_a_remediation_artifact_and_performs_one_bounded_correction() {
    let mut s = session();
    s.intent = AgentIntent::Investigate;
    let (client, requests, task) =
        provider(vec![final_text(), call("propose_plan"), final_text()]).await;
    run(
        s,
        0,
        client,
        "model".into(),
        GenerationOptions::default(),
        String::new(),
        "Investigate workload".into(),
        Arc::new(RemediationHost),
        sink(),
    )
    .await
    .unwrap();
    task.await.unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(
        !requests[2]
            .to_string()
            .contains("do-not-duplicate-plan-body")
    );
    assert!(
        requests[1]
            .to_string()
            .contains("ordered steps including risk and verification")
    );
}
#[tokio::test]
async fn investigation_is_not_reported_complete_when_model_repeatedly_omits_remediation() {
    let mut s = session();
    s.intent = AgentIntent::Investigate;
    let (client, requests, task) = provider(vec![final_text(), final_text()]).await;
    let result = run(
        s,
        0,
        client,
        "model".into(),
        GenerationOptions::default(),
        String::new(),
        "Investigate workload".into(),
        Arc::new(RemediationHost),
        sink(),
    )
    .await;
    assert!(result.unwrap_err().contains("Investigation is incomplete"));
    task.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn an_outline_published_before_new_evidence_is_not_the_final_remediation_plan() {
    let mut s = session();
    s.intent = AgentIntent::Investigate;
    let (client, requests, task) = provider(vec![
        call("propose_plan"),
        call("get_resource"),
        final_text(),
        call("propose_plan"),
        final_text(),
    ])
    .await;
    run(
        s,
        0,
        client,
        "model".into(),
        GenerationOptions::default(),
        String::new(),
        "Investigate workload".into(),
        Arc::new(RemediationHost),
        sink(),
    )
    .await
    .unwrap();
    task.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 5);
}

#[tokio::test]
async fn an_older_plan_cannot_certify_a_new_investigation_turn() {
    let mut s = session();
    s.intent = AgentIntent::Investigate;
    let proposal:PlanProposal=serde_json::from_value(json!({"title":"Old plan","bodyMarkdown":"Old evidence","diagnosis":"Old diagnosis","uncertainty":"Historical","steps":[{"id":"inspect","title":"Inspect","action":"inspect","reason":"Find cause","risk":"Read only","verification":"Read current state"}]})).unwrap();
    s.plans
        .lock()
        .unwrap()
        .propose(
            proposal,
            &s.id,
            &s.scope,
            s.control().unwrap().policy_revision,
            &mut *s.evidence.lock().unwrap(),
        )
        .unwrap();
    let (client, _, task) = provider(vec![final_text(), final_text()]).await;
    let outcome = run(
        s,
        0,
        client,
        "model".into(),
        GenerationOptions::default(),
        String::new(),
        "Investigate a new symptom".into(),
        Arc::new(RemediationHost),
        sink(),
    )
    .await;
    assert!(outcome.unwrap_err().contains("Investigation is incomplete"));
    task.await.unwrap();
}

struct EnvironmentHost;
#[async_trait]
impl ToolExecutor for EnvironmentHost {
    async fn additional_tools(&self, _: &Session) -> Result<Vec<ToolDefinition>, String> {
        Ok(vec![ToolDefinition {name:"read_skill".into(),description:"Read installed skill".into(),parameters:json!({"type":"object","properties":{},"additionalProperties":false})}])
    }
    async fn execute(&self, _: &Session, call: &ToolCall, _: &EventSink) -> Result<Value, String> {
        assert_eq!(call.name,"read_skill");
        Ok(json!({"text":"Skill instructions"}))
    }
}
#[tokio::test]
async fn general_chat_can_use_environment_tools_without_advertising_cluster_tools() {
    let (client,requests,task)=provider(vec![call("read_skill"),final_text()]).await;
    let session=Session::new("environment".into(),"window".into(),AgentScope::default(),AgentPolicy::default(),ClusterCapabilities::default());
    run(session,0,client,"model".into(),GenerationOptions::default(),String::new(),"Use a skill".into(),Arc::new(EnvironmentHost),sink()).await.unwrap();
    let requests=requests.lock().unwrap();
    let tools=requests[0]["tools"].as_array().unwrap();
    assert!(tools.iter().any(|tool|tool["function"]["name"]=="read_skill"));
    assert!(!tools.iter().any(|tool|tool["function"]["name"]=="get_resource"));
    drop(requests);task.await.unwrap();
}
