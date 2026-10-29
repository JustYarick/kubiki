use super::*;

/// One step of a batch mutation. `critical` stops the remaining steps when it fails.
pub struct BatchIntent {
    pub intent: MutationIntent,
    pub critical: bool,
}

impl BatchIntent {
    pub fn new(intent: MutationIntent) -> Self {
        Self {
            intent,
            critical: false,
        }
    }

    pub fn critical(intent: MutationIntent) -> Self {
        Self {
            intent,
            critical: true,
        }
    }
}

/// Hard cap so one confirmation cannot hide an unbounded operation.
pub const MAX_BATCH_STEPS: usize = 1000;
struct PreparedBatchStep {
    action: String,
    critical: bool,
    mutation: PreparedMutation,
}

/// A prepared multi-step operation that is confirmed once and committed sequentially.
/// The single consent covers every step; callers must not re-enter the guard per step.
pub struct PreparedBatch {
    primary: ResourceRef,
    steps: Vec<PreparedBatchStep>,
    review: String,
    preconditions: Vec<ResourcePrecondition>,
}

impl PreparedBatch {
    pub async fn prepare(
        client: Client,
        primary: ResourceRef,
        intents: Vec<BatchIntent>,
    ) -> Result<Self, ApiError> {
        if intents.is_empty() {
            return Err(error(
                &primary,
                400,
                "A batch operation needs at least one step",
            ));
        }
        if intents.len() > MAX_BATCH_STEPS {
            return Err(error(
                &primary,
                422,
                "Too many steps in one batch; split the operation",
            ));
        }
        let mut steps = Vec::with_capacity(intents.len());
        for BatchIntent { intent, critical } in intents {
            let mutation = PreparedMutation::prepare(client.clone(), intent).await?;
            let action = mutation.details.steps[0].operation.clone();
            steps.push(PreparedBatchStep {
                action,
                critical,
                mutation,
            });
        }
        let review = Self::build_review(&primary, &steps)?;
        Ok(Self {
            primary,
            steps,
            review,
            preconditions: Vec::new(),
        })
    }

    fn build_review(
        primary: &ResourceRef,
        steps: &[PreparedBatchStep],
    ) -> Result<String, ApiError> {
        Ok(format!(
            "Perform {} operations on the selected resources in cluster {:?}.",
            steps.len(),
            primary.query.context
        ))
    }

    pub fn with_preconditions(mut self, preconditions: Vec<ResourcePrecondition>) -> Self {
        self.preconditions = preconditions;
        self
    }

    pub fn details(&self) -> MutationReview {
        MutationReview {
            kind: ReviewKind::Batch,
            steps: self
                .steps
                .iter()
                .flat_map(|step| step.mutation.details.steps.clone())
                .collect(),
            warnings: self
                .steps
                .iter()
                .flat_map(|step| step.mutation.details.warnings.iter().cloned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
        }
    }

    pub fn review(&self) -> &str {
        &self.review
    }

    /// One consent for the whole batch, then each step commits without re-prompting.
    pub async fn confirm_and_commit<F, Fut>(self, confirm: F) -> Result<Value, ApiError>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<bool, ApiError>>,
    {
        if !confirm(self.review.clone()).await? {
            return Err(cancelled(
                &self.primary,
                "Batch cancelled. Nothing was changed",
            ));
        }
        for condition in &self.preconditions {
            condition.check(true).await?;
        }
        let mut results = Vec::with_capacity(self.steps.len());
        let mut succeeded: u64 = 0;
        let mut failed: u64 = 0;
        let mut stopped = false;
        for step in self.steps {
            let action = step.action;
            let critical = step.critical;
            let kind = step.mutation.resource.query.kind.clone();
            let name = step.mutation.resource.name.clone();
            let namespace = step.mutation.resource.query.namespace.clone();
            let mut source_failure = None;
            for condition in &self.preconditions {
                if let Err(error) = condition.check(false).await {
                    source_failure = Some(error);
                    break;
                }
            }
            let source_changed = source_failure.is_some();
            let outcome = match source_failure {
                Some(error) => Err(error),
                None => step.mutation.commit().await,
            };
            match outcome {
                Ok(_) => {
                    succeeded += 1;
                    results.push(json!({
                        "action": action,
                        "kind": kind,
                        "name": name,
                        "namespace": namespace,
                        "ok": true,
                    }));
                }
                Err(error) => {
                    failed += 1;
                    results.push(json!({
                        "action": action,
                        "kind": kind,
                        "name": name,
                        "namespace": namespace,
                        "ok": false,
                        "code": error.code,
                        "message": error.message,
                    }));
                    if critical || source_changed {
                        stopped = true;
                        break;
                    }
                }
            }
        }
        Ok(json!({
            "steps": results,
            "succeeded": succeeded,
            "failed": failed,
            "stopped": stopped,
        }))
    }
}
