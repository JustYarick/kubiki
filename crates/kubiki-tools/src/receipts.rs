//! Connection-owned, bounded identities of API-accepted operations. Never replayed.
use crate::{Target, ToolCall};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct AcceptedOperation {
    pub id: String,
    pub call_id: String,
    pub target: Target,
    pub uid: String,
    pub generation: Option<u64>,
    pub replicas: Option<u32>,
    pub desired_state: Option<Value>,
    at: Instant,
}
impl AcceptedOperation {
    pub fn new(id: String, call: &ToolCall, target: Target, object: &Value) -> Option<Self> {
        let desired_state = call.arguments["yaml"].as_str().and_then(|yaml| serde_yaml::from_str::<Value>(yaml).ok())
            .map(|v| json!({"spec":v["spec"],"metadata":{"labels":v["metadata"]["labels"],"annotations":v["metadata"]["annotations"]}}));
        Some(Self {
            id,
            call_id: call.id.clone(),
            target,
            uid: object["metadata"]["uid"].as_str()?.into(),
            generation: object["metadata"]["generation"].as_u64(),
            replicas: call.arguments["replicas"]
                .as_u64()
                .or_else(|| object["spec"]["replicas"].as_u64())
                .and_then(|n| u32::try_from(n).ok()),
            desired_state,
            at: Instant::now(),
        })
    }
}
#[derive(Default)]
pub struct AcceptedOperations(VecDeque<AcceptedOperation>);
impl AcceptedOperations {
    pub fn save(&mut self, operation: AcceptedOperation) {
        self.0
            .retain(|o| o.at.elapsed() < Duration::from_secs(3600));
        while self.0.len() >= 256 {
            self.0.pop_front();
        }
        self.0.push_back(operation);
    }
    pub fn get(&self, id: &str) -> Option<AcceptedOperation> {
        self.0
            .iter()
            .rev()
            .find(|o| o.id == id && o.at.elapsed() < Duration::from_secs(3600))
            .cloned()
    }
    pub fn for_call(&self, call_id: &str) -> Option<AcceptedOperation> {
        self.0
            .iter()
            .rev()
            .find(|o| o.call_id == call_id && o.at.elapsed() < Duration::from_secs(3600))
            .cloned()
    }
    pub fn latest(&self, target: &Target) -> Option<AcceptedOperation> {
        self.0
            .iter()
            .rev()
            .find(|o| o.target == *target && o.at.elapsed() < Duration::from_secs(3600))
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_is_bounded_and_operation_ids_are_not_call_aliases() {
        let target = Target {
            group: "apps".into(),
            version: "v1".into(),
            kind: "Deployment".into(),
            namespace: Some("apps".into()),
            name: "web".into(),
        };
        let mut registry = AcceptedOperations::default();
        for index in 0..257 {
            let call = ToolCall {
                id: format!("c{index}"),
                name: "scale_workload".into(),
                arguments: json!({"replicas":1}),
            };
            registry.save(
                AcceptedOperation::new(
                    format!("op{index}"),
                    &call,
                    target.clone(),
                    &json!({"metadata":{"uid":"u","generation":index+1}}),
                )
                .unwrap(),
            );
        }
        assert!(registry.get("op0").is_none());
        assert!(registry.get("call:c256").is_none());
        assert_eq!(registry.latest(&target).unwrap().id, "op256");
        assert_eq!(registry.for_call("c256").unwrap().generation, Some(257));
    }
}
