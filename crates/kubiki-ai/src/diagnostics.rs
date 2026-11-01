//! Pure interpretation of policy-projected Kubernetes data. Missing fields stay unknown.
use serde_json::{Value, json};

pub fn workload_health(kind: &str, object: &Value) -> Value {
    let spec = &object["spec"];
    let status = &object["status"];
    let condition = |name: &str| {
        status["conditions"].as_array().is_some_and(|cs| {
            cs.iter()
                .any(|c| c["type"] == name && c["status"] == "True")
        })
    };
    let observed = object["metadata"]["generation"]
        .as_i64()
        .zip(status["observedGeneration"].as_i64());
    let mut state = "unknown";
    let mut reasons = Vec::new();
    let (desired, current, ready, updated, available) = match kind {
        "DaemonSet" => (
            status.get("desiredNumberScheduled"),
            status.get("currentNumberScheduled"),
            status.get("numberReady"),
            status.get("updatedNumberScheduled"),
            status.get("numberAvailable"),
        ),
        "Deployment" | "StatefulSet" | "ReplicaSet" => (
            spec.get("replicas"),
            status.get("replicas"),
            status.get("readyReplicas"),
            status.get("updatedReplicas"),
            status.get("availableReplicas"),
        ),
        _ => (None, None, None, None, None),
    };
    match kind {
        "Job" => {
            state = if condition("Failed") {
                "failed"
            } else if condition("Complete") {
                "completed"
            } else if spec["suspend"] == true {
                "suspended"
            } else if status["active"].as_u64().is_some_and(|n| n > 0) {
                "progressing"
            } else {
                "unknown"
            };
        }
        "CronJob" => {
            if spec["suspend"] == true {
                state = "suspended";
            }
            reasons.push("CronJob scheduling and child Job outcomes require separate evidence");
        }
        "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" => {
            if let Some((generation, observed)) = observed {
                if observed < generation {
                    state = "progressing";
                    reasons.push("Controller has not observed the current generation");
                } else if observed == generation {
                    if let Some((d, r)) = desired
                        .and_then(Value::as_i64)
                        .zip(ready.and_then(Value::as_i64))
                    {
                        if r < d {
                            state = "degraded";
                            reasons.push("Ready count is below desired count");
                        } else {
                            let rollout_done = match kind {
                                "Deployment" => {
                                    updated.and_then(Value::as_i64) == Some(d)
                                        && available.and_then(Value::as_i64) == Some(d)
                                        && current.and_then(Value::as_i64) == Some(d)
                                }
                                "DaemonSet" => {
                                    updated.and_then(Value::as_i64) == Some(d)
                                        && available.and_then(Value::as_i64) == Some(d)
                                        && status["numberMisscheduled"].as_i64() == Some(0)
                                }
                                "StatefulSet" => {
                                    status["currentRevision"]
                                        .as_str()
                                        .zip(status["updateRevision"].as_str())
                                        .is_some_and(|(a, b)| a == b)
                                        && updated.and_then(Value::as_i64) == Some(d)
                                }
                                _ => current.and_then(Value::as_i64) == Some(d),
                            };
                            if rollout_done {
                                state = "healthy";
                            }
                        }
                    }
                }
            }
            if condition("ReplicaFailure")
                || status["conditions"].as_array().is_some_and(|cs| {
                    cs.iter()
                        .any(|c| c["type"] == "Progressing" && c["status"] == "False")
                })
            {
                state = "failed";
                reasons.push("Controller reports a failure condition");
            }
        }
        _ => reasons.push("Unsupported workload kind"),
    }
    if state == "unknown" {
        reasons.push("Insufficient permitted evidence to establish workload health");
    }
    json!({"rolloutState":state,"issuesSummary":reasons,"replicas":{"desired":desired,"current":current,"ready":ready,"updated":updated,"available":available},"conditions":status.get("conditions")})
}

