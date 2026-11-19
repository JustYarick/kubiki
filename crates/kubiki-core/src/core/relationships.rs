//! Pure references from a projected object. No discovery, authorization or I/O.
//! Callers must verify target UIDs and scope before treating a reference as a live edge.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct RelatedResource {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub uid: Option<String>,
    pub relation: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PodRule {
    path: String,
    kind: String,
    api_version: String,
    cluster: bool,
}
fn pod_rules() -> &'static Vec<PodRule> {
    static RULES: std::sync::OnceLock<Vec<PodRule>> = std::sync::OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../shared/pod-reference-rules.json"))
            .expect("valid shared Pod reference rules")
    })
}
/// Extract a single explicitly pinned Node from a PodSpec when `spec.nodeName` is unset:
/// 1. DaemonSet / required `nodeAffinity` `matchFields` (`metadata.name In [node]`) across every term
/// 2. Required `nodeAffinity` `matchExpressions` (`kubernetes.io/hostname In [node]`) across every term
/// 3. `spec.nodeSelector["kubernetes.io/hostname"]`
pub fn pinned_pod_node(pod_spec: &Value) -> Option<(String, &'static str)> {
    fn single_pinned_value(terms: &[Value], field: &str, key: &str) -> Option<String> {
        if terms.is_empty() {
            return None;
        }
        let mut pinned: Option<String> = None;
        for term in terms {
            let mut allowed: Option<std::collections::BTreeSet<String>> = None;
            for req in term.get(field).and_then(Value::as_array).into_iter().flatten() {
                if req.get("key").and_then(Value::as_str) != Some(key)
                    || req.get("operator").and_then(Value::as_str) != Some("In")
                {
                    continue;
                }
                let values: std::collections::BTreeSet<String> = req
                    .get("values")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect();
                allowed = Some(match allowed {
                    None => values,
                    Some(prev) => prev.intersection(&values).cloned().collect(),
                });
            }
            let set = allowed?;
            if set.len() != 1 {
                return None;
            }
            let candidate = set.into_iter().next()?;
            match &pinned {
                None => pinned = Some(candidate),
                Some(existing) if *existing == candidate => {}
                Some(_) => return None,
            }
        }
        pinned
    }

    if let Some(terms) = pod_spec
        .pointer("/affinity/nodeAffinity/requiredDuringSchedulingIgnoredDuringExecution/nodeSelectorTerms")
        .and_then(Value::as_array)
    {
        if let Some(node) = single_pinned_value(terms, "matchFields", "metadata.name") {
            return Some((node, "nodeAffinity"));
        }
        if let Some(node) = single_pinned_value(terms, "matchExpressions", "kubernetes.io/hostname")
        {
            return Some((node, "nodeAffinity"));
        }
    }
    if let Some(host) = pod_spec
        .get("nodeSelector")
        .and_then(|s| s.get("kubernetes.io/hostname"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some((host.to_owned(), "nodeSelector"));
    }
    None
}

fn path_values<'a>(value: &'a Value, path: &str) -> Vec<&'a Value> {
    let mut values = vec![value];
    for part in path.split('.') {
        values = values
            .into_iter()
            .flat_map(|value| {
                if part == "*" {
                    value
                        .as_array()
                        .map(|a| a.iter().collect())
                        .unwrap_or_default()
                } else {
                    value.get(part).into_iter().collect::<Vec<_>>()
                }
            })
            .collect();
    }
    values
}

