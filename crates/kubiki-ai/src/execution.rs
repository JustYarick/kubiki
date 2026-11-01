//! Deterministic execution of a native-reviewed proposal. No model replans a write.
use crate::*;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
pub struct ReviewedStep {
    pub id: String,
    pub call: ToolCall,
    pub target: Target,
    pub operation: WriteOperation,
    pub depends_on: Vec<String>,
    pub depends_on_accepted: Vec<String>,
}
pub struct PlanReview {
    pub token: String,
    pub plan_id: String,
    pub version: u32,
    pub revision: u64,
    pub at: Instant,
    pub steps: Vec<ReviewedStep>,
}
/// Concurrency preconditions are native state, never unprojected model evidence.
pub fn public_execution_call(call: &ToolCall) -> ToolCall {
    let mut result = call.clone();
    if let Some(args) = result.arguments.as_object_mut() {
        for key in [
            "expectedUid",
            "expectedResourceVersion",
            "expectedAbsent",
            "uid",
        ] {
            args.remove(key);
        }
    }
    result
}
pub fn contains_desired_fields(desired: &Value, observed: &Value) -> bool {
    match desired {
        Value::Object(map) => observed.as_object().is_some_and(|out| {
            map.iter().all(|(k, v)| {
                out.get(k)
                    .is_some_and(|got| contains_desired_fields(v, got))
            })
        }),
        Value::Array(items) => observed.as_array().is_some_and(|got| {
            items.len() == got.len()
                && items
                    .iter()
                    .zip(got)
                    .all(|(a, b)| contains_desired_fields(a, b))
        }),
        _ => desired == observed,
    }
}
pub async fn execute_reviewed_plan(
    session: &Session,
    review: PlanReview,
    host: Arc<dyn ToolExecutor>,
    emit: EventSink,
) -> Result<Value, String> {
    if review.revision != session.control()?.revision
        || review.at.elapsed() > Duration::from_secs(300)
    {
        return Err("Plan review expired or mode/phase changed; review again".into());
    }
    let plan = session
        .plans
        .lock()
        .map_err(|_| "Plan registry unavailable")?
        .current(&review.plan_id, review.version)?;
    if plan.session_id != session.id
        || plan.policy_revision != session.control()?.policy_revision
        || plan.scope != session.scope
    {
        return Err("Plan belongs to another scope or policy revision".into());
    }
    if plan.status != PlanStatus::Ready {
        return Err("Plan is not ready for this execution".into());
    }
    let running = session
        .plans
        .lock()
        .map_err(|_| "Plan registry unavailable")?
        .set_status(&review.plan_id, review.version, PlanStatus::Running)?;
    emit(AgentEvent::PlanUpdated { plan: running });
    emit(AgentEvent::Status {
        status: "executing".into(),
    });
    let mut receipts = Vec::new();
    let mut accepted = std::collections::BTreeSet::new();
    let mut verified = std::collections::BTreeSet::new();
    for step in &review.steps {
        if step.depends_on.iter().any(|id| !verified.contains(id))
            || step
                .depends_on_accepted
                .iter()
                .any(|id| !accepted.contains(id))
        {
            receipts.push(json!({"stepId":step.id,"status":"blocked","executed":false,"reason":"A prerequisite has not been verified or accepted as explicitly required"}));
            break;
        }
        if session
            .authorize_dispatch(review.revision, &step.target, step.operation)
            .is_err()
        {
            break;
        }
        let public = public_execution_call(&step.call);
        emit(AgentEvent::ToolStarted {
            call: public.clone(),
        });
        let result = host
            .execute(session, &step.call, &emit)
            .await
            .unwrap_or_else(|e| json!({"status":"failed","error":e,"executed":false}));
        emit(AgentEvent::ToolCompleted {
            id: public.id.clone(),
            result: result.clone(),
        });
        session.record_execution(public, result.clone()).await;
        let ok = result["status"] == "accepted";
        receipts.push(json!({"stepId":step.id,"receipt":result}));
        if !ok {
            // A fresh read can assist reconciliation but never turns an uncertain
            // write into a retry or proof that this request caused the live state.
            if result["status"] == "uncertain" {
                let call = ToolCall {
                    id: format!("reconcile-{}", step.call.id),
                    name: "get_resource".into(),
                    arguments: json!({"group":step.target.group,"version":step.target.version,"kind":step.target.kind,"namespace":step.target.namespace,"name":step.target.name,"profile":"health"}),
                };
                emit(AgentEvent::ToolStarted { call: call.clone() });
                let observation = host
                    .execute(session, &call, &emit)
                    .await
                    .unwrap_or_else(|e| json!({"error":e}));
                emit(AgentEvent::ToolCompleted {
                    id: call.id.clone(),
                    result: observation.clone(),
                });
                session.record_execution(call, observation.clone()).await;
                receipts.last_mut().unwrap()["reconciliationObservation"] = observation;
            }
            break;
        }
        accepted.insert(step.id.clone());
        let uid = result["operationId"]
            .as_str()
            .and_then(|id| host.accepted_uid(id))
            .or_else(|| {
                step.call.arguments["expectedUid"]
                    .as_str()
                    .map(str::to_owned)
            });
        let call = ToolCall {
            id: format!("verify-{}", step.call.id),
            name: "get_resource".into(),
            arguments: json!({"group":step.target.group,"version":step.target.version,"kind":step.target.kind,"namespace":step.target.namespace,"name":step.target.name,"profile":"health"}),
        };
        emit(AgentEvent::ToolStarted { call: call.clone() });
        let verification = match uid {
            Some(uid) => host
                .verify_change(session, &step.call, &step.target, &uid, &emit)
                .await
                .unwrap_or_else(|e| json!({"verification":"unavailable","error":e})),
            None => {
                json!({"verification":"unavailable","reason":"The accepted resource UID is unavailable; do not verify a possible replacement"})
            }
        };
        emit(AgentEvent::ToolCompleted {
            id: call.id.clone(),
            result: verification.clone(),
        });
        session.record_execution(call, verification.clone()).await;
        if verification["verification"] == "verified" {
            verified.insert(step.id.clone());
        }
        receipts.last_mut().unwrap()["verification"] = verification;
    }
    let status = if accepted.len() == review.steps.len() && verified.len() == review.steps.len() {
        PlanStatus::Completed
    } else if !accepted.is_empty()
        || receipts
            .iter()
            .any(|r| r["receipt"]["status"] == "uncertain")
    {
        PlanStatus::Partial
    } else if *session.cancellation().borrow() {
        PlanStatus::Cancelled
    } else {
        PlanStatus::Failed
    };
    let final_plan = session
        .plans
        .lock()
        .map_err(|_| "Plan registry unavailable")?
        .finish_execution(&review.plan_id, review.version, status)?;
    emit(AgentEvent::PlanUpdated {
        plan: final_plan.clone(),
    });
    emit(AgentEvent::Status {
        status: match status {
            PlanStatus::Completed => "completed",
            PlanStatus::Partial => "partial",
            PlanStatus::Cancelled => "cancelled",
            _ => "failed",
        }
        .into(),
    });
    Ok(
        json!({"plan":final_plan,"receipts":receipts,"acceptedSteps":accepted.len(),"verifiedSteps":verified.len(),"selectedSteps":review.steps.len(),"applicationHealth":"unverified","warning":"No automatic rollback/replay. Reconcile live state and create a new plan version before another change."}),
    )
}

