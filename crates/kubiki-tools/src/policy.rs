use crate::{AgentMode, AgentPhase, AgentScope, Target};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum DataAccess {
    None,
    #[default]
    Metadata,
    /// Selected diagnostic fields for recognized CRDs; other resources remain metadata-only.
    Diagnostic,
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
    /// Explicitly allow reading Helm release values and revision history from Helm storage Secrets.
    pub helm_values: bool,
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
            custom_resources: DataAccess::Diagnostic,
            helm: OptionalToolMode::Auto,
            helm_values: false,
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
        Self::default()
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
        json!({"resources":self.resources,"events":self.events,"logs":self.logs,"metrics":self.metrics,"clusterResources":self.cluster_resources,"secrets":self.secrets,"configMaps":self.config_maps,"customResources":self.custom_resources,"helmValues":self.helm_values,"workloadConfiguration":self.workload_configuration,"annotations":self.annotations,"writes":self.writes,"maxReplicas":self.max_replicas,"resourceRuleCount":self.rules.len(),"excludedPathCount":self.denied_paths.len(),"note":"Exact rules and field exclusions are enforced by the backend. Defaults are not grants for every object; omitted fields remain unknown."})
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
        if !self.data_category_enabled(target) {
            return Err("Event, Metrics or Secret data access is disabled by policy".into());
        }
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

    fn rule_applies(r: &ResourceRule, target: &Target) -> bool {
        matches(&r.group, &target.group)
            && matches(&r.kind, &target.kind)
            && matches(&r.namespace, target.namespace.as_deref().unwrap_or(""))
            && matches(&r.name, &target.name)
    }

    fn rule(&self, target: &Target) -> Option<&ResourceRule> {
        if self.rule_resolution == RuleResolution::DenyOverrides {
            return self
                .rules
                .iter()
                .filter(|r| Self::rule_applies(r, target))
                .min_by_key(|r| (r.read, r.writes.len()));
        }
        self.rules.iter().find(|r| Self::rule_applies(r, target))
    }

    fn write_permitted_by_rules(&self, target: &Target, op: WriteOperation) -> bool {
        if self.rule_resolution == RuleResolution::DenyOverrides {
            let mut matched = self
                .rules
                .iter()
                .filter(|r| Self::rule_applies(r, target))
                .peekable();
            if matched.peek().is_none() {
                return self.writes.contains(&op);
            }
            return matched.all(|r| r.writes.contains(&op));
        }
        self.rule(target)
            .map(|r| r.writes.contains(&op))
            .unwrap_or_else(|| self.writes.contains(&op))
    }

    pub fn data_category_enabled(&self, target: &Target) -> bool {
        !(!self.events
            && ["", "events.k8s.io"].contains(&target.group.as_str())
            && target.kind == "Event")
            && (self.metrics || target.group != "metrics.k8s.io")
            && !(self.secrets == DataAccess::None
                && target.group.is_empty()
                && target.kind == "Secret")
    }

    fn configured_access(&self, target: &Target, builtin: bool) -> DataAccess {
        if !self.data_category_enabled(target) {
            return DataAccess::None;
        }
        let rule_read = if self.rule_resolution == RuleResolution::DenyOverrides {
            self.rules
                .iter()
                .filter(|r| Self::rule_applies(r, target))
                .map(|r| r.read)
                .min()
        } else {
            self.rules
                .iter()
                .find(|r| Self::rule_applies(r, target))
                .map(|r| r.read)
        };
        rule_read.unwrap_or_else(|| match target.kind.as_str() {
            "Secret" if target.group.is_empty() => self.secrets,
            "ConfigMap" if target.group.is_empty() => self.config_maps,
            "Release" if target.group == "helm.sh" => {
                if self.helm_values {
                    DataAccess::Content
                } else {
                    DataAccess::Metadata
                }
            }
            _ if !builtin || !native_api_group(&target.group) => self.custom_resources,
            _ => DataAccess::Content,
        })
    }

    pub fn access(&self, target: &Target, builtin: bool) -> DataAccess {
        let access = match self.configured_access(target, builtin) {
            DataAccess::Diagnostic if diagnostic_fields(target).is_some() => DataAccess::Content,
            DataAccess::Diagnostic => DataAccess::Metadata,
            access => access,
        };
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

    /// High-confidence denials, independent of whether the live field exists.
    pub fn denied_fields(&self, target: &Target, builtin: bool, fields: &[String]) -> Vec<String> {
        fields.iter().filter(|field| {
            let Ok(selection) = crate::FieldSelection::new(&[(*field).clone()]) else { return false; };
            let access = self.access(target, builtin);
            if access == DataAccess::None || (access == DataAccess::Metadata && !selection.metadata_only()) { return true; }
            if !self.annotations && selection.has_key("annotations") { return true; }
            if !self.workload_configuration && selection.has_workload_configuration() { return true; }
            if self.denied_paths.iter().any(|path| crate::FieldSelection::new(&[path.clone()]).is_ok_and(|deny| deny.covers(&selection))) { return true; }
            if !self.allowed_fields.is_empty() && crate::FieldSelection::new(&self.allowed_fields).is_ok_and(|allow| !allow.intersects(&selection)) { return true; }
            if self.configured_access(target, builtin) == DataAccess::Diagnostic {
                if let Some(allowed) = diagnostic_fields(target) {
                    return crate::FieldSelection::new(&allowed.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).is_ok_and(|allow| !allow.intersects(&selection));
                }
            }
            false
        }).cloned().collect()
    }

    /// Actionable UI settings hints explaining why requested fields are blocked so the AI can
    /// tell the user which Kubiki toggle controls access and where to enable it.
    pub fn denial_hints(&self, target: &Target, builtin: bool, fields: &[String]) -> Vec<Value> {
        let mut hints: Vec<Value> = Vec::new();
        let mut seen = std::collections::HashSet::<&'static str>::new();
        let mut push = |key: &'static str, setting: &str, location: &str, action: &str| {
            if seen.insert(key) {
                hints.push(json!({
                    "setting": setting,
                    "location": location,
                    "recommendedAction": action,
                }));
            }
        };
        let access = self.access(target, builtin);
        let configured = self.configured_access(target, builtin);
        let is_crd = !builtin || !native_api_group(&target.group);
        for field in fields {
            let Ok(selection) = crate::FieldSelection::new(&[field.clone()]) else {
                continue;
            };
            if !self.annotations && selection.has_key("annotations") {
                push(
                    "annotations",
                    "Annotations",
                    "Settings → AI / MCP Access → Data & Categories → Annotations (or TitleBar MCP popover → MCP Access settings)",
                    "Enable 'Annotations' in the active profile to allow reading Kubernetes object annotations.",
                );
            }
            if !self.workload_configuration && selection.has_workload_configuration() {
                push(
                    "workload_configuration",
                    "Workload configuration",
                    "Settings → AI / MCP Access → Data & Categories → Workload configuration",
                    "Enable 'Workload configuration' to read inline env values, commands, args, or probe HTTP headers.",
                );
            }
            if access == DataAccess::None || (access == DataAccess::Metadata && !selection.metadata_only()) {
                if target.kind == "Secret" && target.group.is_empty() {
                    push(
                        "secrets",
                        "Secrets",
                        "Settings → AI / MCP Access → Data & Categories → Secrets",
                        "Change 'Secrets' from 'No access' to 'Metadata only' (or 'Full contents' / add an exact resource rule).",
                    );
                } else if target.kind == "ConfigMap" && target.group.is_empty() {
                    push(
                        "config_maps",
                        "ConfigMaps",
                        "Settings → AI / MCP Access → Data & Categories → ConfigMaps",
                        "Change 'ConfigMaps' to 'Full contents' (or add an exact resource rule).",
                    );
                } else if is_crd {
                    let rec = if diagnostic_fields(target).is_some() {
                        "Change 'Custom resources' to 'Diagnostic fields' (exposes Flux/Argo CD/cert-manager/Gateway/KEDA status without values) or 'Full contents'."
                    } else {
                        "Change 'Custom resources' to 'Full contents' (or add a resource rule for this CRD)."
                    };
                    push(
                        "custom_resources",
                        "Custom resources",
                        "Settings → AI / MCP Access → Data & Categories → Custom resources",
                        rec,
                    );
                } else {
                    push(
                        "rules",
                        "Resource rules",
                        "Settings → AI / MCP Access → Scope & rules → Resource rules",
                        "Adjust the matching resource rule to allow reading this resource's contents.",
                    );
                }
            } else if configured == DataAccess::Diagnostic {
                if let Some(allowed) = diagnostic_fields(target) {
                    if crate::FieldSelection::new(
                        &allowed.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>(),
                    )
                    .is_ok_and(|allow| !allow.intersects(&selection))
                    {
                        push(
                            "custom_resources_full",
                            "Custom resources",
                            "Settings → AI / MCP Access → Data & Categories → Custom resources",
                            "Field is outside the 'Diagnostic fields' projection. Change 'Custom resources' to 'Full contents' (or add an exact resource rule) to read it.",
                        );
                    }
                }
            }
            if self.denied_paths.iter().any(|path| {
                crate::FieldSelection::new(&[path.clone()]).is_ok_and(|deny| deny.covers(&selection))
            }) {
                push(
                    "denied_paths",
                    "Excluded JSON pointer paths",
                    "Settings → AI / MCP Access → Scope & rules → Excluded paths",
                    "Remove the matching JSON pointer from Excluded paths to allow reading this field.",
                );
            }
            if !self.allowed_fields.is_empty()
                && crate::FieldSelection::new(&self.allowed_fields)
                    .is_ok_and(|allow| !allow.intersects(&selection))
            {
                push(
                    "allowed_fields",
                    "Included fields",
                    "Settings → AI / MCP Access → Scope & rules → Included fields",
                    "Add the requested field to Included fields or leave Included fields empty.",
                );
            }
        }
        hints
    }

    /// Human- and AI-actionable error message when a resource/collection read is blocked by policy.
    pub fn resource_denial_message(&self, target: &Target, builtin: bool) -> String {
        let hint = if target.kind == "Secret" && target.group.is_empty() && self.secrets == DataAccess::None {
            "Tell the user Secrets access is blocked by Kubiki's active AI/MCP policy ('Secrets: No access'). To enable it, open Settings → AI / MCP Access → Data & Categories → Secrets."
        } else if target.kind == "Event" && matches!(target.group.as_str(), "" | "events.k8s.io") && !self.events {
            "Tell the user Events access is disabled by Kubiki's active AI/MCP policy. Enable it in Settings → AI / MCP Access → Data & Categories → Events."
        } else if target.group == "metrics.k8s.io" && !self.metrics {
            "Tell the user Metrics access is disabled by Kubiki's active AI/MCP policy. Enable it in Settings → AI / MCP Access → Data & Categories → Metrics."
        } else if target.kind == "ConfigMap" && target.group.is_empty() && self.config_maps == DataAccess::None {
            "Tell the user ConfigMaps access is disabled by Kubiki's active AI/MCP policy. Enable it in Settings → AI / MCP Access → Data & Categories → ConfigMaps."
        } else if (!builtin || !native_api_group(&target.group)) && self.custom_resources == DataAccess::None {
            "Tell the user Custom resources access is disabled by Kubiki's active AI/MCP policy. Set Custom resources to 'Diagnostic fields' or 'Full contents' in Settings → AI / MCP Access → Data & Categories → Custom resources."
        } else if target.namespace.is_none() && !self.cluster_resources {
            "Tell the user Cluster-scoped resources are disabled by Kubiki's active AI/MCP policy. Enable it in Settings → AI / MCP Access → Data & Categories → Cluster resources."
        } else {
            "Tell the user this resource is blocked by Kubiki's active AI/MCP access policy (check Settings → AI / MCP Access → Scope & rules or Data & Categories)."
        };
        format!("Reading this resource is disabled by the AI access policy. {hint}")
    }

    /// Conservative proof that no object in this collection can be read at all.
    /// Prevents listing denied categories (such as Secrets when secrets=none) or exposing
    /// omittedByPolicy membership oracles.
    pub fn collection_completely_denied(&self, target: &Target, builtin: bool) -> bool {
        if !self.data_category_enabled(target) {
            return true;
        }
        let default_denied = match target.kind.as_str() {
            "Secret" if target.group.is_empty() => self.secrets == DataAccess::None,
            "ConfigMap" if target.group.is_empty() => self.config_maps == DataAccess::None,
            "Release" if target.group == "helm.sh" => false,
            _ if !builtin || !native_api_group(&target.group) => {
                self.custom_resources == DataAccess::None
            }
            _ => false,
        };
        let all_ns = target.namespace.as_deref() == Some("*");
        let matching_collection_rules = |r: &&ResourceRule| {
            matches(&r.group, &target.group)
                && matches(&r.kind, &target.kind)
                && if all_ns {
                    true
                } else {
                    matches(&r.namespace, target.namespace.as_deref().unwrap_or(""))
                }
        };
        if default_denied {
            !self
                .rules
                .iter()
                .filter(matching_collection_rules)
                .any(|r| r.read != DataAccess::None)
        } else {
            self.rules.iter().filter(matching_collection_rules).any(|r| {
                r.name == "*"
                    && (!all_ns || r.namespace == "*")
                    && r.read == DataAccess::None
                    && (self.rule_resolution == RuleResolution::DenyOverrides
                        || self
                            .rules
                            .iter()
                            .filter(matching_collection_rules)
                            .next()
                            .is_some_and(|first| std::ptr::eq(first, r)))
            })
        }
    }

    /// Conservative proof that content access is uniform across this collection.
    /// Any potentially applicable resource rule forces per-identity authorization.
    pub fn collection_content_allowed(&self, target: &Target, builtin: bool) -> bool {
        let all_ns = target.namespace.as_deref() == Some("*");
        self.access(target, builtin) == DataAccess::Content
            && !self.rules.iter().any(|r| {
                matches(&r.group, &target.group)
                    && matches(&r.kind, &target.kind)
                    && (all_ns || matches(&r.namespace, target.namespace.as_deref().unwrap_or("")))
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
        if !self.write_permitted_by_rules(target, op) {
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
        let effective_access = self.access(target, builtin);
        let data_access = if effective_access == DataAccess::Content && self.configured_access(target, builtin) == DataAccess::Diagnostic { DataAccess::Diagnostic } else { effective_access };

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
            return Err(self.resource_denial_message(target, builtin));
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
        if self.configured_access(target, builtin) == DataAccess::Diagnostic {
            if let Some(fields) = diagnostic_fields(target) {
                result = crate::FieldSelection::new(&fields.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>())?.apply(&result);
            }
        }
        if self.annotations {
            result["metadata"]["annotations"] = metadata["annotations"].clone();
        }
        let mut path = Vec::new();
        scrub(
            &mut result,
            self,
            &mut path,
            target.kind == "Secret" && access == DataAccess::Content,
            0,
        );
        if !self.allowed_fields.is_empty() {
            result = crate::FieldSelection::new(&self.allowed_fields)?.apply(&result);
        }
        Ok(result)
    }
}

fn diagnostic_fields(target: &Target) -> Option<&'static [&'static str]> {
    match (target.group.as_str(), target.kind.as_str()) {
        ("kustomize.toolkit.fluxcd.io", "Kustomization")
        | ("helm.toolkit.fluxcd.io", "HelmRelease")
        | ("source.toolkit.fluxcd.io", "GitRepository" | "OCIRepository" | "HelmRepository" | "HelmChart" | "Bucket") => Some(&[
            "metadata", "spec.type", "spec.suspend", "spec.dependsOn", "spec.path", "spec.sourceRef", "spec.chartRef",
            "spec.releaseName", "spec.targetNamespace", "spec.storageNamespace", "spec.interval",
            "status.conditions", "status.observedGeneration", "status.lastAppliedRevision", "status.lastAttemptedRevision",
            "status.artifact", "status.inventory", "status.failures", "status.installFailures", "status.upgradeFailures",
            "status.storageNamespace", "status.lastHandledReconcileAt", "status.lastHandledResetAt",
        ]),
        ("argoproj.io", "Application" | "ApplicationSet") => Some(&[
            "metadata",
            "spec.project",
            "spec.destination",
            "spec.source.repoURL",
            "spec.source.path",
            "spec.source.chart",
            "spec.source.targetRevision",
            "spec.sources[*].repoURL",
            "spec.sources[*].path",
            "spec.sources[*].chart",
            "spec.sources[*].targetRevision",
            "spec.syncPolicy.automated",
            "status.health",
            "status.sync",
            "status.conditions",
            "status.operationState.phase",
            "status.operationState.message",
            "status.operationState.finishedAt",
            "status.resources",
            "status.summary",
        ]),
        ("argoproj.io", "Rollout") => Some(&[
            "metadata",
            "spec.replicas",
            "spec.strategy",
            "status.phase",
            "status.message",
            "status.replicas",
            "status.readyReplicas",
            "status.updatedReplicas",
            "status.availableReplicas",
            "status.conditions",
            "status.observedGeneration",
            "status.stableRS",
            "status.currentPodHash",
        ]),
        ("external-secrets.io", "ExternalSecret" | "SecretStore" | "ClusterSecretStore") => Some(&[
            "metadata", "status.conditions", "status.refreshTime", "status.syncedResourceVersion",
        ]),
        ("cert-manager.io", "Certificate" | "CertificateRequest" | "Issuer" | "ClusterIssuer" | "Order" | "Challenge") => Some(&[
            "metadata",
            "spec.dnsNames",
            "spec.issuerRef",
            "spec.secretName",
            "status.conditions",
            "status.notBefore",
            "status.notAfter",
            "status.renewalTime",
            "status.revision",
            "status.state",
            "status.reason",
        ]),
        ("gateway.networking.k8s.io", "Gateway" | "HTTPRoute" | "GRPCRoute" | "GatewayClass") => Some(&[
            "metadata",
            "spec.gatewayClassName",
            "spec.listeners",
            "spec.parentRefs",
            "spec.hostnames",
            "spec.rules",
            "status.addresses",
            "status.listeners",
            "status.parents",
            "status.conditions",
        ]),
        ("keda.sh", "ScaledObject" | "ScaledJob") => Some(&[
            "metadata",
            "spec.scaleTargetRef",
            "spec.minReplicaCount",
            "spec.maxReplicaCount",
            "status.conditions",
            "status.externalMetricNames",
            "status.health",
            "status.paused",
        ]),
        _ => None,
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

fn decode_pointer_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    let mut chars = segment.chars();
    while let Some(c) = chars.next() {
        if c == '~' {
            match chars.next() {
                Some('0') => out.push('~'),
                Some('1') => out.push('/'),
                Some(other) => {
                    out.push('~');
                    out.push(other);
                }
                None => out.push('~'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Segment-aware JSON pointer prefix matcher supporting `*` wildcards (matching array indices or keys).
fn denied_path_matches(actual: &[String], denied_pattern: &str) -> bool {
    let Some(rest) = denied_pattern.strip_prefix('/') else {
        return false;
    };
    if rest.is_empty() {
        return true;
    }
    let pattern_segments: Vec<String> = rest.split('/').map(decode_pointer_segment).collect();
    if pattern_segments.len() > actual.len() {
        return false;
    }
    pattern_segments
        .iter()
        .zip(actual.iter())
        .all(|(pat, seg)| pat == "*" || pat == seg)
}

pub fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "token"
            | "password"
            | "passwd"
            | "pass"
            | "secret"
            | "authorization"
            | "cookie"
            | "set-cookie"
            | "credentials"
            | "credential"
            | "dsn"
            | "apikey"
            | "api_key"
            | "api-key"
            | "privatekey"
            | "private_key"
            | "private-key"
            | "clientkeydata"
            | "clientcertificatedata"
            | "accesskey"
            | "access_key"
            | "access-key"
            | "secretkey"
            | "secret_key"
            | "secret-key"
            | "bearertoken"
            | "bearer_token"
            | "bearer-token"
            | "connectionstring"
            | "connection_string"
            | "connection-string"
            | "signingkey"
            | "signing_key"
            | "encryptionkey"
            | "encryption_key"
            | "tls.key"
            | "ca.key"
            | "webhookurl"
            | "webhook_url"
            | "jwtsecret"
            | "jwt_secret"
            | "sshkey"
            | "ssh_key"
            | "htpasswd"
            | "auth"
    ) {
        return true;
    }
    // Compound suffixes that never collide with standard Kubernetes reference schema fields
    // (such as secretName, secretRef, secretKeyRef, imagePullSecrets, automountServiceAccountToken).
    [
        "password",
        "passwd",
        "secretkey",
        "secret_key",
        "secret-key",
        "apikey",
        "api_key",
        "api-key",
        "privatekey",
        "private_key",
        "private-key",
        "accesskey",
        "access_key",
        "access-key",
        "bearertoken",
        "bearer_token",
        "bearer-token",
        "connectionstring",
        "connection_string",
        "connection-string",
        "_secret",
        "-secret",
        "_token",
        "-token",
        "_key",
        "-key",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
}

fn scrub(
    value: &mut Value,
    policy: &AgentPolicy,
    path: &mut Vec<String>,
    secret_content: bool,
    depth: usize,
) {
    if depth > 24 {
        *value = json!("[depth limit]");
        return;
    }
    match value {
        Value::Object(map) => {
            let in_env = path.iter().any(|segment| segment == "env");
            let in_http_headers = path.iter().any(|segment| segment == "httpHeaders");
            let in_volume_ref = path
                .iter()
                .any(|segment| matches!(segment.as_str(), "volumes" | "sources"));
            map.retain(|key, val| {
                path.push(key.clone());
                let denied = policy
                    .denied_paths
                    .iter()
                    .any(|p| denied_path_matches(path, p));
                path.pop();
                let is_volume_secret_schema =
                    in_volume_ref && key == "secret" && val.is_object();
                !denied
                    && (secret_content || is_volume_secret_schema || !is_sensitive_key(key))
                    && (policy.workload_configuration
                        || !["command", "args"].contains(&key.as_str())
                            && !((in_env || in_http_headers) && key == "value"))
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
                path.push(key.clone());
                scrub(entry, policy, path, secret_content, depth + 1);
                path.pop();
            }
        }
        Value::Array(items) => {
            items.truncate(100);
            for (i, entry) in items.iter_mut().enumerate() {
                path.push(i.to_string());
                scrub(entry, policy, path, secret_content, depth + 1);
                path.pop();
            }
        }
        Value::String(text) if text.chars().count() > 8000 => {
            *text = text.chars().take(8000).collect::<String>() + " [truncated]";
        }
        _ => {}
    }
}
