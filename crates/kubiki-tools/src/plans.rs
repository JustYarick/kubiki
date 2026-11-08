//! Bounded, session-owned proposal versions. Plans do not grant execution rights.
use crate::{AgentScope, EvidenceStore, PlanAction, PlanArtifact, PlanKind, PlanStatus, PlanStep};
use serde::Deserialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(1);
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanProposal {
    #[serde(default)]
    pub kind: PlanKind,
    pub diagnosis: String,
    pub uncertainty: String,
    pub steps: Vec<PlanStep>,
    pub plan_id: Option<String>,
    pub title: String,
    pub body_markdown: String,
    pub target_scope: Option<String>,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    #[serde(default)]
    pub proposed_actions: Vec<String>,
}
#[derive(Default)]
pub struct PlanStore {
    versions: VecDeque<PlanArtifact>,
}
impl PlanStore {
    pub fn propose(
        &mut self,
        input: PlanProposal,
        session_id: &str,
        scope: &AgentScope,
        revision: u64,
        evidence: &mut EvidenceStore,
    ) -> Result<PlanArtifact, String> {
        if input.title.trim().is_empty()
            || input.title.len() > 200
            || input.body_markdown.trim().is_empty()
            || input.body_markdown.len() > 24000
            || input.target_scope.as_ref().is_some_and(|s| s.len() > 256)
            || input.evidence_ids.len() > 16
            || input.proposed_actions.len() > 16
            || input.evidence_ids.iter().any(|s| s.len() > 64)
            || input.proposed_actions.iter().any(|s| s.len() > 500)
        {
            return Err("Invalid or oversized plan proposal".into());
        }
        if input.diagnosis.trim().is_empty()
            || input.diagnosis.len() > 4000
            || input.uncertainty.len() > 2000
            || input.steps.is_empty()
            || input.steps.len() > 16
        {
            return Err(
                "Plan needs a diagnosis, uncertainty and 1–16 remediation/verification steps"
                    .into(),
            );
        }
        let mut ids = std::collections::BTreeSet::new();
        for step in &input.steps {
            if step.id.is_empty()
                || step.id.len() > 64
                || !ids.insert(step.id.clone())
                || step.title.trim().is_empty()
                || step.title.len() > 200
                || step.reason.trim().is_empty()
                || step.reason.len() > 1000
                || step.verification.trim().is_empty()
                || step.verification.len() > 1000
                || step.risk.trim().is_empty()
                || step.risk.len() > 1000
                || step.depends_on.len() > 16
                || step.depends_on_accepted.len() > 16
                || step
                    .depends_on
                    .iter()
                    .chain(&step.depends_on_accepted)
                    .any(|id| id == &step.id || !ids.contains(id))
                || step.yaml.as_ref().is_some_and(|s| s.len() > 24000)
                || step
                    .expected_uid
                    .as_ref()
                    .is_some_and(|s| s.is_empty() || s.len() > 253)
                || (matches!(
                    step.action,
                    PlanAction::Scale | PlanAction::Restart | PlanAction::Delete
                ) && step.target.is_none())
                || (step.action == PlanAction::Scale && step.replicas.is_none())
                || (step.action == PlanAction::Apply
                    && step.yaml.as_ref().is_none_or(|s| s.trim().is_empty()))
            {
                return Err("Invalid plan step, payload, verification or dependency order".into());
            }
        }
        for id in &input.evidence_ids {
            evidence.get(id)?;
        }
        // An unknown planId (hallucinated, or evicted from this session) never revises
        // another session's plan; it starts a fresh plan instead of losing the proposal.
        let previous = input
            .plan_id
            .as_ref()
            .and_then(|id| self.versions.iter().rev().find(|p| &p.id == id));
        let (id, version) = match previous {
            Some(previous) => (previous.id.clone(), previous.version + 1),
            None => (format!("plan-{}", NEXT.fetch_add(1, Ordering::Relaxed)), 1),
        };
        // Actual scope comes from the backend; targetScope is only a proposal label.
        let artifact = PlanArtifact {
            schema_version: 1,
            session_id: session_id.to_owned(),
            kind: input.kind,
            diagnosis: input.diagnosis,
            uncertainty: input.uncertainty,
            steps: input.steps,
            id,
            version,
            title: input.title,
            body_markdown: input.body_markdown,
            target_scope: input.target_scope,
            scope: scope.clone(),
            evidence_ids: input.evidence_ids,
            proposed_actions: input.proposed_actions,
            status: PlanStatus::Draft,
            policy_revision: revision,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                .to_string(),
        };
        if serde_json::to_vec(&artifact)
            .map_err(|_| "Cannot encode plan")?
            .len()
            > 60_000
        {
            return Err("Plan exceeds 60 KB; split the proposal into smaller versions".into());
        }
        self.versions.push_back(artifact.clone());
        while self.versions.len() > 16
            || self
                .versions
                .iter()
                .map(|p| serde_json::to_vec(p).map(|v| v.len()).unwrap_or(usize::MAX))
                .sum::<usize>()
                > 256 * 1024
        {
            self.versions.pop_front();
        }
        Ok(artifact)
    }
    pub fn current(&self, id: &str, version: u32) -> Result<PlanArtifact, String> {
        let plan = self
            .versions
            .iter()
            .rev()
            .find(|p| p.id == id)
            .ok_or("Plan unavailable or evicted")?;
        if plan.version != version || plan.status == PlanStatus::Stale {
            return Err("Plan version is stale; review the current proposal".into());
        }
        Ok(plan.clone())
    }
    pub fn set_status(
        &mut self,
        id: &str,
        version: u32,
        status: PlanStatus,
    ) -> Result<PlanArtifact, String> {
        self.current(id, version)?;
        let plan = self
            .versions
            .iter_mut()
            .rev()
            .find(|p| p.id == id && p.version == version)
            .unwrap();
        plan.status = status;
        Ok(plan.clone())
    }
    pub fn finish_execution(
        &mut self,
        id: &str,
        version: u32,
        status: PlanStatus,
    ) -> Result<PlanArtifact, String> {
        let plan = self
            .versions
            .iter_mut()
            .rev()
            .find(|p| p.id == id && p.version == version)
            .ok_or("Execution plan unavailable")?;
        if plan.status != PlanStatus::Stale {
            plan.status = status;
        }
        Ok(plan.clone())
    }
    pub fn stale(&mut self) {
        for p in &mut self.versions {
            p.status = PlanStatus::Stale;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn proposal() -> PlanProposal {
        serde_json::from_value(
            serde_json::json!({"title":"Remediate","bodyMarkdown":"Check evidence","diagnosis":"Insufficient evidence","uncertainty":"Cause unknown","steps":[{"id":"s1","title":"Collect missing evidence","action":"inspect","reason":"Establish cause before writes","verification":"Read conditions","risk":"Read only","dependsOn":[]}]}),
        )
        .unwrap()
    }
    #[test]
    fn versions_scope_revision_and_evidence_are_owned_by_session() {
        let mut store = PlanStore::default();
        let mut evidence = EvidenceStore::default();
        let scope = AgentScope {
            context: "prod".into(),
            ..Default::default()
        };
        let p = store
            .propose(proposal(), "owner", &scope, 42, &mut evidence)
            .unwrap();
        assert_eq!(p.policy_revision, 42);
        assert_eq!(p.scope.context, "prod");
        let mut next = proposal();
        next.plan_id = Some(p.id.clone());
        assert_eq!(
            store
                .propose(next, "owner", &scope, 43, &mut evidence)
                .unwrap()
                .version,
            2
        );
        let mut invalid = proposal();
        invalid.evidence_ids = vec!["made-up".into()];
        assert!(
            store
                .propose(invalid, "owner", &scope, 43, &mut evidence)
                .is_err()
        );
        let mut foreign = proposal();
        foreign.plan_id = Some("another-session-plan".into());
        let fresh = store
            .propose(foreign, "owner", &scope, 43, &mut evidence)
            .unwrap();
        assert_ne!(fresh.id, "another-session-plan");
        assert_ne!(fresh.id, p.id);
        assert_eq!(fresh.version, 1);
        store.stale();
        assert!(store.versions.iter().all(|p| p.status == PlanStatus::Stale));
    }
}