impl PlanReview {
    pub fn consume(slot: &mut Option<Self>, token: &str) -> Result<Self, String> {
        if slot.as_ref().is_none_or(|r| r.token != token) {
            return Err("Unknown or consumed plan review".into());
        }
        Ok(slot.take().unwrap())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;
    struct Host {
        writes: Mutex<usize>,
        uncertain: bool,
        verified: bool,
        verification_uids: Mutex<Vec<String>>,
    }
    #[async_trait]
    impl ToolExecutor for Host {
        fn accepted_uid(&self, _: &str) -> Option<String> {
            Some("actual-accepted-uid".into())
        }
        async fn verify_change(
            &self,
            _: &Session,
            _: &ToolCall,
            _: &Target,
            uid: &str,
            _: &EventSink,
        ) -> Result<Value, String> {
            self.verification_uids.lock().unwrap().push(uid.into());
            Ok(json!({"verification":if self.verified{"verified"}else{"pending"}}))
        }
        async fn execute(
            &self,
            _: &Session,
            call: &ToolCall,
            _: &EventSink,
        ) -> Result<Value, String> {
            if call.name == "get_resource" {
                return Ok(json!({"resource":{"status":"observed"}}));
            }
            *self.writes.lock().unwrap() += 1;
            Ok(json!({"status":if self.uncertain{"uncertain"}else{"accepted"},"operationId":"op"}))
        }
    }
    fn prepared(accepted_dependency: bool) -> (Session, PlanReview) {
        let session = Session::new(
            "test".into(),
            "owner".into(),
            AgentScope {
                context: "prod".into(),
                namespaces: vec!["apps".into()],
                all_namespaces: false,
            },
            AgentPolicy {
                writes: vec![WriteOperation::Scale],
                ..Default::default()
            },
            ClusterCapabilities::all(),
        );
        session.mode(AgentMode::Ask).unwrap();
        session.phase(AgentPhase::Action).unwrap();
        let revision = session.control().unwrap().revision;
        let step = |id: &str| json!({"id":id,"title":"Scale workload","action":"scale","target":{"group":"apps","version":"v1","kind":"Deployment","namespace":"apps","name":id},"replicas":2,"reason":"Restore capacity","verification":"Controller ready","risk":"Changes capacity"});
        let mut second = step("b");
        second[if accepted_dependency {
            "dependsOnAccepted"
        } else {
            "dependsOn"
        }] = json!(["a"]);
        let proposal:PlanProposal=serde_json::from_value(json!({"title":"Remediate","bodyMarkdown":"Approved shape","diagnosis":"Insufficient capacity","uncertainty":"Application health untested","steps":[step("a"),second]})).unwrap();
        let artifact = session
            .plans
            .lock()
            .unwrap()
            .propose(
                proposal,
                &session.id,
                &session.scope,
                session.control().unwrap().policy_revision,
                &mut *session.evidence.lock().unwrap(),
            )
            .unwrap();
        session
            .plans
            .lock()
            .unwrap()
            .set_status(&artifact.id, artifact.version, PlanStatus::Ready)
            .unwrap();
        let steps=artifact.steps.iter().map(|s|ReviewedStep{id:s.id.clone(),call:ToolCall{id:s.id.clone(),name:"scale_workload".into(),arguments:json!({"replicas":2,"expectedUid":"private-review-uid","expectedResourceVersion":"private-review-rv"})},target:s.target.clone().unwrap(),operation:WriteOperation::Scale,depends_on:s.depends_on.clone(),depends_on_accepted:s.depends_on_accepted.clone()}).collect();
        (
            session,
            PlanReview {
                token: "token".into(),
                plan_id: artifact.id,
                version: 1,
                revision,
                at: Instant::now(),
                steps,
            },
        )
    }
    #[tokio::test]
    async fn pending_verification_blocks_verified_dependencies_and_keeps_native_identity_out_of_history()
     {
        let (session, review) = prepared(false);
        let _running = session.begin_action(review.revision).unwrap();
        let host = Arc::new(Host {
            writes: Mutex::new(0),
            uncertain: false,
            verified: false,
            verification_uids: Mutex::new(Vec::new()),
        });
        let result = execute_reviewed_plan(&session, review, host.clone(), Arc::new(|_| {}))
            .await
            .unwrap();
        assert_eq!(*host.writes.lock().unwrap(), 1);
        assert_eq!(result["plan"]["status"], "partial");
        assert_eq!(result["receipts"][1]["status"], "blocked");
        assert_eq!(
            &*host.verification_uids.lock().unwrap(),
            &["actual-accepted-uid"]
        );
        let history = format!("{:?}", session.inspect_history().await);
        assert!(!history.contains("private-review-uid") && !history.contains("private-review-rv"));
    }
    #[tokio::test]
    async fn explicit_acceptance_dependencies_do_not_claim_readiness() {
        let (session, review) = prepared(true);
        let _running = session.begin_action(review.revision).unwrap();
        let host = Arc::new(Host {
            writes: Mutex::new(0),
            uncertain: false,
            verified: false,
            verification_uids: Mutex::new(Vec::new()),
        });
        let result = execute_reviewed_plan(&session, review, host.clone(), Arc::new(|_| {}))
            .await
            .unwrap();
        assert_eq!(*host.writes.lock().unwrap(), 2);
        assert_eq!(result["plan"]["status"], "partial");
        assert_eq!(result["verifiedSteps"], 0);
    }
    #[tokio::test]
    async fn uncertain_write_is_observed_but_never_replayed_or_followed_by_another_write() {
        let (session, review) = prepared(false);
        let _running = session.begin_action(review.revision).unwrap();
        let host = Arc::new(Host {
            writes: Mutex::new(0),
            uncertain: true,
            verified: true,
            verification_uids: Mutex::new(Vec::new()),
        });
        let result = execute_reviewed_plan(&session, review, host.clone(), Arc::new(|_| {}))
            .await
            .unwrap();
        assert_eq!(*host.writes.lock().unwrap(), 1);
        assert!(
            result["receipts"][0]
                .get("reconciliationObservation")
                .is_some()
        );
        assert_eq!(result["receipts"][0]["receipt"]["status"], "uncertain");
    }
    #[test]
    fn review_tokens_are_single_use_and_readonly_cannot_begin_execution() {
        let (session, review) = prepared(false);
        let mut slot = Some(review);
        assert!(PlanReview::consume(&mut slot, "bad").is_err());
        assert!(PlanReview::consume(&mut slot, "token").is_ok());
        assert!(PlanReview::consume(&mut slot, "token").is_err());
        session.mode(AgentMode::ReadOnly).unwrap();
        assert!(
            session
                .begin_action(session.control().unwrap().revision)
                .is_err()
        );
    }
    #[test]
    fn filtered_fields_cannot_satisfy_configuration_verification() {
        assert!(!contains_desired_fields(
            &json!({"data":{"key":"wanted"}}),
            &json!({})
        ));
        assert!(contains_desired_fields(
            &json!({"spec":{"ports":[{"port":80}]}}),
            &json!({"spec":{"ports":[{"port":80,"protocol":"TCP"}],"clusterIP":"x"}})
        ));
    }
}
