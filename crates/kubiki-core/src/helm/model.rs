use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: String,
    pub updated: String,
    pub status: String,
    pub chart: String,
    pub app_version: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HelmReleaseHistory {
    pub revision: i32,
    pub updated: String,
    pub status: String,
    pub chart: String,
    pub app_version: String,
    pub description: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HelmRepo {
    pub name: String,
    pub url: String,
}
