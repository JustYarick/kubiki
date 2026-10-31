use crate::{AgentMode, AgentScope, Target};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum DataAccess {
    None,
    #[default]
    Metadata,
    Content,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WriteOperation {
    Create,
    Update,
    Delete,
    Scale,
    Restart,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRule {
    pub group: String,
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub read: DataAccess,
    pub writes: Vec<WriteOperation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPolicy {
    pub resources: bool,
    pub events: bool,
    pub logs: bool,
    pub metrics: bool,
    pub cluster_resources: bool,
    pub secrets: DataAccess,
    pub config_maps: DataAccess,
    pub workload_configuration: bool,
    pub annotations: bool,
    pub custom_resources: DataAccess,
    pub helm: bool,
    pub argocd: bool,
    pub flux: bool,
    pub contexts: Vec<String>,
    pub namespaces: Vec<String>,
    pub writes: Vec<WriteOperation>,
    pub max_replicas: u32,
    /// First matching rule overrides data access/write defaults, never scope.
    pub rules: Vec<ResourceRule>,
    /// JSON pointer prefixes to omit, including inside nested objects.
    pub denied_paths: Vec<String>,
}
impl Default for AgentPolicy {
    fn default() -> Self {
        Self {
            resources: true,
            events: true,
            logs: false,
            metrics: true,
            cluster_resources: false,
            secrets: DataAccess::None,
            config_maps: DataAccess::Metadata,
            workload_configuration: false,
            annotations: false,
            custom_resources: DataAccess::Metadata,
            helm: true,
            argocd: true,
            flux: true,
            contexts: vec!["*".into()],
            namespaces: vec!["*".into()],
            writes: vec![],
            max_replicas: 10,
            rules: vec![],
            denied_paths: vec![],
        }
    }
}

/// A small wildcard language: only '*' is special; no regex execution.
pub fn matches(pattern: &str, value: &str) -> bool {
    let (p, v) = (pattern.as_bytes(), value.as_bytes());
    let (mut i, mut j, mut star, mut checkpoint) = (0, 0, None, 0);
    while j < v.len() {
        if i < p.len() && p[i] == v[j] {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            i += 1;
            checkpoint = j;
        } else if let Some(s) = star {
            checkpoint += 1;
            j = checkpoint;
            i = s + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == b'*' {
        i += 1;
    }
    i == p.len()
}

impl AgentPolicy {
    pub fn validate(&self) -> Result<(), String> {
        if self.contexts.len() > 100
            || self.namespaces.len() > 100
            || self.rules.len() > 100
            || self.denied_paths.len() > 100
            || self.max_replicas > 10000
            || self
                .contexts
                .iter()
                .chain(&self.namespaces)
                .any(|s| s.len() > 253)
            || self.rules.iter().any(|r| {
                [&r.group, &r.kind, &r.namespace, &r.name]
                    .iter()
                    .any(|s| s.len() > 253)
            })
            || self
                .denied_paths
                .iter()
                .any(|p| !p.starts_with('/') || p.len() > 512)
        {
            return Err("Invalid or oversized AI access policy".into());
        }
        Ok(())
    }

    pub fn check_scope(&self, scope: &AgentScope, target: &Target) -> Result<(), String> {
        if scope.context.is_empty() || !self.contexts.iter().any(|p| matches(p, &scope.context)) {
            return Err("This conversation has no permitted Kubernetes context".into());
        }
        match &target.namespace {
            Some(ns)
                if (scope.all_namespaces || scope.namespaces.contains(ns))
                    && self.namespaces.iter().any(|p| matches(p, ns)) =>
            {
                Ok(())
            }
            None if self.cluster_resources => Ok(()),
            _ => Err("Resource is outside this conversation's namespace/cluster scope".into()),
        }
    }

    fn rule(&self, target: &Target) -> Option<&ResourceRule> {
        self.rules.iter().find(|r| {
            matches(&r.group, &target.group)
                && matches(&r.kind, &target.kind)
                && matches(&r.namespace, target.namespace.as_deref().unwrap_or(""))
                && matches(&r.name, &target.name)
        })
    }

    pub fn access(&self, target: &Target, builtin: bool) -> DataAccess {
        if let Some(rule) = self.rule(target) {
            return rule.read;
        }
        match target.kind.as_str() {
            "Secret" if target.group.is_empty() => self.secrets,
            "ConfigMap" if target.group.is_empty() => self.config_maps,
            _ if !builtin || !native_api_group(&target.group) => self.custom_resources,
            _ => DataAccess::Content,
        }
    }

    pub fn check_write(
        &self,
        mode: AgentMode,
        scope: &AgentScope,
        target: &Target,
        op: WriteOperation,
    ) -> Result<(), String> {
        self.check_scope(scope, target)?;
        if mode == AgentMode::ReadOnly {
            return Err("Read only mode forbids changes".into());
        }
        let allowed = self.rule(target).map(|r| &r.writes).unwrap_or(&self.writes);
        if !allowed.contains(&op) {
            return Err("This operation is disabled by the AI access policy".into());
        }
        // These capabilities require an explicit future design, even with generic create/update.
        if ![
            "Deployment",
            "StatefulSet",
            "DaemonSet",
            "ReplicaSet",
            "Service",
            "ConfigMap",
            "PersistentVolumeClaim",
            "Ingress",
            "HorizontalPodAutoscaler",
            "PodDisruptionBudget",
        ]
        .contains(&target.kind.as_str())
            || !["", "apps", "networking.k8s.io", "autoscaling", "policy"]
                .contains(&target.group.as_str())
        {
            return Err("AI writes support workload, service, configuration and storage resources only; RBAC, Secrets, Pods and cluster resources are excluded".into());
        }
        Ok(())
    }

    pub fn project(&self, target: &Target, source: &Value, builtin: bool) -> Result<Value, String> {
        let access = self.access(target, builtin);
        if access == DataAccess::None {
            return Err("Reading this resource is disabled by the AI access policy".into());
        }
        let metadata = &source["metadata"];
        let mut result = json!({"apiVersion": source["apiVersion"], "kind": source["kind"], "metadata": {
            "name": metadata["name"], "namespace": metadata["namespace"], "uid": metadata["uid"],
            "resourceVersion": metadata["resourceVersion"], "creationTimestamp": metadata["creationTimestamp"],
            "ownerReferences": metadata["ownerReferences"], "labels": metadata["labels"]
        }});
        if access == DataAccess::Content {
            if let Some(obj) = source.as_object() {
                for (key, value) in obj {
                    if !["metadata", "apiVersion", "kind"].contains(&key.as_str()) {
                        result[key] = value.clone();
                    }
                }
            }
        }
        if self.annotations {
            result["metadata"]["annotations"] = metadata["annotations"].clone();
        }
        scrub(
            &mut result,
            self,
            "",
            target.kind == "Secret" && access == DataAccess::Content,
            0,
        );
        Ok(result)
    }
}

fn native_api_group(group: &str) -> bool {
    matches!(
        group,
        "" | "apps"
            | "batch"
            | "autoscaling"
            | "policy"
            | "networking.k8s.io"
            | "rbac.authorization.k8s.io"
            | "storage.k8s.io"
            | "scheduling.k8s.io"
            | "node.k8s.io"
            | "coordination.k8s.io"
            | "apiextensions.k8s.io"
            | "admissionregistration.k8s.io"
            | "apiregistration.k8s.io"
            | "certificates.k8s.io"
            | "discovery.k8s.io"
            | "events.k8s.io"
            | "flowcontrol.apiserver.k8s.io"
            | "resource.k8s.io"
    )
}

fn scrub(value: &mut Value, policy: &AgentPolicy, path: &str, secret_content: bool, depth: usize) {
    if depth > 24 {
        *value = json!("[depth limit]");
        return;
    }
    match value {
        Value::Object(map) => {
            let env = path.ends_with("/env") || path.contains("/env/");
            map.retain(|key, _| {
                let next = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
                !policy
                    .denied_paths
                    .iter()
                    .any(|p| next == *p || next.starts_with(&format!("{p}/")))
                    && (secret_content
                        || ![
                            "token",
                            "password",
                            "clientKeyData",
                            "clientCertificateData",
                            "authorization",
                        ]
                        .iter()
                        .any(|s| key.eq_ignore_ascii_case(s)))
                    && (policy.workload_configuration
                        || !["command", "args"].contains(&key.as_str()) && !(env && key == "value"))
                    && (policy.annotations || key != "annotations")
                    && key != "managedFields"
                    && key != "last-applied-configuration"
            });
            for (key, entry) in map {
                scrub(
                    entry,
                    policy,
                    &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")),
                    secret_content,
                    depth + 1,
                );
            }
        }
        Value::Array(items) => {
            items.truncate(100);
            for (i, entry) in items.iter_mut().enumerate() {
                scrub(
                    entry,
                    policy,
                    &format!("{path}/{i}"),
                    secret_content,
                    depth + 1,
                );
            }
        }
        Value::String(text) if text.chars().count() > 8000 => {
            *text = text.chars().take(8000).collect::<String>() + " [truncated]";
        }
        _ => {}
    }
}
