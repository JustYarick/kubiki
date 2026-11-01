//! Bounded field selection over already policy-projected JSON.
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

#[derive(Default, Clone)]
struct Selection {
    whole: bool,
    children: BTreeMap<String, Selection>,
}

pub struct FieldSelection(Selection);
impl FieldSelection {
    /// Dot paths support array [*]/[index]. JSON pointers support escaped keys
    /// containing dots or slashes, and '*' array segments.
    pub fn new(fields: &[String]) -> Result<Self, String> {
        if fields.is_empty() || fields.len() > 32 {
            return Err("Request 1–32 fields".into());
        }
        let mut root = Selection::default();
        for path in fields {
            if path.len() > 256 {
                return Err("Field path exceeds 256 bytes".into());
            }
            let parts: Vec<String> = if path.starts_with('/') {
                path[1..]
                    .split('/')
                    .map(|p| {
                        let mut result = String::new();
                        let mut chars = p.chars();
                        while let Some(c) = chars.next() {
                            if c == '~' {
                                result.push(match chars.next() {
                                    Some('0') => '~',
                                    Some('1') => '/',
                                    _ => return Err("Invalid JSON pointer escape"),
                                });
                            } else {
                                result.push(c);
                            }
                        }
                        Ok(result)
                    })
                    .collect::<Result<_, _>>()?
            } else {
                let mut parts = Vec::new();
                for segment in path.split('.') {
                    let (key, suffix) = segment.split_once('[').unwrap_or((segment, ""));
                    if key.is_empty() || key.contains(']') {
                        return Err("Invalid field path".into());
                    }
                    parts.push(key.to_owned());
                    if !suffix.is_empty() || segment.contains('[') {
                        let mut rest = suffix;
                        loop {
                            let (index, tail) = rest.split_once(']').ok_or("Invalid array path")?;
                            if index != "*"
                                && (index.is_empty() || !index.bytes().all(|c| c.is_ascii_digit()))
                            {
                                return Err("Array index must be a number or *".into());
                            }
                            parts.push(index.to_owned());
                            if tail.is_empty() {
                                break;
                            }
                            rest = tail.strip_prefix('[').ok_or("Invalid array path suffix")?;
                        }
                    }
                }
                parts
            };
            if parts.is_empty() || parts.len() > 16 || parts.iter().any(|p| p.is_empty()) {
                return Err("Invalid field path or excessive depth".into());
            }
            let mut node = &mut root;
            for part in parts {
                node = node.children.entry(part).or_default();
            }
            node.whole = true;
        }
        Ok(Self(root))
    }
    pub fn metadata_only(&self) -> bool {
        self.0
            .children
            .keys()
            .all(|k| matches!(k.as_str(), "metadata" | "apiVersion" | "kind"))
    }
    pub fn apply(&self, source: &Value) -> Value {
        let mut result = select(source, &self.0).unwrap_or(json!({}));
        // Identity is always taken from the permitted projection, never raw data.
        if let Some(out) = result.as_object_mut() {
            for key in ["apiVersion", "kind"] {
                if let Some(v) = source.get(key) {
                    out.insert(key.into(), v.clone());
                }
            }
            for key in ["name", "namespace", "uid", "resourceVersion"] {
                if let Some(v) = source.get("metadata").and_then(|m| m.get(key)) {
                    if out.get("metadata").is_none() {
                        out.insert("metadata".into(), json!({}));
                    }
                    if let Some(metadata) = out.get_mut("metadata").and_then(Value::as_object_mut) {
                        metadata.insert(key.into(), v.clone());
                    }
                }
            }
        }
        result
    }
}
fn merge_selection(target: &mut Selection, source: &Selection) {
    target.whole |= source.whole;
    for (key, node) in &source.children {
        merge_selection(target.children.entry(key.clone()).or_default(), node);
    }
}
fn select(source: &Value, node: &Selection) -> Option<Value> {
    if node.whole {
        return Some(source.clone());
    }
    match source {
        Value::Object(map) => {
            let result: Map<String, Value> = node
                .children
                .iter()
                .filter_map(|(key, child)| Some((key.clone(), select(map.get(key)?, child)?)))
                .collect();
            if result.is_empty() {
                None
            } else {
                Some(Value::Object(result))
            }
        }
        Value::Array(items) => {
            let mut result = Vec::new();
            for (index, value) in items.iter().enumerate() {
                let mut child = node.children.get("*").cloned().unwrap_or_default();
                if let Some(indexed) = node.children.get(&index.to_string()) {
                    merge_selection(&mut child, indexed);
                }
                result.push(select(value, &child).unwrap_or(json!({})));
            }
            Some(Value::Array(result))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wildcard_and_index_fields_merge_without_leaking_other_entries() {
        let selection =
            FieldSelection::new(&["items[*].name".into(), "items[1].image".into()]).unwrap();
        let result = selection
            .apply(&json!({"items":[{"name":"a","image":"secret"},{"name":"b","image":"wanted"}]}));
        assert_eq!(result["items"][1], json!({"name":"b","image":"wanted"}));
        assert_eq!(result["items"][0], json!({"name":"a"}));
        for path in ["a[0]junk", "a[[]]", "a]", "a[]", "a[foo]"] {
            assert!(FieldSelection::new(&[path.into()]).is_err(), "{path}");
        }
    }
    #[test]
    fn preserves_array_relationships_and_missing_vs_null() {
        let fields = vec![
            "spec.containers[*].name".into(),
            "spec.containers[*].resources.limits.cpu".into(),
        ];
        let selected = FieldSelection::new(&fields).unwrap().apply(&json!({"metadata":{"name":"web"},"spec":{"containers":[{"name":"a","resources":{"limits":{"cpu":null}},"env":["private"]},{"name":"b"}]}}));
        assert_eq!(selected["spec"]["containers"][1]["name"], "b");
        assert!(selected.pointer("/spec/containers/1/resources").is_none());
        assert_eq!(
            selected.pointer("/spec/containers/0/resources/limits/cpu"),
            Some(&Value::Null)
        );
        assert!(!selected.to_string().contains("private"));
    }
    #[test]
    fn pointers_support_label_keys_and_never_restore_denied_fields() {
        let selection = FieldSelection::new(&[
            "/metadata/labels/app.kubernetes.io~1name".into(),
            "status.private".into(),
        ])
        .unwrap();
        let output = selection.apply(&json!({"metadata":{"labels":{"app.kubernetes.io/name":"web"}},"status":{"phase":"Running"}}));
        assert_eq!(
            output["metadata"]["labels"]["app.kubernetes.io/name"],
            "web"
        );
        assert!(output.get("status").is_none());
        assert!(!selection.metadata_only());
        assert!(
            FieldSelection::new(&["metadata.name".into()])
                .unwrap()
                .metadata_only()
        );
    }
    #[test]
    fn rejects_unbounded_or_malformed_paths() {
        for fields in [
            vec![],
            vec!["a..b".into()],
            vec!["/a~2b".into()],
            vec!["a[0".into()],
            vec!["a".repeat(257)],
            vec!["a".into(); 33],
        ] {
            assert!(FieldSelection::new(&fields).is_err());
        }
    }
}

/// Stable, bounded profiles. None explicitly requests the full permitted body.
pub fn profile_fields(profile: &str) -> Result<Option<Vec<String>>, String> {
    let paths: &[&str] =
        match profile {
            "full" => return Ok(None),
            "identity" => &[
                "metadata.name",
                "metadata.namespace",
                "metadata.labels",
                "metadata.ownerReferences",
            ],
            "health" => &[
                "metadata.generation",
                "status.phase",
                "status.conditions",
                "spec.replicas",
                "status.replicas",
                "status.readyReplicas",
                "status.availableReplicas",
                "status.updatedReplicas",
                "status.observedGeneration",
                "status.desiredNumberScheduled",
                "status.numberReady",
                "status.numberAvailable",
                "status.updatedNumberScheduled",
                "status.currentNumberScheduled",
                "status.numberMisscheduled",
                "status.currentRevision",
                "status.updateRevision",
                "status.active",
                "status.succeeded",
                "status.failed",
                "spec.suspend",
                "status.containerStatuses[*].name",
                "status.containerStatuses[*].ready",
                "status.containerStatuses[*].restartCount",
                "status.containerStatuses[*].state",
                "status.containerStatuses[*].lastState",
            ],
            "images" => &[
                "spec.containers[*].name",
                "spec.containers[*].image",
                "spec.initContainers[*].name",
                "spec.initContainers[*].image",
                "spec.template.spec.containers[*].name",
                "spec.template.spec.containers[*].image",
                "spec.template.spec.initContainers[*].name",
                "spec.template.spec.initContainers[*].image",
            ],
            "resources" => &[
                "spec.containers[*].name",
                "spec.containers[*].resources",
                "spec.initContainers[*].name",
                "spec.initContainers[*].resources",
                "spec.template.spec.containers[*].name",
                "spec.template.spec.containers[*].resources",
                "spec.template.spec.initContainers[*].name",
                "spec.template.spec.initContainers[*].resources",
            ],
            "scheduling" => &[
                "spec.nodeName",
                "spec.nodeSelector",
                "spec.affinity",
                "spec.tolerations",
                "spec.topologySpreadConstraints",
                "status.conditions",
                "spec.template.spec.nodeSelector",
                "spec.template.spec.affinity",
                "spec.template.spec.tolerations",
            ],
            _ => return Err(
                "Unknown profile; choose identity, health, images, resources, scheduling or full"
                    .into(),
            ),
        };
    Ok(Some(paths.iter().map(|s| (*s).to_owned()).collect()))
}

#[cfg(test)]
mod profile_tests {
    use super::*;
    #[test]
    fn every_profile_is_valid_and_images_excludes_unrelated_configuration() {
        for name in ["identity", "health", "images", "resources", "scheduling"] {
            FieldSelection::new(&profile_fields(name).unwrap().unwrap()).unwrap();
        }
        let profile = FieldSelection::new(&profile_fields("images").unwrap().unwrap()).unwrap();
        let result = profile.apply(&json!({"spec":{"containers":[{"name":"app","image":"nginx:1","command":["private"],"env":["private"]}]}}));
        assert_eq!(
            result["spec"]["containers"][0],
            json!({"name":"app","image":"nginx:1"})
        );
        assert!(profile_fields("full").unwrap().is_none());
        assert!(profile_fields("unknown").is_err());
    }
}
