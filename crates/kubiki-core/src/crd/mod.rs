//! Dynamic CRD Discovery and Inspection

pub mod discovery;
pub mod dynamic_client;

pub use discovery::{CrdDiscoveryService, CrdInfo, CrdPrinterColumn, CrdVersionInfo};
pub use dynamic_client::DynamicCrdService;