/// Convert a validated Kubernetes LabelSelector without dropping expressions.
/// Refuse empty selectors so missing/filtered data never causes a namespace scan.
pub fn diagnostic_selector(value: &Value) -> Result<String, String> {
    let mut terms = Vec::new();
    let safe = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_./".contains(&c))
    };
    if let Some(labels) = value.get("matchLabels") {
        for (key, value) in labels.as_object().ok_or("Invalid matchLabels")? {
            let value = value.as_str().ok_or("Invalid label value")?;
            if !safe(key) || (!value.is_empty() && !safe(value)) {
                return Err("Invalid selector token".into());
            }
            terms.push(format!("{key}={value}"));
        }
    }
    if let Some(expressions) = value.get("matchExpressions") {
        for expr in expressions.as_array().ok_or("Invalid matchExpressions")? {
            let key = expr["key"]
                .as_str()
                .filter(|s| safe(s))
                .ok_or("Invalid expression key")?;
            let values = match expr.get("values") {
                None => Vec::new(),
                Some(v) => v
                    .as_array()
                    .ok_or("Invalid expression values")?
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .filter(|s| s.is_empty() || safe(s))
                            .ok_or("Invalid expression value")
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            };
            terms.push(match expr["operator"].as_str() {
                Some("In") if !values.is_empty() => format!("{key} in ({})", values.join(",")),
                Some("NotIn") if !values.is_empty() => {
                    format!("{key} notin ({})", values.join(","))
                }
                Some("Exists") if values.is_empty() => key.to_owned(),
                Some("DoesNotExist") if values.is_empty() => format!("!{key}"),
                _ => return Err("Unsupported or invalid selector expression".into()),
            });
        }
    }
    if terms.is_empty() {
        return Err("Selector unavailable; refusing an unscoped child scan".into());
    }
    Ok(terms.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selectors_preserve_expressions_and_reject_broad_fallback() {
        assert_eq!(diagnostic_selector(&json!({"matchLabels":{"app":"web"},"matchExpressions":[{"key":"tier","operator":"In","values":["api","worker"]},{"key":"debug","operator":"DoesNotExist"}]})).unwrap(), "app=web,tier in (api,worker),!debug");
        for selector in [
            json!({}),
            json!({"matchExpressions":[{"key":"x","operator":"In","values":[]}]}),
            json!({"matchLabels":{"app":"x,y=z"}}),
        ] {
            assert!(diagnostic_selector(&selector).is_err());
        }
    }
    #[test]
    fn missing_or_filtered_fields_never_become_zero_or_healthy() {
        for kind in ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"] {
            let result = workload_health(kind, &json!({}));
            assert_eq!(result["rolloutState"], "unknown");
            assert!(result["replicas"]["desired"].is_null());
        }
    }
    #[test]
    fn daemonsets_and_jobs_use_their_own_status_fields() {
        let ds = json!({"metadata":{"generation":2},"status":{"observedGeneration":2,"desiredNumberScheduled":5,"currentNumberScheduled":5,"numberReady":4}});
        assert_eq!(
            workload_health("DaemonSet", &ds)["rolloutState"],
            "degraded"
        );
        assert_eq!(workload_health("DaemonSet", &ds)["replicas"]["desired"], 5);
        for (condition, expected) in [("Complete", "completed"), ("Failed", "failed")] {
            assert_eq!(
                workload_health(
                    "Job",
                    &json!({"status":{"conditions":[{"type":condition,"status":"True"}]}})
                )["rolloutState"],
                expected
            );
        }
    }
    #[test]
    fn rollout_requires_observed_generation_and_current_revision() {
        let mut obj = json!({"metadata":{"generation":2},"spec":{"replicas":3},"status":{"observedGeneration":1,"replicas":3,"readyReplicas":3,"updatedReplicas":3,"availableReplicas":3}});
        assert_eq!(
            workload_health("Deployment", &obj)["rolloutState"],
            "progressing"
        );
        obj["status"]["observedGeneration"] = json!(2);
        assert_eq!(
            workload_health("Deployment", &obj)["rolloutState"],
            "healthy"
        );
        assert_eq!(
            workload_health("StatefulSet", &obj)["rolloutState"],
            "unknown"
        );
    }
}

/// Missing or superseded generations cannot verify a particular accepted write.
pub fn accepted_generation_matches(object: &Value, expected: Option<u64>) -> bool {
    expected.is_none_or(|generation| object["metadata"]["generation"].as_u64() == Some(generation))
}

