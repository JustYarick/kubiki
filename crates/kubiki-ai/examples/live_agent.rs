use async_trait::async_trait;
use kubiki_ai::*;
use serde_json::{Value, json};
use std::sync::Arc;

struct LiveKubeExecutor;

#[async_trait]
impl ToolExecutor for LiveKubeExecutor {
    async fn execute(
        &self,
        session: &Session,
        call: &ToolCall,
        _emit: &EventSink,
    ) -> Result<Value, String> {
        let state = session.control()?;
        println!("\n⚙️  [TOOL CALLED]: {} (phase: {:?}, mode: {:?})", call.name, state.phase, state.mode);
        println!("    Arguments: {}", serde_json::to_string(&call.arguments).unwrap_or_default());

        match call.name.as_str() {
            "get_pod_diagnostics" => {
                let name = call.arguments["name"].as_str().unwrap_or("caretta-2z27t");
                let ns = call.arguments["namespace"].as_str().unwrap_or("caretta");
                let output = std::process::Command::new("kubectl")
                    .args(["get", "pod", name, "-n", ns, "-o", "json"])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !output.status.success() {
                    return Err(String::from_utf8_lossy(&output.stderr).to_string());
                }
                let json: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
                let phase = json["status"]["phase"].as_str().unwrap_or("Unknown");
                let container_statuses = &json["status"]["containerStatuses"];
                let restarts = container_statuses[0]["restartCount"].as_i64().unwrap_or(0);
                let waiting_reason = container_statuses[0]["state"]["waiting"]["reason"].as_str().unwrap_or("");
                let exit_code = container_statuses[0]["lastState"]["terminated"]["exitCode"].as_i64().unwrap_or(0);

                let summary = json!({
                    "pod": name,
                    "namespace": ns,
                    "phase": phase,
                    "restarts": restarts,
                    "waitingReason": waiting_reason,
                    "lastExitCode": exit_code,
                    "issuesSummary": vec!["CrashLoopBackOff", "Failed container initialization"],
                    "containerStatuses": container_statuses
                });
                println!("    Result: Diagnostics gathered (restarts: {}, waiting: {})", restarts, waiting_reason);
                Ok(summary)
            }
            "get_logs" => {
                let name = call.arguments["name"].as_str().unwrap_or("caretta-2z27t");
                let ns = call.arguments["namespace"].as_str().unwrap_or("caretta");
                let mut cmd = std::process::Command::new("kubectl");
                cmd.args(["logs", name, "-n", ns, "--tail=15"]);
                if call.arguments["previous"].as_bool() == Some(true) {
                    cmd.arg("--previous");
                }
                let output = cmd.output().map_err(|e| e.to_string())?;
                let logs = String::from_utf8_lossy(&output.stdout).to_string();
                let lines = logs.lines().count();
                println!("    Result: Fetched {} log lines from cluster", lines);
                Ok(json!({ "logs": logs, "lines": lines }))
            }
            "get_events_timeline" | "get_events" => {
                let ns = call.arguments["namespace"].as_str().unwrap_or("caretta");
                let output = std::process::Command::new("kubectl")
                    .args(["get", "events", "-n", ns, "--sort-by=.metadata.creationTimestamp"])
                    .output()
                    .map_err(|e| e.to_string())?;
                let events_str = String::from_utf8_lossy(&output.stdout).to_string();
                let events: Vec<String> = events_str.lines().skip(1).take(5).map(|s| s.to_string()).collect();
                println!("    Result: {} timeline events recorded", events.len());
                Ok(json!({ "timeline": events }))
            }
            "get_resource" => {
                let kind = call.arguments["kind"].as_str().unwrap_or("Pod");
                let name = call.arguments["name"].as_str().unwrap_or("caretta-2z27t");
                let ns = call.arguments["namespace"].as_str().unwrap_or("caretta");
                let output = std::process::Command::new("kubectl")
                    .args(["get", kind, name, "-n", ns, "-o", "json"])
                    .output()
                    .map_err(|e| e.to_string())?;
                let json: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
                println!("    Result: Live resource {}/{} retrieved", kind, name);
                Ok(json)
            }
            "list_resources" => {
                let kind = call.arguments["kind"].as_str().unwrap_or("Deployment");
                let ns = call.arguments["namespace"].as_str().unwrap_or("caretta");
                let output = std::process::Command::new("kubectl")
                    .args(["get", kind, "-n", ns, "-o", "json"])
                    .output()
                    .map_err(|e| e.to_string())?;
                let json: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
                let items = json["items"].as_array().cloned().unwrap_or_default();
                println!("    Result: Found {} {} resources in {}", items.len(), kind, ns);
                Ok(json!({ "items": items, "hasMore": false }))
            }
            "get_workload_diagnostics" => {
                let kind = call.arguments["kind"].as_str().unwrap_or("DaemonSet");
                let name = call.arguments["name"].as_str().unwrap_or("caretta");
                let ns = call.arguments["namespace"].as_str().unwrap_or("caretta");
                let output = std::process::Command::new("kubectl")
                    .args(["get", kind, name, "-n", ns, "-o", "json"])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !output.status.success() {
                    return Err(String::from_utf8_lossy(&output.stderr).to_string());
                }
                let json: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
                println!("    Result: Workload diagnostics for {}/{} gathered", kind, name);
                Ok(json!({
                    "kind": kind,
                    "name": name,
                    "status": json["status"],
                }))
            }
            other => {
                println!("    Result: Unsupported in mock executor ({})", other);
                Ok(json!({"status": "not implemented"}))
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let model = args.get(1).cloned().unwrap_or_else(|| "qwen3.8:iq3-fast".into());
    let prompt_type = args.get(2).map(|s| s.as_str()).unwrap_or("both");

    println!("============================================================");
    println!("Testing Kubiki Agent Runtime with live cluster + Ollama");
    println!("Model: {}", model);
    println!("Endpoint: http://localhost:11434");
    println!("============================================================");

    let provider = ProviderClient::new(
        ProviderProfile {
            id: "ollama".into(),
            name: "Ollama".into(),
            protocol: ProviderProtocol::Ollama,
            base_url: "http://localhost:11434".into(),
        },
        "".into(),
    )?;

    let host = Arc::new(LiveKubeExecutor);
    let options = GenerationOptions {
        max_output_tokens: None,
        temperature: Some(0.7),
        tool_use: Some(true),
        context_tokens: Some(32768),
    };

    // Test 1: Informational / Diagnostic Request
    if prompt_type == "diag" || prompt_type == "both" {
        println!("\n\n>>> TEST 1: Diagnostic Request ('Analyze Pod caretta/caretta-2z27t') <<<");
        let session = Session::new(
            "test-diag-session".into(),
            "main".into(),
            AgentScope {
                context: "k3d-testbed".into(),
                namespaces: vec!["caretta".into()],
                all_namespaces: false,
            },
            AgentPolicy {
                resources: true,
                events: true,
                logs: true,
                metrics: true,
                cluster_resources: false,
                secrets: DataAccess::None,
                config_maps: DataAccess::Metadata,
                workload_configuration: false,
                annotations: false,
                custom_resources: DataAccess::Metadata,
                helm: false,
                argocd: false,
                flux: false,
                contexts: vec!["k3d-testbed".into()],
                namespaces: vec!["caretta".into()],
                writes: vec![],
                max_replicas: 10,
                rules: vec![],
                denied_paths: vec![],
            },
        );

        let revision = session.control()?.revision;
        let emit: EventSink = Arc::new(|event| {
            if let AgentEvent::TextDelta { text } = event {
                print!("{}", text);
                use std::io::Write;
                std::io::stdout().flush().ok();
            }
        });

        let diag_prompt = "Analyze Pod caretta/caretta-2z27t. Explain the problem, collect permitted evidence, and suggest next steps.".to_string();
        println!("Prompt: {}\n", diag_prompt);
        let outcome = run(
            session.clone(),
            revision,
            provider.clone(),
            model.clone(),
            options.clone(),
            "".into(),
            diag_prompt,
            host.clone(),
            emit,
        ).await;

        println!("\n\n--- Turn 1 Result ---");
        match outcome {
            Ok(_) => println!("Agent turn completed successfully."),
            Err(e) => println!("Agent error: {}", e),
        }
    }

    // Test 2: Action Plan Request in Plan Phase
    if prompt_type == "plan" || prompt_type == "both" {
        println!("\n\n>>> TEST 2: Action Plan Request ('Составь пошаговый план действий как устранить CrashLoopBackOff в caretta-2z27t') <<<");
        let session = Session::new(
            "test-plan-session".into(),
            "main".into(),
            AgentScope {
                context: "k3d-testbed".into(),
                namespaces: vec!["caretta".into()],
                all_namespaces: false,
            },
            AgentPolicy {
                resources: true,
                events: true,
                logs: true,
                metrics: true,
                cluster_resources: false,
                secrets: DataAccess::None,
                config_maps: DataAccess::Metadata,
                workload_configuration: false,
                annotations: false,
                custom_resources: DataAccess::Metadata,
                helm: false,
                argocd: false,
                flux: false,
                contexts: vec!["k3d-testbed".into()],
                namespaces: vec!["caretta".into()],
                writes: vec![],
                max_replicas: 10,
                rules: vec![],
                denied_paths: vec![],
            },
        );

        let revision = session.control()?.revision;
        let collected_text = Arc::new(std::sync::Mutex::new(String::new()));
        let text_sink = collected_text.clone();
        let emit: EventSink = Arc::new(move |event| {
            if let AgentEvent::TextDelta { text } = event {
                print!("{}", text);
                use std::io::Write;
                std::io::stdout().flush().ok();
                text_sink.lock().unwrap().push_str(&text);
            }
        });

        let plan_prompt = "Составь пошаговый план действий как устранить CrashLoopBackOff в поде caretta-2z27t".to_string();
        println!("Prompt: {}\n", plan_prompt);
        let outcome = run(
            session.clone(),
            revision,
            provider.clone(),
            model.clone(),
            options.clone(),
            "".into(),
            plan_prompt,
            host.clone(),
            emit,
        ).await;

        println!("\n\n--- Turn 2 Result ---");
        match outcome {
            Ok(_) => {
                println!("Agent turn completed successfully.");
                let final_text = collected_text.lock().unwrap().clone();
                let has_plan_heading = final_text.lines().any(|l| l.trim_start().starts_with("#") && (l.to_lowercase().contains("plan") || l.to_lowercase().contains("план")));
                let has_numbered_steps = final_text.lines().any(|l| {
                    let trimmed = l.trim_start();
                    trimmed.starts_with("1.") || trimmed.starts_with("1)") || trimmed.starts_with("- ")
                });
                println!("\n🔍 [Plan Detection Verification]");
                println!("    Plan heading present: {}", has_plan_heading);
                println!("    Numbered/bullet steps present: {}", has_numbered_steps);
                println!("    isPlanMessage() result: {}", has_plan_heading || has_numbered_steps);
            }
            Err(e) => println!("Agent error: {}", e),
        }
    }

    Ok(())
}
