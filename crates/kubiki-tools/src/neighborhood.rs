//! Bounded graph traversal over policy-projected reads, shared by agent and MCP.
use crate::{kubernetes::KubernetesTools, *};
use kubiki_core::core::relationships::references;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};

const FIELDS: &[&str] = &[
    "metadata",
    "spec.nodeName",
    "spec.serviceAccountName",
    "spec.imagePullSecrets",
    "spec.priorityClassName",
    "spec.runtimeClassName",
    "spec.resourceClaims",
    "spec.ephemeralContainers[*].envFrom",
    "spec.volumes",
    "spec.containers[*].envFrom",
    "spec.containers[*].env[*].valueFrom",
    "spec.initContainers[*].envFrom",
    "spec.initContainers[*].env[*].valueFrom",
    "spec.ephemeralContainers[*].env[*].valueFrom",
    "spec.template.spec",
    "spec.jobTemplate.spec.template.spec",
    "spec.selector",
    "spec.rules",
    "spec.tls",
    "spec.defaultBackend",
    "spec.serviceName",
    "spec.volumeName",
    "spec.storageClassName",
    "spec.claimRef",
    "spec.scaleTargetRef",
    "endpoints[*].targetRef",
    "roleRef",
    "subjects",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NeighborhoodArgs {
    group: String,
    version: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    uid: Option<String>,
    hops: Option<usize>,
    max_nodes: Option<usize>,
}
impl KubernetesTools {
    pub(crate) async fn neighborhood(
        &self,
        session: &Session,
        arguments: Value,
    ) -> Result<Value, String> {
        let args: NeighborhoodArgs =
            serde_json::from_value(arguments).map_err(|_| "Invalid neighborhood arguments")?;
        let hops = args.hops.unwrap_or(2);
        let cap = args.max_nodes.unwrap_or(25);
        if !(1..=4).contains(&hops) || !(1..=100).contains(&cap) {
            return Err("Neighborhood requires hops 1–4 and maxNodes 1–100".into());
        }
        let root = json!({"group":args.group,"version":args.version,"kind":args.kind,"namespace":args.namespace,"name":args.name});
        let mut queue = VecDeque::from([(root.clone(), args.uid, 0usize, None::<(Value, String)>)]);
        let mut visited = HashSet::new();
        let mut nodes = vec![];
        let mut edges = vec![];
        let mut omitted = vec![];
        let mut queries = vec![];
        let mut truncated = false;
        while let Some((target, expected, depth, parent)) = queue.pop_front() {
            if json!([&nodes, &edges, &omitted, &queries])
                .to_string()
                .len()
                > 24000
            {
                truncated = true;
                break;
            }
            let key = target.to_string();
            if visited.contains(&key) {
                // Cycles and convergent paths retain their edges without rereading objects.
                if let Some((from, relation)) = parent {
                    if let Some(node) = nodes.iter().find(|n: &&Value| n["target"] == target) {
                        if expected
                            .as_ref()
                            .is_some_and(|uid| node["uid"].as_str() != Some(uid.as_str()))
                        {
                            omitted.push(
                                json!({"target":target,"reason":"Conflicting referenced UID"}),
                            );
                            continue;
                        }
                        let state = reference_state(&expected, &node["uid"], &relation);
                        edges.push(
                            json!({"from":from,"to":target,"relation":relation,"state":state}),
                        );
                    }
                }
                continue;
            }
            if visited.len() >= cap {
                truncated = true;
                break;
            }
            visited.insert(key);
            let mut query = target.clone();
            query["fields"] = json!(FIELDS);
            let result = self.linked_read(session, "get_resource", query).await;
            let page = match result {
                Ok(v) => v,
                Err(error) => {
                    if depth == 0 {
                        return Err(error);
                    }
                    omitted.push(json!({"target":target,"reason":error}));
                    continue;
                }
            };
            let resource = &page["resource"];
            let actual = resource["metadata"]["uid"].clone();
            if expected
                .as_ref()
                .is_some_and(|uid| actual.as_str() != Some(uid.as_str()))
            {
                if depth == 0 {
                    return Err(
                        "Root UID changed or is unavailable; refresh the resource identity".into(),
                    );
                }
                omitted.push(
                    json!({"target":target,"reason":"Referenced UID changed or is unavailable"}),
                );
                continue;
            }
            if let Some((from, relation)) = parent {
                edges.push(json!({"from":from,"to":target,"state":reference_state(&expected,&actual,&relation),"relation":relation}));
            }
            nodes.push(json!({"target":target,"uid":actual,"resourceVersion":resource["metadata"]["resourceVersion"],"capturedAt":page["capturedAt"]}));
            let refs = references(resource);
            if depth == hops {
                if !refs.is_empty() {
                    truncated = true;
                }
                continue;
            }
            for r in refs {
                if queue.len() >= cap * 4 {
                    truncated = true;
                    break;
                }
                let mut namespace = r.namespace.clone();
                if kubiki_core::core::api::resource_type(&r.kind)
                    .is_none_or(|known| known.group != r.group)
                {
                    if let Some(client) = self.client.clone() {
                        if let Ok(discovery) = kube::discovery::Discovery::new(client)
                            .filter(&[r.group.as_str()])
                            .run()
                            .await
                        {
                            if discovery
                                .groups()
                                .flat_map(|g| g.resources_by_stability())
                                .any(|(ar, c)| {
                                    ar.group == r.group
                                        && ar.version == r.version
                                        && ar.kind == r.kind
                                        && c.scope == kube::discovery::Scope::Cluster
                                })
                            {
                                namespace = None;
                            }
                        }
                    }
                }
                let next = json!({"group":r.group,"version":r.version,"kind":r.kind,"namespace":namespace,"name":r.name});
                queue.push_back((next, r.uid, depth + 1, Some((target.clone(), r.relation))));
            }
            // Reverse relationships stay namespace-bounded and expose continuation queries.
            // A page limit is coverage, never evidence that further consumers do not exist.
            let kind = target["kind"].as_str().unwrap_or("");
            let builtin = kubiki_core::core::api::resource_type(kind)
                .is_some_and(|r| Some(r.group.as_str()) == target["group"].as_str());
            let reverse = match if builtin { kind } else { "" } {
                "Pod"
                    if resource["metadata"]["labels"]
                        .as_object()
                        .is_some_and(|m| !m.is_empty()) =>
                {
                    Some(("", "Service", json!(["metadata", "spec.selector"]), None))
                }
                "Service" => Some((
                    "discovery.k8s.io",
                    "EndpointSlice",
                    json!(["metadata", "endpoints[*].targetRef"]),
                    Some(format!(
                        "kubernetes.io/service-name={}",
                        target["name"].as_str().unwrap_or("")
                    )),
                )),
                "ConfigMap" | "Secret" | "PersistentVolumeClaim" | "ServiceAccount" => {
                    Some(("", "Pod", json!(FIELDS), None))
                }
                "CronJob" => Some(("batch", "Job", json!(["metadata"]), None)),
                _ => None,
            };
            if let Some((group, related_kind, fields, selector)) = reverse {
                if target["namespace"].is_string() {
                    let list = json!({"group":group,"version":"v1","kind":related_kind,"namespace":target["namespace"],"labelSelector":selector.unwrap_or_default(),"fields":fields,"pageSize":25});
                    match self.linked_read(session, "list_resources", list).await {
                        Ok(page) => {
                            if page["hasMore"] == true {
                                truncated = true;
                                queries.push(page["continuationQuery"].clone());
                            }
                            for item in page["items"].as_array().into_iter().flatten() {
                                let matches = if kind == "Pod" {
                                    item["spec"]["selector"]
                                        .as_object()
                                        .is_some_and(|selector| {
                                            !selector.is_empty()
                                                && selector.iter().all(|(key, value)| {
                                                    resource["metadata"]["labels"].get(key)
                                                        == Some(value)
                                                })
                                        })
                                } else if kind == "Service" {
                                    !item["metadata"]["ownerReferences"].as_array().is_some_and(
                                        |refs| {
                                            refs.iter().any(|r| {
                                                r["kind"] == "Service"
                                                    && r["uid"].is_string()
                                                    && actual.is_string()
                                                    && r["uid"] != actual
                                            })
                                        },
                                    )
                                } else {
                                    references(item).iter().any(|r| {
                                        r.group == target["group"].as_str().unwrap_or("")
                                            && r.kind == kind
                                            && r.name == target["name"].as_str().unwrap_or("")
                                            && json!(r.namespace) == target["namespace"]
                                            && r.uid.as_ref().is_none_or(|uid| {
                                                actual.as_str() == Some(uid.as_str())
                                            })
                                    })
                                };
                                if !matches {
                                    continue;
                                }
                                let Some(name) = item["metadata"]["name"].as_str() else {
                                    continue;
                                };
                                if queue.len() >= cap * 4 {
                                    truncated = true;
                                    break;
                                }
                                queue.push_back((json!({"group":group,"version":"v1","kind":related_kind,"namespace":target["namespace"],"name":name}), item["metadata"]["uid"].as_str().map(str::to_owned),depth+1,Some((target.clone(),if kind=="Pod" {"selectedBy"} else {"referencedBy"}.into()))));
                            }
                        }
                        Err(error) => omitted.push(
                            json!({"target":target,"relation":"reverseReferences","reason":error}),
                        ),
                    }
                }
            }
            // Selector relationships are not ownership. Controllers additionally require exact owner UID.
            let kind = target["kind"].as_str().unwrap_or("");
            let child = match if builtin { kind } else { "" } {
                "Deployment" => Some(("apps", "ReplicaSet")),
                "Service" | "DaemonSet" | "StatefulSet" | "ReplicaSet" | "Job" => Some(("", "Pod")),
                _ => None,
            };
            if let Some((group, child_kind)) = child {
                let selector = if kind == "Service" {
                    json!({"matchLabels":resource["spec"]["selector"]})
                } else {
                    resource["spec"]["selector"].clone()
                };
                if let Ok(selector) = diagnostic_selector(&selector) {
                    let list = json!({"group":group,"version":"v1","kind":child_kind,"namespace":target["namespace"],"labelSelector":selector,"fields":["metadata"],"pageSize":25});
                    match self.linked_read(session, "list_resources", list).await {
                        Ok(page) => {
                            if page["hasMore"] == true {
                                truncated = true;
                                queries.push(page["continuationQuery"].clone());
                            }
                            for item in page["items"].as_array().into_iter().flatten() {
                                if kind != "Service"
                                    && !item["metadata"]["ownerReferences"].as_array().is_some_and(
                                        |rs| {
                                            rs.iter().any(|r| {
                                                r["controller"] == true
                                                    && actual.as_str().is_some()
                                                    && r["uid"] == actual
                                            })
                                        },
                                    )
                                {
                                    continue;
                                }
                                if queue.len() >= cap * 4 {
                                    truncated = true;
                                    break;
                                }
                                let Some(name) = item["metadata"]["name"].as_str() else {
                                    continue;
                                };
                                queue.push_back((json!({"group":group,"version":"v1","kind":child_kind,"namespace":target["namespace"],"name":name}),item["metadata"]["uid"].as_str().map(str::to_owned),depth+1,Some((target.clone(),if kind=="Service" {"selects"}else{"owns"}.into()))));
                            }
                        }
                        Err(error) => omitted
                            .push(json!({"target":target,"relation":"children","reason":error})),
                    }
                }
            }
        }
        Ok(
            json!({"root":root,"nodes":nodes,"edges":edges,"omitted":omitted,"truncated":truncated,"continuationQueries":queries,"coverage":"Permitted explicit references, bounded selectors and namespace consumer pages. Not a complete cluster graph; absent/filtered fields and unscanned reverse links do not establish absence. Re-root to expand.","completeness":"partial"}),
        )
    }

    pub(crate) async fn diagnose_resource(
        &self,
        session: &Session,
        arguments: Value,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Args {
            group: String,
            version: String,
            kind: String,
            namespace: Option<String>,
            name: String,
            uid: Option<String>,
            include_logs: Option<bool>,
        }
        let a: Args =
            serde_json::from_value(arguments).map_err(|_| "Invalid diagnosis arguments")?;
        let root = json!({"group":a.group,"version":a.version,"kind":a.kind,"namespace":a.namespace,"name":a.name});
        let mut graph = root.clone();
        graph["uid"] = json!(a.uid);
        graph["hops"] = json!(2);
        graph["maxNodes"] = json!(12);
        let builtin =
            kubiki_core::core::api::resource_type(&a.kind).is_some_and(|r| r.group == a.group);
        let (tool, args) = match if builtin { a.kind.as_str() } else { "" } {
            "Pod" => (
                "get_pod_diagnostics",
                json!({"namespace":a.namespace,"name":a.name}),
            ),
            "Service" => (
                "get_service_diagnostics",
                json!({"namespace":a.namespace,"name":a.name}),
            ),
            "PersistentVolumeClaim" => (
                "get_pvc_diagnostics",
                json!({"namespace":a.namespace,"name":a.name}),
            ),
            "Node" => ("get_node_diagnostics", json!({"name":a.name})),
            "Deployment" | "DaemonSet" | "StatefulSet" | "ReplicaSet" | "Job" | "CronJob" => {
                ("get_workload_diagnostics", root.clone())
            }
            _ => {
                let mut q = root.clone();
                q["profile"] = json!("health");
                ("get_resource", q)
            }
        };
        let (diagnosis, neighborhood) = tokio::join!(
            self.linked_read(session, tool, args),
            self.neighborhood(session, graph)
        );
        let diagnosis = diagnosis?;
        let uid = diagnosis
            .pointer("/evidence/uid")
            .or_else(|| diagnosis.pointer("/resource/metadata/uid"))
            .and_then(Value::as_str);
        if a.uid
            .as_deref()
            .is_some_and(|expected| uid != Some(expected))
        {
            return Err("Diagnostic root UID changed or is unavailable".into());
        }
        let neighborhood = neighborhood.and_then(|value| {
            if uid.is_some() && value.pointer("/nodes/0/uid").and_then(Value::as_str) != uid {
                Err("Root changed between health and graph reads; refresh before combining evidence".into())
            } else { Ok(value) }
        });
        let state = session.control()?;
        let events = async {
            if state.policy.events && uid.is_some() && a.namespace.is_some() {
                self.linked_read(
                    session,
                    "get_events_timeline",
                    json!({"namespace":a.namespace,"name":a.name,"uid":uid,"limit":20}),
                )
                .await
            } else {
                Err("Events unavailable: policy, namespace or UID".into())
            }
        };
        let logs = async {
            if !builtin || a.kind != "Pod" || a.include_logs == Some(false) {
                return json!({"collected":false,"reason":"Not requested for this target"});
            }
            if !state.policy.logs || uid.is_none() {
                return json!({"collected":false,"reason":"Logs unavailable: policy or UID"});
            }
            let mut out = vec![];
            for c in diagnosis["initContainers"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(diagnosis["containers"].as_array().into_iter().flatten())
            {
                let Some(container) = c["name"].as_str() else {
                    continue;
                };
                if c["restartCount"].as_u64().unwrap_or(0) == 0
                    && c["state"] != "terminated"
                    && c["state"] != "waiting"
                {
                    continue;
                }
                if out.len() >= 2 {
                    break;
                }
                let result=self.linked_read(session,"get_logs",json!({"namespace":a.namespace,"name":a.name,"uid":uid,"container":container,"previous":c["restartCount"].as_u64().unwrap_or(0)>0,"tailLines":80})).await;
                out.push(json!({"container":container,"result":compact_observation(session,observation(result))}));
            }
            json!({"containers":out,"coverage":"Up to two failing containers, up to 80 lines each. Use get_logs for additional evidence."})
        };
        let crash_causes = crate::diagnostics::extract_crash_causes(&diagnosis);
        let (events, logs) = tokio::join!(events, logs);
        Ok(
            json!({
                "diagnostic": compact_observation(session, diagnosis),
                "crashCauses": crash_causes,
                "neighborhood": compact_observation(session, observation(neighborhood)),
                "events": compact_observation(session, observation(events)),
                "logs": compact_observation(session, logs),
                "completeness": "partial",
                "next": "Follow exact graph references; use get_config_diagnostics on the root for config issues. Expand graph or logs for unresolved hypotheses."
            }),
        )
    }
}
fn observation(result: Result<Value, String>) -> Value {
    result.unwrap_or_else(|error| json!({"unavailable":true,"error":error}))
}
fn reference_state(expected: &Option<String>, actual: &Value, relation: &str) -> &'static str {
    if expected
        .as_ref()
        .is_some_and(|uid| actual.as_str() == Some(uid.as_str()))
    {
        "uid_verified"
    } else if matches!(relation, "owner" | "controller" | "owns") {
        "unverified_reference"
    } else {
        "observed_reference"
    }
}

fn compact_observation(session: &Session, value: Value) -> Value {
    let text = value.to_string();
    if text.len() <= 8000 {
        return value;
    }
    let id = session
        .evidence
        .lock()
        .ok()
        .and_then(|mut store| store.save(&value));
    json!({"evidenceId":id,"abridged":true,"originalBytes":text.len(),"excerpt":text.chars().take(1200).collect::<String>(),"coverage":"Partial excerpt. Use get_evidence with fields when evidenceId is present; otherwise repeat a narrower individual read. Do not infer absence."})
}
