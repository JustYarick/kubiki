//! Resource usage and reservations from independently authorized live reads.
use crate::{kubernetes::KubernetesTools, *};
use kubiki_core::metrics::{
    MetricsService,
    budget::{pod_budget, quantity},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
enum MetricsKind {
    #[default]
    Pod,
    Node,
}

impl MetricsKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pod => "Pod",
            Self::Node => "Node",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Args {
    namespace: Option<String>,
    name: Option<String>,
    #[serde(default)]
    kind: MetricsKind,
    pod_namespaces: Option<Vec<String>>,
    history_minutes: Option<u32>,
    history_end: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Default)]
pub(crate) struct MetricHistory {
    samples: std::collections::VecDeque<(u64, String, i64, Value)>,
}

impl MetricHistory {
    fn observe(&mut self, revision: u64, metric: &Value) {
        let (Some(uid), Some(time)) = (metric["uid"].as_str(), metric["timestamp"].as_str()) else {
            return;
        };
        let Ok(time) = chrono::DateTime::parse_from_rfc3339(time) else {
            return;
        };
        let at = time.timestamp_millis();
        if !metric["usage"].is_object()
            || self
                .samples
                .iter()
                .rev()
                .any(|(r, id, t, _)| *r == revision && id == uid && *t == at)
        {
            return;
        }
        if self.samples.len() >= 4096 {
            self.samples.pop_front();
        }
        self.samples.push_back((
            revision,
            uid.into(),
            at,
            json!({"timestamp":metric["timestamp"],"usage":metric["usage"]}),
        ));
    }

    fn range(&self, revision: u64, uid: &str, minutes: u32, now: i64) -> Vec<Value> {
        let mut points: Vec<_> = self
            .samples
            .iter()
            .filter(|(r, id, t, _)| {
                *r == revision && id == uid && (now - i64::from(minutes) * 60000..=now).contains(t)
            })
            .collect();
        points.sort_by_key(|(_, _, t, _)| *t);
        points
            .into_iter()
            .rev()
            .take(200)
            .rev()
            .map(|(_, _, _, v)| v.clone())
            .collect()
    }
}

