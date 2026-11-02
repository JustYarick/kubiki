//! Desktop adapter for headless tools. Kubernetes execution lives in kubiki-tools.
use async_trait::async_trait;
use kubiki_core::core::{api::ResourceRef, mutations::MutationReview};
pub use kubiki_tools::kubernetes::KubernetesTools;
use tauri::Manager;
pub struct DesktopConsent(pub tauri::WebviewWindow);
#[async_trait]
impl kubiki_tools::kubernetes::Consent for DesktopConsent {
    fn acquire(&self, resource: &ResourceRef) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        self.0
            .state::<crate::mutation_guard::MutationGuard>()
            .acquire_owned(resource)
            .map_err(|e| e.message)
    }
    async fn confirm(
        &self,
        resource: &ResourceRef,
        review: String,
        details: Option<MutationReview>,
    ) -> Result<bool, String> {
        match details {
            Some(details) => {
                crate::mutation_guard::confirm_details(
                    self.0.clone(),
                    resource,
                    review,
                    Some(details),
                )
                .await
            }
            None => {
                crate::mutation_guard::confirm_action(self.0.clone(), resource, review, "AI_TOOL")
                    .await
            }
        }
        .map_err(|e| e.message)
    }
}

pub struct IntegratedTools {
    pub conversation: kubiki_ai::ConversationState,
    pub cluster: std::sync::Arc<KubernetesTools>,
    pub mcp: kubiki_mcp::McpExecutor,
    pub environment: std::sync::Arc<kubiki_ai::environment::Environment>,
}
#[async_trait]
impl kubiki_tools::ToolExecutor for IntegratedTools {
    async fn record_execution(&self, call: kubiki_tools::ToolCall, result: serde_json::Value) {
        self.conversation.record_execution(call, result).await;
    }
    async fn additional_tools(
        &self,
        session: &kubiki_tools::Session,
    ) -> Result<Vec<kubiki_tools::ToolDefinition>, String> {
        self.environment.definitions(session.control()?.phase).await
    }
    fn accepted_uid(&self, id: &str) -> Option<String> {
        self.cluster.accepted_uid(id)
    }
    async fn verify_change(
        &self,
        session: &kubiki_tools::Session,
        call: &kubiki_tools::ToolCall,
        target: &kubiki_tools::Target,
        uid: &str,
        emit: &kubiki_tools::EventSink,
    ) -> Result<serde_json::Value, String> {
        self.mcp
            .verify_change(session, call, target, uid, emit)
            .await
    }
    async fn execute(
        &self,
        session: &kubiki_tools::Session,
        call: &kubiki_tools::ToolCall,
        emit: &kubiki_tools::EventSink,
    ) -> Result<serde_json::Value, String> {
        use kubiki_tools::*;
        if call.name != "read_skill" {
            return self.mcp.execute(session, call, emit).await;
        }
        let control = session.control()?;
        if control.invalidated || *session.cancellation().borrow() {
            return Err("Session was stopped".into());
        }
        if control
            .policy
            .requires_confirmation(control.mode, &call.name)
        {
            let resource = ResourceRef {
                query: kubiki_core::core::api::ResourceQuery {
                    context: session.scope.context.clone(),
                    group: String::new(),
                    version: "v1".into(),
                    kind: "Skill".into(),
                    namespace: None,
                },
                name: call.arguments["name"].as_str().unwrap_or("").into(),
                uid: None,
            };
            let mut cancel = session.cancellation();
            let decision = tokio::select! { biased;
                _=cancelled(&mut cancel)=>return Err("Skill read cancelled".into()),
                decision=self.cluster.consent.confirm(&resource,format!("Read installed skill {}?",resource.name),None)=>decision?,
            };
            if !decision {
                return Err("User declined skill read".into());
            }
        }
        if session.control()?.revision != control.revision {
            return Err("Permissions changed".into());
        }
        self.environment.execute(call).await
    }
}
impl IntegratedTools {
    pub async fn review_plan_call(
        &self,
        session: &kubiki_tools::Session,
        call: kubiki_tools::ToolCall,
    ) -> Result<
        (
            kubiki_tools::ToolCall,
            kubiki_tools::Target,
            kubiki_tools::WriteOperation,
        ),
        String,
    > {
        self.cluster.review_plan_call(session, call).await
    }
}

/// OpenCode owns approval while desktop updates/manual writes share the mutation gate.
pub struct DesktopHostConsent(pub tauri::WebviewWindow);
#[async_trait]
impl kubiki_tools::kubernetes::Consent for DesktopHostConsent {
    fn acquire(&self, resource: &ResourceRef) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        self.0
            .state::<crate::mutation_guard::MutationGuard>()
            .acquire_owned(resource)
            .map_err(|e| e.message)
    }
    async fn confirm(
        &self,
        _: &ResourceRef,
        _: String,
        _: Option<MutationReview>,
    ) -> Result<bool, String> {
        Err("OpenCode owns permission prompts for this connection".into())
    }
}
