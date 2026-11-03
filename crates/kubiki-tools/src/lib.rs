//! Headless Kubernetes agent capabilities, policy and execution contracts.
pub mod catalog;
pub mod diagnostics;
pub mod execution;
pub mod kubernetes;
pub mod memory;
pub mod pagination;
pub mod plans;
pub mod policy;
pub mod query;
pub mod receipts;
pub mod session;
pub mod summary;
pub mod types;
pub mod working_scope;
pub use catalog::*;
pub use diagnostics::*;
pub use execution::{
    PlanReview, ReviewedStep, contains_desired_fields, execute_reviewed_plan, public_execution_call,
};
pub use memory::EvidenceStore;
pub use pagination::{CursorStore, QueryPage, split_page};
pub use plans::{PlanProposal, PlanStore};
pub use policy::*;
pub use query::{FieldSelection, profile_fields};
pub use receipts::{AcceptedOperation, AcceptedOperations};
pub use session::*;
pub use summary::ResourceSummary;
pub use types::*;
pub use working_scope::WorkingScope;

mod neighborhood;
