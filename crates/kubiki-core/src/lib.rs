//! Kubiki Core - Complete Headless Kubernetes Engine
//!
//! Provides a full-featured, zero-GUI Kubernetes engine:
//! - Multi-cluster Kubeconfig management & context switching
//! - Real-time Event-Driven Watch informers & in-memory normalized store
//! - Live Pod logs streaming
//! - Interactive Pod Exec WebSocket terminal
//! - TCP Port-Forwarding tunnel manager
//! - Dynamic CRD discovery & printer columns parser
//! - Helm 3 package manager integration (releases, history, rollback, repos)
//! - Node & Pod CPU/Memory metrics collector

pub mod cluster;
pub mod core;
pub mod crd;
pub mod helm;
pub mod informer;
pub mod metrics;
pub mod pod_ops;

// Re-exports
pub use cluster::client::{ClusterClientPool, ClusterVersionInfo};
pub use cluster::kubeconfig::{KubeConfigManager, KubeContextInfo};
pub use cluster::namespaces::{CanIRequest, CanIResponse, NamespaceInfo, NamespaceService};
pub use core::error::KubikiError;
pub use core::events::{EventBus, KubikiEvent};
pub use crd::discovery::{CrdDiscoveryService, CrdInfo, CrdPrinterColumn, CrdVersionInfo};
pub use crd::dynamic_client::DynamicCrdService;
pub use helm::client::HelmClient;
pub use helm::model::{HelmRelease, HelmReleaseHistory, HelmRepo};
pub use informer::delta::ResourceDelta;
pub use informer::store::ResourceStore;
pub use informer::watcher::InformerManager;
pub use metrics::client::{ContainerMetric, MetricsService, NodeMetricsInfo, PodMetricsInfo};
pub use pod_ops::exec::{PodExecOptions, PodExecService};
pub use pod_ops::logs::{PodLogOptions, PodLogService};
pub use pod_ops::port_forward::{
    ForwardStatus, ForwardTargetKind, PortForwardManager, PortForwardSession,
};
