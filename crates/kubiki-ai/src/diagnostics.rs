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
