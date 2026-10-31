//! Query defaults for an investigation; never an authorization grant.
use crate::{AgentPolicy, AgentScope, Target};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkingScope {
    pub namespace: Option<String>,
    pub label_selector: Option<String>,
    pub selector_kind: Option<String>,
    pub root_uid: Option<String>,
    pub root: Option<Target>,
    pub reason: String,
    #[serde(default)]
    pub revision: u64,
}
impl WorkingScope {
    pub fn initial(scope: &AgentScope) -> Self {
        Self {
            namespace: if !scope.all_namespaces && scope.namespaces.len() == 1 {
                scope.namespaces.first().cloned()
            } else {
                None
            },
            ..Self::default()
        }
    }
    pub fn inherited_selector(&self, namespace: &Option<String>, kind: &str) -> Option<String> {
        if namespace.is_some()
            && namespace == &self.namespace
            && kind == self.selector_kind.as_deref().unwrap_or("Pod")
        {
            self.label_selector.clone()
        } else {
            None
        }
    }
    pub fn update(
        &mut self,
        allowed: &AgentScope,
        policy: &AgentPolicy,
        mut next: Self,
    ) -> Result<(), String> {
        if next.reason.trim().is_empty()
            || next.reason.len() > 500
            || next.label_selector.as_ref().is_some_and(|s| s.len() > 2048)
        {
            return Err(
                "Working scope requires a short investigation reason and bounded selector".into(),
            );
        }
        if next.selector_kind.as_ref().is_some_and(|kind| {
            kind.is_empty()
                || kind.len() > 253
                || !kind
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
        }) || next.root_uid.as_ref().is_some_and(|uid| {
            uid.is_empty() || uid.len() > 253 || uid.chars().any(char::is_control)
        }) {
            return Err("Invalid selector kind or root UID".into());
        }
        if let Some(namespace) = &next.namespace {
            let target = Target {
                group: "".into(),
                version: "v1".into(),
                kind: "Pod".into(),
                namespace: Some(namespace.clone()),
                name: "".into(),
            };
            policy.check_scope(allowed, &target)?;
        } else if next.label_selector.is_some() {
            return Err("A working selector requires one namespace".into());
        }
        if let Some(root) = &next.root {
            policy.check_scope(allowed, root)?;
            if root.namespace != next.namespace {
                return Err("Root identity must belong to working namespace".into());
            }
        }
        next.revision = self.revision + 1;
        *self = next;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn working_scope_defaults_and_changes_cannot_extend_allowed_scope() {
        let allowed = AgentScope {
            context: "prod".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        };
        let mut working = WorkingScope::initial(&allowed);
        assert_eq!(working.namespace.as_deref(), Some("apps"));
        let mut next = WorkingScope {
            namespace: Some("other".into()),
            reason: "Investigate dependency".into(),
            ..Default::default()
        };
        assert!(
            working
                .update(&allowed, &AgentPolicy::default(), next.clone())
                .is_err()
        );
        assert_eq!(working.revision, 0);
        next.namespace = Some("apps".into());
        next.label_selector = Some("app=web".into());
        working
            .update(&allowed, &AgentPolicy::default(), next)
            .unwrap();
        assert_eq!(working.revision, 1);
        assert_eq!(
            working
                .inherited_selector(&Some("apps".into()), "Pod")
                .as_deref(),
            Some("app=web")
        );
        assert!(
            working
                .inherited_selector(&Some("apps".into()), "Service")
                .is_none()
        );
        assert!(
            working
                .inherited_selector(&Some("other".into()), "Pod")
                .is_none()
        );
    }
}
