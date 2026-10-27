//! Isolated full-Tauri renderer benchmark. Only synthetic reads are available; no kubeconfig/cluster access.
//! Not registered in the application.
#[cfg(target_os = "linux")]
#[path = "../src/graphics.rs"]
mod graphics;

#[cfg(target_os = "linux")]
fn main() {
    use serde_json::{Value, json};
    use std::str::FromStr;
    use tauri::{
        Manager, WebviewUrl, WebviewWindowBuilder,
        ipc::{InvokeBody, JavaScriptChannelId},
    };
    let startup = graphics::initialize().expect("graphics arguments");
    print!("{}", startup.report);
    if startup.options.report_only {
        return;
    }
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::env::var("BENCH_FIXTURE").expect("Set BENCH_FIXTURE to synthetic JSON"),
        )
        .expect("fixture file"),
    )
    .expect("fixture JSON");
    let url: tauri::Url = std::env::var("BENCH_URL")
        .unwrap_or("http://127.0.0.1:1422".into())
        .parse()
        .unwrap();
    assert!(
        matches!(url.host_str(), Some("127.0.0.1" | "localhost")),
        "Only a loopback preview is allowed"
    );
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = Some(url.clone());
    tauri::Builder::default()
        .invoke_handler(move |invoke| {
            let args = match invoke.message.payload() { InvokeBody::Json(args) => args.clone(), _ => Value::Null };
            let command = invoke.message.command();
            if command == "graphics_benchmark_result" {
                let result = &args["result"];
                let window = invoke.message.webview().get_webview_window("graphics-probe");
                let inner_size = window.as_ref().and_then(|window| window.inner_size().ok());
                let scale_factor = window.as_ref().and_then(|window| window.scale_factor().ok());
                println!("{}", json!({"runtime":"full Tauri","nativeInnerSize":inner_size,"nativeScaleFactor":scale_factor,"result":result}));
                invoke.message.webview().app_handle().exit(if result.get("error").is_some() { 1 } else { 0 });
                invoke.resolver.resolve(Value::Null);
                return true;
            }
            let value = match command {
                "get_kube_contexts" => json!([{"name":"test","is_current":true}]),
                "ping_cluster" => json!({"git_version":"v1.34.0"}),
                "get_namespaces" => json!(["perf"]),
                "get_helm_inventory" => json!([]),
                "watch_resources" => {
                    let query = &args["query"];
                    let items = fixture[query["kind"].as_str().unwrap_or("")].as_array().cloned().unwrap_or_default();
                    let channel = JavaScriptChannelId::from_str(args["onEvent"].as_str().expect("channel id")).expect("channel").channel_on::<_, Value>(invoke.message.webview());
                    channel.send(json!({"subscription_id":args["subscriptionId"],"query":query,"messages":[{"sequence":1,"event":{"type":"Delta","payload":{"type":"Restarted","payload":{"items":items}}}},{"sequence":2,"event":{"type":"Status","payload":{"phase":"live","error":null}}}]})).unwrap();
                    Value::Null
                }
                "stop_resource_watches" | "stop_resource_watch" | "stop_pod_execs" | "stop_host_terminals" | "stop_node_debugs" | "stop_port_forwards" => Value::Null,
                _ => { invoke.resolver.reject("Graphics probe has no live operations"); return true; }
            };
            invoke.resolver.resolve(value); true
        })
        .setup(move |app| {
            let app_exit = app.handle().clone();
            WebviewWindowBuilder::new(app, "graphics-probe", WebviewUrl::External(url.clone()))
                .title("Kubiki graphics probe · synthetic data")
                .inner_size(1280., 800.)
                .min_inner_size(1280., 800.)
                .max_inner_size(1280., 800.)
                .resizable(false)
                .incognito(true)
                .on_page_load(move |window, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        let mode = std::env::var("BENCH_MODE").unwrap_or_else(|_| "pan".into());
                        let config = json!({"mode":mode,"variant":std::env::var("BENCH_VARIANT").unwrap_or_else(|_| "default".into()),"zoom":std::env::var("BENCH_ZOOM").ok().and_then(|v|v.parse::<u32>().ok()).unwrap_or(5),"frames":std::env::var("BENCH_FRAMES").ok().and_then(|v|v.parse::<u32>().ok()).unwrap_or(180)});
                        let script = format!("if (!window.__kubikiBenchRunning) {{ window.__kubikiBenchRunning = true; window.__kubikiBench = {config}; window.__kubikiFinish = data => window.__TAURI_INTERNALS__.invoke('graphics_benchmark_result', {{ result: data }}); {}", include_str!("../../tests/perf/native_pan.js")) + "}";
                        window.eval(script).expect("benchmark script");
                    }
                })
                .build()?;
            std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(50)); eprintln!("Graphics probe timeout"); app_exit.exit(1); });
            Ok(())
        })
        .run(context).expect("Tauri graphics probe");
}
#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("This renderer probe targets Linux/WebKitGTK.");
}
