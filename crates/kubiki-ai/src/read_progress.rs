//! Avoid repeating the same failed target through different diagnostic tools in one run.
use crate::{ToolCall, Turn, mutation_tool};
use serde_json::{Value, json};
fn target(call: &ToolCall) -> Option<Value> {
    let a = &call.arguments;
    let name = a["name"].as_str()?;
    let (group, version, kind) = match call.name.as_str() {
        "get_pod_diagnostics" => ("", "v1", "Pod"),
        "get_workload_diagnostics"
        | "get_config_diagnostics"
        | "get_resource"
        | "get_neighborhood"
        | "diagnose_resource" => (
            a["group"].as_str().unwrap_or(""),
            a["version"].as_str()?,
            a["kind"].as_str()?,
        ),
        _ => return None,
    };
    Some(json!([group, version, kind, a["namespace"], name]))
}
fn missing(result: &Value) -> bool {
    result["error"]
        .as_str()
        .is_some_and(|e| e.contains("404") || e.to_lowercase().contains("resource not found"))
}
pub fn repeated_failure(history: &[Turn], call: &ToolCall) -> Option<Value> {
    let identity = target(call)?;
    let mut misses = 0;
    for turn in history.iter().rev() {
        match turn {
            Turn::User(_) => break,
            Turn::Tool {
                call: previous,
                result,
            } => {
                if mutation_tool(&previous.name) {
                    break;
                }
                if target(previous).as_ref() == Some(&identity) {
                    if result["code"] == "repeated_not_found" {
                        continue;
                    }
                    if !missing(result) {
                        break;
                    }
                    misses += 1;
                }
            }
            _ => {}
        }
    }
    (misses>=2).then(||json!({"error":"Repeated unavailable resource: two live reads returned NotFound. Resolve the original resource's ownerReferences or get_neighborhood before retrying this target.","code":"repeated_not_found","executed":false,"target":identity}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn different_tools_do_not_make_a_guessed_target_new() {
        let args = json!({"group":"apps","version":"v1","kind":"Deployment","namespace":"ns","name":"pod-name"});
        let call = |name: &str| ToolCall {
            id: name.into(),
            name: name.into(),
            arguments: args.clone(),
        };
        let mut history = vec![Turn::User("diagnose pod".into())];
        for name in ["get_config_diagnostics", "get_workload_diagnostics"] {
            history.push(Turn::Tool {
                call: call(name),
                result: json!({"error":"Resource not found (HTTP 404)"}),
            });
        }
        assert!(repeated_failure(&history, &call("get_resource")).is_some());
        history.push(Turn::Tool {
            call: call("get_resource"),
            result: repeated_failure(&history, &call("get_resource")).unwrap(),
        });
        assert!(repeated_failure(&history, &call("get_resource")).is_some());
        history.push(Turn::User("retry now".into()));
        assert!(repeated_failure(&history, &call("get_resource")).is_none());
    }
}
