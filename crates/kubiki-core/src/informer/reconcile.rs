use crate::core::api::{ApiError, ApiErrorCode, ResourceQuery, resource_type};
use crate::informer::delta::ResourceDelta;
use kube::runtime::watcher::Event;
use serde_json::Value;
use std::collections::HashMap;

/// Buffers Init/InitApply until InitDone. Failed/cancelled lists never leak partial data.
pub struct Reconciler {
    query: ResourceQuery,
    pending: Option<HashMap<String, Value>>,
    initialized: bool,
}

impl Reconciler {
    pub fn new(query: ResourceQuery) -> Self {
        Self {
            query,
            pending: None,
            initialized: false,
        }
    }
    pub fn discard_pending(&mut self) {
        self.pending = None;
    }

    fn invalid(&self, message: &str) -> ApiError {
        ApiError::new(
            ApiErrorCode::Internal,
            message,
            "watch",
            Some(&self.query.context),
            None,
        )
        .with_resource(&self.query)
    }

    fn validate(&self, mut value: Value) -> Result<Value, ApiError> {
        for field in ["uid", "name"] {
            if !value["metadata"][field]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            {
                return Err(self.invalid("Watch object is missing its name or UID"));
            }
        }
        let namespaced = resource_type(&self.query.kind).is_some_and(|r| r.namespaced);
        let namespace = value["metadata"]["namespace"].as_str();
        if namespaced && namespace.is_none_or(str::is_empty)
            || self
                .query
                .namespace
                .as_deref()
                .is_some_and(|ns| namespace != Some(ns))
            || !namespaced && namespace.is_some_and(|ns| !ns.is_empty())
        {
            return Err(self.invalid("Watch object belongs to a different namespace scope"));
        }
        let api_version = if self.query.group.is_empty() {
            self.query.version.clone()
        } else {
            format!("{}/{}", self.query.group, self.query.version)
        };
        if value.get("kind").is_some_and(|v| v != &self.query.kind)
            || value.get("apiVersion").is_some_and(|v| v != &api_version)
        {
            return Err(self.invalid("Watch object belongs to a different group/version/kind"));
        }
        value["kind"] = self.query.kind.clone().into();
        value["apiVersion"] = api_version.into();
        if let Some(metadata) = value.get_mut("metadata").and_then(Value::as_object_mut) {
            metadata.remove("managedFields");
        }
        Ok(value)
    }

    pub fn consume(&mut self, event: Event<Value>) -> Result<Option<ResourceDelta>, ApiError> {
        let result = self.consume_inner(event);
        if result.is_err() {
            self.discard_pending();
        }
        result
    }

    fn consume_inner(&mut self, event: Event<Value>) -> Result<Option<ResourceDelta>, ApiError> {
        match event {
            Event::Init => {
                self.pending = Some(HashMap::new());
                Ok(None)
            }
            Event::InitApply(value) => {
                let value = self.validate(value)?;
                let uid = value["metadata"]["uid"].as_str().unwrap().to_owned();
                let Some(pending) = &mut self.pending else {
                    return Err(self.invalid("InitApply received without Init"));
                };
                pending.insert(uid, value);
                Ok(None)
            }
            Event::InitDone => {
                let Some(pending) = self.pending.take() else {
                    return Err(self.invalid("InitDone received without a complete initial list"));
                };
                self.initialized = true;
                Ok(Some(ResourceDelta::Restarted {
                    items: pending.into_values().collect(),
                }))
            }
            Event::Apply(value) => {
                let value = self.validate(value)?;
                if let Some(pending) = &mut self.pending {
                    pending.insert(value["metadata"]["uid"].as_str().unwrap().into(), value);
                    Ok(None)
                } else if self.initialized {
                    Ok(Some(ResourceDelta::Applied { data: value }))
                } else {
                    Err(self.invalid("Apply received before first sync"))
                }
            }
            Event::Delete(value) => {
                let value = self.validate(value)?;
                let uid = value["metadata"]["uid"].as_str().unwrap().to_owned();
                if let Some(pending) = &mut self.pending {
                    pending.remove(&uid);
                    Ok(None)
                } else if self.initialized {
                    Ok(Some(ResourceDelta::Deleted { uid }))
                } else {
                    Err(self.invalid("Delete received before first sync"))
                }
            }
        }
    }
}