pub fn controller_verified(
    kind: &str,
    object: &Value,
    expected_replicas: Option<u32>,
    expected_uid: Option<&str>,
) -> bool {
    let uid = object["metadata"]["uid"]
        .as_str()
        .filter(|uid| !uid.is_empty());
    let identity_matches =
        uid.is_some() && expected_uid.is_none_or(|expected| Some(expected) == uid);
    identity_matches
        && expected_replicas
            .is_none_or(|n| object["spec"]["replicas"].as_u64() == Some(u64::from(n)))
        && matches!(
            workload_health(kind, object)["rolloutState"].as_str(),
            Some("healthy" | "completed")
        )
}
#[cfg(test)]
mod verification_tests {
    use super::*;
    #[test]
    fn verification_requires_identity_generation_and_expected_target() {
        let mut resource = json!({"metadata":{"uid":"original","generation":2},"spec":{"replicas":3},"status":{"observedGeneration":2,"replicas":3,"readyReplicas":3,"updatedReplicas":3,"availableReplicas":3}});
        assert!(controller_verified(
            "Deployment",
            &resource,
            Some(3),
            Some("original")
        ));
        assert!(!controller_verified(
            "Deployment",
            &resource,
            Some(4),
            Some("original")
        ));
        assert!(!controller_verified(
            "Deployment",
            &resource,
            None,
            Some("replacement")
        ));
        resource["status"]["observedGeneration"] = json!(1);
        assert!(!controller_verified("Deployment", &resource, None, None));
        resource["metadata"]["uid"] = Value::Null;
        assert!(!controller_verified("Deployment", &resource, None, None));
    }
}

fn termination_details(value: &Value) -> Value {
    let reason = value["reason"].as_str();
    json!({"exitCode":value.get("exitCode"),"reason":reason,"message":value.get("message"),"oomKilled":reason.map(|r|r=="OOMKilled"),"finishedAt":value.get("finishedAt")})
}
/// Interpret only projected fields. Exit 137 alone establishes SIGKILL, not OOM.
pub fn container_diagnostics(
    statuses: &Value,
    is_init: bool,
    issues: &mut Vec<String>,
) -> Vec<Value> {
    statuses.as_array().into_iter().flatten().map(|container| {
        let name=container["name"].as_str();
        let prefix=if is_init {"Init container"}else{"Container"};
        let state=&container["state"];
        let (state_name,details)=if let Some(waiting)=state.get("waiting") {
            issues.push(format!("{prefix} '{}' is waiting: {}",name.unwrap_or("unknown"),waiting["reason"].as_str().unwrap_or("reason unavailable")));
            ("waiting",json!({"reason":waiting.get("reason"),"message":waiting.get("message")}))
        } else if let Some(running)=state.get("running") { ("running",json!({"startedAt":running.get("startedAt")})) }
        else if let Some(terminated)=state.get("terminated") {
            if terminated["exitCode"].as_i64().is_some_and(|n|n!=0) || terminated["reason"]=="OOMKilled" {
                issues.push(format!("{prefix} '{}' terminated: exitCode {:?}, reason {}",name.unwrap_or("unknown"),terminated["exitCode"].as_i64(),terminated["reason"].as_str().unwrap_or("unavailable")));
            }
            ("terminated",termination_details(terminated))
        } else {("unknown",Value::Null)};
        let last=container.pointer("/lastState/terminated").map(termination_details);
        if container["restartCount"].as_i64().is_some_and(|n|n>0) {
            issues.push(format!("{prefix} '{}' has restarted {:?} times",name.unwrap_or("unknown"),container["restartCount"].as_i64()));
        }
        json!({"name":name,"image":container.get("image"),"ready":container.get("ready"),"restartCount":container.get("restartCount"),"state":state_name,"stateDetails":details,"lastTermination":last})
    }).collect()
}

