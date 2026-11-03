use kubiki_mcp::{ClusterServer, McpExecutor};
use kubiki_tools::*;
use rmcp::{ServiceExt, model::CallToolRequestParams};
use serde_json::json;
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct Fake(Mutex<Vec<ToolCall>>);
#[async_trait::async_trait]
impl ToolExecutor for Fake {
    async fn execute(
        &self,
        _: &Session,
        call: &ToolCall,
        emit: &EventSink,
    ) -> Result<serde_json::Value, String> {
        self.0.lock().unwrap().push(call.clone());
        emit(AgentEvent::Status {
            status: "fake-observation".into(),
        });
        if call.arguments["fail"] == true {
            return Err("Fixture failure".into());
        }
        Ok(json!({"id":call.id,"name":call.name,"echo":call.arguments}))
    }
}
fn session() -> Session {
    Session::new(
        "test".into(),
        "test-host".into(),
        AgentScope {
            context: "fixture".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        },
        AgentPolicy::default(),
        ClusterCapabilities::default(),
    )
}
#[tokio::test]
async fn embedded_calls_cross_mcp_keep_call_identity_events_and_errors() {
    let session = session();
    let fake = Arc::new(Fake::default());
    let events = Arc::new(Mutex::new(vec![]));
    let emitted = events.clone();
    let emit: EventSink = Arc::new(move |event| emitted.lock().unwrap().push(event));
    let executor = McpExecutor::connect(ClusterServer::new(
        session.clone(),
        fake.clone(),
        Arc::new(|_| {}),
        false,
    ))
    .await
    .unwrap();
    let _run = session.begin_run(0).unwrap();
    let call = ToolCall {
        id: "original-call-7".into(),
        name: "get_resource".into(),
        arguments: json!({"name":"demo"}),
    };
    assert_eq!(
        executor.execute(&session, &call, &emit).await.unwrap()["id"],
        call.id
    );
    assert_eq!(fake.0.lock().unwrap().len(), 1);
    assert_eq!(events.lock().unwrap().len(), 1);
    let denied = ToolCall {
        name: "run_command".into(),
        ..call.clone()
    };
    assert!(executor.execute(&session, &denied, &emit).await.is_err());
    let failed = ToolCall {
        arguments: json!({"fail":true}),
        ..call
    };
    assert!(
        executor
            .execute(&session, &failed, &emit)
            .await
            .unwrap_err()
            .contains("Fixture failure")
    );
}
#[tokio::test]
async fn external_host_catalog_is_scoped_and_has_no_agent_control_or_shell() {
    let session = session();
    session.mode(AgentMode::Accept).unwrap();
    session.phase(AgentPhase::Action).unwrap();
    let fake = Arc::new(Fake::default());
    let server = ClusterServer::new(session, fake.clone(), Arc::new(|_| {}), true);
    let (client_io, server_io) = tokio::io::duplex(65536);
    let (client, service) = tokio::join!(().serve(client_io), server.serve(server_io));
    let client = client.unwrap();
    let service = service.unwrap();
    assert_eq!(client.peer().peer_info().unwrap().instructions.as_deref(), Some(INVESTIGATION_GUIDANCE));
    let tools = client.peer().list_all_tools().await.unwrap();
    assert!(tools.iter().any(|t| t.name == "get_resource"));
    assert!(!tools.iter().any(|t| matches!(
        t.name.as_ref(),
        "run_command" | "ask_user" | "propose_plan" | "apply_manifest"
    )));
    let result = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("get_resource").with_arguments(serde_json::Map::new()),
        )
        .await
        .unwrap();
    assert_ne!(result.is_error, Some(true));
    assert_eq!(fake.0.lock().unwrap().len(), 1);
    let result = client
        .peer()
        .call_tool(CallToolRequestParams::new("scale_workload"))
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(true));
    let _ = client.cancel().await;
    let _ = service.cancel().await;
}

#[cfg(unix)]
#[tokio::test]
async fn attached_stdio_bridge_reuses_server_and_closes_when_desktop_endpoint_is_dropped() {
    let session = session();
    session.mode(AgentMode::Accept).unwrap();
    session.phase(AgentPhase::Action).unwrap();
    let fake = Arc::new(Fake::default());
    let endpoint = kubiki_mcp::attached::start(ClusterServer::new(
        session,
        fake.clone(),
        Arc::new(|_| {}),
        true,
    ))
    .await
    .unwrap();
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_kubiki-mcp"));
    command.arg("attach").arg(&endpoint.bootstrap);
    let client = ().serve(rmcp::transport::TokioChildProcess::new(command).unwrap()).await.unwrap();
    assert!(
        client
            .peer()
            .list_all_tools()
            .await
            .unwrap()
            .iter()
            .any(|t| t.name == "get_resource")
    );
    let result = client
        .peer()
        .call_tool(CallToolRequestParams::new("get_resource"))
        .await
        .unwrap();
    assert_ne!(result.is_error, Some(true));
    assert_eq!(fake.0.lock().unwrap().len(), 1);
    let bootstrap = endpoint.bootstrap.clone();
    drop(endpoint);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while bootstrap.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(client.peer().list_all_tools().await.is_err());
    let _ = client.cancel().await;
}

#[tokio::test]
async fn shutdown_retains_an_already_dispatched_change_until_its_result_is_recorded() {
    struct Dispatched {
        started: Arc<tokio::sync::Notify>,
        finish: Arc<tokio::sync::Notify>,
    }
    #[async_trait::async_trait]
    impl ToolExecutor for Dispatched {
        async fn execute(
            &self,
            _: &Session,
            _: &ToolCall,
            _: &EventSink,
        ) -> Result<serde_json::Value, String> {
            self.started.notify_one();
            self.finish.notified().await;
            Ok(json!({"status":"accepted"}))
        }
    }
    let base=session();
    let session=Session::new(base.id.clone(),base.owner.clone(),base.scope.clone(),AgentPolicy{writes:vec![WriteOperation::Scale],..Default::default()},ClusterCapabilities::default());
    session.mode(AgentMode::Accept).unwrap();
    session.phase(AgentPhase::Action).unwrap();
    let started = Arc::new(tokio::sync::Notify::new());
    let finish = Arc::new(tokio::sync::Notify::new());
    let server = ClusterServer::new(
        session,
        Arc::new(Dispatched {
            started: started.clone(),
            finish: finish.clone(),
        }),
        Arc::new(|_| {}),
        true,
    );
    let (c, s) = tokio::io::duplex(65536);
    let (client, service) = tokio::join!(().serve(c), server.clone().serve(s));
    let client = client.unwrap();
    let service = service.unwrap();
    let peer = client.peer().clone();
    let call = tokio::spawn(async move {
        peer.call_tool(CallToolRequestParams::new("scale_workload").with_arguments(serde_json::from_value(json!({"group":"apps","version":"v1","kind":"Deployment","namespace":"apps","name":"demo","replicas":2})).unwrap()))
            .await
    });
    started.notified().await;
    let stopped = tokio::spawn(async move { server.shutdown().await });
    tokio::task::yield_now().await;
    assert!(!stopped.is_finished());
    finish.notify_one();
    let result = call.await.unwrap().unwrap();
    assert_eq!(result.structured_content.unwrap()["status"], "accepted");
    stopped.await.unwrap();
    let _ = client.cancel().await;
    let _ = service.cancel().await;
}
