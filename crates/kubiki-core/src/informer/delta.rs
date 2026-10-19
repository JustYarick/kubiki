use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum ResourceDelta {
    Applied {
        gvk: String,
        uid: String,
        name: String,
        namespace: Option<String>,
        data: serde_json::Value,
    },
    Deleted {
        gvk: String,
        uid: String,
        name: String,
        namespace: Option<String>,
    },
    Restarted {
        gvk: String,
        items: Vec<serde_json::Value>,
    },
}