pub fn references(object: &Value) -> Vec<RelatedResource> {
    let namespace = object["metadata"]["namespace"].as_str().map(str::to_owned);
    let mut out = Vec::new();
    let mut add = |api: &str,
                   kind: &str,
                   name: Option<&str>,
                   ns: Option<String>,
                   uid: Option<&str>,
                   relation: &str| {
        let Some(name) = name.filter(|s| !s.is_empty()) else {
            return;
        };
        let (group, version) = api.split_once('/').unwrap_or(("", api));
        if kind.is_empty() || version.is_empty() {
            return;
        }
        let namespace = super::api::resource_type(kind)
            .filter(|r| r.group == group)
            .map(|r| if r.namespaced { ns.clone() } else { None })
            .unwrap_or(ns);
        let reference = RelatedResource {
            group: group.into(),
            version: version.into(),
            kind: kind.into(),
            namespace,
            name: name.into(),
            uid: uid.filter(|s| !s.is_empty()).map(str::to_owned),
            relation: relation.into(),
        };
        if !out.contains(&reference) {
            out.push(reference);
        }
    };
    for owner in object["metadata"]["ownerReferences"]
        .as_array()
        .into_iter()
        .flatten()
    {
        add(
            owner["apiVersion"].as_str().unwrap_or(""),
            owner["kind"].as_str().unwrap_or(""),
            owner["name"].as_str(),
            namespace.clone(),
            owner["uid"].as_str(),
            if owner["controller"] == true {
                "controller"
            } else {
                "owner"
            },
        );
    }
    let kind = object["kind"].as_str().unwrap_or("");
    let api = object["apiVersion"].as_str().unwrap_or("");
    let group = api.split_once('/').map(|(g, _)| g).unwrap_or("");
    // Never interpret an arbitrary CRD's spec as a built-in PodSpec.
    if !super::api::resource_type(kind).is_some_and(|r| r.group == group) {
        return out;
    }
    let spec = &object["spec"];
    let pod = match kind {
        "Pod" => Some(spec),
        "Deployment"
        | "DaemonSet"
        | "StatefulSet"
        | "ReplicaSet"
        | "ReplicationController"
        | "Job" => spec.pointer("/template/spec"),
        "CronJob" => spec.pointer("/jobTemplate/spec/template/spec"),
        _ => None,
    };
    if let Some(pod) = pod {
        let scheduled = pod["nodeName"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(node) = scheduled {
            add("v1", "Node", Some(node), None, None, "scheduledOn");
        } else if let Some((target, _)) = pinned_pod_node(pod) {
            add("v1", "Node", Some(target.as_str()), None, None, "targetsNode");
        } else if kind == "Pod" {
            let nominated = object["status"]["nominatedNodeName"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if let Some(node) = nominated {
                add("v1", "Node", Some(node), None, None, "nominatedNode");
            }
        }
        for rule in pod_rules() {
            for name in path_values(pod, &rule.path) {
                add(
                    &rule.api_version,
                    &rule.kind,
                    name.as_str(),
                    if rule.cluster {
                        None
                    } else {
                        namespace.clone()
                    },
                    None,
                    "uses",
                );
            }
        }
    }
    match kind {
        "PersistentVolumeClaim" => {
            add(
                "v1",
                "PersistentVolume",
                spec["volumeName"].as_str(),
                None,
                None,
                "boundTo",
            );
            add(
                "storage.k8s.io/v1",
                "StorageClass",
                spec["storageClassName"].as_str(),
                None,
                None,
                "uses",
            );
        }
        "PersistentVolume" => {
            let r = &spec["claimRef"];
            add(
                "v1",
                "PersistentVolumeClaim",
                r["name"].as_str(),
                r["namespace"].as_str().map(str::to_owned),
                r["uid"].as_str(),
                "boundTo",
            );
        }
        "StatefulSet" => add(
            "v1",
            "Service",
            spec["serviceName"].as_str(),
            namespace.clone(),
            None,
            "uses",
        ),
        "HorizontalPodAutoscaler" => {
            let r = &spec["scaleTargetRef"];
            add(
                r["apiVersion"].as_str().unwrap_or("apps/v1"),
                r["kind"].as_str().unwrap_or(""),
                r["name"].as_str(),
                namespace.clone(),
                None,
                "scales",
            );
        }
        "Ingress" => {
            let mut backends = vec![&spec["defaultBackend"]];
            for rule in spec["rules"].as_array().into_iter().flatten() {
                for path in rule["http"]["paths"].as_array().into_iter().flatten() {
                    backends.push(&path["backend"]);
                }
            }
            for b in backends {
                add(
                    "v1",
                    "Service",
                    b["service"]["name"].as_str(),
                    namespace.clone(),
                    None,
                    "routesTo",
                );
            }
            for tls in spec["tls"].as_array().into_iter().flatten() {
                add(
                    "v1",
                    "Secret",
                    tls["secretName"].as_str(),
                    namespace.clone(),
                    None,
                    "uses",
                );
            }
        }
        "EndpointSlice" => {
            add(
                "v1",
                "Service",
                object["metadata"]["labels"]["kubernetes.io/service-name"].as_str(),
                namespace.clone(),
                None,
                "serves",
            );
            for endpoint in object["endpoints"].as_array().into_iter().flatten() {
                let r = &endpoint["targetRef"];
                add(
                    r["apiVersion"].as_str().unwrap_or("v1"),
                    r["kind"].as_str().unwrap_or("Pod"),
                    r["name"].as_str(),
                    r["namespace"]
                        .as_str()
                        .map(str::to_owned)
                        .or(namespace.clone()),
                    r["uid"].as_str(),
                    "targets",
                );
            }
        }
        "RoleBinding" | "ClusterRoleBinding" => {
            let r = &object["roleRef"];
            add(
                "rbac.authorization.k8s.io/v1",
                r["kind"].as_str().unwrap_or(""),
                r["name"].as_str(),
                namespace.clone(),
                None,
                "grants",
            );
            for r in object["subjects"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| r["kind"] == "ServiceAccount")
            {
                add(
                    "v1",
                    "ServiceAccount",
                    r["name"].as_str(),
                    r["namespace"]
                        .as_str()
                        .map(str::to_owned)
                        .or(namespace.clone()),
                    None,
                    "subject",
                );
            }
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn daemonset_and_projected_references_are_exact() {
        let pod = json!({"apiVersion":"v1","kind":"Pod","metadata":{"namespace":"ns","ownerReferences":[{"apiVersion":"apps/v1","kind":"DaemonSet","name":"agent","uid":"ds-id","controller":true}]},"spec":{"nodeName":"node","volumes":[{"projected":{"sources":[{"secret":{"name":"auth"}}]}}]}});
        let refs = references(&pod);
        assert_eq!(refs.len(), 3);
        assert_eq!(refs[0].kind, "DaemonSet");
        assert_eq!(refs[0].uid.as_deref(), Some("ds-id"));
        assert!(refs[1].namespace.is_none());
        assert_eq!(refs[2].name, "auth");
    }
    #[test]
    fn custom_kinds_only_use_explicit_owner_references() {
        assert!(references(&json!({"apiVersion":"example.io/v1","kind":"Pod","spec":{"nodeName":"not-a-reference"}})).is_empty());
    }
    #[test]
    fn daemonset_pending_pod_extracts_pinned_node_affinity_and_rejects_multi_node_or() {
        let daemonset_pod = json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {"name": "agent-abc", "namespace": "kube-system"},
            "spec": {
                "affinity": {
                    "nodeAffinity": {
                        "requiredDuringSchedulingIgnoredDuringExecution": {
                            "nodeSelectorTerms": [
                                {
                                    "matchExpressions": [{"key": "role", "operator": "In", "values": ["infra"]}],
                                    "matchFields": [{"key": "metadata.name", "operator": "In", "values": ["worker-3"]}]
                                },
                                {
                                    "matchExpressions": [{"key": "role", "operator": "In", "values": ["edge"]}],
                                    "matchFields": [{"key": "metadata.name", "operator": "In", "values": ["worker-3"]}]
                                }
                            ]
                        }
                    }
                }
            },
            "status": {"phase": "Pending"}
        });
        assert_eq!(
            pinned_pod_node(&daemonset_pod["spec"]),
            Some(("worker-3".into(), "nodeAffinity"))
        );
        let refs = references(&daemonset_pod);
        assert!(refs.iter().any(|r| r.kind == "Node" && r.name == "worker-3" && r.relation == "targetsNode"));

        // Multiple candidate nodes in OR terms must NOT be reported as pinned to a single node.
        let multi_or = json!({
            "affinity": {
                "nodeAffinity": {
                    "requiredDuringSchedulingIgnoredDuringExecution": {
                        "nodeSelectorTerms": [
                            {"matchFields": [{"key": "metadata.name", "operator": "In", "values": ["worker-1"]}]},
                            {"matchFields": [{"key": "metadata.name", "operator": "In", "values": ["worker-2"]}]}
                        ]
                    }
                }
            }
        });
        assert_eq!(pinned_pod_node(&multi_or), None);

        // Hostname nodeSelector fallback.
        let selector_spec = json!({"nodeSelector": {"kubernetes.io/hostname": "worker-9"}});
        assert_eq!(
            pinned_pod_node(&selector_spec),
            Some(("worker-9".into(), "nodeSelector"))
        );
    }
}
