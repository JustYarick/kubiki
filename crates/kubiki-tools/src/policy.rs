use crate::{AgentMode, AgentPhase, AgentScope, Target};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptionalToolMode {
    Auto,
    Enabled,
    Disabled,
}

impl Default for OptionalToolMode {
    fn default() -> Self {
        Self::Auto
    }
}

impl Serialize for OptionalToolMode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Auto => serializer.serialize_str("auto"),
            Self::Enabled => serializer.serialize_str("enabled"),
            Self::Disabled => serializer.serialize_str("disabled"),
        }
    }
}

impl<'de> Deserialize<'de> for OptionalToolMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Helper {
            Str(String),
            Bool(bool),
        }

        match Helper::deserialize(deserializer)? {
            Helper::Str(s) => match s.to_ascii_lowercase().as_str() {
                "auto" => Ok(OptionalToolMode::Auto),
                "enabled" | "enable" | "on" | "true" => Ok(OptionalToolMode::Enabled),
                "disabled" | "disable" | "off" | "false" => Ok(OptionalToolMode::Disabled),
                _ => Err(serde::de::Error::custom(format!(
                    "Invalid tool mode: {}",
                    s
                ))),
            },
            Helper::Bool(b) => Ok(if b {
                OptionalToolMode::Enabled
            } else {
                OptionalToolMode::Disabled
            }),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClusterCapabilities {
    pub helm: bool,
    pub argocd: bool,
    pub flux: bool,
}

impl ClusterCapabilities {
    pub fn all() -> Self {
        Self {
            helm: true,
            argocd: true,
            flux: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRule {
    pub group: String,
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub read: DataAccess,
    pub writes: Vec<WriteOperation>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyExplanation {
    pub allowed: bool,
    pub scope_allowed: bool,
    pub scope_reason: String,
    pub matched_rule_index: Option<usize>,
    pub matched_rule: Option<ResourceRule>,
    pub data_access: DataAccess,
    pub write_allowed: bool,
    pub denied_paths_matched: Vec<String>,
    pub explanation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuleValidationIssue {
    pub rule_index: usize,
    pub kind: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleResolution {
    #[default]
    FirstMatch,
    DenyOverrides,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPolicy {
    /// Tools that require consent even in Auto accept.
    pub always_ask: Vec<String>,
    pub confirm_reads: bool,
    pub read_only: bool,
    pub disabled_tools: Vec<String>,
    #[serde(default)]
    pub plan_disabled_tools: Vec<String>,
    #[serde(default)]
    pub action_disabled_tools: Vec<String>,
    pub schema_version: u32,
    pub rule_resolution: RuleResolution,
    pub allowed_fields: Vec<String>,
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
    pub helm: OptionalToolMode,
    pub argocd: OptionalToolMode,
    pub flux: OptionalToolMode,
    pub contexts: Vec<String>,
    pub namespaces: Vec<String>,
    pub writes: Vec<WriteOperation>,
    pub max_replicas: u32,
    /// First matching rule overrides data access/write defaults, never scope.
    pub rules: Vec<ResourceRule>,
    /// JSON pointer prefixes to omit, including inside nested objects.
    pub denied_paths: Vec<String>,
}

impl AgentPolicy {
    pub fn requires_confirmation(&self, mode: AgentMode, tool: &str) -> bool {
        (mode == AgentMode::Ask
            && (self.confirm_reads
                || matches!(
                    tool,
                    "apply_manifest" | "scale_workload" | "restart_workload" | "delete_resource"
                )))
            || self.always_ask.iter().any(|name| name == tool)
    }

    pub fn is_helm_active(&self, capabilities: &ClusterCapabilities) -> bool {
        match self.helm {
            OptionalToolMode::Auto => capabilities.helm,
            OptionalToolMode::Enabled => true,
            OptionalToolMode::Disabled => false,
        }
    }

    pub fn is_argocd_active(&self, capabilities: &ClusterCapabilities) -> bool {
        match self.argocd {
            OptionalToolMode::Auto => capabilities.argocd,
            OptionalToolMode::Enabled => true,
            OptionalToolMode::Disabled => false,
        }
    }

    pub fn is_flux_active(&self, capabilities: &ClusterCapabilities) -> bool {
        match self.flux {
            OptionalToolMode::Auto => capabilities.flux,
            OptionalToolMode::Enabled => true,
            OptionalToolMode::Disabled => false,
        }
    }
}

impl Default for AgentPolicy {
    fn default() -> Self {
        Self {
            always_ask: vec![],
            confirm_reads: true,
            read_only: false,
            disabled_tools: vec![],
            plan_disabled_tools: vec![],
            action_disabled_tools: vec![],
            schema_version: 1,
            rule_resolution: RuleResolution::FirstMatch,
            allowed_fields: vec![],
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
            helm: OptionalToolMode::Auto,
            argocd: OptionalToolMode::Auto,
            flux: OptionalToolMode::Auto,
            contexts: vec!["*".into()],
            namespaces: vec!["*".into()],
            writes: vec![],
            max_replicas: 10,
            rules: vec![],
            denied_paths: vec![],
        }
    }
}

impl AgentPolicy {
    pub fn default_mcp() -> Self {
        Self {
            confirm_reads: false,
            logs: true,
            cluster_resources: true,
            writes: vec![
                WriteOperation::Create,
                WriteOperation::Update,
                WriteOperation::Delete,
                WriteOperation::Scale,
                WriteOperation::Restart,
            ],
            ..Self::default()
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
    /// The model needs capabilities and limits, not the full authorization database.
    pub fn prompt_summary(&self) -> Value {
        json!({"resources":self.resources,"events":self.events,"logs":self.logs,"metrics":self.metrics,"clusterResources":self.cluster_resources,"secrets":self.secrets,"configMaps":self.config_maps,"customResources":self.custom_resources,"workloadConfiguration":self.workload_configuration,"annotations":self.annotations,"writes":self.writes,"maxReplicas":self.max_replicas,"resourceRuleCount":self.rules.len(),"excludedPathCount":self.denied_paths.len(),"note":"Exact rules and field exclusions are enforced by the backend. Defaults are not grants for every object; omitted fields remain unknown."})
    }

    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.schema_version, 1 | 2)
            || (self.schema_version == 1 && self.rule_resolution != RuleResolution::FirstMatch)
        {
            return Err(
                "Explicitly select policy schema v2 before changing rule resolution".into(),
            );
        }
        if !self.allowed_fields.is_empty() {
            crate::FieldSelection::new(&self.allowed_fields)?;
        }

        if self.always_ask.len() > 64
            || self.always_ask.iter().any(|name| {
                name.is_empty()
                    || name.len() > 64
                    || !name.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
            })
            || self.disabled_tools.len() > 64
            || self.disabled_tools.iter().any(|name| {
                name.is_empty()
                    || name.len() > 64
                    || !name.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
            })
            || self.plan_disabled_tools.len() > 64
            || self.plan_disabled_tools.iter().any(|name| {
                name.is_empty()
                    || name.len() > 64
                    || !name.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
            })
            || self.action_disabled_tools.len() > 64
            || self.action_disabled_tools.iter().any(|name| {
                name.is_empty()
                    || name.len() > 64
                    || !name.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
            })
            || self.contexts.len() > 100
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
        let applies = |r: &&ResourceRule| {
            matches(&r.group, &target.group)
                && matches(&r.kind, &target.kind)
                && matches(&r.namespace, target.namespace.as_deref().unwrap_or(""))
                && matches(&r.name, &target.name)
        };
        if self.rule_resolution == RuleResolution::DenyOverrides {
            if let Some(deny) = self
                .rules
                .iter()
                .filter(applies)
                .find(|r| r.read == DataAccess::None && r.writes.is_empty())
            {
                return Some(deny);
            }
        }
        self.rules.iter().find(applies)
    }
    pub fn access(&self, target: &Target, builtin: bool) -> DataAccess {
        let access =
            self.rule(target)
                .map(|r| r.read)
                .unwrap_or_else(|| match target.kind.as_str() {
                    "Secret" if target.group.is_empty() => self.secrets,
                    "ConfigMap" if target.group.is_empty() => self.config_maps,
                    _ if !builtin || !native_api_group(&target.group) => self.custom_resources,
                    _ => DataAccess::Content,
                });
        if access == DataAccess::Content
            && !self.allowed_fields.is_empty()
            && crate::FieldSelection::new(&self.allowed_fields).is_ok_and(|f| f.metadata_only())
        {
            DataAccess::Metadata
        } else {
            access
        }
    }
    pub fn filter_field_allowed(&self, key: &str) -> bool {
        self.allowed_fields.is_empty()
            || ["metadata.name", "metadata.namespace"].contains(&key)
            || self.allowed_fields.iter().any(|field| {
                let field = if field.starts_with('/') {
                    field[1..].replace('/', ".")
                } else {
                    field.clone()
                };
                key == field || key.starts_with(&format!("{field}."))
            })
    }

    /// Conservative proof that content access is uniform across this collection.
    /// Any potentially applicable resource rule forces per-identity authorization.
    pub fn collection_content_allowed(&self, target: &Target, builtin: bool) -> bool {
        self.access(target, builtin) == DataAccess::Content
            && !self.rules.iter().any(|r| {
                matches(&r.group, &target.group)
                    && matches(&r.kind, &target.kind)
                    && matches(&r.namespace, target.namespace.as_deref().unwrap_or(""))
            })
    }

    pub fn check_write(
        &self,
        mode: AgentMode,
        scope: &AgentScope,
        target: &Target,
        op: WriteOperation,
    ) -> Result<(), String> {
        self.check_scope(scope, target)?;
        if mode == AgentMode::ReadOnly || self.read_only {
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

    pub fn explain_access(
        &self,
        mode: AgentMode,
        phase: AgentPhase,
        scope: &AgentScope,
        target: &Target,
        builtin: bool,
        write_op: Option<WriteOperation>,
    ) -> PolicyExplanation {
        let scope_check = self.check_scope(scope, target);
        let scope_allowed = scope_check.is_ok();
        let scope_reason = scope_check
            .err()
            .unwrap_or_else(|| "Within allowed scope".into());

        let matched = self.rule(target).and_then(|rule| {
            self.rules
                .iter()
                .enumerate()
                .find(|(_, r)| std::ptr::eq(*r, rule))
        });

        let matched_rule_index = matched.map(|(idx, _)| idx);
        let matched_rule = matched.map(|(_, r)| r.clone());
        let data_access = self.access(target, builtin);

        let (write_allowed, write_reason) = if let Some(op) = write_op {
            match if phase == AgentPhase::Plan {
                Err("Plan phase forbids writes".into())
            } else {
                self.check_write(mode, scope, target, op)
            } {
                Ok(()) => (true, "Write permitted by policy and mode".to_owned()),
                Err(err) => (false, err),
            }
        } else {
            (false, "No write operation requested".to_owned())
        };

        let denied_paths_matched: Vec<String> = self
            .denied_paths
            .iter()
            .filter(|p| !p.is_empty())
            .cloned()
            .collect();

        let allowed = if write_op.is_some() {
            scope_allowed && write_allowed
        } else {
            scope_allowed && self.resources && data_access != DataAccess::None
        };

        let mut explanation_parts = Vec::new();
        if !scope_allowed {
            explanation_parts.push(format!("Scope denied: {scope_reason}"));
        } else {
            explanation_parts.push("Scope: permitted".into());
        }

        if let Some(idx) = matched_rule_index {
            explanation_parts.push(format!(
                "Matched rule #{idx} (read: {:?}, writes: {:?})",
                data_access,
                matched_rule.as_ref().map(|r| &r.writes)
            ));
        } else {
            explanation_parts.push(format!(
                "Using default policy (read: {:?}, writes: {:?})",
                data_access, self.writes
            ));
        }

        if write_op.is_some() {
            explanation_parts.push(format!("Write check: {write_reason}"));
        }

        if !denied_paths_matched.is_empty() {
            explanation_parts.push(format!(
                "Excluded subtrees applied: {} path(s)",
                denied_paths_matched.len()
            ));
        }

        PolicyExplanation {
            allowed,
            scope_allowed,
            scope_reason,
            matched_rule_index,
            matched_rule,
            data_access,
            write_allowed,
            denied_paths_matched,
            explanation: explanation_parts.join("; "),
        }
    }

    pub fn validate_rules(&self) -> Vec<RuleValidationIssue> {
        let mut issues = Vec::new();
        for (i, rule) in self.rules.iter().enumerate() {
            if rule.group == "*" && rule.kind == "*" && rule.namespace == "*" && rule.name == "*" {
                if rule.read == DataAccess::Content {
                    issues.push(RuleValidationIssue {
                        rule_index: i,
                        kind: "broad_permission".into(),
                        message: "Rule matches all resources across all namespaces with Content read access".into(),
                    });
                }
            }

            for (j, earlier) in self.rules[..i].iter().enumerate() {
                let shadows_group = earlier.group == "*" || earlier.group == rule.group;
                let shadows_kind = earlier.kind == "*" || earlier.kind == rule.kind;
                let shadows_ns = earlier.namespace == "*" || earlier.namespace == rule.namespace;
                let shadows_name = earlier.name == "*" || earlier.name == rule.name;

                if self.rule_resolution == RuleResolution::FirstMatch
                    && shadows_group
                    && shadows_kind
                    && shadows_ns
                    && shadows_name
                {
                    issues.push(RuleValidationIssue {
                        rule_index: i,
                        kind: "shadowed".into(),
                        message: format!("Rule #{i} is completely shadowed by earlier Rule #{j} and will never be evaluated"),
                    });
                    break;
                }
            }
        }
        issues
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
            "generation": metadata["generation"],
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
        if !self.allowed_fields.is_empty() {
            result = crate::FieldSelection::new(&self.allowed_fields)?.apply(&result);
        }
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
                    && key != "deletionGracePeriodSeconds"
                    && key != "terminationMessagePath"
                    && key != "terminationMessagePolicy"
            });
            if let Some(Value::Object(annotations)) = map.get_mut("annotations") {
                annotations.retain(|k, _| {
                    !k.starts_with("kubectl.kubernetes.io/")
                        && !k.starts_with("control-plane.alpha.kubernetes.io/")
                });
            }
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
