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

pub use diagnostics::{controller_verified, diagnostic_selector, workload_health};

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

pub use diagnostics::container_diagnostics;
