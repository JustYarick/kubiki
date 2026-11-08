//! Bounded aggregation of policy-projected objects; no hidden fields are consulted.
use crate::workload_health;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
pub struct ResourceSummary {
    group_by: String,
    counts: BTreeMap<String, usize>,
    examples: Vec<Value>,
    examined: usize,
    overflow: usize,
}
impl ResourceSummary {
    pub fn new(group_by: &str) -> Result<Self, String> {
        if !matches!(group_by, "phase" | "node" | "image" | "health") {
            return Err("groupBy must be phase, node, image or health".into());
        }
        Ok(Self {
            group_by: group_by.into(),
            counts: BTreeMap::new(),
            examples: Vec::new(),
            examined: 0,
            overflow: 0,
        })
    }
    pub fn add(&mut self, item: &Value) {
        self.examined += 1;
        let keys: BTreeSet<String> = match self.group_by.as_str() {
            "phase" => [item["status"]["phase"]
                .as_str()
                .unwrap_or("unknown")
                .to_owned()]
            .into(),
            "node" => [item["spec"]["nodeName"]
                .as_str()
                .unwrap_or("unknown")
                .to_owned()]
            .into(),
            "image" => {
                let containers = item
                    .pointer("/spec/containers")
                    .or_else(|| item.pointer("/spec/template/spec/containers"))
                    .and_then(Value::as_array);
                let keys: BTreeSet<_> = containers
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c["image"].as_str().map(str::to_owned))
                    .collect();
                if keys.is_empty() {
                    ["unknown".into()].into()
                } else {
                    keys
                }
            }
            _ => {
                let kind = item["kind"].as_str().unwrap_or("");
                let key = if kind == "Pod" {
                    item["status"]["containerStatuses"]
                        .as_array()
                        .and_then(|cs| {
                            cs.iter().find_map(|c| {
                                c.pointer("/state/waiting/reason").and_then(Value::as_str)
                            })
                        })
                        .map(str::to_owned)
                        .or_else(|| {
                            item["status"]["phase"]
                                .as_str()
                                .filter(|p| matches!(*p, "Pending" | "Failed" | "Succeeded"))
                                .map(str::to_owned)
                        })
                        .unwrap_or_else(|| {
                            let ready = item["status"]["conditions"]
                                .as_array()
                                .and_then(|cs| cs.iter().find(|c| c["type"] == "Ready"))
                                .and_then(|c| c["status"].as_str());
                            match ready {
                                Some("True") => "ready",
                                Some("False") => "notReady",
                                _ => "unknown",
                            }
                            .into()
                        })
                } else {
                    workload_health(kind, item)["rolloutState"]
                        .as_str()
                        .unwrap_or("unknown")
                        .into()
                };
                [key].into()
            }
        };
        for key in keys {
            if key.len() > 256 || (!self.counts.contains_key(&key) && self.counts.len() >= 50) {
                self.overflow += 1;
            } else {
                *self.counts.entry(key).or_default() += 1;
            }
        }
        if self.examples.len() < 5 {
            self.examples.push(json!({"kind":item["kind"],"namespace":item["metadata"]["namespace"],"name":item["metadata"]["name"],"uid":item["metadata"]["uid"]}));
        }
    }
    pub fn value(&self) -> Value {
        json!({"groupBy":self.group_by,"counts":self.counts,"objectsExamined":self.examined,"otherBuckets":self.overflow,"examples":self.examples,"countSemantics":"Objects per distinct group value; one object can appear in multiple image buckets. Unknown means evidence is absent or filtered. Counts cover this invocation only."})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ten_thousand_objects_produce_a_bounded_summary_and_filtered_fields_stay_unknown() {
        let mut summary = ResourceSummary::new("phase").unwrap();
        for _ in 0..10_000 {
            summary
                .add(&json!({"kind":"Pod","status":{"phase":"Pending"},"metadata":{"name":"app"}}));
        }
        summary.add(&json!({"metadata":{"name":"filtered"}}));
        let value = summary.value();
        assert_eq!(value["counts"]["Pending"], 10_000);
        assert_eq!(value["counts"]["unknown"], 1);
        assert_eq!(value["examples"].as_array().unwrap().len(), 5);
        assert!(value.to_string().len() < 2000);
    }
    #[test]
    fn bucket_cardinality_is_bounded_and_image_counts_are_per_object() {
        let mut summary = ResourceSummary::new("image").unwrap();
        summary.add(&json!({"spec":{"containers":[{"image":"a"},{"image":"a"}]}}));
        for i in 0..100 {
            summary.add(&json!({"spec":{"containers":[{"image":format!("image-{i}")}]}}));
        }
        let value = summary.value();
        assert_eq!(value["counts"]["a"], 1);
        assert_eq!(value["counts"].as_object().unwrap().len(), 50);
        assert_eq!(value["otherBuckets"], 51);
    }
}