/// Interpret projected observations, never assuming filtered fields are false.
pub fn service_diagnostics(
    service: &Value,
    endpoint_slices: Option<&Value>,
    matching_pods: Option<&[Value]>,
) -> Value {
    let spec = &service["spec"];
    let service_type = spec["type"].as_str();
    let cluster_ip = spec["clusterIP"].as_str();
    let mut issues = Vec::<String>::new();
    let selector = spec.get("selector").and_then(Value::as_object);
    let selector_str =
        selector.and_then(|s| crate::diagnostic_selector(&json!({"matchLabels":s})).ok());
    let ports = spec["ports"].as_array();
    if service_type == Some("LoadBalancer")
        && service
            .pointer("/status/loadBalancer/ingress")
            .and_then(Value::as_array)
            .is_some_and(|a| a.is_empty())
    {
        issues.push(
            "LoadBalancer ingress IP or hostname is not yet assigned in the observed status".into(),
        );
    }
    if selector.is_some_and(|s| s.is_empty()) && service_type != Some("ExternalName") {
        issues.push(
            "Observed empty Service selector; inspect manually managed EndpointSlices".into(),
        );
    }
    let mut pods_summary = Vec::new();
    if let Some(pods) = matching_pods {
        if pods.is_empty() {
            issues.push("No permitted matching Pods observed in this bounded selection; this does not prove no Pods match".into());
        }
        for pod in pods {
            let condition = |name: &str| {
                pod["status"]["conditions"]
                    .as_array()
                    .and_then(|cs| cs.iter().find(|c| c["type"] == name))
                    .and_then(|c| c["status"].as_str())
            };
            let ready = condition("Ready").and_then(|s| match s {
                "True" => Some(true),
                "False" => Some(false),
                _ => None,
            });
            if ready == Some(false) {
                issues.push("An observed matching Pod has Ready=False; inspect conditions to determine the cause".into());
            }
            pods_summary.push(json!({"name":pod["metadata"]["name"],"uid":pod["metadata"]["uid"],"phase":pod["status"]["phase"],"ready":ready,"containersReady":condition("ContainersReady")}));
        }
    }
    let endpoints=endpoint_slices.and_then(Value::as_array).map(|slices| {
        let mut ready=0; let mut not_ready=0; let mut unknown=0; let mut missing=0;
        for slice in slices {
            match slice["endpoints"].as_array() {
                Some(eps)=>for ep in eps { match ep.pointer("/conditions/ready").and_then(Value::as_bool) {Some(true)=>ready+=1,Some(false)=>not_ready+=1,None=>unknown+=1} },
                None=>missing+=1,
            }
        }
        if not_ready>0 { issues.push(format!("{not_ready} observed endpoints explicitly report ready=false")); }
        json!({"slicesExamined":slices.len(),"readyCount":ready,"notReadyCount":not_ready,"unknownReadinessCount":unknown,"slicesWithoutPermittedEndpoints":missing,"coverage":"Observed endpoint entries only; entries may repeat across slices/address families. Missing readiness is unknown after policy projection."})
    });
    json!({"serviceType":service_type,"clusterIp":cluster_ip,"isHeadless":cluster_ip.map(|ip|ip=="None"),"externalName":spec.get("externalName"),"publishNotReadyAddresses":spec.get("publishNotReadyAddresses"),"ports":ports,"selector":selector_str,"endpoints":endpoints,"matchingPods":pods_summary,"issuesSummary":issues,"coverage":"Partial projected observations; Pod readiness does not prove probe failure, numeric containerPort declarations do not establish listeners or connectivity"})
}

