//! The AI domain has no WebView, shell or Kubernetes credentials. All capabilities
//! enter through a host-owned ToolExecutor and backend-owned Session control.
pub mod diagnostics;
pub mod policy;
pub mod provider;
pub mod runtime;
pub mod types;

pub use policy::*;
pub use provider::ProviderClient;
pub use runtime::*;
pub use types::*;

pub use diagnostics::{
    accepted_generation_matches, config_reference_diagnostics, container_diagnostics, controller_verified,
    diagnostic_selector, node_diagnostics, pvc_diagnostics, service_diagnostics, workload_health,
};

pub mod query;
pub use query::{FieldSelection, profile_fields};

pub mod pagination;
pub use pagination::{CursorStore, QueryPage, split_page};

pub mod working_scope;
pub use working_scope::WorkingScope;

pub mod summary;
pub use summary::ResourceSummary;

pub mod memory;
pub use memory::{ConversationMemory, EvidenceStore};

pub mod plans;
pub use plans::{PlanProposal, PlanStore};

pub mod execution;
pub use execution::{PlanReview, ReviewedStep, execute_reviewed_plan, public_execution_call, contains_desired_fields};