impl KubernetesTools {
    pub(crate) async fn resource_metrics(
        &self,
        session: &Session,
        call: &ToolCall,
    ) -> Result<Value, String> {
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid metrics arguments")?;
        let state = session.control()?;
        if !state.policy.metrics {
            return Err("Metrics are disabled by policy".into());
        }
        let kind = args.kind;
        if (kind == MetricsKind::Pod
            && (args.namespace.is_none() || args.pod_namespaces.is_some()))
            || (kind == MetricsKind::Node
                && (args.namespace.is_some() || args.name.as_deref().is_none_or(str::is_empty)))
        {
            return Err("Pod metrics require one namespace; Node metrics require namespace:null and an exact name".into());
        }
        if args
            .pod_namespaces
            .as_ref()
            .is_some_and(|ns| ns.is_empty() || ns.len() > 20)
        {
            return Err("Choose 1–20 Pod namespaces".into());
        }
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: kind.as_str().into(),
            namespace: args.namespace.clone(),
            name: args.name.clone().unwrap_or_default(),
        };
        if target
            .namespace
            .iter()
            .chain(std::iter::once(&target.name))
            .any(|v| {
                v.len() > 253
                    || !v
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
            })
        {
            return Err("Invalid metrics identity".into());
        }
        state.policy.check_scope(&session.scope, &target)?;
        if state.policy.access(&target, true) != DataAccess::Content {
            return Err("Metrics require content access to the target resource".into());
        }
        if !state
            .policy
            .denied_fields(&target, true, &["status.metrics".into()])
            .is_empty()
        {
            return Err("Metrics fields are disabled by policy".into());
        }
        let client = self
            .client
            .clone()
            .ok_or("Cluster connection unavailable")?;
        if kind == MetricsKind::Pod
            && target.name.is_empty()
            && !state.policy.collection_content_allowed(&target, true)
        {
            return Err("Per-resource rules require an exact Pod name for metrics; query permitted identities first".into());
        }
        if args.history_end.is_some() && args.history_minutes.is_none() {
            return Err("historyEnd requires historyMinutes".into());
        }
        if let Some(minutes) = args.history_minutes {
            let end = args.history_end.unwrap_or_else(chrono::Utc::now);
            if end > chrono::Utc::now() {
                return Err("History end is in the future".into());
            }
            if !(1..=1440).contains(&minutes) || target.name.is_empty() {
                return Err(
                    "History requires an exact resource name and historyMinutes between 1 and 1440"
                        .into(),
                );
            }
            let root = self
                .metric_resource(session, &target)
                .await
                .ok_or("Cannot verify the current resource identity")?;
            let uid = root["metadata"]["uid"]
                .as_str()
                .ok_or("Resource UID unavailable")?;
            if let Some(service) =
                kubiki_core::metrics::history::configured_service(&session.scope.context)?
            {
                // External series contain aggregate usage. Never reconstruct a hidden input.
                let fields = ["cpu", "memory", "usage", "containers", "timestamp", "uid"];
                let restricted = !state.policy.allowed_fields.is_empty()
                    || state.policy.denied_paths.iter().any(|p| {
                        fields.iter().any(|field| {
                            let path = format!("/status/metrics/{field}");
                            path == *p
                                || path.starts_with(&format!("{p}/"))
                                || p.starts_with(&format!("{path}/"))
                        })
                    });
                if restricted {
                    return Err("Historical aggregates require unrestricted metric inputs".into());
                }
                let created = root["metadata"]["creationTimestamp"]
                    .as_str()
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                    .ok_or("Cannot establish resource creation time for historical series")?;
                let end = end.timestamp();
                // CPU uses a five-minute rate; keep its entire window inside the current object's lifetime.
                let start = (end - i64::from(minutes) * 60).max(created.timestamp() + 301);
                let samples = if start <= end {
                    service
                        .usage(
                            &client,
                            target.namespace.as_deref(),
                            &target.name,
                            start,
                            end,
                        )
                        .await?
                } else {
                    Vec::new()
                };
                return Ok(
                    json!({"kind":kind,"uid":uid,"samples":samples,"units":{"cpu":"cores","memory":"bytes"},"source":"Prometheus","coverage":"Source series for the current resource lifetime. Missing points or dimensions are unknown."}),
                );
            }
            let samples = session
                .metric_history
                .lock()
                .map_err(|_| "Metrics history unavailable")?
                .range(state.revision, uid, minutes, end.timestamp_millis());
            return Ok(
                json!({"kind":kind,"samples":samples,"units":{"cpu":"cores","memory":"bytes"},"coverage":"Up to 200 previously observed Metrics API samples for this resource UID in the current session and scope. Gaps are unknown."}),
            );
        }
        let mut metrics = Vec::new();
        let mut has_more = false;
        if kind == MetricsKind::Pod {
            let ns = args.namespace.as_deref().unwrap();
            let samples = if target.name.is_empty() {
                MetricsService::get_pod_metrics(&client, Some(ns)).await
            } else {
                MetricsService::get_pod_metric(&client, ns, &target.name)
                    .await
                    .map(|sample| vec![sample])
            }
            .map_err(|_| "Pod metrics unavailable or denied")?;
            has_more = samples.len() > 50;
            for sample in samples.into_iter().take(50) {
                if sample.namespace != ns || !target.name.is_empty() && sample.name != target.name {
                    return Err("Metrics response does not match the requested resource".into());
                }
                let actual = Target {
                    name: sample.name.clone(),
                    ..target.clone()
                };
                if state.policy.access(&actual, true) != DataAccess::Content {
                    continue;
                }
                let root = self.metric_resource(session, &actual).await;
                let mut data = serde_json::to_value(&sample).map_err(|_| "Invalid Pod metric")?;
                let permitted = project_metric_fields(&state.policy, &actual, data.clone())?;
                let sum = |dimension: &str| -> Option<f64> {
                    let containers = permitted["containers"].as_array()?;
                    if containers.is_empty() || containers.len() != sample.containers.len() {
                        return None;
                    }
                    containers
                        .iter()
                        .map(|container| quantity(&container[dimension]))
                        .collect::<Option<Vec<_>>>()
                        .map(|values| values.iter().sum::<f64>())
                };
                let cpu = sum("cpu");
                let memory = sum("memory");
                let replaced = root
                    .as_ref()
                    .and_then(|pod| pod["metadata"]["creationTimestamp"].as_str())
                    .zip(chrono::DateTime::parse_from_rfc3339(&sample.timestamp).ok())
                    .is_some_and(|(created, measured)| {
                        chrono::DateTime::parse_from_rfc3339(created)
                            .is_ok_and(|created| created > measured)
                    });
                data["usage"] = if replaced {
                    Value::Null
                } else {
                    json!({"cpu":cpu,"memory":memory})
                };
                if replaced {
                    data["containers"] = json!([]);
                }
                data["uid"] = root
                    .as_ref()
                    .map(|pod| pod["metadata"]["uid"].clone())
                    .unwrap_or(Value::Null);
                data["budgets"] = root
                    .as_ref()
                    .map(|pod| budgets(&state.policy, &actual, pod))
                    .unwrap_or(Value::Null);
                data["usageStatus"] = json!(if replaced {
                    "samplePredatesResource"
                } else {
                    "observed"
                });
                metrics.push(project_metric(&state.policy, &actual, data)?);
            }
        } else {
            let root = self.metric_resource(session, &target).await;
            let sample = MetricsService::get_node_metric(&client, &target.name)
                .await
                .map_err(|_| "Node metrics unavailable or denied")?;
            if sample.name != target.name {
                return Err("Metrics response does not match the requested Node".into());
            }
            let mut data = serde_json::to_value(&sample).map_err(|_| "Invalid Node metric")?;
            let permitted = project_metric_fields(&state.policy, &target, data.clone())?;
            data["usage"] =
                json!({"cpu":quantity(&permitted["cpu"]),"memory":quantity(&permitted["memory"])});
            data["capacity"] = resource_pair(root.as_ref().map(|v| &v["status"]["capacity"]));
            data["allocatable"] = resource_pair(root.as_ref().map(|v| &v["status"]["allocatable"]));
            data["allocations"] = self
                .node_allocations(session, &target.name, args.pod_namespaces)
                .await;
            data["uid"] = root
                .as_ref()
                .map(|v| v["metadata"]["uid"].clone())
                .unwrap_or(Value::Null);
            metrics.push(project_metric(&state.policy, &target, data)?);
        }
        let mut history = session
            .metric_history
            .lock()
            .map_err(|_| "Metrics history unavailable")?;
        for metric in &metrics {
            history.observe(state.revision, metric);
        }
        Ok(
            json!({"kind":kind,"metrics":metrics,"hasMore":has_more,"capturedAt":chrono::Utc::now().timestamp_millis(),"units":{"cpu":"cores","memory":"bytes"},"completeness":"partial","coverage":"Current Metrics API samples; requests are scheduler reservations, limits are configured ceilings, null is unbounded or unknown. Node allocations report their own namespace/page/policy coverage; usage includes host processes and is never inferred from Pod sums."}),
        )
    }

    async fn metric_resource(&self, session: &Session, target: &Target) -> Option<Value> {
        self.linked_read(session, "get_resource", json!({"group":"","version":"v1","kind":target.kind,"namespace":target.namespace,"name":target.name,"fields":["metadata","spec.containers","spec.initContainers","spec.resources","spec.overhead","status.capacity","status.allocatable"]}))
            .await.ok().map(|v| v["resource"].clone())
    }

    async fn node_allocations(
        &self,
        session: &Session,
        name: &str,
        requested: Option<Vec<String>>,
    ) -> Value {
        let Ok(state) = session.control() else {
            return json!({"status":"unavailable"});
        };
        let mut complete =
            requested.is_none() && session.scope.all_namespaces && state.policy.namespaces == ["*"];
        let mut reasons = Vec::new();
        let names = if let Some(names) = requested {
            names
        } else {
            match self
                .linked_read(session, "list_namespaces", json!({"pageSize":20}))
                .await
            {
                Ok(page) => {
                    if page["hasMore"] == true || page["omittedByPolicy"].as_u64().unwrap_or(0) > 0
                    {
                        complete = false;
                        reasons.push("Namespace discovery is partial".to_owned());
                    }
                    page["namespaces"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                }
                Err(_) => {
                    return json!({"status":"unavailable","reason":"Cannot discover permitted Pod namespaces; pass podNamespaces explicitly"});
                }
            }
        };
        let names: std::collections::BTreeSet<_> = names.into_iter().collect();
        let mut totals = [[Some(0.0); 2]; 2];
        let mut count = 0;
        let mut pages = 0;
        let mut successful_pages = 0;
        let mut ranked_pods = Vec::new();
        for ns in &names {
            let mut query = json!({"group":"","version":"v1","kind":"Pod","namespace":ns,"fieldSelector":format!("spec.nodeName={name}"),"fields":["metadata","spec.nodeName","spec.containers","spec.initContainers","spec.resources","spec.overhead","status.phase"],"pageSize":50});
            loop {
                if pages >= 10 {
                    complete = false;
                    reasons.push("Allocation page budget exhausted".into());
                    break;
                }
                pages += 1;
                let page = match self
                    .linked_read(session, "list_resources", query.clone())
                    .await
                {
                    Ok(page) => page,
                    Err(_) => {
                        complete = false;
                        reasons.push(format!("{ns}: Pod read unavailable or denied"));
                        break;
                    }
                };
                successful_pages += 1;
                if page["omittedByPolicy"].as_u64().unwrap_or(0) > 0 {
                    complete = false;
                    reasons.push(format!("{ns}: Pods omitted by policy"));
                }
                for pod in page["items"].as_array().into_iter().flatten() {
                    if matches!(
                        pod["status"]["phase"].as_str(),
                        Some("Succeeded" | "Failed")
                    ) {
                        continue;
                    }
                    if pod["spec"]["nodeName"] != name || !pod["status"]["phase"].is_string() {
                        complete = false;
                        reasons.push("Scheduling or phase fields are hidden".into());
                        continue;
                    }
                    count += 1;
                    let target = Target {
                        group: "".into(),
                        version: "v1".into(),
                        kind: "Pod".into(),
                        namespace: Some(ns.clone()),
                        name: pod["metadata"]["name"].as_str().unwrap_or_default().into(),
                    };
                    let known = budgets(&state.policy, &target, pod);
                    if let (Some(memory), Some(pod_name)) = (
                        known["memory"]["requests"].as_f64(),
                        pod["metadata"]["name"].as_str(),
                    ) {
                        ranked_pods.push((memory, json!({"namespace":pod["metadata"]["namespace"],"name":pod_name,"uid":pod["metadata"]["uid"],"budgets":known})));
                    }
                    if known["status"] == "unknown"
                        || known["cpu"]["requests"].is_null()
                        || known["memory"]["requests"].is_null()
                    {
                        complete = false;
                        reasons.push("Some Pod budget fields are unknown or hidden".into());
                    }
                    for (i, dimension) in ["cpu", "memory"].iter().enumerate() {
                        for (j, key) in ["requests", "limits"].iter().enumerate() {
                            totals[i][j] = totals[i][j]
                                .zip(known[dimension][key].as_f64())
                                .map(|(a, b)| a + b);
                        }
                    }
                }
                if page["hasMore"] != true {
                    break;
                }
                let Some(cursor) = page["cursor"].as_str() else {
                    complete = false;
                    break;
                };
                query["cursor"] = json!(cursor);
            }
        }
        if !complete && reasons.is_empty() {
            reasons.push("Only permitted or explicitly selected namespaces were examined".into());
        }
        reasons.sort();
        reasons.dedup();
        if successful_pages == 0 && !names.is_empty() {
            return json!({"status":"unavailable","namespaces":names,"pages":pages,"activePods":null,"cpu":{"requests":null,"limits":null},"memory":{"requests":null,"limits":null},"reasons":reasons});
        }
        ranked_pods.sort_by(|a, b| b.0.total_cmp(&a.0));
        let top: Vec<_> = ranked_pods
            .into_iter()
            .take(20)
            .map(|(_, pod)| pod)
            .collect();
        json!({"topPodsByMemoryRequest":top,"status":if complete {"complete"} else {"partial"},"namespaces":names,"pages":pages,"activePods":count,"cpu":{"requests":totals[0][0],"limits":totals[0][1]},"memory":{"requests":totals[1][0],"limits":totals[1][1]},"reasons":reasons})
    }
}