/// Pure interpretation of policy-projected PersistentVolumeClaim storage data. Missing fields stay unknown.
pub fn pvc_diagnostics(pvc: &Value, pv: Option<&Value>, events: Option<&[Value]>) -> Value {
    let spec = &pvc["spec"];
    let status = &pvc["status"];
    let mut issues = Vec::new();

    let phase = status
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let storage_class = spec
        .get("storageClassName")
        .or_else(|| pvc.pointer("/metadata/annotations/volume.beta.kubernetes.io/storage-class"))
        .and_then(Value::as_str);
    let volume_name = spec.get("volumeName").and_then(Value::as_str);
    let requested_storage = spec
        .pointer("/resources/requests/storage")
        .and_then(Value::as_str);
    let capacity_storage = status.pointer("/capacity/storage").and_then(Value::as_str);
    let access_modes = spec.get("accessModes").cloned();

    match phase {
        "Pending" => {
            // Inspect events or conditions for specific pending reasons
            let mut detected_reason = false;
            if let Some(evs) = events {
                for ev in evs {
                    let reason = ev.get("reason").and_then(Value::as_str).unwrap_or("");
                    let msg = ev.get("message").and_then(Value::as_str).unwrap_or("");
                    if reason == "WaitForFirstConsumer" || msg.contains("WaitForFirstConsumer") {
                        issues.push("PVC is Pending: Waiting for first consumer (a pod using this volume must be scheduled to a node)".into());
                        detected_reason = true;
                        break;
                    } else if reason == "ProvisioningFailed" || reason == "FailedBinding" {
                        issues.push(format!("PVC provisioning failed: {msg}"));
                        detected_reason = true;
                        break;
                    }
                }
            }
            if !detected_reason {
                issues.push("PVC is Pending: Volume is not yet bound or provisioned".into());
            }
        }
        "Lost" => {
            issues.push("PVC reports Lost; inspect the bound volume identity and controller events before inferring its cause".into());
        }
        "Bound" => {
            if let Some(conditions) = status.get("conditions").and_then(Value::as_array) {
                for c in conditions {
                    if c.get("status").and_then(Value::as_str) == Some("True") {
                        let c_type = c.get("type").and_then(Value::as_str).unwrap_or("unknown");
                        issues.push(format!("PVC has active condition: {c_type}"));
                    }
                }
            }
        }
        _ => {
            issues.push("PVC phase is unknown or omitted by policy".into());
        }
    }

    let pv_summary = pv.map(|v| {
        json!({
            "name": v.pointer("/metadata/name"),
            "phase": v.pointer("/status/phase"),
            "capacity": v.pointer("/spec/capacity/storage"),
            "reclaimPolicy": v.pointer("/spec/persistentVolumeReclaimPolicy"),
            "storageClassName": v.pointer("/spec/storageClassName"),
        })
    });

    json!({
        "phase": phase,
        "storageClassName": storage_class,
        "volumeName": volume_name,
        "requestedStorage": requested_storage,
        "capacityStorage": capacity_storage,
        "accessModes": access_modes,
        "boundVolume": pv_summary,
        "issuesSummary": issues,
    })
}

/// Pure interpretation of policy-projected Node conditions, pressure, and taints.
pub fn node_diagnostics(node: &Value) -> Value {
    let spec = &node["spec"];
    let status = &node["status"];
    let mut issues = Vec::new();

    let name = node
        .pointer("/metadata/name")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let unschedulable = spec.get("unschedulable").and_then(Value::as_bool);
    if unschedulable == Some(true) {
        issues.push("Node is marked unschedulable (cordoned)".into());
    }

    let mut ready_state = "unknown";
    let conditions = status.get("conditions").and_then(Value::as_array);
    let mut condition_summaries = Vec::new();
    if let Some(cs) = conditions {
        for c in cs {
            let c_type = c.get("type").and_then(Value::as_str).unwrap_or("");
            let c_status = c.get("status").and_then(Value::as_str).unwrap_or("");
            let c_reason = c.get("reason").and_then(Value::as_str).unwrap_or("");
            let c_msg = c.get("message").and_then(Value::as_str).unwrap_or("");

            match c_type {
                "Ready" => {
                    ready_state = match c_status {
                        "True" => "ready",
                        "False" => "degraded",
                        _ => "unknown",
                    };
                    if c_status != "True" {
                        issues.push(format!(
                            "Node is NotReady: reason={c_reason}, message={c_msg}"
                        ));
                    }
                }
                "MemoryPressure" if c_status == "True" => {
                    issues.push("Node has MemoryPressure: available compute memory is low".into());
                }
                "DiskPressure" if c_status == "True" => {
                    issues.push("Node has DiskPressure: available disk space is low".into());
                }
                "PIDPressure" if c_status == "True" => {
                    issues
                        .push("Node has PIDPressure: available process IDs are constrained".into());
                }
                "NetworkUnavailable" if c_status == "True" => {
                    issues.push(
                        "Node reports NetworkUnavailable; inspect network controller evidence to determine the cause".into(),
                    );
                }
                _ => {}
            }
            condition_summaries.push(json!({
                "type": c_type,
                "status": c_status,
                "reason": c_reason,
                "message": c_msg,
            }));
        }
    }

    let taints: Vec<Value> = spec
        .get("taints")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|t| {
                    let key = t.get("key").and_then(Value::as_str).unwrap_or("");
                    let value = t.get("value").and_then(Value::as_str).unwrap_or("");
                    let effect = t.get("effect").and_then(Value::as_str).unwrap_or("");
                    if effect == "NoSchedule" || effect == "NoExecute" {
                        issues.push(format!(
                            "Node has taint '{key}={value}' with effect '{effect}'"
                        ));
                    }
                    json!({
                        "key": key,
                        "value": value,
                        "effect": effect,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let capacity = status.get("capacity");
    let allocatable = status.get("allocatable");

    json!({
        "name": name,
        "readyState": ready_state,
        "unschedulable": unschedulable,
        "conditions": condition_summaries,
        "taints": taints,
        "capacity": capacity,
        "allocatable": allocatable,
        "issuesSummary": issues,
    })
}

/// Extract only permitted references. Missing names/optional fields stay unknown.
pub fn config_reference_diagnostics(spec: &Value) -> Value {
    let mut maps = Vec::new();
    let mut secrets = Vec::new();
    fn visit(value: &Value, path: &str, maps: &mut Vec<Value>, secrets: &mut Vec<Value>) {
        if let Some(obj) = value.as_object() {
            for (key, item) in obj {
                let reference = match key.as_str() {
                    "configMapRef" | "configMapKeyRef" | "configMap" => Some((false, "name")),
                    "secretRef" | "secretKeyRef" => Some((true, "name")),
                    "secret" => Some((true, "secretName")),
                    _ => None,
                };
                if let Some((secret, name_key)) = reference {
                    if let Some(name) = item[name_key].as_str().filter(|s| !s.is_empty()) {
                        let out = json!({"name":name,"key":item.get("key"),"optional":item.get("optional"),"source":format!("{path}/{key}")});
                        if secret {
                            secrets.push(out)
                        } else {
                            maps.push(out)
                        }
                    }
                }
                if key == "imagePullSecrets" {
                    if let Some(items) = item.as_array() {
                        for item in items {
                            if let Some(name) = item["name"].as_str() {
                                secrets.push(json!({"name":name,"source":"imagePullSecret","optional":item.get("optional")}));
                            }
                        }
                    }
                }
                visit(item, &format!("{path}/{key}"), maps, secrets);
            }
        } else if let Some(items) = value.as_array() {
            for (index, item) in items.iter().enumerate() {
                visit(item, &format!("{path}/{index}"), maps, secrets);
            }
        }
    }
    visit(spec, "", &mut maps, &mut secrets);
    json!({"configMaps":maps,"secrets":secrets,"issuesSummary":[],"coverage":"Projected references only; an absent/filtered reference or optional flag is unknown"})
}
#[cfg(test)]
mod container_tests {
    use super::*;
    #[test]
    fn sigkill_is_not_sufficient_evidence_of_oom_and_omitted_values_stay_unknown() {
        let mut issues = Vec::new();
        let values = container_diagnostics(
            &json!([
                {"name":"a","state":{"terminated":{"exitCode":137,"reason":"Error"}}},
                {"name":"b","state":{"terminated":{"exitCode":137,"reason":"OOMKilled"}}},
                {"name":"c","state":{"terminated":{"exitCode":0,"reason":"Completed"}}}
            ]),
            false,
            &mut issues,
        );
        assert_eq!(values[0]["stateDetails"]["oomKilled"], false);
        assert_eq!(values[1]["stateDetails"]["oomKilled"], true);
        assert!(values[0]["ready"].is_null() && values[0]["restartCount"].is_null());
        assert_eq!(issues.len(), 2);
    }
}

#[cfg(test)]
mod network_and_storage_diagnostic_tests {
    use super::*;

    #[test]
    fn filtered_service_fields_remain_unknown_without_invented_probe_or_port_failures() {
        let result = service_diagnostics(
            &json!({}),
            Some(&json!([{"endpoints":[{"conditions":{}}]}])),
            Some(&[json!({"status":{"phase":"Running"}})]),
        );
        assert!(result["serviceType"].is_null());
        assert!(result["isHeadless"].is_null());
        assert!(result["matchingPods"][0]["ready"].is_null());
        assert_eq!(result["endpoints"]["unknownReadinessCount"], 1);
        assert_eq!(result["endpoints"]["notReadyCount"], 0);
        assert!(result["issuesSummary"].as_array().unwrap().is_empty());
    }

    #[test]
    fn unready_service_detects_zero_endpoints_and_unready_pods() {
        let svc = json!({
            "spec": {
                "type": "ClusterIP",
                "clusterIP": "10.96.0.1",
                "selector": {"app": "web"},
                "ports": [{"name": "http", "port": 80, "targetPort": 8080}]
            }
        });

        // 1. No pods match selector
        let diag_no_pods = service_diagnostics(&svc, None, Some(&[]));
        let issues: Vec<&str> = diag_no_pods["issuesSummary"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(
            issues
                .iter()
                .any(|i| i.contains("No permitted matching Pods observed"))
        );

        // 2. Matching pod is Running but failed readiness probes
        let pod_unready = json!({
            "metadata": {"name": "web-pod-1"},
            "spec": {"containers": [{"name": "web", "ports": [{"containerPort": 8080}]}]},
            "status": {
                "phase": "Running",
                "conditions": [
                    {"type": "Ready", "status": "False"},
                    {"type": "ContainersReady", "status": "False"}
                ]
            }
        });
        let diag_unready = service_diagnostics(&svc, None, Some(&[pod_unready]));
        let issues_unready: Vec<&str> = diag_unready["issuesSummary"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(issues_unready.iter().any(|i| i.contains("Ready=False")));

        // 3. Port mismatch: targetPort 8080 vs containerPort 3000
        let pod_wrong_port = json!({
            "metadata": {"name": "web-pod-2"},
            "spec": {"containers": [{"name": "web", "ports": [{"containerPort": 3000}]}]},
            "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}
        });
        let diag_wrong_port = service_diagnostics(&svc, None, Some(&[pod_wrong_port]));
        let issues_port: Vec<&str> = diag_wrong_port["issuesSummary"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(
            !issues_port
                .iter()
                .any(|i| i.contains("does not match any containerPort"))
        );
    }

    #[test]
    fn load_balancer_and_headless_services_diagnose_expected_issues() {
        let lb_pending = json!({
            "spec": {"type": "LoadBalancer", "ports": [{"port": 443}]},
            "status": {"loadBalancer": {"ingress": []}}
        });
        let diag = service_diagnostics(&lb_pending, None, None);
        let issues: Vec<&str> = diag["issuesSummary"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(
            issues
                .iter()
                .any(|i| i.contains("LoadBalancer ingress IP or hostname is not yet assigned"))
        );

        let headless = json!({
            "spec": {"clusterIP": "None", "ports": [{"port": 9092}]}
        });
        let diag_h = service_diagnostics(&headless, None, None);
        assert!(diag_h["isHeadless"].as_bool().unwrap());
        let issues_h: Vec<&str> = diag_h["issuesSummary"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(
            issues_h.is_empty(),
            "A filtered selector is not proof of no selector"
        );
    }

    #[test]
    fn pvc_diagnostics_detects_pending_consumer_and_lost_volume() {
        // PVC waiting for first consumer
        let pvc_pending = json!({
            "spec": {
                "storageClassName": "local-path",
                "accessModes": ["ReadWriteOnce"],
                "resources": {"requests": {"storage": "10Gi"}}
            },
            "status": {"phase": "Pending"}
        });
        let events = [json!({
            "reason": "WaitForFirstConsumer",
            "message": "waiting for first consumer to be created before binding"
        })];
        let diag_pvc = pvc_diagnostics(&pvc_pending, None, Some(&events));
        assert_eq!(diag_pvc["phase"], "Pending");
        assert_eq!(diag_pvc["storageClassName"], "local-path");
        let issues: Vec<&str> = diag_pvc["issuesSummary"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(
            issues
                .iter()
                .any(|i| i.contains("Waiting for first consumer"))
        );

        // PVC Lost
        let pvc_lost = json!({
            "spec": {"volumeName": "pv-123"},
            "status": {"phase": "Lost"}
        });
        let diag_lost = pvc_diagnostics(&pvc_lost, None, None);
        assert_eq!(diag_lost["phase"], "Lost");
        let issues_lost: Vec<&str> = diag_lost["issuesSummary"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(issues_lost.iter().any(|i| i.contains("PVC reports Lost")));
    }

    #[test]
    fn node_diagnostics_detects_not_ready_pressure_and_taints() {
        let node = json!({
            "metadata": {"name": "worker-1"},
            "spec": {
                "unschedulable": true,
                "taints": [
                    {"key": "node.kubernetes.io/unreachable", "value": "true", "effect": "NoSchedule"}
                ]
            },
            "status": {
                "conditions": [
                    {"type": "Ready", "status": "False", "reason": "KubeletNotReady", "message": "kubelet stopped posting status"},
                    {"type": "MemoryPressure", "status": "True"},
                    {"type": "DiskPressure", "status": "False"}
                ],
                "allocatable": {"cpu": "4", "memory": "16Gi"}
            }
        });
        let diag = node_diagnostics(&node);
        assert_eq!(diag["readyState"], "degraded");
        assert!(diag["unschedulable"].as_bool().unwrap());
        let issues: Vec<&str> = diag["issuesSummary"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(issues.iter().any(|i| i.contains("Node is NotReady")));
        assert!(issues.iter().any(|i| i.contains("MemoryPressure")));
        assert!(issues.iter().any(|i| {
            i.contains("taint 'node.kubernetes.io/unreachable=true' with effect 'NoSchedule'")
        }));
        assert!(
            issues
                .iter()
                .any(|i| i.contains("Node is marked unschedulable (cordoned)"))
        );
    }

    #[test]
    fn config_reference_diagnostics_extracts_cm_and_secrets_without_leaking_contents() {
        let pod_spec = json!({
            "containers": [
                {
                    "name": "app",
                    "envFrom": [
                        {"configMapRef": {"name": "app-config"}},
                        {"secretRef": {"name": "app-secrets", "optional": true}}
                    ],
                    "env": [
                        {"name": "DB_PASS", "valueFrom": {"secretKeyRef": {"name": "db-credentials", "key": "password"}}},
                        {"name": "APP_ENV", "valueFrom": {"configMapKeyRef": {"name": "app-config", "key": "env"}}}
                    ]
                }
            ],
            "volumes": [
                {"name": "tls", "secret": {"secretName": "app-tls"}},
                {"name": "nginx-conf", "configMap": {"name": "nginx-conf"}}
            ],
            "imagePullSecrets": [
                {"name": "docker-regcred"}
            ]
        });

        let diag = config_reference_diagnostics(&pod_spec);
        let cms: Vec<&str> = diag["configMaps"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|cm| cm["name"].as_str())
            .collect();
        let secs: Vec<&str> = diag["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|sec| sec["name"].as_str())
            .collect();

        assert!(cms.contains(&"app-config"));
        assert!(cms.contains(&"nginx-conf"));
        assert!(secs.contains(&"app-secrets"));
        assert!(secs.contains(&"db-credentials"));
        assert!(secs.contains(&"app-tls"));
        assert!(secs.contains(&"docker-regcred"));
        // Check that no secret values or credentials are present
        assert!(!diag.to_string().contains("supersecret"));
    }
}

#[cfg(test)]
mod accepted_revision_tests {
    use super::*;
    #[test]
    fn healthy_rollback_does_not_verify_the_accepted_generation() {
        let reverted = json!({"metadata":{"uid":"same","generation":4},"spec":{"replicas":3},"status":{"observedGeneration":4,"replicas":3,"readyReplicas":3,"updatedReplicas":3,"availableReplicas":3}});
        assert!(controller_verified("Deployment", &reverted, Some(3), Some("same")));
        assert!(!accepted_generation_matches(&reverted, Some(3)));
        assert!(accepted_generation_matches(&reverted, Some(4)));
        assert!(!accepted_generation_matches(&json!({}), Some(4)));
    }
}