fn resource_pair(value: Option<&Value>) -> Value {
    json!({"cpu":value.and_then(|v| quantity(&v["cpu"])),"memory":value.and_then(|v| quantity(&v["memory"]))})
}
fn project_metric_fields(
    policy: &AgentPolicy,
    target: &Target,
    data: Value,
) -> Result<Value, String> {
    let source = json!({"apiVersion":"v1","kind":target.kind,"metadata":{"name":target.name,"namespace":target.namespace},"status":{"metrics":data}});
    Ok(policy.project(target, &source, true)?["status"]["metrics"].clone())
}
fn project_metric(policy: &AgentPolicy, target: &Target, mut data: Value) -> Result<Value, String> {
    let permitted = project_metric_fields(policy, target, data.clone())?;
    let age = permitted["timestamp"]
        .as_str()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|time| chrono::Utc::now().signed_duration_since(time).num_seconds());
    data["sampleAgeSeconds"] = json!(age);
    data["stale"] = json!(age.is_none_or(|seconds| seconds > 120 || seconds < -30));
    project_metric_fields(policy, target, data)
}
fn budgets(policy: &AgentPolicy, target: &Target, pod: &Value) -> Value {
    // Prove required budget subtrees are visible before interpreting absence as zero/unbounded.
    let mut marker = json!({"containers":[{"resources":{"requests":{"cpu":"1","memory":"1"},"limits":{"cpu":"1","memory":"1"}}}],"initContainers":[{"restartPolicy":"Always","resources":{"requests":{"cpu":"1","memory":"1"},"limits":{"cpu":"1","memory":"1"}}}],"resources":{"requests":{"cpu":"1","memory":"1"},"limits":{"cpu":"1","memory":"1"}},"overhead":{"cpu":"1","memory":"1"}});
    for field in ["containers", "initContainers"] {
        let count = pod["spec"][field]
            .as_array()
            .map_or(1, |items| items.len().max(1));
        if count >= 100 {
            return json!({"status":"unknown","reason":"Container projection may be truncated"});
        }
        marker[field] = json!(vec![marker[field][0].clone(); count]);
    }
    let allowed = policy
        .project(
            target,
            &json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":target.name},"spec":marker}),
            true,
        )
        .ok();
    if allowed.as_ref().map(|v| &v["spec"]) != Some(&marker) {
        return json!({"status":"unknown","reason":"Resource budget fields are hidden by policy"});
    }
    json!({"cpu":pod_budget(&pod["spec"],"cpu"),"memory":pod_budget(&pod["spec"],"memory")})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indexed_budget_masks_and_truncated_container_lists_stay_unknown() {
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: Some("apps".into()),
            name: "web".into(),
        };
        let pod = json!({"spec":{"containers":[{"resources":{"requests":{"cpu":"1"}}},{}]}});
        let policy = AgentPolicy {
            denied_paths: vec!["/spec/containers/1/resources".into()],
            ..Default::default()
        };
        assert_eq!(budgets(&policy, &target, &pod)["status"], "unknown");
        let many = json!({"spec":{"containers":vec![json!({});100]}});
        assert_eq!(
            budgets(&AgentPolicy::default(), &target, &many)["status"],
            "unknown"
        );
    }
}
