//! Agent tools compose existing core operations. No shell, arbitrary HTTP or
//! renderer-supplied authorization enters this boundary.
use crate::*;
use async_trait::async_trait;
use kube::{
    Client,
    api::{DynamicObject, ListParams},
};

use kubiki_core::core::{
    api::{ResourceQuery, ResourceRef, resource_types},
    mutations::{ManifestTarget, MutationIntent, PreparedMutation, ResourceAction},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Human approval belongs to the embedded client; external hosts use their own permissions.
#[async_trait]
pub trait Consent: Send + Sync {
    fn acquire(&self, resource: &ResourceRef) -> Result<tokio::sync::OwnedMutexGuard<()>, String>;
    async fn confirm(
        &self,
        resource: &ResourceRef,
        review: String,
        details: Option<kubiki_core::core::mutations::MutationReview>,
    ) -> Result<bool, String>;
}
/// OpenCode authorizes tool calls before dispatch. This adapter only serializes writes.
#[derive(Default)]
pub struct HostConsent(pub std::sync::Arc<tokio::sync::Mutex<()>>);
#[async_trait]
impl Consent for HostConsent {
    fn acquire(&self, _: &ResourceRef) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        self.0
            .clone()
            .try_lock_owned()
            .map_err(|_| "Another cluster change is running".into())
    }
    async fn confirm(
        &self,
        _: &ResourceRef,
        _: String,
        _: Option<kubiki_core::core::mutations::MutationReview>,
    ) -> Result<bool, String> {
        Err("Host-owned permissions must not request Kubiki confirmation".into())
    }
}

pub struct KubernetesTools {
    pub consent: std::sync::Arc<dyn Consent>,
    pub pool: kubiki_core::cluster::client::ClusterClientPool,
    pub client: Option<Client>,
    pub connection_generation: Option<u64>,
    pub write_rejected: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub budget: std::sync::Arc<kubiki_core::core::read_budget::ReadBudget>,
    pub journal: PathBuf,
    pub read_permits: std::sync::Arc<tokio::sync::Semaphore>,
    pub accepted_operations: std::sync::Arc<std::sync::Mutex<AcceptedOperations>>,
}

fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
fn error_message(error: kubiki_core::core::api::ApiError) -> String {
    if error.code == kubiki_core::core::api::ApiErrorCode::Cancelled {
        return "Change cancelled before a Kubernetes write was dispatched".into();
    }
    // Kubernetes/admission error bodies may contain object values. Keep the code.
    format!(
        "Kubernetes operation failed ({:?}, HTTP {}). Inspect the resource and cluster permissions in Kubiki",
        error.code,
        error.status.unwrap_or(0)
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceArgs {
    #[serde(default)]
    group: String,
    version: String,
    kind: String,
    namespace: Option<String>,
    #[serde(default)]
    name: String,
    replicas: Option<u32>,
    #[serde(rename = "expectedUid")]
    _expected_uid: Option<String>,
    #[serde(rename = "expectedResourceVersion")]
    _expected_resource_version: Option<String>,
    #[serde(rename = "expectedAbsent")]
    _expected_absent: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadResourceArgs {
    #[serde(default)]
    group: String,
    version: String,
    kind: String,
    namespace: Option<String>,
    #[serde(default)]
    name: String,
    fields: Option<Vec<String>>,
    profile: Option<String>,
    label_selector: Option<String>,
    field_selector: Option<String>,
    page_size: Option<u32>,
    cursor: Option<String>,
}

fn normalize_core_group(group: &str, version: &str) -> String {
    if version == "v1" && matches!(group, "v1" | "core") {
        String::new()
    } else {
        group.to_owned()
    }
}

impl ResourceArgs {
    fn target(&self) -> Target {
        Target {
            group: normalize_core_group(&self.group, &self.version),
            version: self.version.clone(),
            kind: self.kind.clone(),
            namespace: self.namespace.clone(),
            name: self.name.clone(),
        }
    }
}

fn validate_target(target: &Target, named: bool) -> Result<(), String> {
    fn segment(s: &str, empty: bool) -> bool {
        (empty || !s.is_empty())
            && s.len() <= 253
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
    }
    if !segment(&target.group, true)
        || !segment(&target.version, false)
        || !segment(&target.kind, false)
        || (!target.name.is_empty()
            && (target.name.len() > 253
                || matches!(target.name.as_str(), "." | "..")
                || !target
                    .name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-.:_".contains(&c))))
        || (named && target.name.is_empty())
        || target
            .namespace
            .as_ref()
            .is_some_and(|s| !segment(s, false))
    {
        return Err("Invalid resource identity".into());
    }
    Ok(())
}

async fn resource_access(
    client: Client,
    target: &Target,
) -> Result<kubiki_core::core::access::ResourceAccess, String> {
    validate_target(target, false)?;
    let query = ResourceQuery {
        context: String::new(),
        group: target.group.clone(),
        version: target.version.clone(),
        kind: target.kind.clone(),
        namespace: target.namespace.clone(),
    };
    kubiki_core::core::access::ResourceAccess::new(client, &query, false).await
}

#[async_trait]
impl ToolExecutor for KubernetesTools {
    fn accepted_uid(&self, id: &str) -> Option<String> {
        self.accepted_operations
            .lock()
            .ok()?
            .get(id)
            .map(|identity| identity.uid.clone())
    }
    async fn verify_change(
        &self,
        session: &Session,
        call: &ToolCall,
        target: &Target,
        uid: &str,
        emit: &EventSink,
    ) -> Result<Value, String> {
        self.ensure_connection(session).await?;
        let policy = session.control()?.policy;
        policy.check_scope(&session.scope, target)?;
        if !policy.resources || policy.access(target, true) == DataAccess::None {
            return Err("Read-back verification is disabled by the data policy".into());
        }
        if call.name == "delete_resource" {
            let reader = resource_access(
                self.client
                    .clone()
                    .ok_or("Cluster connection unavailable")?,
                target,
            )
            .await?;
            return match reader.get(&target.name, true).await {
                Err(kube::Error::Api(e)) if e.code == 404 => Ok(
                    json!({"verification":"verified","observation":"Resource is absent after accepted deletion"}),
                ),
                Ok(_) => Ok(
                    json!({"verification":"pending","observation":"An object still exists under this name; no replacement was modified"}),
                ),
                Err(_) => Ok(json!({"verification":"unavailable"})),
            };
        }
        if matches!(
            target.kind.as_str(),
            "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" | "Job"
        ) {
            let mut arguments =
                serde_json::to_value(target).map_err(|_| "Cannot encode verification target")?;
            arguments["uid"] = json!(uid);
            arguments["timeoutSeconds"] = json!(20);
            let generation = self.accepted_operations.lock().ok().and_then(|ids| {
                ids.for_call(&call.id)
                    .filter(|identity| identity.uid == uid)
                    .and_then(|identity| identity.generation)
            });
            let Some(generation) = generation else {
                return Ok(
                    json!({"verification":"unavailable","observation":"Accepted workload generation is unavailable"}),
                );
            };
            arguments["expectedGeneration"] = json!(generation);
            if let Some(yaml) = call.arguments["yaml"].as_str() {
                let desired: Value =
                    serde_yaml::from_str(yaml).map_err(|_| "Invalid reviewed YAML")?;
                arguments["desiredState"] = json!({"spec":desired["spec"],"metadata":{"labels":desired["metadata"]["labels"],"annotations":desired["metadata"]["annotations"]}});
            }
            if let Some(n) = call.arguments.get("replicas") {
                arguments["expectedReplicas"] = n.clone();
            }
            return Box::pin(self.execute_inner(
                session,
                &ToolCall {
                    id: call.id.clone(),
                    name: "verify_workload".into(),
                    arguments,
                },
                emit,
            ))
            .await;
        }
        let page=self.linked_read(session,"get_resource",json!({"group":target.group,"version":target.version,"kind":target.kind,"namespace":target.namespace,"name":target.name,"fields":["metadata.labels","metadata.annotations","spec","data","binaryData","status.phase"]})).await?;
        let observed = &page["resource"];
        let same_uid = observed["metadata"]["uid"].as_str() == Some(uid);
        let configuration = if let Some(yaml) = call.arguments["yaml"].as_str() {
            let wanted: Value = serde_yaml::from_str(yaml).map_err(|_| "Invalid reviewed YAML")?;
            let metadata_matches = ["labels", "annotations"].iter().all(|key| {
                wanted["metadata"].get(key).is_none_or(|value| {
                    observed["metadata"]
                        .get(key)
                        .is_some_and(|actual| contains_desired_fields(value, actual))
                })
            });
            metadata_matches
                && ["spec", "data", "binaryData"].iter().all(|key| {
                    wanted.get(key).is_none_or(|value| {
                        observed
                            .get(key)
                            .is_some_and(|actual| contains_desired_fields(value, actual))
                    })
                })
        } else {
            false
        };
        let verified = same_uid
            && configuration
            && (target.kind != "PersistentVolumeClaim" || observed["status"]["phase"] == "Bound");
        Ok(
            json!({"verification":if verified{"verified"}else{"pending"},"resource":observed,"capturedAt":page["capturedAt"],"coverage":"Fresh UID-bound permitted configuration; PVC additionally requires Bound. Application health is unverified."}),
        )
    }
    async fn execute(
        &self,
        session: &Session,
        call: &ToolCall,
        emit: &EventSink,
    ) -> Result<Value, String> {
        self.ensure_connection(session).await?;
        let control = session.control()?;
        let mutation = matches!(
            call.name.as_str(),
            "apply_manifest" | "scale_workload" | "restart_workload" | "delete_resource"
        );
        // Mutations request consent after preparing their exact native diff.
        // Internal reads belonging to one approved tool do not prompt again.
        if !mutation
            && call.name != "ask_user"
            && control
                .policy
                .requires_confirmation(control.mode, &call.name)
        {
            let available = tool_definitions(
                &control.policy,
                control.mode,
                control.phase,
                &control.capabilities,
            );
            if !available.iter().any(|tool| tool.name == call.name) {
                return Err("Tool is unavailable".into());
            }
            let target = Target {
                group: call.arguments["group"].as_str().unwrap_or("").into(),
                version: call.arguments["version"].as_str().unwrap_or("v1").into(),
                kind: call.arguments["kind"]
                    .as_str()
                    .unwrap_or("Agent tool")
                    .into(),
                namespace: call.arguments["namespace"].as_str().map(str::to_owned),
                name: call.arguments["name"].as_str().unwrap_or(&call.name).into(),
            };
            let resource = reference(&session.scope.context, &target, None);
            emit(AgentEvent::Status {
                status: "awaiting_approval".into(),
            });
            let started = tokio::time::Instant::now();
            let mut cancellation = session.cancellation();
            let decision = tokio::select! {
                biased;
                _ = cancelled(&mut cancellation) => Err("Tool cancelled before dispatch".to_owned()),
                result = self.consent.confirm(&resource, format!("Run {}? Results are shared with the selected model.\n{}", call.name, call.arguments), None) => result,
            };
            self.budget.exclude_approval_wait(started.elapsed());
            session.exclude_approval_wait(started.elapsed());
            if !decision? {
                return Err("User declined this tool".into());
            }
            self.ensure_connection(session).await?;
            if session.control()?.revision != control.revision {
                return Err("Permissions changed; request the tool again".into());
            }
        }
        if !parallel_read_tool(&call.name) {
            return self.execute_inner(session, call, emit).await;
        }
        if self.budget.expired()
            && !(matches!(call.name.as_str(), "get_evidence" | "get_plan")
                || (call.name == "cluster_info"
                    && matches!(call.arguments["view"].as_str(), None | Some("session"))))
        {
            return Err("AI read deadline exhausted".into());
        }
        let mut cancellation = session.cancellation();
        let read = async {
            let _permit = self
                .read_permits
                .acquire()
                .await
                .map_err(|_| "AI read limiter unavailable")?;
            let mut result = tokio::time::timeout(
                Duration::from_secs(25),
                self.execute_inner(session, call, emit),
            )
            .await
            .map_err(|_| "Cluster read timed out")??;
            if let Some(map) = result.as_object_mut() {
                map.insert("readCost".into(), self.budget.stats());
            }
            Ok(result)
        };
        tokio::select! { biased; _ = cancelled(&mut cancellation) => Err("AI read cancelled".into()), result = read => result }
    }
}

impl KubernetesTools {
    async fn ensure_connection(&self, session: &Session) -> Result<(), String> {
        if session.control()?.invalidated || *session.cancellation().borrow() {
            return Err("AI run was cancelled or invalidated".into());
        }
        if let Some(expected) = self.connection_generation {
            let pool = &self.pool;
            let current = tokio::time::timeout(
                Duration::from_secs(15),
                pool.get_client_with_generation(&session.scope.context),
            )
            .await;
            if !matches!(current,Ok(Ok((_,generation))) if generation==expected) {
                session.invalidate();
                return Err("Cluster connection changed; start a new conversation".into());
            }
        }
        Ok(())
    }
    async fn execute_inner(
        &self,
        session: &Session,
        call: &ToolCall,
        emit: &EventSink,
    ) -> Result<Value, String> {
        let state = session.control()?;
        if state.invalidated || *session.cancellation().borrow() {
            return Err("AI run was cancelled".into());
        }
        // Unknown, unadvertised and malformed tool calls fail closed.
        if !tool_definitions(&state.policy, state.mode, state.phase, &state.capabilities)
            .iter()
            .any(|t| t.name == call.name)
        {
            return Err("Tool is unavailable in the current mode/access policy".into());
        }
        if call.name == "propose_manifests" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Proposal {
                title: String,
                yaml: String,
                dry_run: Option<bool>,
            }
            let proposal: Proposal = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid proposal arguments")?;
            if proposal.title.len() > 200 || proposal.yaml.len() > 24000 {
                return Err("Proposal is too large; split it into smaller resources".into());
            }
            let docs = serde_yaml::Deserializer::from_str(&proposal.yaml)
                .map(Value::deserialize)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "Proposal contains invalid YAML")?;
            if docs.is_empty() || docs.iter().any(|d| !d.is_object()) {
                return Err("Provide YAML resource documents".into());
            }
            if proposal.dry_run != Some(true) {
                return Ok(
                    json!({"proposal":true,"title":proposal.title,"yaml":proposal.yaml,"executed":false}),
                );
            }
            let mut results = Vec::new();
            let can_server_dry_run = self.client.is_some()
                && state.policy.resources
                && state.phase == AgentPhase::Action
                && state.mode != AgentMode::ReadOnly
                && !state.policy.read_only;
            for doc in &docs {
                let api_version = match doc["apiVersion"].as_str() {
                    Some(v) => v,
                    None => {
                        results.push(json!({"valid":false,"stage":"schema","error":"apiVersion is required"}));
                        continue;
                    }
                };
                let (group, version) = api_version.split_once('/').unwrap_or(("", api_version));
                let kind = match doc["kind"].as_str() {
                    Some(k) => k,
                    None => {
                        results.push(json!({"valid":false,"stage":"schema","error":"kind is required"}));
                        continue;
                    }
                };
                let name = match doc["metadata"]["name"].as_str() {
                    Some(n) => n,
                    None => {
                        results.push(json!({"valid":false,"stage":"schema","error":"metadata.name is required"}));
                        continue;
                    }
                };
                let target = Target {
                    group: group.into(),
                    version: version.into(),
                    kind: kind.into(),
                    namespace: doc["metadata"]["namespace"].as_str().map(str::to_owned),
                    name: name.into(),
                };
                if let Err(err) = validate_target(&target, true)
                    .and_then(|_| state.policy.check_scope(&session.scope, &target))
                    .and_then(|_| reject_privileged_manifest(doc))
                    .and_then(|_| check_manifest_data_access(doc, &state.policy, &session.scope, &target))
                {
                    results.push(json!({"target":target,"valid":false,"stage":"policy","error":err}));
                    continue;
                }
                if doc["spec"]["replicas"]
                    .as_u64()
                    .is_some_and(|n| n > u64::from(state.policy.max_replicas))
                {
                    results.push(json!({"target":target,"valid":false,"stage":"policy","error":"Manifest replica count exceeds the AI policy limit"}));
                    continue;
                }
                if target.kind == "HorizontalPodAutoscaler"
                    && doc["spec"]["maxReplicas"]
                        .as_u64()
                        .is_some_and(|n| n > u64::from(state.policy.max_replicas))
                {
                    results.push(json!({"target":target,"valid":false,"stage":"policy","error":"HPA maximum replicas exceeds the AI policy limit"}));
                    continue;
                }
                let Some(client) = self.client.clone() else {
                    results.push(json!({"target":target,"valid":true,"serverDryRun":false,"note":"Validated against Kubiki policy locally; no cluster connection available for live dry-run"}));
                    continue;
                };
                if !state.policy.resources {
                    results.push(json!({"target":target,"valid":true,"serverDryRun":false,"note":"Validated against Kubiki policy locally; resource reads are disabled"}));
                    continue;
                }
                let query = ResourceQuery {
                    context: session.scope.context.clone(),
                    group: target.group.clone(),
                    version: target.version.clone(),
                    kind: target.kind.clone(),
                    namespace: target.namespace.clone(),
                };
                let (api, builtin, _ar) = match kubiki_core::core::access::resolve_api(client, &query, false).await {
                    Ok(resolved) => resolved,
                    Err(err) => {
                        results.push(json!({"target":target,"valid":false,"stage":"discovery","error":err}));
                        continue;
                    }
                };
                let write_permitted = can_server_dry_run
                    && (state
                        .policy
                        .check_write(state.mode, &session.scope, &target, WriteOperation::Create)
                        .is_ok()
                        || state
                            .policy
                            .check_write(state.mode, &session.scope, &target, WriteOperation::Update)
                            .is_ok());
                if !write_permitted {
                    results.push(json!({
                        "target": target,
                        "valid": true,
                        "apiDiscovered": true,
                        "serverDryRun": false,
                        "note": "Validated locally against policy and live API discovery. Server-side dry-run requires Action phase with write permission enabled (ReadOnly/Plan never sends non-GET API requests)."
                    }));
                    continue;
                }
                let patch_params = kube::api::PatchParams::apply("kubiki-dry-run").dry_run();
                match tokio::time::timeout(
                    Duration::from_secs(15),
                    api.patch(&target.name, &patch_params, &kube::api::Patch::Apply(doc)),
                )
                .await
                {
                    Ok(Ok(obj)) => {
                        let preview = if state.policy.access(&target, builtin) != DataAccess::None {
                            serde_json::to_value(obj)
                                .ok()
                                .and_then(|v| state.policy.project(&target, &v, builtin).ok())
                        } else {
                            None
                        };
                        results.push(json!({
                            "target": target,
                            "valid": true,
                            "apiDiscovered": true,
                            "serverDryRun": true,
                            "preview": preview
                        }));
                    }
                    Ok(Err(kube::Error::Api(err))) => {
                        let safe_message = if target.kind == "Secret"
                            || state.policy.access(&target, builtin) != DataAccess::Content
                        {
                            format!("Dry-run rejected (HTTP {}, {})", err.code, err.reason)
                        } else {
                            let bounded_msg: String = err.message.chars().take(500).collect();
                            format!("Dry-run rejected (HTTP {}, {}): {}", err.code, err.reason, bounded_msg)
                        };
                        results.push(json!({
                            "target": target,
                            "valid": false,
                            "apiDiscovered": true,
                            "serverDryRun": true,
                            "status": err.code,
                            "reason": err.reason,
                            "error": safe_message
                        }));
                    }
                    Ok(Err(_)) => {
                        results.push(json!({"target":target,"valid":false,"serverDryRun":true,"error":"Server-side dry-run failed; check cluster connectivity and permissions"}));
                    }
                    Err(_) => {
                        results.push(json!({"target":target,"valid":false,"serverDryRun":true,"error":"Server-side dry-run timed out"}));
                    }
                }
            }
            let all_valid = results.iter().all(|r| r["valid"] == true);
            return bounded_result(json!({
                "proposal": true,
                "title": proposal.title,
                "executed": false,
                "dryRun": true,
                "valid": all_valid,
                "results": results
            }));
        }
        if call.name == "propose_plan" {
            let args: PlanProposal = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid propose_plan arguments")?;
            let artifact = session
                .plans
                .lock()
                .map_err(|_| "Plan registry unavailable")?
                .propose(
                    args,
                    &session.id,
                    &session.scope,
                    state.policy_revision,
                    &mut *session
                        .evidence
                        .lock()
                        .map_err(|_| "Evidence unavailable")?,
                )?;
            emit(AgentEvent::PlanUpdated {
                plan: artifact.clone(),
            });
            return Ok(json!({"planArtifact":artifact,"executed":false,"status":"plan_proposed"}));
        }
        if call.name == "get_plan" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Args {
                plan_id: String,
                version: u32,
            }
            let args: Args = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid plan lookup")?;
            let plan = session
                .plans
                .lock()
                .map_err(|_| "Plan registry unavailable")?
                .current(&args.plan_id, args.version)?;
            return Ok(json!({"planArtifact":plan,"historical":true,"executed":false}));
        }
        if call.name == "ask_user" {
            #[derive(Deserialize)]
            struct QuestionArgs {
                question: String,
                options: Vec<String>,
                multi_select: Option<bool>,
                allow_other: Option<bool>,
            }
            let args: QuestionArgs = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid ask_user arguments")?;
            return Ok(json!({
                "question": args.question,
                "options": args.options,
                "multi_select": args.multi_select.unwrap_or(false),
                "allow_other": args.allow_other.unwrap_or(true),
                "status": "awaiting_user_selection"
            }));
        }
        if call.name == "verify_workload" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Args {
                #[serde(default)]
                group: String,
                version: String,
                kind: String,
                namespace: String,
                name: String,
                uid: Option<String>,
                operation_id: Option<String>,
                timeout_seconds: Option<u64>,
                expected_replicas: Option<u32>,
                expected_generation: Option<u64>,
                desired_state: Option<Value>,
            }
            let mut args: Args = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid verification request")?;
            let target = Target {
                group: args.group.clone(),
                version: args.version.clone(),
                kind: args.kind.clone(),
                namespace: Some(args.namespace.clone()),
                name: args.name.clone(),
            };
            let accepted =
                {
                    let registry = self
                        .accepted_operations
                        .lock()
                        .map_err(|_| "Accepted operation registry unavailable")?;
                    match &args.operation_id {
                        Some(id) => Some(registry.get(id).ok_or(
                            "Accepted operation expired or belongs to another connection",
                        )?),
                        None => registry.latest(&target),
                    }
                };
            if let Some(operation) = accepted {
                if operation.target != target
                    || args.uid.as_ref().is_some_and(|uid| *uid != operation.uid)
                {
                    return Err("Verification target does not match the accepted operation".into());
                }
                if target.kind != "Job" && operation.generation.is_none() {
                    return Ok(
                        json!({"verification":"unavailable","observation":"Accepted workload generation is unavailable"}),
                    );
                }
                args.uid = Some(operation.uid);
                args.expected_generation = operation.generation;
                args.expected_replicas = operation.replicas.or(args.expected_replicas);
                args.desired_state = operation.desired_state.or(args.desired_state);
            } else if args.uid.is_none() {
                return Ok(
                    json!({"verification":"unavailable","observation":"Provide an accepted operationId or a previously observed UID. Use workload diagnostics for current health."}),
                );
            }
            let timeout = args.timeout_seconds.unwrap_or(15);
            if !(1..=20).contains(&timeout)
                || !matches!(
                    args.kind.as_str(),
                    "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" | "Job"
                )
            {
                return Err(
                    "Verification supports controller workloads and timeoutSeconds 1–20".into(),
                );
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
            let query = ToolCall {
                id: call.id.clone(),
                name: "get_resource".into(),
                arguments: json!({"group":args.group,"version":args.version,"kind":args.kind,"namespace":args.namespace,"name":args.name,"profile":if args.desired_state.is_some() {"full"} else {"health"}}),
            };
            let mut attempts = 0;
            let mut expected_uid = args.uid;
            let mut last_observation = Value::Null;
            loop {
                let page = match tokio::time::timeout_at(
                    deadline,
                    Box::pin(self.execute_inner(session, &query, emit)),
                )
                .await
                {
                    Ok(result) => result?,
                    Err(_) => {
                        return Ok(
                            json!({"verification":"pending","lastObservation":last_observation,"attempts":attempts,"coverage":"Verification deadline reached; no rollout completion established"}),
                        );
                    }
                };
                last_observation = page.clone();
                attempts += 1;
                let health = workload_health(&args.kind, &page["resource"]);
                if let Some(expected) = &expected_uid {
                    if page["resource"]["metadata"]["uid"]
                        .as_str()
                        .is_some_and(|current| current != expected)
                    {
                        return Err("Workload was replaced during verification; inspect the new identity before continuing".into());
                    }
                } else {
                    expected_uid = page["resource"]["metadata"]["uid"]
                        .as_str()
                        .map(str::to_owned);
                }
                if args.expected_generation.is_some_and(|generation| {
                    page["resource"]["metadata"]["generation"]
                        .as_u64()
                        .is_some_and(|current| current != generation)
                }) {
                    return Ok(
                        json!({"verification":"pending","observation":"Workload changed after the accepted operation; inspect before continuing"}),
                    );
                }
                let desired_matches = args.desired_state.as_ref().is_none_or(|desired| {
                    let observed = &page["resource"];
                    (desired["spec"].is_null()
                        || contains_desired_fields(&desired["spec"], &observed["spec"]))
                        && ["labels", "annotations"].iter().all(|key| {
                            desired["metadata"][key].is_null()
                                || contains_desired_fields(
                                    &desired["metadata"][key],
                                    &observed["metadata"][key],
                                )
                        })
                });
                let verified = desired_matches
                    && accepted_generation_matches(&page["resource"], args.expected_generation)
                    && controller_verified(
                        &args.kind,
                        &page["resource"],
                        args.expected_replicas,
                        expected_uid.as_deref(),
                    );
                let expired = tokio::time::Instant::now() >= deadline;
                if verified || expired || health["rolloutState"] == "failed" || attempts >= 6 {
                    return Ok(
                        json!({"verification":if verified {"verified"} else {"pending"},"controllerHealth":health,"attempts":attempts,"resource":page["resource"],"capturedAt":page["capturedAt"],"coverage":"Fresh bounded controller verification; application health requires separate evidence"}),
                    );
                }
                tokio::time::sleep(std::cmp::min(
                    Duration::from_secs(2),
                    deadline.saturating_duration_since(tokio::time::Instant::now()),
                ))
                .await;
            }
        }
        if call.name == "get_evidence" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Args {
                evidence_id: String,
                fields: Option<Vec<String>>,
            }
            let args: Args = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid evidence request")?;
            let data = session
                .evidence
                .lock()
                .map_err(|_| "Evidence store unavailable")?
                .get(&args.evidence_id)?;
            let data = if let Some(fields) = args.fields {
                FieldSelection::new(&fields)?.apply(&data)
            } else {
                data
            };
            return Ok(
                json!({"evidenceId":args.evidence_id,"historical":true,"data":data,"warning":"Previously collected evidence, not a fresh live read"}),
            );
        }
        if call.name == "set_working_scope" {
            let next: WorkingScope = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid working scope")?;
            if let Some(root) = &next.root {
                validate_target(root, true)?;
            }
            if let Some(ns) = &next.namespace {
                let target = Target {
                    group: "".into(),
                    version: "v1".into(),
                    kind: "Pod".into(),
                    namespace: Some(ns.clone()),
                    name: "".into(),
                };
                validate_target(&target, false)?;
                validate_query_filters(
                    &state.policy,
                    &target,
                    true,
                    next.label_selector.as_deref(),
                    None,
                )?;
            }
            let mut working = session
                .working_scope
                .lock()
                .map_err(|_| "Working scope unavailable")?;
            working.update(&session.scope, &state.policy, next)?;
            return Ok(
                json!({"workingScope":*working,"allowedScope":session.scope,"permissionsChanged":false}),
            );
        }
        if call.name == "cluster_info" {
            return self.execute_cluster_info(session, call).await;
        }
        let client = self
            .client
            .clone()
            .ok_or("Start a conversation bound to a Kubernetes context to use cluster tools")?;
        if call.name == "get_metrics" {
            let result = timed_read(session, "Metrics read cancelled", "Metrics read timed out", self.resource_metrics(session, call)).await?;
            return bounded_result(result);
        }
        if matches!(call.name.as_str(), "get_logs" | "get_events") {
            return self.read_diagnostic(session, call, client).await;
        }
        if call.name == "get_neighborhood" {
            return self.neighborhood(session, call.arguments.clone()).await;
        }
        if call.name == "diagnose_resource" {
            return self.diagnose_resource(session, call.arguments.clone()).await;
        }
        if call.name == "helm" {
            return self.execute_helm(session, call, client).await;
        }
        if call.name == "gitops" {
            return self.execute_gitops(session, call, client).await;
        }
        if [
            "apply_manifest",
            "scale_workload",
            "restart_workload",
            "delete_resource",
        ]
        .contains(&call.name.as_str())
        {
            return self.mutate(session, call, client, emit).await;
        }
        if call.name == "summarize_resources" {
            let mut arguments = call.arguments.clone();
            let map = arguments.as_object_mut().ok_or("Invalid summary query")?;
            let group = map
                .remove("groupBy")
                .and_then(|v| v.as_str().map(str::to_owned))
                .ok_or("groupBy required")?;
            let max_pages = match map.remove("maxPages") {
                Some(value) => value
                    .as_u64()
                    .filter(|n| (1..=10).contains(n))
                    .ok_or("maxPages must be 1–10")?,
                None => 5,
            };
            if map.contains_key("fields") || map.contains_key("profile") {
                return Err("Summary selects its own permitted projection".into());
            }
            map.insert(
                "profile".into(),
                json!(match group.as_str() {
                    "image" => "images",
                    "node" | "nodeName" => "scheduling",
                    _ => "health",
                }),
            );
            map.entry("pageSize").or_insert(json!(50));
            let mut summary = ResourceSummary::new(&group)?;
            let mut cursor = map.get("cursor").and_then(Value::as_str).map(str::to_owned);
            let mut partial = false;
            let mut pages = 0;
            let mut failure = None;
            let scan_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            for _ in 0..max_pages {
                let query = ToolCall {
                    id: call.id.clone(),
                    name: "list_resources".into(),
                    arguments: arguments.clone(),
                };
                let next=tokio::time::timeout_at(scan_deadline,Box::pin(self.execute_inner(session,&query,emit))).await.unwrap_or_else(|_|Err("Summary scan deadline reached; continue the returned cursor for additional evidence".into()));
                let page = match next {
                    Ok(page) => page,
                    Err(error) if pages > 0 => {
                        failure = Some(error);
                        partial = true;
                        break;
                    }
                    Err(error) => return Err(error),
                };
                pages += 1;
                if page["omittedByPolicy"].as_u64().unwrap_or(0) > 0 {
                    partial = true;
                }
                for item in page["items"].as_array().ok_or("Malformed summary page")? {
                    summary.add(item);
                }
                cursor = page["cursor"].as_str().map(str::to_owned);
                if cursor.is_none() {
                    break;
                }
                arguments["cursor"] = json!(cursor);
            }
            let restart = failure.as_ref().is_some_and(|error| {
                error.contains("expired") || error.contains("connection changed")
            });
            if restart {
                cursor = None;
            }
            let mut result = summary.value();
            result["restartRequired"] = json!(restart);
            result["pagesExamined"] = json!(pages);
            result["hasMore"] = json!(cursor.is_some());
            result["cursor"] = json!(cursor);
            result["completeness"] = json!(if partial || cursor.is_some() {
                "partial"
            } else {
                "complete"
            });
            if let Some(err) = failure {
                result["error"] = json!(err);
            }
            result["capturedAt"] = json!(stamp());
            return bounded_result(result);
        }
        let mut args: ReadResourceArgs = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid resource read arguments")?;
        let working = session
            .working_scope
            .lock()
            .map_err(|_| "Working scope unavailable")?
            .clone();
        // Explicit null remains cluster-scoped; only an omitted namespace inherits.
        if call.arguments.get("namespace").is_none() {
            args.namespace = working.namespace.clone();
        }
        if call.name == "list_resources" && args.label_selector.is_none() {
            args.label_selector = working.inherited_selector(&args.namespace, &args.kind);
        }
        if args.profile.is_some() && args.fields.is_some() {
            return Err("Choose fields or profile, not both".into());
        }
        let fields = if let Some(fields) = args.fields {
            Some(fields)
        } else if let Some(profile) = args.profile.as_deref() {
            profile_fields(profile)?
        } else if call.name == "list_resources" {
            profile_fields("health")?
        } else {
            None
        };
        let selection = fields
            .as_ref()
            .map(|fields| FieldSelection::new(fields))
            .transpose()?;
        let metadata_only = selection
            .as_ref()
            .is_some_and(FieldSelection::metadata_only);
        if args.page_size.is_some_and(|size| size == 0 || size > 50)
            || args.label_selector.as_ref().is_some_and(|s| s.len() > 2048)
            || args.field_selector.as_ref().is_some_and(|s| s.len() > 2048)
        {
            return Err("Query exceeds page or selector limits".into());
        }
        if call.name == "get_resource"
            && (args.page_size.is_some()
                || args.label_selector.is_some()
                || args.field_selector.is_some()
                || args.cursor.is_some())
        {
            return Err("Exact reads do not accept list selectors or pageSize".into());
        }
        let mut query_binding = call.arguments.clone();
        if let Some(map) = query_binding.as_object_mut() {
            map.remove("cursor");
            map.insert("workingScopeRevision".into(), json!(working.revision));
        }
        let resumed = args
            .cursor
            .as_ref()
            .map(|cursor| {
                session
                    .query_cursors
                    .lock()
                    .map_err(|_| "Cursor store unavailable".to_owned())?
                    .load(cursor, &query_binding, state.revision)
            })
            .transpose()?;
        let target = Target {
            group: normalize_core_group(&args.group, &args.version),
            version: args.version,
            kind: args.kind,
            namespace: args.namespace,
            name: args.name,
        };
        let all_ns = call.name == "list_resources" && target.namespace.as_deref() == Some("*");
        if all_ns {
            validate_target(
                &Target {
                    namespace: None,
                    ..target.clone()
                },
                false,
            )?;
            if !state.policy.data_category_enabled(&target) {
                return Err("Event, Metrics or Secret data access is disabled by policy".into());
            }
            if session.scope.context.is_empty()
                || !state
                    .policy
                    .contexts
                    .iter()
                    .any(|p| crate::policy::matches(p, &session.scope.context))
            {
                return Err("This conversation has no permitted Kubernetes context".into());
            }
        } else {
            validate_target(&target, call.name == "get_resource")?;
            state.policy.check_scope(&session.scope, &target)?;
        }
        let read = async {
            let known = kubiki_core::core::api::resource_type(&target.kind)
                .is_some_and(|resource| resource.group == target.group);
            if call.name == "get_resource"
                && state.policy.access(&target, known) == DataAccess::None
            {
                return Err("Reading this resource is disabled by policy".into());
            }
            if call.name == "list_resources"
                && state.policy.collection_completely_denied(&target, known)
            {
                return Err("Reading this resource is disabled by policy".into());
            }
            if call.name == "list_resources" && all_ns {
                if !target.name.is_empty() {
                    return Err("Use get_resource for an exact object".into());
                }
                let unrestricted_all_ns = session.scope.all_namespaces
                    && state.policy.namespaces.iter().any(|p| p == "*");
                if unrestricted_all_ns {
                    let query = ResourceQuery {
                        context: session.scope.context.clone(),
                        group: target.group.clone(),
                        version: target.version.clone(),
                        kind: target.kind.clone(),
                        namespace: None,
                    };
                    let reader =
                        kubiki_core::core::access::ResourceAccess::new(client.clone(), &query, true)
                            .await?;
                    let builtin = reader.builtin;
                    if state.policy.collection_completely_denied(&target, builtin) {
                        return Err("Reading this resource is disabled by policy".into());
                    }
                    validate_query_filters(
                        &state.policy,
                        &target,
                        builtin,
                        args.label_selector.as_deref(),
                        args.field_selector.as_deref(),
                    )?;
                    let mut pending = resumed;
                    if pending
                        .as_ref()
                        .is_none_or(|page| page.items.is_empty() && page.continuation.is_some())
                    {
                        let mut params = ListParams::default().limit(args.page_size.unwrap_or(25));
                        if let Some(token) = pending
                            .as_ref()
                            .and_then(|page| page.continuation.as_deref())
                        {
                            params = params.continue_token(token);
                        }
                        if let Some(selector) = &args.label_selector {
                            params = params.labels(selector);
                        }
                        if let Some(selector) = &args.field_selector {
                            params = params.fields(selector);
                        }
                        let mut page = projected_page(
                            &client,
                            &reader,
                            &state.policy,
                            &session.scope,
                            &target,
                            &params,
                            metadata_only,
                        )
                        .await?;
                        if let Some(selection) = &selection {
                            page.items = page
                                .items
                                .iter()
                                .map(|item| selection.apply(item))
                                .collect();
                        }
                        pending = Some(page);
                    }
                    let pending = pending.ok_or("Cursor has no remaining page")?;
                    let captured_at = pending.captured_at;
                    let omitted = pending.omitted;
                    let field_access =
                        field_access_report(&state.policy, &target, builtin, fields.as_deref());
                    let page_budget =
                        48_000.min(56_000usize.saturating_sub(field_access.to_string().len()));
                    let (items, mut tail) = split_page(pending, page_budget)?;
                    tail.omitted = 0;
                    let has_more = !tail.items.is_empty() || tail.continuation.is_some();
                    let cursor = if has_more {
                        Some(
                            session
                                .query_cursors
                                .lock()
                                .map_err(|_| "Cursor store unavailable")?
                                .save(query_binding, state.revision, tail)?,
                        )
                    } else {
                        None
                    };
                    return Ok(json!({
                        "scope": {"namespace": "*", "kind": target.kind, "labelSelector": args.label_selector, "fieldSelector": args.field_selector},
                        "capturedAt": captured_at,
                        "returned": items.len(),
                        "items": items,
                        "fieldAccess": field_access,
                        "omittedByPolicy": omitted,
                        "hasMore": has_more,
                        "cursor": cursor,
                        "completeness": if has_more || omitted > 0 { "partial" } else { "complete" },
                        "coverage": "Cross-namespace policy-projected bounded page; cursor retains byte-limited tail before the next Kubernetes page"
                    }));
                }
                // Restricted namespace scope: fan out across explicit/permitted namespaces (up to 10)
                // without ever fetching objects from unpermitted namespaces.
                let mut namespaces: Vec<String> = if !session.scope.all_namespaces {
                    session
                        .scope
                        .namespaces
                        .iter()
                        .filter(|ns| {
                            state
                                .policy
                                .namespaces
                                .iter()
                                .any(|p| crate::policy::matches(p, ns))
                        })
                        .cloned()
                        .collect()
                } else {
                    let ns_res = self
                        .linked_read(
                            session,
                            "cluster_info",
                            json!({"view": "namespaces", "pageSize": 50}),
                        )
                        .await?;
                    ns_res["namespaces"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                };
                if namespaces.is_empty() {
                    return Err(
                        "Resource is outside this conversation's namespace/cluster scope".into(),
                    );
                }
                let truncated_namespaces = namespaces.len() > 10;
                namespaces.truncate(10);
                let mut pending = resumed;
                let mut builtin = known;
                let mut ns_truncated = truncated_namespaces;
                if pending.is_none() {
                    let mut combined = QueryPage {
                        items: Vec::new(),
                        continuation: None,
                        captured_at: stamp(),
                        omitted: 0,
                    };
                    let per_ns_limit = args.page_size.unwrap_or(25);
                    for ns in &namespaces {
                        let ns_target = Target {
                            namespace: Some(ns.clone()),
                            ..target.clone()
                        };
                        if state.policy.check_scope(&session.scope, &ns_target).is_err()
                            || state
                                .policy
                                .collection_completely_denied(&ns_target, known)
                        {
                            combined.omitted += 1;
                            continue;
                        }
                        let query = ResourceQuery {
                            context: session.scope.context.clone(),
                            group: ns_target.group.clone(),
                            version: ns_target.version.clone(),
                            kind: ns_target.kind.clone(),
                            namespace: Some(ns.clone()),
                        };
                        let reader = kubiki_core::core::access::ResourceAccess::new(
                            client.clone(),
                            &query,
                            false,
                        )
                        .await?;
                        builtin = reader.builtin;
                        if state
                            .policy
                            .collection_completely_denied(&ns_target, builtin)
                        {
                            combined.omitted += 1;
                            continue;
                        }
                        validate_query_filters(
                            &state.policy,
                            &ns_target,
                            builtin,
                            args.label_selector.as_deref(),
                            args.field_selector.as_deref(),
                        )?;
                        let mut params = ListParams::default().limit(per_ns_limit);
                        if let Some(selector) = &args.label_selector {
                            params = params.labels(selector);
                        }
                        if let Some(selector) = &args.field_selector {
                            params = params.fields(selector);
                        }
                        let page = projected_page(
                            &client,
                            &reader,
                            &state.policy,
                            &session.scope,
                            &ns_target,
                            &params,
                            metadata_only,
                        )
                        .await?;
                        if page.continuation.is_some() {
                            ns_truncated = true;
                        }
                        combined.omitted += page.omitted;
                        for item in page.items {
                            let projected = match &selection {
                                Some(sel) => sel.apply(&item),
                                None => item,
                            };
                            combined.items.push(projected);
                        }
                    }
                    pending = Some(combined);
                }
                let pending = pending.ok_or("Cursor has no remaining page")?;
                let captured_at = pending.captured_at;
                let omitted = pending.omitted;
                let field_access =
                    field_access_report(&state.policy, &target, builtin, fields.as_deref());
                let page_budget =
                    48_000.min(56_000usize.saturating_sub(field_access.to_string().len()));
                let (items, mut tail) = split_page(pending, page_budget)?;
                tail.omitted = 0;
                let has_more = !tail.items.is_empty();
                let cursor = if has_more {
                    Some(
                        session
                            .query_cursors
                            .lock()
                            .map_err(|_| "Cursor store unavailable")?
                            .save(query_binding, state.revision, tail)?,
                    )
                } else {
                    None
                };
                return Ok(json!({
                    "scope": {"namespace": "*", "namespacesScanned": namespaces, "kind": target.kind, "labelSelector": args.label_selector, "fieldSelector": args.field_selector},
                    "capturedAt": captured_at,
                    "returned": items.len(),
                    "items": items,
                    "fieldAccess": field_access,
                    "omittedByPolicy": omitted,
                    "hasMore": has_more,
                    "cursor": cursor,
                    "completeness": if has_more || omitted > 0 || ns_truncated { "partial" } else { "complete" },
                    "coverage": "Bounded multi-namespace fan-out across up to 10 permitted namespaces; query individual namespaces if truncated"
                }));
            }
            let query = ResourceQuery {
                context: session.scope.context.clone(),
                group: target.group.clone(),
                version: target.version.clone(),
                kind: target.kind.clone(),
                namespace: target.namespace.clone(),
            };
            let reader =
                kubiki_core::core::access::ResourceAccess::new(client.clone(), &query, false)
                    .await?;
            let builtin = reader.builtin;
            if call.name == "list_resources"
                && state.policy.collection_completely_denied(&target, builtin)
            {
                return Err("Reading this resource is disabled by policy".into());
            }
            validate_query_filters(
                &state.policy,
                &target,
                builtin,
                args.label_selector.as_deref(),
                args.field_selector.as_deref(),
            )?;
            if call.name == "get_resource" {
                // Do not fetch an explicitly denied exact resource.
                if state.policy.access(&target, builtin) == DataAccess::None {
                    return Err("Reading this resource is disabled by policy".into());
                }
                let value = reader
                    .get(
                        &target.name,
                        metadata_only
                            || state.policy.access(&target, builtin) == DataAccess::Metadata,
                    )
                    .await
                    .map_err(query_get_error)?;
                let data = state.policy.project(&target, &value, builtin)?;
                let data = selection
                    .as_ref()
                    .map_or_else(|| data.clone(), |fields| fields.apply(&data));
                bounded_result(
                    json!({"capturedAt":stamp(),"resource":data,"fieldAccess":field_access_report(&state.policy, &target, builtin, fields.as_deref()),"coverage":"Policy-filtered live Kubernetes read; omitted fields are not evidence of absence"}),
                )
            } else if call.name == "list_resources" {
                if !target.name.is_empty() {
                    return Err("Use get_resource for an exact object".into());
                }
                // Discover identities without fetching Secret/ConfigMap contents.
                // Fetch complete objects only after the exact rule grants content.
                let mut pending = resumed;
                if pending
                    .as_ref()
                    .is_none_or(|page| page.items.is_empty() && page.continuation.is_some())
                {
                    let mut params = ListParams::default().limit(args.page_size.unwrap_or(25));
                    if let Some(token) = pending
                        .as_ref()
                        .and_then(|page| page.continuation.as_deref())
                    {
                        params = params.continue_token(token);
                    }
                    if let Some(selector) = &args.label_selector {
                        params = params.labels(selector);
                    }
                    if let Some(selector) = &args.field_selector {
                        params = params.fields(selector);
                    }
                    let mut page = projected_page(
                        &client,
                        &reader,
                        &state.policy,
                        &session.scope,
                        &target,
                        &params,
                        metadata_only,
                    )
                    .await?;
                    if let Some(selection) = &selection {
                        page.items = page
                            .items
                            .iter()
                            .map(|item| selection.apply(item))
                            .collect();
                    }
                    pending = Some(page);
                }
                let pending = pending.ok_or("Cursor has no remaining page")?;
                let captured_at = pending.captured_at;
                let omitted = pending.omitted;
                let field_access = field_access_report(&state.policy, &target, builtin, fields.as_deref());
                let page_budget = 48_000.min(56_000usize.saturating_sub(field_access.to_string().len()));
                let (items, mut tail) = split_page(pending, page_budget)?;
                tail.omitted = 0;
                let has_more = !tail.items.is_empty() || tail.continuation.is_some();
                let cursor = if has_more {
                    Some(
                        session
                            .query_cursors
                            .lock()
                            .map_err(|_| "Cursor store unavailable")?
                            .save(query_binding, state.revision, tail)?,
                    )
                } else {
                    None
                };
                Ok(
                    json!({"scope":{"namespace":target.namespace,"kind":target.kind,"labelSelector":args.label_selector,"fieldSelector":args.field_selector},"capturedAt":captured_at,"returned":items.len(),"items":items,"fieldAccess":field_access,"omittedByPolicy":omitted,"hasMore":has_more,"cursor":cursor,"completeness":if has_more || omitted > 0 {"partial"} else {"complete"},"coverage":"Policy-projected bounded page; cursor retains byte-limited tail before the next Kubernetes page"}),
                )
            } else {
                Err("Unknown AI tool".into())
            }
        };
        timed_read(session, "Read cancelled", "AI resource read timed out", read).await
    }
}

async fn diagnostic_metadata_list(
    reader: &kubiki_core::core::access::ResourceAccess,
    policy: &AgentPolicy,
    scope: &AgentScope,
    target: &Target,
    label_selector: &str,
    limit: u32,
) -> Result<kube::api::ObjectList<kube::core::PartialObjectMeta<DynamicObject>>, String> {
    policy.check_scope(scope, target)?;
    validate_query_filters(policy, target, reader.builtin, Some(label_selector), None)?;
    reader
        .list_metadata(&ListParams::default().labels(label_selector).limit(limit))
        .await
        .map_err(query_list_error)
}

async fn projected_page(
    client: &Client,
    reader: &kubiki_core::core::access::ResourceAccess,
    policy: &AgentPolicy,
    scope: &AgentScope,
    target: &Target,
    params: &ListParams,
    metadata_only: bool,
) -> Result<QueryPage, String> {
    let full_list = !metadata_only && policy.collection_content_allowed(target, reader.builtin);
    let page = reader
        .page(params, !full_list)
        .await
        .map_err(query_list_error)?;
    let mut items = Vec::new();
    let mut omitted = 0;
    let all_ns = target.namespace.as_deref() == Some("*");
    for item in page.items {
        let actual = Target {
            namespace: if all_ns {
                item["metadata"]["namespace"].as_str().map(str::to_owned)
            } else {
                target.namespace.clone()
            },
            name: item["metadata"]["name"].as_str().unwrap_or_default().into(),
            ..target.clone()
        };
        if policy.check_scope(scope, &actual).is_err() {
            omitted += 1;
            continue;
        }
        let access = policy.access(&actual, reader.builtin);
        if access == DataAccess::None {
            omitted += 1;
            continue;
        }
        let value = if !full_list && access == DataAccess::Content && !metadata_only {
            let object = if all_ns && actual.namespace.is_some() {
                let ns_reader = resource_access(client.clone(), &actual).await?;
                ns_reader
                    .get(&actual.name, false)
                    .await
                    .map_err(|_| "Resource changed or access was denied during list")?
            } else {
                reader
                    .get(&actual.name, false)
                    .await
                    .map_err(|_| "Resource changed or access was denied during list")?
            };
            if object["metadata"]["uid"] != item["metadata"]["uid"] {
                return Err("Resource replaced during list; repeat the scoped query".into());
            }
            object
        } else {
            item
        };
        match policy.project(&actual, &value, reader.builtin) {
            Ok(data) => items.push(data),
            Err(_) => omitted += 1,
        }
    }
    Ok(QueryPage {
        items,
        continuation: page.continuation,
        captured_at: stamp(),
        omitted,
    })
}

fn permitted_owner(
    policy: &AgentPolicy,
    target: &Target,
    metadata: &kube::core::ObjectMeta,
    owners: &[String],
) -> bool {
    let source = json!({"apiVersion":"v1","kind":target.kind,"metadata":metadata});
    let Ok(projected) = policy.project(target, &source, true) else {
        return false;
    };
    projected["metadata"]["ownerReferences"]
        .as_array()
        .is_some_and(|refs| {
            refs.iter().any(|r| {
                r["controller"] == true
                    && r["uid"].as_str().is_some_and(|uid| {
                        !uid.is_empty() && owners.iter().any(|owner| owner == uid)
                    })
            })
        })
}
fn silent_events() -> EventSink {
    std::sync::Arc::new(|_| {})
}
fn event_in_window(item: &Value, since: Option<chrono::DateTime<chrono::FixedOffset>>, until: Option<chrono::DateTime<chrono::FixedOffset>>) -> bool {
    if since.is_none() && until.is_none() { return true; }
    let time = ["/series/lastObservedTime","/lastTimestamp","/eventTime","/firstTimestamp","/metadata/creationTimestamp"].iter()
        .find_map(|path| item.pointer(path).and_then(Value::as_str).and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok()));
    time.is_some_and(|time| since.is_none_or(|start| time >= start) && until.is_none_or(|end| time <= end))
}
fn field_access_report(policy: &AgentPolicy, target: &Target, builtin: bool, fields: Option<&[String]>) -> Value {
    let requested = fields.unwrap_or_default();
    let denied = policy.denied_fields(target, builtin, requested);
    let per_resource = target.name.is_empty() && !policy.rules.is_empty();
    json!({"requested":requested,"denied":if per_resource {None}else{Some(&denied)},"allRequestedFieldsDenied":if per_resource {None}else{Some(!requested.is_empty() && requested.len()==denied.len())},"perResourceRules":per_resource,"coverage":"Reported denials follow policy; per-resource rules require exact reads for field explanations. A permitted but omitted field may be absent or partially projected."})
}
fn flux_gvk(kind: &str) -> Result<(&'static str, &'static [&'static str]), String> {
    match kind {
        "HelmRelease" => Ok(("helm.toolkit.fluxcd.io", &["v2", "v2beta2", "v2beta1"])),
        "Kustomization" => Ok(("kustomize.toolkit.fluxcd.io", &["v1", "v1beta2", "v1beta1"])),
        "GitRepository" | "OCIRepository" | "HelmRepository" | "HelmChart" | "Bucket" => {
            Ok(("source.toolkit.fluxcd.io", &["v1", "v1beta2", "v1beta1"]))
        }
        _ => Err("Unsupported Flux kind".into()),
    }
}

async fn resolve_flux_gvk(client: &Client, kind: &str) -> Result<(&'static str, String), String> {
    let (group, candidates) = flux_gvk(kind)?;
    if let Ok(discovery) = kube::discovery::Discovery::new(client.clone())
        .filter(&[group])
        .run()
        .await
    {
        if let Some(api_group) = discovery.groups().find(|g| g.name() == group) {
            for candidate in candidates {
                if api_group
                    .versioned_resources(candidate)
                    .iter()
                    .any(|(ar, _)| ar.kind == kind)
                {
                    return Ok((group, (*candidate).to_owned()));
                }
            }
            if let Some((ar, _)) = api_group
                .recommended_resources()
                .into_iter()
                .find(|(ar, _)| ar.kind == kind)
            {
                return Ok((group, ar.version));
            }
        }
    }
    Ok((group, candidates[0].to_owned()))
}

fn query_get_error(error: kube::Error) -> String {
    match error {
        kube::Error::Api(response) if response.code == 404 => {
            "Resource not found (HTTP 404) in this live read".into()
        }
        kube::Error::Api(response) if response.code == 403 => {
            "Resource read denied by Kubernetes RBAC (HTTP 403)".into()
        }
        _ => "Resource read unavailable; no absence or health claim can be established".into(),
    }
}

fn query_list_error(error: kube::Error) -> String {
    match error {
        kube::Error::Api(response) if response.code == 410 => "Kubernetes snapshot expired (410); start a new scoped query. Earlier pages are historical; do not combine them with a restarted scan".into(),
        kube::Error::Api(response) if response.code == 400 => "Unsupported or invalid selector; use fields supported by this Kubernetes kind".into(),
        kube::Error::Api(response) if response.code == 403 => "Resource list denied by Kubernetes RBAC".into(),
        _ => "Resource list unavailable; no complete scan was established".into(),
    }
}

// Filters must not turn hidden data into a membership oracle. Conservatively
// reject restricted selector families until field-level query authorization exists.
fn validate_query_filters(
    policy: &AgentPolicy,
    target: &Target,
    builtin: bool,
    labels: Option<&str>,
    fields: Option<&str>,
) -> Result<(), String> {
    if (labels.is_some_and(|s| !s.is_empty()) || fields.is_some_and(|s| !s.is_empty()))
        && policy.collection_completely_denied(target, builtin)
    {
        return Err("Reading this resource is disabled by policy".into());
    }
    if labels.is_some_and(|s| !s.is_empty()) && !policy.filter_field_allowed("metadata.labels") {
        return Err("Label filters are outside the selected-field access policy".into());
    }
    if fields.is_some_and(|s| {
        s.split(',').any(|term| {
            !policy.filter_field_allowed(term.split(['=', '!']).next().unwrap_or("").trim())
        })
    }) {
        return Err("Field filters are outside the selected-field access policy".into());
    }

    if labels
        .into_iter()
        .chain(fields)
        .any(|selector| selector.chars().any(char::is_control))
    {
        return Err("Selectors cannot contain control characters".into());
    }
    if labels.is_some()
        && policy
            .denied_paths
            .iter()
            .any(|p| p == "/metadata" || p.starts_with("/metadata/labels") || p.is_empty())
    {
        return Err("Label selectors are unavailable when label fields are restricted".into());
    }
    if let Some(selector) = labels {
        for term in selector.split(',') {
            let key = term
                .trim()
                .trim_start_matches('!')
                .split(|c: char| c.is_whitespace() || c == '=' || c == '!')
                .next()
                .unwrap_or("");
            let leaf = key.rsplit('/').next().unwrap_or(key);
            if crate::policy::is_sensitive_key(key) || crate::policy::is_sensitive_key(leaf) {
                return Err("Selector references a sensitive field".into());
            }
        }
    }
    if let Some(selector) = fields {
        for term in selector.split(',') {
            let key = term.split(['=', '!']).next().unwrap_or("").trim();
            let path = format!("/{}", key.replace('.', "/"));
            if key.split('.').any(|part| {
                crate::policy::is_sensitive_key(part) || part.eq_ignore_ascii_case("managedFields")
            }) || (!policy.annotations && key.split('.').any(|part| part == "annotations"))
                || (!policy.workload_configuration
                    && key
                        .split('.')
                        .any(|part| matches!(part, "command" | "args" | "env")))
            {
                return Err("Field selector references restricted configuration".into());
            }
            if policy.denied_paths.iter().any(|p| {
                path == *p
                    || path.starts_with(&format!("{p}/"))
                    || p.starts_with(&format!("{path}/"))
            }) || !policy.denied_fields(target, builtin, &[key.to_owned()]).is_empty()
                || (!key.starts_with("metadata.")
                    && !policy.collection_content_allowed(target, builtin))
            {
                return Err("Field selector is outside the permitted query projection".into());
            }
        }
    }
    Ok(())
}

// Diagnostics must derive facts only from the same projection as generic reads.
fn diagnostic_projection(
    policy: &AgentPolicy,
    target: &Target,
    object: &DynamicObject,
) -> Result<Value, String> {
    if policy.access(target, true) != DataAccess::Content {
        return Err("Diagnostics require content access".into());
    }
    policy.project(
        target,
        &serde_json::to_value(object).map_err(|_| "Cannot encode diagnostic resource")?,
        true,
    )
}

fn parse_mutation(
    policy: &AgentPolicy,
    scope: &AgentScope,
    mode: AgentMode,
    call: &ToolCall,
) -> Result<(Target, Option<String>, Option<WriteOperation>, Option<u32>), String> {
    let (target, yaml, requested_op, replicas) = if call.name == "apply_manifest" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Manifest {
            yaml: String,
            #[serde(rename = "expectedUid")]
            _expected_uid: Option<String>,
            #[serde(rename = "expectedResourceVersion")]
            _expected_resource_version: Option<String>,
            #[serde(rename = "expectedAbsent")]
            _expected_absent: Option<bool>,
        }
        let args: Manifest = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid manifest arguments")?;
        if args.yaml.len() > 24000 {
            return Err("Manifest exceeds 24000 bytes".into());
        }
        let value: Value = serde_yaml::from_str(&args.yaml)
            .map_err(|_| "Provide exactly one valid YAML resource")?;
        let api_version = value["apiVersion"]
            .as_str()
            .ok_or("apiVersion is required")?;
        let (group, version) = api_version.split_once('/').unwrap_or(("", api_version));
        let target = Target {
            group: group.into(),
            version: version.into(),
            kind: value["kind"].as_str().ok_or("kind is required")?.into(),
            namespace: value["metadata"]["namespace"].as_str().map(str::to_owned),
            name: value["metadata"]["name"]
                .as_str()
                .ok_or("metadata.name is required")?
                .into(),
        };
        // Generic manifest tools must not become a route to privileged host Pods.
        reject_privileged_manifest(&value)?;
        check_manifest_data_access(&value, &policy, scope, &target)?;
        if value["spec"]["replicas"]
            .as_u64()
            .is_some_and(|n| n > u64::from(policy.max_replicas))
        {
            return Err("Manifest replica count exceeds the AI policy limit".into());
        }
        if target.kind == "HorizontalPodAutoscaler"
            && value["spec"]["maxReplicas"]
                .as_u64()
                .is_some_and(|n| n > u64::from(policy.max_replicas))
        {
            return Err("HPA maximum replicas exceeds the AI policy limit".into());
        }
        (target, Some(args.yaml), None, None)
    } else {
        let args: ResourceArgs = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid mutation arguments")?;
        let op = match call.name.as_str() {
            "scale_workload" => WriteOperation::Scale,
            "restart_workload" => WriteOperation::Restart,
            "delete_resource" => WriteOperation::Delete,
            _ => return Err("Unknown mutation tool".into()),
        };
        if op == WriteOperation::Scale && args.replicas.is_none_or(|r| r > policy.max_replicas) {
            return Err("Replica count exceeds the AI policy limit or is missing".into());
        }
        if op != WriteOperation::Scale && args.replicas.is_some() {
            return Err("Unexpected replicas argument".into());
        }
        (args.target(), None, Some(op), args.replicas)
    };
    if requested_op == Some(WriteOperation::Scale)
        && !matches!(
            target.kind.as_str(),
            "Deployment" | "StatefulSet" | "ReplicaSet"
        )
    {
        return Err("Scale supports Deployment, StatefulSet and ReplicaSet".into());
    }
    if requested_op == Some(WriteOperation::Restart)
        && !matches!(
            target.kind.as_str(),
            "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet"
        )
    {
        return Err("Restart supports controller workloads".into());
    }
    validate_target(&target, true)?;
    if let Some(op) = requested_op {
        policy.check_write(mode, scope, &target, op)?;
    } else if policy
        .check_write(mode, scope, &target, WriteOperation::Create)
        .is_err()
        && policy
            .check_write(mode, scope, &target, WriteOperation::Update)
            .is_err()
    {
        return Err("Manifest create/update is disabled by policy".into());
    }
    Ok((target, yaml, requested_op, replicas))
}

fn bounded_result(mut result: Value) -> Result<Value, String> {
    if result.to_string().len() > 64000 {
        if let Some(items) = result.get_mut("items").and_then(Value::as_array_mut) {
            let mut size = 0;
            items.retain(|item| {
                size += item.to_string().len();
                size < 56000
            });
            result["truncated"] = json!(true);
            result["hasMore"] = json!(true);
            result["completeness"] = json!("partial");
            result["truncationReason"] =
                json!("Output byte budget reached; narrow selectors or fields");
        } else {
            return Err("Resource exceeds the AI data budget; request a smaller resource or restrict fields in the AI access policy".into());
        }
    }
    Ok(result)
}

impl KubernetesTools {
    async fn execute_cluster_info(
        &self,
        session: &Session,
        call: &ToolCall,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Args {
            view: Option<String>,
            namespace: Option<String>,
            discover: Option<bool>,
            group: Option<String>,
            page: Option<usize>,
            page_size: Option<u32>,
            cursor: Option<String>,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid cluster_info arguments")?;
        let view = args.view.as_deref().unwrap_or("session");
        let state = session.control()?;
        match view {
            "session" => {
                if args.namespace.is_some()
                    || args.discover.is_some()
                    || args.group.is_some()
                    || args.page.is_some()
                    || args.page_size.is_some()
                    || args.cursor.is_some()
                {
                    return Err("view='session' does not accept catalog/namespace/problem filters".into());
                }
                let working = session
                    .working_scope
                    .lock()
                    .map_err(|_| "Working scope unavailable")?
                    .clone();
                Ok(json!({
                    "view": "session",
                    "context": session.scope.context,
                    "connected": self.client.is_some(),
                    "allowedScope": session.scope,
                    "workingScope": working,
                    "mode": state.mode,
                    "phase": state.phase,
                    "capabilities": state.capabilities,
                    "policy": state.policy.prompt_summary(),
                    "capturedAt": stamp()
                }))
            }
            "catalog" => {
                if args.namespace.is_some() || args.page_size.is_some() || args.cursor.is_some() {
                    return Err("view='catalog' only accepts discover, group and page".into());
                }
                if args.group.as_ref().is_some_and(|g| {
                    g.len() > 253
                        || !g
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
                }) {
                    return Err("Invalid API group".into());
                }
                let mut resources = Vec::new();
                if args.discover == Some(true) {
                    let client = self
                        .client
                        .clone()
                        .ok_or("Start a conversation bound to a Kubernetes context to discover cluster APIs")?;
                    let mut discovery = kube::discovery::Discovery::new(client);
                    if let Some(group) = &args.group {
                        discovery = discovery.filter(&[group.as_str()]);
                    }
                    let discovery = discovery
                        .run()
                        .await
                        .map_err(|_| "API discovery unavailable")?;
                    for group in discovery.groups() {
                        for (ar, caps) in group.resources_by_stability() {
                            if !ar.plural.contains('/') && caps.supports_operation("get") {
                                resources.push(json!({
                                    "group": ar.group,
                                    "version": ar.version,
                                    "kind": ar.kind,
                                    "plural": ar.plural,
                                    "namespaced": caps.scope == kube::discovery::Scope::Namespaced
                                }));
                            }
                        }
                    }
                } else {
                    resources = resource_types()
                        .iter()
                        .filter(|r| args.group.as_ref().is_none_or(|g| g == &r.group))
                        .map(|r| json!(r))
                        .collect();
                }
                resources.sort_by_key(|r| r.to_string());
                resources.dedup();
                let start = args
                    .page
                    .unwrap_or(0)
                    .checked_mul(100)
                    .ok_or("Catalog page overflow")?;
                let has_more = start.saturating_add(100) < resources.len();
                bounded_result(json!({
                    "view": "catalog",
                    "resources": resources.into_iter().skip(start).take(100).collect::<Vec<_>>(),
                    "hasMore": has_more,
                    "nextPage": if has_more { Some(args.page.unwrap_or(0) + 1) } else { None },
                    "coverage": if args.discover == Some(true) {
                        "Live API discovery snapshot; object access still requires policy/RBAC"
                    } else {
                        "Built-in registry; use discover=true for CRDs"
                    }
                }))
            }
            "namespaces" => {
                if args.namespace.is_some()
                    || args.discover.is_some()
                    || args.group.is_some()
                    || args.page.is_some()
                {
                    return Err("view='namespaces' only accepts pageSize and cursor".into());
                }
                let client = self
                    .client
                    .clone()
                    .ok_or("Start a conversation bound to a Kubernetes context to list namespaces")?;
                let size = args.page_size.unwrap_or(200);
                if !(1..=200).contains(&size)
                    || !state
                        .policy
                        .contexts
                        .iter()
                        .any(|p| crate::matches(p, &session.scope.context))
                {
                    return Err("Namespace query is outside policy or page limits".into());
                }
                let mut binding = call.arguments.clone();
                if let Some(map) = binding.as_object_mut() {
                    map.remove("cursor");
                }
                let binding = json!({"tool":"cluster_info","view":"namespaces","arguments":binding});
                let pending = if let Some(cursor) = &args.cursor {
                    Some(
                        session
                            .query_cursors
                            .lock()
                            .map_err(|_| "Cursor store unavailable")?
                            .load(cursor, &binding, state.revision)?,
                    )
                } else {
                    None
                };
                let read = async {
                    let mut page = match pending {
                        Some(page) => page,
                        None => QueryPage {
                            items: Vec::new(),
                            continuation: None,
                            captured_at: stamp(),
                            omitted: 0,
                        },
                    };
                    if page.items.is_empty() {
                        let names = if session.scope.all_namespaces {
                            let target = Target {
                                group: "".into(),
                                version: "v1".into(),
                                kind: "Namespace".into(),
                                namespace: None,
                                name: "".into(),
                            };
                            let reader = resource_access(client, &target).await?;
                            let mut params = ListParams::default().limit(size);
                            if let Some(token) = &page.continuation {
                                params = params.continue_token(token);
                            }
                            let fetched =
                                reader.page(&params, true).await.map_err(query_list_error)?;
                            page.continuation = fetched.continuation;
                            fetched
                                .items
                                .into_iter()
                                .filter_map(|v| v["metadata"]["name"].as_str().map(str::to_owned))
                                .collect::<Vec<_>>()
                        } else {
                            session.scope.namespaces.clone()
                        };
                        page.captured_at = stamp();
                        for name in names {
                            if !state
                                .policy
                                .namespaces
                                .iter()
                                .any(|p| crate::matches(p, &name))
                            {
                                page.omitted += 1;
                                continue;
                            }
                            let target = Target {
                                group: "".into(),
                                version: "v1".into(),
                                kind: "Namespace".into(),
                                namespace: None,
                                name: name.clone(),
                            };
                            let source = json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":name}});
                            if let Ok(projected) = state.policy.project(&target, &source, true) {
                                if let Some(name) = projected["metadata"]["name"].as_str() {
                                    page.items.push(json!(name));
                                    continue;
                                }
                            }
                            page.omitted += 1;
                        }
                    }
                    let captured_at = page.captured_at;
                    let omitted = page.omitted;
                    let tail = page
                        .items
                        .split_off(std::cmp::min(size as usize, page.items.len()));
                    let names = std::mem::replace(&mut page.items, tail);
                    page.omitted = 0;
                    let more = !page.items.is_empty() || page.continuation.is_some();
                    let cursor = if more {
                        Some(
                            session
                                .query_cursors
                                .lock()
                                .map_err(|_| "Cursor store unavailable")?
                                .save(binding, state.revision, page)?,
                        )
                    } else {
                        None
                    };
                    Ok(json!({
                        "view": "namespaces",
                        "source": if session.scope.all_namespaces { "kubernetesMetadata" } else { "conversationScope" },
                        "namespaces": names,
                        "hasMore": more,
                        "cursor": cursor,
                        "capturedAt": captured_at,
                        "omittedByPolicy": omitted,
                        "completeness": if more || omitted > 0 { "partial" } else { "complete" },
                        "coverage": "Namespace names only, projected by allowed scope and policy; missing names do not prove absence"
                    }))
                };
                timed_read(
                    session,
                    "Namespace discovery cancelled",
                    "Namespace discovery timed out",
                    read,
                )
                .await
            }
            "problems" => {
                if args.discover.is_some()
                    || args.group.is_some()
                    || args.page.is_some()
                    || args.page_size.is_some()
                    || args.cursor.is_some()
                {
                    return Err("view='problems' only accepts optional namespace".into());
                }
                let _client = self
                    .client
                    .clone()
                    .ok_or("Start a conversation bound to a Kubernetes context to scan problems")?;
                let working_ns = session
                    .working_scope
                    .lock()
                    .ok()
                    .and_then(|w| w.namespace.clone());
                let scope_ns = args.namespace.or(working_ns).unwrap_or_else(|| {
                    if session.scope.all_namespaces
                        && state.policy.namespaces.iter().any(|p| p == "*")
                    {
                        "*".to_owned()
                    } else if session.scope.namespaces.len() == 1 {
                        session.scope.namespaces[0].clone()
                    } else {
                        "*".to_owned()
                    }
                });
                let pods_fut = self.linked_read(
                    session,
                    "list_resources",
                    json!({"group":"","version":"v1","kind":"Pod","namespace":scope_ns,"profile":"health","pageSize":50}),
                );
                let deploys_fut = self.linked_read(
                    session,
                    "list_resources",
                    json!({"group":"apps","version":"v1","kind":"Deployment","namespace":scope_ns,"profile":"health","pageSize":30}),
                );
                let sts_fut = self.linked_read(
                    session,
                    "list_resources",
                    json!({"group":"apps","version":"v1","kind":"StatefulSet","namespace":scope_ns,"profile":"health","pageSize":20}),
                );
                let ds_fut = self.linked_read(
                    session,
                    "list_resources",
                    json!({"group":"apps","version":"v1","kind":"DaemonSet","namespace":scope_ns,"profile":"health","pageSize":20}),
                );
                let pvcs_fut = self.linked_read(
                    session,
                    "list_resources",
                    json!({"group":"","version":"v1","kind":"PersistentVolumeClaim","namespace":scope_ns,"profile":"health","pageSize":30}),
                );
                let nodes_fut = async {
                    if state.policy.cluster_resources {
                        Some(
                            self.linked_read(
                                session,
                                "list_resources",
                                json!({"group":"","version":"v1","kind":"Node","namespace":null,"fields":["spec.unschedulable","status.conditions"],"pageSize":30}),
                            )
                            .await,
                        )
                    } else {
                        None
                    }
                };
                let events_fut = async {
                    if state.policy.events {
                        Some(
                            self.linked_read(
                                session,
                                "get_events",
                                json!({"namespace":scope_ns,"mode":"timeline","type":"Warning","limit":20,"maxPages":1}),
                            )
                            .await,
                        )
                    } else {
                        None
                    }
                };
                let (pods_res, deploys_res, sts_res, ds_res, pvcs_res, nodes_res, events_res) = tokio::join!(
                    pods_fut,
                    deploys_fut,
                    sts_fut,
                    ds_fut,
                    pvcs_fut,
                    nodes_fut,
                    events_fut
                );

                let mut problem_pods = Vec::new();
                let mut truncated = Vec::new();
                if let Ok(page) = pods_res {
                    if page["hasMore"] == true {
                        truncated.push("pods");
                    }
                    for item in page["items"].as_array().into_iter().flatten() {
                        let phase = item["status"]["phase"].as_str().unwrap_or("");
                        let reason = item["status"]["reason"].as_str().unwrap_or("");
                        let mut issues = Vec::new();
                        let _ = container_diagnostics(&item["status"]["initContainerStatuses"], true, &mut issues);
                        let _ = container_diagnostics(&item["status"]["containerStatuses"], false, &mut issues);
                        let unready = item["status"]["conditions"]
                            .as_array()
                            .is_some_and(|cs| {
                                cs.iter().any(|c| c["type"] == "Ready" && c["status"] == "False")
                            });
                        if matches!(phase, "Pending" | "Failed" | "Unknown")
                            || !reason.is_empty()
                            || !issues.is_empty()
                            || (phase == "Running" && unready)
                        {
                            if problem_pods.len() < 20 {
                                let node_name = item["spec"]["nodeName"]
                                    .as_str()
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty());
                                let mut entry = json!({
                                    "name": item["metadata"]["name"],
                                    "namespace": item["metadata"]["namespace"],
                                    "uid": item["metadata"]["uid"],
                                    "phase": phase,
                                    "reason": if reason.is_empty() { Value::Null } else { json!(reason) },
                                    "nodeName": node_name,
                                    "issues": issues
                                });
                                if node_name.is_none() {
                                    if let Some((target, source)) =
                                        crate::diagnostics::extract_pod_target_node(item)
                                    {
                                        entry["targetNode"] = json!(target);
                                        entry["targetNodeSource"] = json!(source);
                                    }
                                    if let Some(nominated) = item["status"]["nominatedNodeName"]
                                        .as_str()
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                    {
                                        entry["nominatedNodeName"] = json!(nominated);
                                    }
                                }
                                problem_pods.push(entry);
                            }
                        }
                    }
                }
                let mut problem_workloads = Vec::new();
                for (kind, res) in [
                    ("Deployment", deploys_res),
                    ("StatefulSet", sts_res),
                    ("DaemonSet", ds_res),
                ] {
                    if let Ok(page) = res {
                        if page["hasMore"] == true {
                            truncated.push(kind);
                        }
                        for item in page["items"].as_array().into_iter().flatten() {
                            let health = workload_health(kind, item);
                            if health["rolloutState"] != "healthy" {
                                if problem_workloads.len() < 20 {
                                    problem_workloads.push(json!({
                                        "kind": kind,
                                        "name": item["metadata"]["name"],
                                        "namespace": item["metadata"]["namespace"],
                                        "uid": item["metadata"]["uid"],
                                        "rolloutState": health["rolloutState"],
                                        "replicas": health["replicas"],
                                        "issues": health["issuesSummary"]
                                    }));
                                }
                            }
                        }
                    }
                }
                let mut problem_pvcs = Vec::new();
                if let Ok(page) = pvcs_res {
                    if page["hasMore"] == true {
                        truncated.push("pvcs");
                    }
                    for item in page["items"].as_array().into_iter().flatten() {
                        let phase = item["status"]["phase"].as_str().unwrap_or("");
                        if phase != "Bound" && problem_pvcs.len() < 15 {
                            problem_pvcs.push(json!({
                                "name": item["metadata"]["name"],
                                "namespace": item["metadata"]["namespace"],
                                "phase": phase
                            }));
                        }
                    }
                }
                let mut problem_nodes = Vec::new();
                if let Some(Ok(page)) = nodes_res {
                    if page["hasMore"] == true {
                        truncated.push("nodes");
                    }
                    for item in page["items"].as_array().into_iter().flatten() {
                        let unschedulable = item["spec"]["unschedulable"] == true;
                        let bad_conditions: Vec<Value> = item["status"]["conditions"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|c| {
                                let t = c["type"].as_str().unwrap_or("");
                                let s = c["status"].as_str().unwrap_or("");
                                (t == "Ready" && s != "True") || (t != "Ready" && s == "True")
                            })
                            .cloned()
                            .collect();
                        if unschedulable || !bad_conditions.is_empty() {
                            if problem_nodes.len() < 15 {
                                problem_nodes.push(json!({
                                    "name": item["metadata"]["name"],
                                    "unschedulable": unschedulable,
                                    "conditions": bad_conditions
                                }));
                            }
                        }
                    }
                }
                let warning_events = match events_res {
                    Some(Ok(v)) => v["timeline"].clone(),
                    Some(Err(e)) => json!({"unavailable": true, "error": e}),
                    None => json!({"unavailable": true, "error": "Events disabled by policy"}),
                };
                bounded_result(json!({
                    "view": "problems",
                    "namespace": scope_ns,
                    "pods": problem_pods,
                    "workloads": problem_workloads,
                    "pvcs": problem_pvcs,
                    "nodes": problem_nodes,
                    "warningEvents": warning_events,
                    "truncatedCollections": truncated,
                    "capturedAt": stamp(),
                    "completeness": "partial",
                    "coverage": "Bounded triage snapshot over first page of each collection (Pods<=50, Workloads<=30/20, PVCs<=30, Nodes<=30, Warning Events<=20); empty lists do not prove absence outside scanned pages or namespaces."
                }))
            }
            _ => Err("Unsupported cluster_info view; choose session, namespaces, catalog or problems".into()),
        }
    }

    async fn read_diagnostic(
        &self,
        session: &Session,
        call: &ToolCall,
        client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Args {
            namespace: String,
            name: Option<String>,
            uid: Option<String>,
            container: Option<String>,
            previous: Option<bool>,
            limit: Option<u32>,
            max_pages: Option<u32>,
            involved_kind: Option<String>,
            tail_lines: Option<i64>,
            since_seconds: Option<i64>,
            cursor: Option<String>,
            since_time: Option<String>,
            mode: Option<String>,
            contains: Option<String>,
            ignore_case: Option<bool>,
            context_lines: Option<usize>,
            page_size: Option<usize>,
            #[serde(rename = "type")]
            event_type: Option<String>,
            reason: Option<String>,
            until_time: Option<String>,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid diagnostic arguments")?;
        if call.name != "get_logs"
            && (args.tail_lines.is_some()
                || args.since_seconds.is_some()
                || args.contains.is_some()
                || args.ignore_case.is_some()
                || args.context_lines.is_some())
        {
            return Err("Log options only apply to get_logs".into());
        }
        let events = call.name == "get_events";
        if !events
            && (args.event_type.is_some()
                || args.reason.is_some()
                || args.until_time.is_some()
                || args.involved_kind.is_some()
                || args.limit.is_some()
                || args.max_pages.is_some())
        {
            return Err("Event filters only apply to Events".into());
        }
        if events
            && (args
                .event_type
                .as_ref()
                .is_some_and(|v| !["Normal", "Warning"].contains(&v.as_str()))
                || args.reason.as_ref().is_some_and(|v| {
                    v.is_empty()
                        || v.len() > 253
                        || !v.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
                })
                || args.involved_kind.as_ref().is_some_and(|v| {
                    v.is_empty()
                        || v.len() > 253
                        || !v.bytes().all(|c| c.is_ascii_alphanumeric())
                })
                || args.page_size.is_some_and(|n| !(1..=100).contains(&n))
                || args.limit.is_some_and(|n| !(1..=100).contains(&n))
                || args.max_pages.is_some_and(|n| !(1..=5).contains(&n)))
        {
            return Err("Invalid Event filter, pageSize, limit or maxPages".into());
        }
        let since = if events {
            args.since_time
                .as_deref()
                .map(chrono::DateTime::parse_from_rfc3339)
                .transpose()
                .map_err(|_| "Invalid Event sinceTime")?
        } else {
            None
        };
        let until = if events {
            args.until_time
                .as_deref()
                .map(chrono::DateTime::parse_from_rfc3339)
                .transpose()
                .map_err(|_| "Invalid Event untilTime")?
        } else {
            None
        };
        if since.zip(until).is_some_and(|(start, end)| start > end) {
            return Err("sinceTime must not be after untilTime".into());
        }
        if args.tail_lines.is_some_and(|n| !(1..=5000).contains(&n))
            || args
                .since_seconds
                .is_some_and(|n| !(1..=604800).contains(&n))
        {
            return Err("Logs require tailLines 1–5000 and sinceSeconds 1–604800".into());
        }
        let state = session.control()?;
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: if events { "Event" } else { "Pod" }.into(),
            namespace: Some(args.namespace.clone()),
            name: args.name.clone().unwrap_or_default(),
        };
        let all_events = events && args.namespace == "*";
        if all_events {
            validate_target(
                &Target {
                    namespace: None,
                    ..target.clone()
                },
                false,
            )?;
            if !state.policy.data_category_enabled(&target) {
                return Err("Event, Metrics or Secret data access is disabled by policy".into());
            }
            if session.scope.context.is_empty()
                || !state
                    .policy
                    .contexts
                    .iter()
                    .any(|p| crate::policy::matches(p, &session.scope.context))
            {
                return Err("This conversation has no permitted Kubernetes context".into());
            }
        } else {
            validate_target(&target, call.name == "get_logs")?;
            state.policy.check_scope(&session.scope, &target)?;
        }
        let read = async {
            if call.name == "get_logs" {
                if !state.policy.logs || state.policy.access(&target, true) != DataAccess::Content {
                    return Err("Pod logs are disabled by policy".into());
                }
                if args.uid.as_deref().is_none_or(str::is_empty) {
                    return Err(
                        "Pod uid is required for get_logs; read the Pod first to obtain metadata.uid"
                            .into(),
                    );
                }
                let mode = args.mode.as_deref().unwrap_or("diagnostic");
                if !matches!(mode, "diagnostic" | "lines")
                    || args
                        .page_size
                        .is_some_and(|size| !(1..=100).contains(&size))
                    || args.contains.as_ref().is_some_and(|text| text.len() > 1024)
                    || args.context_lines.is_some_and(|c| c > 10)
                    || (mode != "lines"
                        && (args.cursor.is_some()
                            || args.contains.is_some()
                            || args.ignore_case.is_some()
                            || args.context_lines.is_some()
                            || args.page_size.is_some()))
                {
                    return Err("Choose diagnostic or lines mode; cursor, contains, ignoreCase, contextLines (0–10) and pageSize (1–100) require lines mode".into());
                }
                let previous = args.previous.unwrap_or(false);
                let request = kubiki_core::pod_ops::logs::LogSliceRequest {
                    resource: reference(&session.scope.context, &target, args.uid.clone()),
                    container: args.container.clone().ok_or("Container is required")?,
                    previous,
                    tail_lines: Some(args.tail_lines.unwrap_or(150)),
                    since_time: args.since_time.clone(),
                    since_seconds: args.since_seconds,
                };
                request.validate().map_err(error_message)?;
                let map_log_err = |err: kubiki_core::core::api::ApiError| {
                    if previous && err.status == Some(400) {
                        "Previous container logs unavailable (HTTP 400; container may not have a previous terminated instance or logs rotated). Retry with previous=false".into()
                    } else if err.status == Some(400) {
                        "Container logs unavailable (HTTP 400; container may still be initializing or invalid container name)".into()
                    } else {
                        error_message(err)
                    }
                };
                if mode == "lines" {
                    let mut arguments = call.arguments.clone();
                    arguments
                        .as_object_mut()
                        .ok_or("Invalid log arguments")?
                        .remove("cursor");
                    let binding = json!({"tool":"get_logs","arguments":arguments});
                    let page = if let Some(cursor) = &args.cursor {
                        session
                            .query_cursors
                            .lock()
                            .map_err(|_| "Cursor store unavailable")?
                            .load(cursor, &binding, state.revision)?
                    } else {
                        let logs = request.read(client).await.map_err(map_log_err)?;
                        let all_lines: Vec<&str> = logs.lines().collect();
                        let ignore_case = args.ignore_case.unwrap_or(false);
                        let ctx = args.context_lines.unwrap_or(0);
                        let items = if let Some(needle) = &args.contains {
                            let needle_lower = ignore_case.then(|| needle.to_lowercase());
                            let matched: std::collections::BTreeSet<usize> = all_lines
                                .iter()
                                .enumerate()
                                .filter(|(_, line)| {
                                    if let Some(ref lower) = needle_lower {
                                        line.to_lowercase().contains(lower)
                                    } else {
                                        line.contains(needle)
                                    }
                                })
                                .map(|(idx, _)| idx)
                                .collect();
                            if ctx == 0 {
                                matched
                                    .into_iter()
                                    .map(|idx| json!({"line": idx + 1, "text": all_lines[idx]}))
                                    .collect()
                            } else {
                                let mut expanded = std::collections::BTreeSet::new();
                                for &idx in &matched {
                                    let lo = idx.saturating_sub(ctx);
                                    let hi = (idx + ctx).min(all_lines.len().saturating_sub(1));
                                    for i in lo..=hi {
                                        expanded.insert(i);
                                    }
                                }
                                expanded
                                    .into_iter()
                                    .map(|idx| {
                                        json!({
                                            "line": idx + 1,
                                            "text": all_lines[idx],
                                            "matched": matched.contains(&idx)
                                        })
                                    })
                                    .collect()
                            }
                        } else {
                            all_lines
                                .into_iter()
                                .enumerate()
                                .map(|(index, line)| json!({"line": index + 1, "text": line}))
                                .collect()
                        };
                        QueryPage {
                            items,
                            continuation: None,
                            captured_at: stamp(),
                            omitted: 0,
                        }
                    };
                    let captured_at = page.captured_at;
                    let mut page = page;
                    let remaining = page
                        .items
                        .split_off(page.items.len().min(args.page_size.unwrap_or(50)));
                    let (lines, mut tail) = split_page(page, 48_000)?;
                    tail.items.extend(remaining);
                    let more = !tail.items.is_empty();
                    let cursor = if more {
                        Some(
                            session
                                .query_cursors
                                .lock()
                                .map_err(|_| "Cursor store unavailable")?
                                .save(binding, state.revision, tail)?,
                        )
                    } else {
                        None
                    };
                    return Ok(
                        json!({"capturedAt":captured_at,"lines":lines,"cursor":cursor,"hasMore":more,
                        "completeness":"partial","coverage":"Exact lines within one bounded Pod log slice; cursor resumes this captured slice without reading live logs. Tail, time, API byte limit and rotation may omit other logs."}),
                    );
                }
                let logs = request.read(client).await.map_err(map_log_err)?;
                let (filtered_logs, total_lines, matched_lines, is_filtered) =
                    crate::diagnostics::filter_logs_for_ai(
                        &logs,
                        args.tail_lines.unwrap_or(150) as usize,
                    );
                Ok(json!({
                    "capturedAt": stamp(),
                    "logs": filtered_logs,
                    "totalLines": total_lines,
                    "matchedErrorLines": matched_lines,
                    "filtered": is_filtered,
                    "tailLines": args.tail_lines.unwrap_or(150),
                    "sinceSeconds": args.since_seconds,
                    "coverage": if is_filtered {
                        "Filtered to relevant diagnostic error/warning lines"
                    } else {
                        "Recent tail lines (no error patterns detected)"
                    }
                }))
            } else if call.name == "get_events" {
                if !state.policy.events {
                    return Err("Events are disabled by policy".into());
                }
                if args.container.is_some() || args.previous.is_some() {
                    return Err("Unexpected Event arguments".into());
                }
                let mode = args.mode.as_deref().unwrap_or("raw");
                if !matches!(mode, "raw" | "timeline") {
                    return Err("Event mode must be 'raw' or 'timeline'".into());
                }
                if mode == "raw" && (args.limit.is_some() || args.max_pages.is_some()) {
                    return Err("limit and maxPages only apply to Event timeline mode".into());
                }
                if mode == "timeline" && args.cursor.is_some() {
                    return Err("Cursor only applies to raw Event mode".into());
                }
                let mut filters = Vec::new();
                if !target.name.is_empty() {
                    filters.push(format!("involvedObject.name={}", target.name));
                }
                if let Some(kind) = &args.involved_kind {
                    filters.push(format!("involvedObject.kind={kind}"));
                }
                if let Some(uid) = &args.uid {
                    if uid.is_empty()
                        || uid.len() > 253
                        || !uid.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    {
                        return Err("Invalid Event resource UID".into());
                    }
                    filters.push(format!("involvedObject.uid={uid}"));
                }
                if let Some(value) = &args.event_type {
                    filters.push(format!("type={value}"));
                }
                if let Some(value) = &args.reason {
                    filters.push(format!("reason={value}"));
                }
                let selector = filters.join(",");
                if !selector.is_empty() {
                    validate_query_filters(&state.policy, &target, true, None, Some(&selector))?;
                }
                let unrestricted_all_ns = all_events
                    && session.scope.all_namespaces
                    && state.policy.namespaces.iter().any(|p| p == "*");
                let fanout_namespaces: Option<Vec<String>> = if all_events && !unrestricted_all_ns {
                    let mut nss: Vec<String> = if !session.scope.all_namespaces {
                        session
                            .scope
                            .namespaces
                            .iter()
                            .filter(|ns| {
                                state
                                    .policy
                                    .namespaces
                                    .iter()
                                    .any(|p| crate::policy::matches(p, ns))
                            })
                            .cloned()
                            .collect()
                    } else {
                        let ns_res = self
                            .linked_read(
                                session,
                                "cluster_info",
                                json!({"view": "namespaces", "pageSize": 50}),
                            )
                            .await?;
                        ns_res["namespaces"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect()
                    };
                    if nss.is_empty() {
                        return Err(
                            "Resource is outside this conversation's namespace/cluster scope".into(),
                        );
                    }
                    nss.truncate(10);
                    Some(nss)
                } else {
                    None
                };

                if mode == "raw" {
                    let mut arguments = call.arguments.clone();
                    arguments
                        .as_object_mut()
                        .ok_or("Invalid Event arguments")?
                        .remove("cursor");
                    let binding = json!({"tool":"get_events","arguments":arguments});
                    let mut pending = args
                        .cursor
                        .as_ref()
                        .map(|cursor| {
                            session
                                .query_cursors
                                .lock()
                                .map_err(|_| "Cursor store unavailable".to_owned())?
                                .load(cursor, &binding, state.revision)
                        })
                        .transpose()?;
                    if pending
                        .as_ref()
                        .is_none_or(|page| page.items.is_empty() && page.continuation.is_some())
                    {
                        if let Some(ref namespaces) = fanout_namespaces {
                            let mut combined = QueryPage {
                                items: Vec::new(),
                                continuation: None,
                                captured_at: stamp(),
                                omitted: 0,
                            };
                            let per_ns = args.page_size.unwrap_or(50) as u32;
                            for ns in namespaces {
                                let ns_target = Target {
                                    namespace: Some(ns.clone()),
                                    ..target.clone()
                                };
                                let query = ResourceQuery {
                                    context: session.scope.context.clone(),
                                    group: "".into(),
                                    version: "v1".into(),
                                    kind: "Event".into(),
                                    namespace: Some(ns.clone()),
                                };
                                let reader = kubiki_core::core::access::ResourceAccess::new(
                                    client.clone(),
                                    &query,
                                    false,
                                )
                                .await?;
                                let mut params = ListParams::default().limit(per_ns);
                                if !selector.is_empty() {
                                    params = params.fields(&selector);
                                }
                                let p = projected_page(
                                    &client,
                                    &reader,
                                    &state.policy,
                                    &session.scope,
                                    &ns_target,
                                    &params,
                                    false,
                                )
                                .await?;
                                combined.omitted += p.omitted;
                                combined.items.extend(p.items);
                            }
                            pending = Some(combined);
                        } else {
                            let query = ResourceQuery {
                                context: session.scope.context.clone(),
                                group: target.group.clone(),
                                version: target.version.clone(),
                                kind: target.kind.clone(),
                                namespace: if unrestricted_all_ns {
                                    None
                                } else {
                                    target.namespace.clone()
                                },
                            };
                            let reader = kubiki_core::core::access::ResourceAccess::new(
                                client.clone(),
                                &query,
                                unrestricted_all_ns,
                            )
                            .await?;
                            let mut params =
                                ListParams::default().limit(args.page_size.unwrap_or(50) as u32);
                            if !selector.is_empty() {
                                params = params.fields(&selector);
                            }
                            if let Some(token) = pending
                                .as_ref()
                                .and_then(|page| page.continuation.as_deref())
                            {
                                params = params.continue_token(token);
                            }
                            pending = Some(
                                projected_page(
                                    &client,
                                    &reader,
                                    &state.policy,
                                    &session.scope,
                                    &target,
                                    &params,
                                    false,
                                )
                                .await?,
                            );
                        }
                    }
                    let mut page = pending.ok_or("Cursor has no remaining page")?;
                    let before_time_filter = page.items.len();
                    page.items.retain(|item| event_in_window(item, since, until));
                    let time_filter_omitted = before_time_filter - page.items.len();
                    let captured_at = page.captured_at;
                    let omitted = page.omitted;
                    let (items, mut tail) = split_page(page, 48_000)?;
                    tail.omitted = 0;
                    let more = !tail.items.is_empty() || tail.continuation.is_some();
                    let cursor = if more {
                        Some(
                            session
                                .query_cursors
                                .lock()
                                .map_err(|_| "Cursor store unavailable")?
                                .save(binding, state.revision, tail)?,
                        )
                    } else {
                        None
                    };
                    return Ok(
                        json!({"capturedAt":captured_at,"items":items,"hasMore":more,"cursor":cursor,"omittedByPolicy":omitted,"timeFilterOmitted":time_filter_omitted,"coverage":"Policy-projected Events in API order. Time filters apply after each bounded page using latest occurrence (inclusive); unknown timestamps are omitted. Empty filtered pages may have a cursor; no chronological or complete absence claim"}),
                    );
                }

                // Timeline mode: scan up to max_pages (default 2, max 5) pages, sort newest-first, deduplicate.
                let limit = args.limit.unwrap_or(40).clamp(1, 100);
                let max_pages = args.max_pages.unwrap_or(2).clamp(1, 5);
                let mut raw_events = Vec::new();
                let mut pages_examined = 0u32;
                let mut has_more_pages = false;
                if let Some(ref namespaces) = fanout_namespaces {
                    for ns in namespaces {
                        let ns_target = Target {
                            namespace: Some(ns.clone()),
                            ..target.clone()
                        };
                        let query = ResourceQuery {
                            context: session.scope.context.clone(),
                            group: "".into(),
                            version: "v1".into(),
                            kind: "Event".into(),
                            namespace: Some(ns.clone()),
                        };
                        let reader = kubiki_core::core::access::ResourceAccess::new(
                            client.clone(),
                            &query,
                            false,
                        )
                        .await?;
                        let mut params = ListParams::default().limit(limit);
                        if !selector.is_empty() {
                            params = params.fields(&selector);
                        }
                        let page = projected_page(
                            &client,
                            &reader,
                            &state.policy,
                            &session.scope,
                            &ns_target,
                            &params,
                            false,
                        )
                        .await?;
                        pages_examined += 1;
                        if page.continuation.is_some() {
                            has_more_pages = true;
                        }
                        raw_events.extend(page.items);
                        if raw_events.len() >= 250 {
                            has_more_pages = true;
                            break;
                        }
                    }
                } else {
                    let query = ResourceQuery {
                        context: session.scope.context.clone(),
                        group: target.group.clone(),
                        version: target.version.clone(),
                        kind: target.kind.clone(),
                        namespace: if unrestricted_all_ns {
                            None
                        } else {
                            target.namespace.clone()
                        },
                    };
                    let reader = kubiki_core::core::access::ResourceAccess::new(
                        client.clone(),
                        &query,
                        unrestricted_all_ns,
                    )
                    .await?;
                    let mut continuation: Option<String> = None;
                    for _ in 0..max_pages {
                        let mut params = ListParams::default().limit(limit.max(50));
                        if !selector.is_empty() {
                            params = params.fields(&selector);
                        }
                        if let Some(ref token) = continuation {
                            params = params.continue_token(token);
                        }
                        let page = projected_page(
                            &client,
                            &reader,
                            &state.policy,
                            &session.scope,
                            &target,
                            &params,
                            false,
                        )
                        .await?;
                        pages_examined += 1;
                        continuation = page.continuation;
                        raw_events.extend(page.items);
                        if continuation.is_none() || raw_events.len() >= 250 {
                            break;
                        }
                    }
                    has_more_pages = continuation.is_some();
                }

                let mut timeline = Vec::new();
                for value in raw_events {
                    if !event_in_window(&value, since, until) {
                        continue;
                    }
                    let last_ts = [
                        "/series/lastObservedTime",
                        "/lastTimestamp",
                        "/eventTime",
                        "/firstTimestamp",
                        "/metadata/creationTimestamp",
                    ]
                    .iter()
                    .find_map(|p| value.pointer(p).and_then(Value::as_str).map(str::to_owned));
                    let item: DynamicObject = serde_json::from_value(value)
                        .map_err(|_| "Cannot decode projected Event")?;
                    if let Some(ref target_uid) = args.uid {
                        let item_uid = item
                            .data
                            .get("involvedObject")
                            .and_then(|io| io.get("uid"))
                            .and_then(Value::as_str);
                        if item_uid != Some(target_uid.as_str()) {
                            continue;
                        }
                    }
                    let item_ns = item.metadata.namespace.clone();
                    let actual = Target {
                        namespace: item_ns.clone().or_else(|| target.namespace.clone()),
                        name: item.metadata.name.clone().unwrap_or_default(),
                        ..target.clone()
                    };
                    if state.policy.access(&actual, true) == DataAccess::None {
                        continue;
                    }
                    let data = item.data;
                    let event_type = data.get("type").and_then(Value::as_str);
                    let reason = data
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let message = data
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let count = data.get("count").and_then(Value::as_i64);
                    let first_ts = data
                        .get("firstTimestamp")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let involved = data.get("involvedObject").cloned().unwrap_or(json!({}));
                    let component = data
                        .get("source")
                        .and_then(|s| s.get("component"))
                        .and_then(Value::as_str)
                        .or_else(|| data.get("reportingComponent").and_then(Value::as_str))
                        .unwrap_or("")
                        .to_string();

                    timeline.push(json!({
                        "namespace": item_ns,
                        "type": event_type,
                        "reason": reason,
                        "message": message,
                        "count": count,
                        "firstTimestamp": first_ts,
                        "lastTimestamp": last_ts,
                        "involvedObject": {
                            "kind": involved.get("kind"),
                            "name": involved.get("name"),
                            "namespace": involved.get("namespace"),
                            "uid": involved.get("uid"),
                            "fieldPath": involved.get("fieldPath"),
                        },
                        "component": component,
                    }));
                }
                timeline.sort_by(|a, b| {
                    let ts_a = a.get("lastTimestamp").and_then(Value::as_str).unwrap_or("");
                    let ts_b = b.get("lastTimestamp").and_then(Value::as_str).unwrap_or("");
                    ts_b.cmp(ts_a)
                });
                let deduped = crate::diagnostics::deduplicate_events(&timeline, limit as usize);
                bounded_result(json!({
                    "diagnostic": "events_timeline",
                    "evidence": {
                        "namespace": args.namespace,
                        "name": args.name,
                        "uid": args.uid,
                        "involvedKind": args.involved_kind,
                        "capturedAt": stamp(),
                        "pagesExamined": pages_examined,
                        "hasMore": has_more_pages,
                        "total": timeline.len(),
                        "deduplicated": deduped.len(),
                        "completeness": "partial",
                        "coverage": "Policy-projected deduplicated timeline across bounded pages; missing fields and expired Events are unknown"
                    },
                    "timeline": deduped,
                }))
            } else {
                Err("Unsupported diagnostic read".into())
            }
        };
        timed_read(session, "Read cancelled", "Diagnostic read timed out", read).await
    }

    pub(crate) async fn read_pod_diagnostics_for(
        &self,
        session: &Session,
        target: &Target,
    ) -> Result<Value, String> {
        let client = self
            .client
            .clone()
            .ok_or("Cluster connection unavailable")?;
        let state = session.control()?;
        if !state.policy.resources {
            return Err("Resource access is disabled by policy".into());
        }
        let namespace = target
            .namespace
            .clone()
            .ok_or("Pod diagnostics require a namespace")?;
        let pod_target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: Some(namespace.clone()),
            name: target.name.clone(),
        };
        validate_target(&pod_target, true)?;
        state.policy.check_scope(&session.scope, &pod_target)?;
        if state.policy.access(&pod_target, true) != DataAccess::Content {
            return Err(
                "Pod diagnostics require content access; use get_resource for permitted metadata"
                    .into(),
            );
        }

        let read = async {
            let api_dyn = resource_access(client.clone(), &pod_target).await?;
            let pod = api_dyn
                .get_object(&pod_target.name)
                .await
                .map_err(query_get_error)?;

            let projected = diagnostic_projection(&state.policy, &pod_target, &pod)?;
            let spec = projected.get("spec").cloned().unwrap_or(json!({}));
            let status = projected.get("status").cloned().unwrap_or(json!({}));
            let uid = projected["metadata"]["uid"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let resource_version = projected["metadata"]["resourceVersion"]
                .as_str()
                .unwrap_or_default()
                .to_owned();

            let phase = status
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or("Unknown")
                .to_string();
            let status_reason = status
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let status_message = status
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let pod_ip = status
                .get("podIP")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let host_ip = status
                .get("hostIP")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let node_name = spec
                .get("nodeName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let target_node = if node_name.is_none() {
                crate::diagnostics::extract_pod_target_node(&projected)
            } else {
                None
            };
            let restart_policy = spec.get("restartPolicy").and_then(Value::as_str);

            let mut issues = Vec::new();
            if let Some(ref reason) = status_reason {
                let msg = status_message.as_deref().unwrap_or("");
                if msg.is_empty() {
                    issues.push(format!("Pod status reason: {reason}"));
                } else {
                    issues.push(format!("Pod status reason {reason}: {msg}"));
                }
            }

            // Conditions
            let mut conditions_summary = Vec::new();
            if let Some(conditions) = status.get("conditions").and_then(Value::as_array) {
                for c in conditions {
                    let c_type = c.get("type").and_then(Value::as_str).unwrap_or("");
                    let c_status = c.get("status").and_then(Value::as_str).unwrap_or("");
                    let c_reason = c.get("reason").and_then(Value::as_str).unwrap_or("");
                    let c_msg = c.get("message").and_then(Value::as_str).unwrap_or("");
                    if c_status == "False" && !c_msg.is_empty() {
                        issues.push(format!("Condition '{}' is False: {}", c_type, c_msg));
                    }
                    conditions_summary.push(json!({
                        "type": c_type,
                        "status": c_status,
                        "reason": c_reason,
                        "message": c_msg,
                        "lastTransitionTime": c.get("lastTransitionTime"),
                    }));
                }
            }

            let init_containers = container_diagnostics(
                &status
                    .get("initContainerStatuses")
                    .cloned()
                    .unwrap_or(json!([])),
                true,
                &mut issues,
            );
            let containers = container_diagnostics(
                &status
                    .get("containerStatuses")
                    .cloned()
                    .unwrap_or(json!([])),
                false,
                &mut issues,
            );
            let ephemeral_containers = container_diagnostics(
                &status
                    .get("ephemeralContainerStatuses")
                    .cloned()
                    .unwrap_or(json!([])),
                false,
                &mut issues,
            );

            // Compact describe-equivalent scheduling & container specs (policy-projected).
            let mut scheduling = serde_json::Map::new();
            for field in [
                "nodeSelector",
                "tolerations",
                "affinity",
                "priorityClassName",
                "topologySpreadConstraints",
                "schedulerName",
                "preemptionPolicy",
            ] {
                if let Some(val) = spec.get(field) {
                    if !val.is_null() {
                        scheduling.insert(field.into(), val.clone());
                    }
                }
            }
            let mut container_specs = Vec::new();
            for (is_init, list) in [
                (true, spec.get("initContainers").and_then(Value::as_array)),
                (false, spec.get("containers").and_then(Value::as_array)),
            ] {
                for c in list.into_iter().flatten() {
                    let mut entry = serde_json::Map::new();
                    if let Some(n) = c.get("name") {
                        entry.insert("name".into(), n.clone());
                    }
                    if is_init {
                        entry.insert("init".into(), json!(true));
                    }
                    for field in [
                        "image",
                        "ports",
                        "resources",
                        "livenessProbe",
                        "readinessProbe",
                        "startupProbe",
                    ] {
                        if let Some(val) = c.get(field) {
                            if !val.is_null() {
                                entry.insert(field.into(), val.clone());
                            }
                        }
                    }
                    container_specs.push(Value::Object(entry));
                }
            }

            let mut out = json!({
                "diagnostic": "pod_diagnostics",
                "evidence": {
                    "kind": "Pod",
                    "namespace": namespace,
                    "name": pod_target.name,
                    "uid": uid,
                    "resourceVersion": resource_version,
                    "capturedAt": stamp(),
                    "completeness": "partial",
                    "coverage": "Policy-filtered diagnostic projection; omitted fields and bounded child selections do not establish absence"
                },
                "phase": phase,
                "ownerReferences": projected["metadata"].get("ownerReferences"),
                "nodeName": node_name,
                "nominatedNodeName": status.get("nominatedNodeName"),
                "podIP": pod_ip,
                "hostIP": host_ip,
                "restartPolicy": restart_policy,
                "issuesSummary": issues,
                "conditions": conditions_summary,
                "fieldAccess": field_access_report(&state.policy, &pod_target, true, Some(&[
                    "spec.nodeName".into(),
                    "status.nominatedNodeName".into(),
                    "status.conditions".into(),
                    "status.reason".into()
                ])),
                "initContainers": init_containers,
                "containers": containers,
            });
            if let Some((target, source)) = target_node {
                out["targetNode"] = json!(target);
                out["targetNodeSource"] = json!(source);
            }
            if let Some(reason) = status_reason {
                out["reason"] = json!(reason);
            }
            if let Some(message) = status_message {
                out["message"] = json!(message);
            }
            if let Some(qos) = status.get("qosClass").filter(|v| !v.is_null()) {
                out["qosClass"] = qos.clone();
            }
            if let Some(start) = status.get("startTime").filter(|v| !v.is_null()) {
                out["startTime"] = start.clone();
            }
            if !scheduling.is_empty() {
                out["scheduling"] = Value::Object(scheduling);
            }
            if !container_specs.is_empty() {
                out["containerSpecs"] = Value::Array(container_specs);
            }
            if !ephemeral_containers.is_empty() {
                out["ephemeralContainers"] = json!(ephemeral_containers);
            }
            bounded_result(out)
        };
        timed_read(session, "Pod diagnostics cancelled", "Pod diagnostics timed out", read).await
    }

    pub(crate) async fn read_workload_diagnostics_for(
        &self,
        session: &Session,
        target: &Target,
    ) -> Result<Value, String> {
        let client = self
            .client
            .clone()
            .ok_or("Cluster connection unavailable")?;
        let state = session.control()?;
        if !state.policy.resources {
            return Err("Resource access is disabled by policy".into());
        }
        let namespace = target
            .namespace
            .clone()
            .ok_or("Workload diagnostics require a namespace")?;
        let target = target.clone();
        validate_target(&target, true)?;
        state.policy.check_scope(&session.scope, &target)?;
        if state.policy.access(&target, true) != DataAccess::Content {
            return Err("Workload diagnostics require content access; use get_resource for permitted metadata".into());
        }

        let read = async {
            let api_dyn = resource_access(client.clone(), &target).await?;
            let obj = api_dyn
                .get_object(&target.name)
                .await
                .map_err(query_get_error)?;

            let projected = diagnostic_projection(&state.policy, &target, &obj)?;
            let spec = projected.get("spec").cloned().unwrap_or(json!({}));
            let status = projected.get("status").cloned().unwrap_or(json!({}));
            let uid = projected["metadata"]["uid"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let generation = projected["metadata"]["generation"].as_i64();
            let obs_gen = status.get("observedGeneration").cloned();
            let health = workload_health(&target.kind, &projected);
            let selector = diagnostic_selector(&spec["selector"]);
            let mut coverage_reasons =
                vec!["Bounded, policy-filtered child diagnostics".to_owned()];
            let mut pod_owners = if target.kind == "Deployment" {
                Vec::new()
            } else {
                vec![uid.clone()]
            };

            // Child ReplicaSets for Deployment
            let mut replica_sets_summary = Vec::new();
            if target.kind == "Deployment" {
                let rs_target = Target {
                    group: "apps".into(),
                    version: "v1".into(),
                    kind: "ReplicaSet".into(),
                    namespace: Some(namespace.clone()),
                    name: "".into(),
                };
                if let Ok(label_selector) = &selector {
                    if let Ok(rs_api) = resource_access(client.clone(), &rs_target).await {
                        if let Ok(page) = diagnostic_metadata_list(
                            &rs_api,
                            &state.policy,
                            &session.scope,
                            &rs_target,
                            label_selector,
                            20,
                        )
                        .await
                        {
                            if page
                                .metadata
                                .continue_
                                .as_ref()
                                .is_some_and(|v| !v.is_empty())
                            {
                                coverage_reasons.push("ReplicaSet page limit reached".into());
                            }
                            for rs in page.items {
                                let owner_target = Target {
                                    name: rs.metadata.name.clone().unwrap_or_default(),
                                    ..rs_target.clone()
                                };
                                let is_owned = permitted_owner(
                                    &state.policy,
                                    &owner_target,
                                    &rs.metadata,
                                    &[uid.clone()],
                                );
                                if is_owned {
                                    let child_target = Target {
                                        name: rs.metadata.name.clone().unwrap_or_default(),
                                        ..rs_target.clone()
                                    };
                                    if state
                                        .policy
                                        .check_scope(&session.scope, &child_target)
                                        .is_err()
                                        || state.policy.access(&child_target, true)
                                            != DataAccess::Content
                                    {
                                        coverage_reasons
                                            .push("Child content omitted by policy".into());
                                        continue;
                                    }
                                    let Ok(raw) = rs_api.get_object(&child_target.name).await
                                    else {
                                        coverage_reasons.push("ReplicaSet read unavailable".into());
                                        continue;
                                    };
                                    if raw.metadata.uid != rs.metadata.uid {
                                        coverage_reasons.push(
                                            "ReplicaSet replaced during diagnostic read".into(),
                                        );
                                        continue;
                                    }
                                    let projected = state.policy.project(
                                        &child_target,
                                        &serde_json::to_value(raw)
                                            .map_err(|_| "Cannot encode ReplicaSet")?,
                                        true,
                                    )?;
                                    let rs_created = projected["metadata"]["creationTimestamp"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .to_owned();
                                    let pod_template_hash = projected["metadata"]["labels"]
                                        ["pod-template-hash"]
                                        .as_str()
                                        .map(str::to_owned);
                                    let rs: DynamicObject = serde_json::from_value(projected)
                                        .map_err(|_| "Cannot decode projected ReplicaSet")?;
                                    if let Some(owner) = rs.metadata.uid.clone() {
                                        pod_owners.push(owner);
                                    }
                                    let rs_name = rs.metadata.name.clone().unwrap_or_default();
                                    let rs_spec = rs.data.get("spec");
                                    let rs_status = rs.data.get("status");
                                    let rs_desired = rs_spec
                                        .and_then(|s| s.get("replicas"))
                                        .and_then(Value::as_i64);
                                    let rs_current = rs_status
                                        .and_then(|s| s.get("replicas"))
                                        .and_then(Value::as_i64);
                                    let rs_ready = rs_status
                                        .and_then(|s| s.get("readyReplicas"))
                                        .and_then(Value::as_i64);
                                    let revision = rs
                                        .metadata
                                        .annotations
                                        .as_ref()
                                        .and_then(|a| {
                                            a.get("deployment.kubernetes.io/revision").cloned()
                                        })
                                        .unwrap_or_default();
                                    replica_sets_summary.push(json!({
                                        "name": rs_name,
                                        "revision": revision,
                                        "podTemplateHash": pod_template_hash,
                                        "creationTimestamp": rs_created,
                                        "desired": rs_desired,
                                        "current": rs_current,
                                        "ready": rs_ready,
                                    }));
                                }
                            }
                            replica_sets_summary.sort_by(|a, b| {
                                let rev_a = a["revision"].as_str().and_then(|s| s.parse::<u64>().ok());
                                let rev_b = b["revision"].as_str().and_then(|s| s.parse::<u64>().ok());
                                match (rev_b, rev_a) {
                                    (Some(rb), Some(ra)) => rb.cmp(&ra),
                                    _ => b["creationTimestamp"]
                                        .as_str()
                                        .unwrap_or("")
                                        .cmp(a["creationTimestamp"].as_str().unwrap_or("")),
                                }
                            });
                        } else {
                            coverage_reasons.push("ReplicaSet list unavailable".into());
                        }
                    } else {
                        coverage_reasons.push("ReplicaSet API unavailable".into());
                    }
                }
            }
            if let Err(reason) = &selector {
                coverage_reasons.push(reason.clone());
            }
            // Child Pods summary
            let mut child_pods_summary = Vec::new();
            if let Ok(label_selector) = &selector {
                if !pod_owners.is_empty() {
                    let pod_target = Target {
                        group: "".into(),
                        version: "v1".into(),
                        kind: "Pod".into(),
                        namespace: Some(namespace.clone()),
                        name: "".into(),
                    };
                    if let Ok(pod_api) = resource_access(client.clone(), &pod_target).await {
                        if let Ok(pod_page) = diagnostic_metadata_list(
                            &pod_api,
                            &state.policy,
                            &session.scope,
                            &pod_target,
                            label_selector,
                            30,
                        )
                        .await
                        {
                            if pod_page
                                .metadata
                                .continue_
                                .as_ref()
                                .is_some_and(|v| !v.is_empty())
                            {
                                coverage_reasons.push("Pod page limit reached".into());
                            }
                            for pod in pod_page.items {
                                let owner_target = Target {
                                    name: pod.metadata.name.clone().unwrap_or_default(),
                                    ..pod_target.clone()
                                };
                                if !permitted_owner(
                                    &state.policy,
                                    &owner_target,
                                    &pod.metadata,
                                    &pod_owners,
                                ) {
                                    continue;
                                }
                                let child_target = Target {
                                    name: pod.metadata.name.clone().unwrap_or_default(),
                                    ..pod_target.clone()
                                };
                                if state
                                    .policy
                                    .check_scope(&session.scope, &child_target)
                                    .is_err()
                                    || state.policy.access(&child_target, true)
                                        != DataAccess::Content
                                {
                                    coverage_reasons.push("Child content omitted by policy".into());
                                    continue;
                                }
                                let Ok(raw) = pod_api.get_object(&child_target.name).await else {
                                    coverage_reasons.push("Pod read unavailable".into());
                                    continue;
                                };
                                if raw.metadata.uid != pod.metadata.uid {
                                    coverage_reasons
                                        .push("Pod replaced during diagnostic read".into());
                                    continue;
                                }
                                let projected = state.policy.project(
                                    &child_target,
                                    &serde_json::to_value(raw)
                                        .map_err(|_| "Cannot encode child Pod")?,
                                    true,
                                )?;
                                let pod: DynamicObject = serde_json::from_value(projected)
                                    .map_err(|_| "Cannot decode projected Pod")?;
                                let pod_name = pod.metadata.name.clone().unwrap_or_default();
                                let pod_phase = pod
                                    .data
                                    .get("status")
                                    .and_then(|s| s.get("phase"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("Unknown")
                                    .to_string();
                                let pod_reason = pod
                                    .data
                                    .get("status")
                                    .and_then(|s| s.get("reason"))
                                    .and_then(Value::as_str)
                                    .map(str::to_owned);
                                let pod_node = pod
                                    .data
                                    .get("spec")
                                    .and_then(|s| s.get("nodeName"))
                                    .and_then(Value::as_str)
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                    .map(str::to_owned);
                                let pod_target_node = if pod_node.is_none() {
                                    crate::diagnostics::extract_pod_target_node(&pod.data)
                                } else {
                                    None
                                };
                                let pod_nominated_node = if pod_node.is_none() {
                                    pod.data
                                        .pointer("/status/nominatedNodeName")
                                        .and_then(Value::as_str)
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                        .map(str::to_owned)
                                } else {
                                    None
                                };
                                let mut pod_issues = Vec::new();
                                let init_diag = container_diagnostics(
                                    &pod.data["status"]["initContainerStatuses"],
                                    true,
                                    &mut pod_issues,
                                );
                                let cont_diag = container_diagnostics(
                                    &pod.data["status"]["containerStatuses"],
                                    false,
                                    &mut pod_issues,
                                );
                                let pod_causes = crate::diagnostics::extract_crash_causes(&json!({
                                    "initContainers": init_diag,
                                    "containers": cont_diag,
                                }));
                                let pod_issue =
                                    (!pod_issues.is_empty()).then(|| pod_issues.join("; "));
                                let mut pod_entry = json!({
                                    "name": pod_name,
                                    "uid": pod.metadata.uid,
                                    "phase": pod_phase,
                                    "nodeName": pod_node,
                                    "issue": pod_issue,
                                });
                                if let Some((target, source)) = pod_target_node {
                                    pod_entry["targetNode"] = json!(target);
                                    pod_entry["targetNodeSource"] = json!(source);
                                }
                                if let Some(nominated) = pod_nominated_node {
                                    pod_entry["nominatedNodeName"] = json!(nominated);
                                }
                                if let Some(reason) = pod_reason {
                                    pod_entry["reason"] = json!(reason);
                                }
                                if !pod_causes.is_empty() {
                                    pod_entry["crashCauses"] = json!(pod_causes);
                                }
                                child_pods_summary.push(pod_entry);
                            }
                        } else {
                            coverage_reasons.push("Pod list unavailable".into());
                        }
                    } else {
                        coverage_reasons.push("Pod API unavailable".into());
                    }
                } else {
                    coverage_reasons.push("Permitted owner identities unavailable".into());
                }
            }
            coverage_reasons.sort();
            coverage_reasons.dedup();

            bounded_result(json!({
                "diagnostic": "workload_diagnostics",
                "evidence": {
                    "kind": target.kind,
                    "group": target.group,
                    "version": target.version,
                    "namespace": namespace,
                    "name": target.name,
                    "uid": uid,
                    "generation": generation,
                    "observedGeneration": obs_gen,
                    "capturedAt": stamp(),
                    "completeness": "partial",
                    "coverage": "Policy-filtered diagnostic projection; omitted fields and bounded child selections do not establish absence"
                },
                "rolloutState": health["rolloutState"],
                "replicas": health["replicas"],
                "issuesSummary": health["issuesSummary"],
                "conditions": health["conditions"],
                "coverageReasons": coverage_reasons,
                "replicaSets": replica_sets_summary,
                "childPods": child_pods_summary,
            }))
        };
        timed_read(session, "Workload diagnostics cancelled", "Workload diagnostics timed out", read).await
    }

    // Compose generic projected reads so policy, selectors, UID checks, paging and
    // uniform-LIST optimization have exactly one implementation.
    pub(crate) async fn linked_read(
        &self,
        session: &Session,
        name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        let call = ToolCall {
            id: "linked-diagnostic".into(),
            name: name.into(),
            arguments,
        };
        let mut result = Box::pin(self.execute_inner(session, &call, &silent_events())).await?;
        if name == "list_resources" {
            if let Some(cursor) = result["cursor"].as_str() {
                let mut args = call.arguments.clone();
                args["cursor"] = json!(cursor);
                result["continuationQuery"] = json!({"tool":"list_resources","arguments":args});
            }
        }
        Ok(result)
    }

    pub(crate) async fn read_service_diagnostics_for(
        &self,
        session: &Session,
        target: &Target,
    ) -> Result<Value, String> {
        let state = session.control()?;
        let namespace = target
            .namespace
            .clone()
            .ok_or("Service diagnostics require a namespace")?;
        let svc_target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "Service".into(),
            namespace: Some(namespace.clone()),
            name: target.name.clone(),
        };
        validate_target(&svc_target, true)?;
        state.policy.check_scope(&session.scope, &svc_target)?;
        if state.policy.access(&svc_target, true) != DataAccess::Content {
            return Err("Service diagnostics require content access".into());
        }
        let root = self.linked_read(session, "get_resource", json!({"group":"","version":"v1","kind":"Service","namespace":namespace,"name":svc_target.name,"fields":["spec.type","spec.clusterIP","spec.selector","spec.ports","spec.externalName","spec.publishNotReadyAddresses","status.loadBalancer"]})).await?;
        let service = &root["resource"];
        let mut coverage = json!({});
        let mut slices = None;
        let mut pods = None;
        if service["spec"]["type"] != "ExternalName" {
            let result = self.linked_read(session, "list_resources", json!({"group":"discovery.k8s.io","version":"v1","kind":"EndpointSlice","namespace":namespace,"labelSelector":format!("kubernetes.io/service-name={}", svc_target.name),"pageSize":10,"fields":["metadata.ownerReferences","endpoints[*].conditions","ports"]})).await;
            match result {
                Ok(mut page) => {
                    let service_uid = service["metadata"]["uid"].as_str();
                    if let Some(items) = page["items"].as_array_mut() {
                        let before = items.len();
                        items.retain(|item| {
                            !item["metadata"]["ownerReferences"]
                                .as_array()
                                .is_some_and(|owners| {
                                    owners.iter().any(|owner| {
                                        owner["kind"] == "Service"
                                            && owner["uid"]
                                                .as_str()
                                                .zip(service_uid)
                                                .is_some_and(|(a, b)| a != b)
                                    })
                                })
                        });
                        let omitted = before - items.len();
                        page["omittedReplacedOwners"] = json!(omitted);
                    }
                    slices = Some(page["items"].clone());
                    coverage["endpointSlices"] = page;
                }
                Err(error) => {
                    coverage["endpointSlices"] =
                        json!({"completeness":"unavailable","reason":error})
                }
            }
            let selector = service
                .pointer("/spec/selector")
                .and_then(Value::as_object)
                .filter(|s| !s.is_empty());
            if let Some(selector) = selector {
                let selector = diagnostic_selector(&json!({"matchLabels":selector}))?;
                match self.linked_read(session, "list_resources", json!({"group":"","version":"v1","kind":"Pod","namespace":namespace,"labelSelector":selector,"pageSize":20,"fields":["status.phase","status.conditions","spec.containers[*].name","spec.containers[*].ports","spec.containers[*].readinessProbe"]})).await {
                    Ok(page) => { pods = page["items"].as_array().cloned(); coverage["pods"]=page; }
                    Err(error) => coverage["pods"]=json!({"completeness":"unavailable","reason":error}),
                }
            } else {
                coverage["pods"] = json!({"completeness":"unavailable","reason":"No usable permitted selector; no broad Pod scan performed"});
            }
            if let Ok(np_page) = self.linked_read(session, "list_resources", json!({"group":"networking.k8s.io","version":"v1","kind":"NetworkPolicy","namespace":namespace,"pageSize":10,"fields":["metadata.name","spec.podSelector","spec.policyTypes"]})).await {
                if let Some(items) = np_page["items"].as_array() {
                    if !items.is_empty() {
                        coverage["networkPolicies"] = json!({
                            "count": items.len(),
                            "hasMore": np_page["hasMore"],
                            "policies": items.iter().map(|np| json!({
                                "name": np["metadata"]["name"],
                                "podSelector": np["spec"]["podSelector"],
                                "policyTypes": np["spec"]["policyTypes"],
                            })).collect::<Vec<_>>()
                        });
                    }
                }
            }
        }
        let diag = service_diagnostics(service, slices.as_ref(), pods.as_deref());
        for key in ["pods", "endpointSlices"] {
            if let Some(map) = coverage[key].as_object_mut() {
                map.remove("items");
            }
        }
        bounded_result(
            json!({"diagnostic":"service_diagnostics","service":diag,"components":coverage,"evidence":{"context":session.scope.context,"kind":"Service","namespace":namespace,"name":svc_target.name,"uid":service["metadata"]["uid"],"resourceVersion":service["metadata"]["resourceVersion"],"capturedAt":root["capturedAt"],"completeness":"partial","coverage":"Scoped policy-projected observations; endpoint readiness does not establish connectivity or application health"}}),
        )
    }

    pub(crate) async fn read_pvc_diagnostics_for(
        &self,
        session: &Session,
        target: &Target,
    ) -> Result<Value, String> {
        let state = session.control()?;
        let namespace = target
            .namespace
            .clone()
            .ok_or("PVC diagnostics require a namespace")?;
        let pvc_target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "PersistentVolumeClaim".into(),
            namespace: Some(namespace.clone()),
            name: target.name.clone(),
        };
        validate_target(&pvc_target, true)?;
        state.policy.check_scope(&session.scope, &pvc_target)?;
        if state.policy.access(&pvc_target, true) != DataAccess::Content {
            return Err("PVC diagnostics require content access".into());
        }
        let root=self.linked_read(session,"get_resource",json!({"group":"","version":"v1","kind":"PersistentVolumeClaim","namespace":namespace,"name":pvc_target.name,"fields":["spec.volumeName","spec.storageClassName","spec.resources.requests.storage","spec.accessModes","status.phase","status.capacity","status.conditions"]})).await?;
        let pvc = &root["resource"];
        let mut components = json!({});
        let mut pv = None;
        if let Some(name) = pvc["spec"]["volumeName"].as_str().filter(|s| !s.is_empty()) {
            match self.linked_read(session,"get_resource",json!({"group":"","version":"v1","kind":"PersistentVolume","namespace":null,"name":name,"fields":["spec.claimRef","spec.capacity","spec.storageClassName","spec.persistentVolumeReclaimPolicy","spec.nodeAffinity","status.phase"]})).await {
                Ok(page)=> {
                    let resource=&page["resource"];
                    let valid=resource.pointer("/spec/claimRef/uid").and_then(Value::as_str).zip(pvc["metadata"]["uid"].as_str()).is_some_and(|(a,b)|a==b);
                    if valid { pv=Some(resource.clone()); }
                    components["volume"]=json!({"identity":resource["metadata"],"capturedAt":page["capturedAt"],"claimUidVerified":valid,"completeness":if valid {"partial"}else{"unavailable"},"reason":if valid {"Projected bound volume"}else{"Claim UID missing, filtered or mismatched; volume not attributed to this claim"}});
                }
                Err(error)=>components["volume"]=json!({"completeness":"unavailable","reason":error}),
            }
        }
        if let Some(name) = pvc["spec"]["storageClassName"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            match self.linked_read(session,"get_resource",json!({"group":"storage.k8s.io","version":"v1","kind":"StorageClass","namespace":null,"name":name,"fields":["volumeBindingMode","allowVolumeExpansion","allowedTopologies","provisioner"]})).await {
                Ok(page)=>components["storageClass"]=page,
                Err(error)=>components["storageClass"]=json!({"completeness":"unavailable","reason":error}),
            }
        }
        let mut events = None;
        if state.policy.events {
            if let Some(uid) = pvc["metadata"]["uid"].as_str().filter(|s| !s.is_empty()) {
                let selector = format!("involvedObject.uid={uid}");
                match self.linked_read(session,"list_resources",json!({"group":"","version":"v1","kind":"Event","namespace":namespace,"labelSelector":"","fieldSelector":selector,"pageSize":20,"fields":["involvedObject.uid","reason","message","type","lastTimestamp","eventTime"]})).await {
                    Ok(mut page)=> {
                        events=page["items"].as_array().map(|items|items.iter().filter(|item|item["involvedObject"]["uid"]==uid).cloned().collect::<Vec<_>>());
                        page.as_object_mut().unwrap().remove("items");
                        components["events"]=page;
                    }
                    Err(error)=>components["events"]=json!({"completeness":"unavailable","reason":error}),
                }
            } else {
                components["events"] = json!({"completeness":"unavailable","reason":"Claim UID unavailable; no name-only Event query performed"});
            }
        } else {
            components["events"] =
                json!({"completeness":"denied","reason":"Event access disabled"});
        }
        let diag = pvc_diagnostics(pvc, pv.as_ref(), events.as_deref());
        bounded_result(
            json!({"diagnostic":"pvc_diagnostics","pvc":diag,"components":components,"evidence":{"context":session.scope.context,"kind":"PersistentVolumeClaim","namespace":namespace,"name":pvc_target.name,"uid":pvc["metadata"]["uid"],"resourceVersion":pvc["metadata"]["resourceVersion"],"capturedAt":root["capturedAt"],"completeness":"partial","coverage":"Projected claim, exact volume/class and UID-bound Events; unavailable fields do not establish absence"}}),
        )
    }

    pub(crate) async fn read_node_diagnostics_for(
        &self,
        session: &Session,
        target: &Target,
    ) -> Result<Value, String> {
        let page = self
            .linked_read(
                session,
                "get_resource",
                json!({
                    "group": "",
                    "version": "v1",
                    "kind": "Node",
                    "namespace": null,
                    "name": target.name,
                    "fields": [
                        "metadata.labels",
                        "spec.unschedulable",
                        "spec.taints",
                        "status.conditions",
                        "status.capacity",
                        "status.allocatable",
                        "status.nodeInfo"
                    ]
                }),
            )
            .await?;
        let mut node = node_diagnostics(&page["resource"]);
        if let Some(info) = page["resource"]["status"].get("nodeInfo").filter(|v| !v.is_null()) {
            node["nodeInfo"] = info.clone();
        }
        if let Some(labels) = page["resource"]["metadata"].get("labels").filter(|v| !v.is_null()) {
            node["labels"] = labels.clone();
        }
        bounded_result(json!({
            "diagnostic": "node_diagnostics",
            "node": node,
            "evidence": {
                "context": session.scope.context,
                "kind": "Node",
                "name": page["resource"]["metadata"]["name"],
                "uid": page["resource"]["metadata"]["uid"],
                "capturedAt": page["capturedAt"],
                "completeness": "partial"
            }
        }))
    }

    pub(crate) async fn read_config_diagnostics_for(
        &self,
        session: &Session,
        target: &Target,
    ) -> Result<Value, String> {
        if !matches!(
            target.kind.as_str(),
            "Pod"
                | "Deployment"
                | "StatefulSet"
                | "DaemonSet"
                | "ReplicaSet"
                | "Job"
                | "CronJob"
        ) {
            return Err("Configuration diagnostics supports Pods and workloads".into());
        }
        let state = session.control()?;
        let prefix = match target.kind.as_str() {
            "Pod" => "spec",
            "CronJob" => "spec.jobTemplate.spec.template.spec",
            _ => "spec.template.spec",
        };
        let fields = [
            "containers[*].name",
            "containers[*].envFrom",
            "containers[*].env[*].valueFrom",
            "initContainers[*].name",
            "initContainers[*].envFrom",
            "initContainers[*].env[*].valueFrom",
            "ephemeralContainers[*].name",
            "ephemeralContainers[*].envFrom",
            "ephemeralContainers[*].env[*].valueFrom",
            "volumes[*].configMap",
            "volumes[*].secret",
            "volumes[*].projected",
            "imagePullSecrets",
        ]
        .into_iter()
        .map(|field| format!("{prefix}.{field}"))
        .collect::<Vec<_>>();
        let page = self
            .linked_read(
                session,
                "get_resource",
                json!({
                    "group": target.group,
                    "version": target.version,
                    "kind": target.kind,
                    "namespace": target.namespace,
                    "name": target.name,
                    "fields": fields
                }),
            )
            .await?;
        let root = &page["resource"];
        let pod_spec = if target.kind == "Pod" {
            &root["spec"]
        } else if target.kind == "CronJob" {
            &root["spec"]["jobTemplate"]["spec"]["template"]["spec"]
        } else {
            &root["spec"]["template"]["spec"]
        };
        let references = config_reference_diagnostics(pod_spec);
        let mut checks = Vec::new();
        let mut examined = 0;
        let mut seen = std::collections::BTreeSet::new();
        for (key, kind) in [("configMaps", "ConfigMap"), ("secrets", "Secret")] {
            for reference in references[key].as_array().into_iter().flatten() {
                if examined >= 20 {
                    break;
                }
                let Some(name) = reference["name"].as_str() else {
                    continue;
                };
                if !seen.insert((
                    kind.to_owned(),
                    name.to_owned(),
                    reference["key"].as_str().map(str::to_owned),
                )) {
                    continue;
                }
                examined += 1;
                let ref_target = Target {
                    group: "".into(),
                    version: "v1".into(),
                    kind: kind.into(),
                    namespace: target.namespace.clone(),
                    name: name.into(),
                };
                let content = state.policy.access(&ref_target, true) == DataAccess::Content;
                let check_fields = if content && reference["key"].is_string() {
                    json!(["data", "binaryData"])
                } else {
                    json!(["metadata.name"])
                };
                match self
                    .linked_read(
                        session,
                        "get_resource",
                        json!({
                            "group": "",
                            "version": "v1",
                            "kind": kind,
                            "namespace": target.namespace,
                            "name": name,
                            "fields": check_fields
                        }),
                    )
                    .await
                {
                    Ok(found) => {
                        let item = &found["resource"];
                        let k = reference["key"].as_str();
                        let present = k.is_some_and(|k| {
                            item["data"].get(k).is_some() || item["binaryData"].get(k).is_some()
                        });
                        checks.push(json!({
                            "kind": kind,
                            "name": name,
                            "key": k,
                            "object": "observed",
                            "keyStatus": if k.is_none() { "notApplicable" } else if present { "present" } else { "unknownOrMissing" },
                            "capturedAt": found["capturedAt"]
                        }));
                    }
                    Err(error) => checks.push(json!({
                        "kind": kind,
                        "name": name,
                        "key": reference["key"].as_str(),
                        "object": if error.contains("HTTP 404") { "notFound" } else { "unavailableOrDenied" },
                        "reason": error
                    })),
                }
            }
        }
        bounded_result(json!({
            "references": references,
            "checks": checks,
            "examined": examined,
            "evidence": {
                "context": session.scope.context,
                "kind": target.kind,
                "namespace": target.namespace,
                "name": target.name,
                "capturedAt": page["capturedAt"],
                "completeness": "partial",
                "coverage": "Projected references and at most 20 distinct exact checks; secret/configuration values are never returned, absent/filtered keys remain unknown"
            }
        }))
    }

    pub(crate) async fn read_workload_revision_diff(
        &self,
        session: &Session,
        target: &Target,
    ) -> Result<Value, String> {
        let namespace = target
            .namespace
            .clone()
            .ok_or("Revision diff requires a namespaced workload")?;
        if !matches!(
            target.kind.as_str(),
            "Deployment" | "StatefulSet" | "DaemonSet"
        ) {
            return Err("Revision diff supports Deployment, StatefulSet and DaemonSet".into());
        }
        let parent = self
            .linked_read(
                session,
                "get_resource",
                json!({
                    "group": target.group,
                    "version": target.version,
                    "kind": target.kind,
                    "namespace": namespace,
                    "name": target.name,
                    "fields": ["metadata", "spec.selector"]
                }),
            )
            .await?;
        let parent_uid = parent["resource"]["metadata"]["uid"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Workload UID unavailable for revision diff")?
            .to_owned();
        let selector = diagnostic_selector(&parent["resource"]["spec"]["selector"])?;
        if target.kind == "Deployment" {
            let list = self
                .linked_read(
                    session,
                    "list_resources",
                    json!({
                        "group": "apps",
                        "version": "v1",
                        "kind": "ReplicaSet",
                        "namespace": namespace,
                        "labelSelector": selector,
                        "pageSize": 20,
                        "profile": "full"
                    }),
                )
                .await?;
            let mut owned: Vec<&Value> = list["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| {
                    item["metadata"]["ownerReferences"]
                        .as_array()
                        .is_some_and(|refs| {
                            refs.iter()
                                .any(|r| r["controller"] == true && r["uid"] == parent_uid)
                        })
                })
                .collect();
            owned.sort_by(|a, b| {
                let rev_a = a
                    .pointer("/metadata/annotations/deployment.kubernetes.io~1revision")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<u64>().ok());
                let rev_b = b
                    .pointer("/metadata/annotations/deployment.kubernetes.io~1revision")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<u64>().ok());
                match (rev_b, rev_a) {
                    (Some(rb), Some(ra)) => rb.cmp(&ra),
                    _ => b["metadata"]["creationTimestamp"]
                        .as_str()
                        .unwrap_or("")
                        .cmp(a["metadata"]["creationTimestamp"].as_str().unwrap_or("")),
                }
            });
            if owned.len() < 2 {
                return Ok(json!({
                    "kind": target.kind,
                    "namespace": namespace,
                    "name": target.name,
                    "revisionsObserved": owned.len(),
                    "diff": Value::Null,
                    "note": "Fewer than 2 owned ReplicaSet revisions observed; no revision diff available"
                }));
            }
            let current = owned[0];
            let previous = owned[1];
            let diff = crate::diagnostics::diff_pod_templates(
                &current["spec"]["template"]["spec"],
                &previous["spec"]["template"]["spec"],
            );
            return bounded_result(json!({
                "kind": "Deployment",
                "namespace": namespace,
                "name": target.name,
                "currentRevision": {
                    "name": current["metadata"]["name"],
                    "revision": current.pointer("/metadata/annotations/deployment.kubernetes.io~1revision"),
                    "creationTimestamp": current["metadata"]["creationTimestamp"]
                },
                "previousRevision": {
                    "name": previous["metadata"]["name"],
                    "revision": previous.pointer("/metadata/annotations/deployment.kubernetes.io~1revision"),
                    "creationTimestamp": previous["metadata"]["creationTimestamp"]
                },
                "diff": diff,
                "coverage": "Diff computed strictly over policy-projected ReplicaSet PodTemplates; omitted/redacted fields (e.g. command/args/env.value when workloadConfiguration is off) are excluded"
            }));
        }
        // StatefulSet / DaemonSet: ControllerRevisions
        let list = self
            .linked_read(
                session,
                "list_resources",
                json!({
                    "group": "apps",
                    "version": "v1",
                    "kind": "ControllerRevision",
                    "namespace": namespace,
                    "labelSelector": selector,
                    "pageSize": 20,
                    "profile": "full"
                }),
            )
            .await?;
        let mut owned: Vec<&Value> = list["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| {
                item["metadata"]["ownerReferences"]
                    .as_array()
                    .is_some_and(|refs| {
                        refs.iter()
                            .any(|r| r["controller"] == true && r["uid"] == parent_uid)
                    })
            })
            .collect();
        owned.sort_by(|a, b| {
            let rev_a = a["revision"].as_i64().unwrap_or(0);
            let rev_b = b["revision"].as_i64().unwrap_or(0);
            rev_b.cmp(&rev_a)
        });
        if owned.len() < 2 {
            return Ok(json!({
                "kind": target.kind,
                "namespace": namespace,
                "name": target.name,
                "revisionsObserved": owned.len(),
                "diff": Value::Null,
                "note": "Fewer than 2 owned ControllerRevisions observed; no revision diff available"
            }));
        }
        let current = owned[0];
        let previous = owned[1];
        let diff = crate::diagnostics::diff_pod_templates(
            &current["data"]["spec"]["template"]["spec"],
            &previous["data"]["spec"]["template"]["spec"],
        );
        bounded_result(json!({
            "kind": target.kind,
            "namespace": namespace,
            "name": target.name,
            "currentRevision": {
                "name": current["metadata"]["name"],
                "revision": current["revision"],
                "creationTimestamp": current["metadata"]["creationTimestamp"]
            },
            "previousRevision": {
                "name": previous["metadata"]["name"],
                "revision": previous["revision"],
                "creationTimestamp": previous["metadata"]["creationTimestamp"]
            },
            "diff": diff,
            "coverage": "Diff computed strictly over policy-projected ControllerRevision PodTemplates; omitted/redacted fields are excluded"
        }))
    }

    async fn execute_helm(
        &self,
        session: &Session,
        call: &ToolCall,
        client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Args {
            action: String,
            namespace: Option<String>,
            name: Option<String>,
            chart: Option<String>,
            version: Option<String>,
            values: Option<Value>,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid helm arguments")?;
        let state = session.control()?;
        if !state.policy.is_helm_active(&state.capabilities) {
            return Err("Helm operations are disabled by policy or not detected in cluster".into());
        }
        let namespace = args
            .namespace
            .or_else(|| session.working_scope.lock().ok()?.namespace.clone())
            .ok_or("Choose one namespace for Helm inspection")?;

        match args.action.as_str() {
            "list" => {
                if args.name.is_some()
                    || args.chart.is_some()
                    || args.version.is_some()
                    || args.values.is_some()
                {
                    return Err("helm action='list' only accepts optional namespace".into());
                }
                let target = Target {
                    group: "helm.sh".into(),
                    version: "v1".into(),
                    kind: "Release".into(),
                    namespace: Some(namespace.clone()),
                    name: "".into(),
                };
                state.policy.check_scope(&session.scope, &target)?;
                // Helm inventory needs only storage labels, never Secret bodies/chart values.
                let query = ResourceQuery {
                    context: session.scope.context.clone(),
                    group: "".into(),
                    version: "v1".into(),
                    kind: "Secret".into(),
                    namespace: Some(namespace.clone()),
                };
                let reader =
                    kubiki_core::core::access::ResourceAccess::new(client, &query, false).await?;
                let page = reader
                    .page(&ListParams::default().labels("owner=helm").limit(50), true)
                    .await
                    .map_err(query_list_error)?;
                let mut releases = std::collections::BTreeMap::<String, (u64, Value)>::new();
                for storage in page.items {
                    let labels = &storage["metadata"]["labels"];
                    let Some(name) = labels["name"].as_str() else {
                        continue;
                    };
                    let revision = labels["version"]
                        .as_str()
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0);
                    let actual = Target {
                        name: name.into(),
                        ..target.clone()
                    };
                    if state.policy.access(&actual, false) == DataAccess::None {
                        continue;
                    }
                    let value = json!({"apiVersion":"helm.sh/v1","kind":"Release","metadata":{"name":name,"namespace":namespace,"labels":{"storageRevision":labels["version"],"status":labels["status"]}}});
                    let projected = state.policy.project(&actual, &value, false)?;
                    if releases.get(name).is_none_or(|(old, _)| revision > *old) {
                        releases.insert(name.into(), (revision, projected));
                    }
                }
                let items: Vec<_> = releases.into_values().map(|(_, item)| item).collect();
                bounded_result(json!({
                    "action": "list",
                    "releases": items,
                    "count": items.len(),
                    "hasMore": page.continuation.is_some(),
                    "evidence": {
                        "context": session.scope.context,
                        "namespace": namespace,
                        "capturedAt": stamp(),
                        "completeness": "partial",
                        "coverage": "Policy-projected Release metadata from at most 50 Helm storage metadata entries; revision is highest observed in this page, not a complete history. No Secret bodies fetched."
                    }
                }))
            }
            "storage" => {
                if args.chart.is_some() || args.version.is_some() || args.values.is_some() {
                    return Err("helm action='storage' only accepts namespace and name".into());
                }
                let name = args
                    .name
                    .filter(|n| !n.is_empty())
                    .ok_or("Release name is required for helm action='storage'")?;
                let target = Target {
                    group: "helm.sh".into(),
                    version: "v1".into(),
                    kind: "Release".into(),
                    namespace: Some(namespace.clone()),
                    name: name.clone(),
                };
                validate_target(&target, true)?;
                state.policy.check_scope(&session.scope, &target)?;
                if state.policy.access(&target, false) == DataAccess::None {
                    return Err("Helm release access is denied by policy".into());
                }
                let query = ResourceQuery {
                    context: session.scope.context.clone(),
                    group: "".into(),
                    version: "v1".into(),
                    kind: "Secret".into(),
                    namespace: Some(namespace.clone()),
                };
                let reader =
                    kubiki_core::core::access::ResourceAccess::new(client, &query, false).await?;
                let selector = format!("owner=helm,name={name}");
                let page = reader
                    .page(&ListParams::default().labels(&selector).limit(50), true)
                    .await
                    .map_err(query_list_error)?;
                let mut revisions: Vec<(u64, Value)> = Vec::new();
                for storage in page.items {
                    let labels = &storage["metadata"]["labels"];
                    if labels["name"].as_str() != Some(name.as_str()) {
                        continue;
                    }
                    let rev = labels["version"]
                        .as_str()
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0);
                    let expected_secret = format!("sh.helm.release.v1.{name}.v{rev}");
                    if rev == 0 || storage["metadata"]["name"] != expected_secret {
                        continue;
                    }
                    let status = labels["status"].as_str().unwrap_or("unknown");
                    let value = json!({
                        "apiVersion": "helm.sh/v1",
                        "kind": "Release",
                        "metadata": {
                            "name": name,
                            "namespace": namespace,
                            "creationTimestamp": storage["metadata"]["creationTimestamp"],
                            "labels": {
                                "storageRevision": labels["version"],
                                "status": status
                            }
                        }
                    });
                    let projected = state.policy.project(&target, &value, false)?;
                    revisions.push((
                        rev,
                        json!({
                            "revision": rev,
                            "status": status,
                            "secretName": expected_secret,
                            "creationTimestamp": projected["metadata"]["creationTimestamp"],
                        }),
                    ));
                }
                revisions.sort_by(|a, b| b.0.cmp(&a.0));
                let has_pending = revisions.iter().any(|(_, r)| {
                    matches!(
                        r["status"].as_str(),
                        Some(
                            "pending-install"
                                | "pending-upgrade"
                                | "pending-rollback"
                                | "uninstalling"
                        )
                    )
                });
                let latest_failed_with_deployed = revisions
                    .first()
                    .is_some_and(|(_, r)| r["status"] == "failed")
                    && revisions.iter().skip(1).any(|(_, r)| r["status"] == "deployed");
                let has_conflict = has_pending || latest_failed_with_deployed;
                let conflict_summary = if has_pending {
                    Some("Release has pending/in-progress Helm storage revision (possible install/upgrade lock or interrupted operation)")
                } else if latest_failed_with_deployed {
                    Some("Latest Helm storage revision failed while an earlier deployed revision remains in storage")
                } else {
                    None
                };
                let latest = revisions.first().map(|(_, r)| r.clone());
                let rev_values: Vec<Value> = revisions.into_iter().map(|(_, r)| r).collect();
                bounded_result(json!({
                    "action": "storage",
                    "release": name,
                    "namespace": namespace,
                    "storagePresent": if !rev_values.is_empty() {
                        Some(true)
                    } else if page.continuation.is_none() {
                        Some(false)
                    } else {
                        None
                    },
                    "latest": latest,
                    "revisions": rev_values,
                    "hasConflict": has_conflict,
                    "conflictSummary": conflict_summary,
                    "hasMore": page.continuation.is_some(),
                    "evidence": {
                        "context": session.scope.context,
                        "capturedAt": stamp(),
                        "completeness": if page.continuation.is_some() { "partial" } else { "metadata_only" },
                        "coverage": "All observed sh.helm.release.v1.<name>.v* storage Secret metadata labels (up to 50); no Secret bodies fetched."
                    }
                }))
            }
            "values" => {
                if args.chart.is_some() || args.version.is_some() || args.values.is_some() {
                    return Err("helm action='values' only accepts namespace and name".into());
                }
                let name = args
                    .name
                    .filter(|n| !n.is_empty())
                    .ok_or("Release name is required for helm action='values'")?;
                let target = Target {
                    group: "helm.sh".into(),
                    version: "v1".into(),
                    kind: "Release".into(),
                    namespace: Some(namespace.clone()),
                    name: name.clone(),
                };
                validate_target(&target, true)?;
                state.policy.check_scope(&session.scope, &target)?;
                if !state.policy.helm_values {
                    return Err("Reading Helm release values is disabled by policy (enable helmValues to allow Helm release values; use helm action='storage' for metadata-only revision checks)".into());
                }
                if state.policy.access(&target, false) == DataAccess::None {
                    return Err("Helm release access is denied by policy".into());
                }
                let manager = self.pool.get_config_manager().clone();
                let reader = tokio::task::spawn_blocking(move || {
                    kubiki_core::helm::reader::HelmReader::default().with_config_manager(&manager)
                })
                .await
                .map_err(|_| "Cannot prepare Helm configuration")?
                .map_err(error_message)?
                .with_read_timeout(Duration::from_secs(20));
                self.ensure_connection(session).await?;
                let history = reader
                    .history(&session.scope.context, &namespace, &name)
                    .await
                    .map_err(error_message)?;
                let revision = history
                    .iter()
                    .map(|h| h.revision)
                    .max()
                    .filter(|r| *r > 0)
                    .ok_or("Helm release history has no revision")? as u32;
                self.ensure_connection(session).await?;
                let values = reader
                    .content(
                        &session.scope.context,
                        &namespace,
                        &name,
                        revision,
                        kubiki_core::helm::reader::HelmDocument::Values,
                    )
                    .await
                    .map_err(error_message)?;
                let values: Value = serde_yaml::from_str(&values)
                    .map_err(|_| "Cannot parse Helm values for policy projection")?;
                let value = json!({"apiVersion":"helm.sh/v1","kind":"Release","metadata":{"name":name,"namespace":namespace},"spec":{"values":values},"status":{"history":history}});
                let projected = state.policy.project(&target, &value, false)?;
                bounded_result(json!({
                    "action": "values",
                    "release": name,
                    "namespace": namespace,
                    "values": projected["spec"]["values"],
                    "history": projected["status"]["history"],
                    "evidence": {
                        "context": session.scope.context,
                        "revision": revision,
                        "capturedAt": stamp(),
                        "completeness": "partial",
                        "coverage": "Context-pinned, policy-projected Helm release values and history; sensitive keys and denied paths are scrubbed."
                    }
                }))
            }
            "preview" => {
                let name = args
                    .name
                    .filter(|n| !n.is_empty())
                    .ok_or("Release name is required for helm action='preview'")?;
                let chart = args
                    .chart
                    .filter(|c| !c.is_empty())
                    .ok_or("chart is required for helm action='preview'")?;
                let version = args
                    .version
                    .filter(|v| !v.is_empty())
                    .ok_or("version is required for helm action='preview'")?;
                let values = args.values.unwrap_or_else(|| json!({}));
                let release = Target {
                    group: "helm.sh".into(),
                    version: "v1".into(),
                    kind: "Release".into(),
                    namespace: Some(namespace.clone()),
                    name: name.clone(),
                };
                validate_target(&release, true)?;
                state.policy.check_scope(&session.scope, &release)?;
                if !state.policy.resources || state.policy.access(&release, false) == DataAccess::None {
                    return Err("Helm preview requires resource and Helm Release access".into());
                }
                let manager = self.pool.get_config_manager().clone();
                let read = async {
                    let reader = tokio::task::spawn_blocking(move || {
                        kubiki_core::helm::reader::HelmReader::default().with_config_manager(&manager)
                    })
                    .await
                    .map_err(|_| "Cannot prepare Helm configuration")?
                    .map_err(error_message)?
                    .with_read_timeout(Duration::from_secs(20));
                    let yaml = reader
                        .preview(&session.scope.context, &namespace, &name, &chart, &version, &values)
                        .await
                        .map_err(|_| "Helm render failed; check repository, version, values and Helm availability")?;
                    let mut items = Vec::new();
                    let mut omitted = 0;
                    for document in serde_yaml::Deserializer::from_str(&yaml) {
                        let value =
                            Value::deserialize(document).map_err(|_| "Invalid rendered manifest")?;
                        if value.is_null() {
                            continue;
                        }
                        let kind = value["kind"]
                            .as_str()
                            .ok_or("Rendered resource has no kind")?;
                        let Some(def) = kubiki_core::core::api::resource_type(kind) else {
                            omitted += 1;
                            continue;
                        };
                        let api = value["apiVersion"].as_str().unwrap_or("");
                        let (group, version) = api.split_once('/').unwrap_or(("", api));
                        if group != def.group || version != def.version || kind == "Secret" {
                            omitted += 1;
                            continue;
                        }
                        let target = Target {
                            group: group.into(),
                            version: version.into(),
                            kind: kind.into(),
                            namespace: def.namespaced.then(|| {
                                value["metadata"]["namespace"]
                                    .as_str()
                                    .unwrap_or(&namespace)
                                    .into()
                            }),
                            name: value["metadata"]["name"].as_str().unwrap_or("").into(),
                        };
                        if validate_target(&target, true).is_err()
                            || state.policy.check_scope(&session.scope, &target).is_err()
                            || state.policy.access(&target, true) == DataAccess::None
                        {
                            omitted += 1;
                            continue;
                        }
                        items.push(state.policy.project(&target, &value, true)?);
                    }
                    bounded_result(json!({
                        "action": "preview",
                        "items": items,
                        "omitted": omitted,
                        "source": "client-side Helm template"
                    }))
                };
                timed_read(
                    session,
                    "Helm preview cancelled",
                    "Helm preview timed out",
                    read,
                )
                .await
            }
            _ => Err("Unsupported helm action; choose list, storage, values or preview".into()),
        }
    }

    async fn execute_gitops(
        &self,
        session: &Session,
        call: &ToolCall,
        client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Args {
            provider: String,
            action: String,
            namespace: Option<String>,
            kind: Option<String>,
            name: Option<String>,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid gitops arguments")?;
        let state = session.control()?;
        let namespace = args
            .namespace
            .or_else(|| session.working_scope.lock().ok()?.namespace.clone())
            .ok_or("Choose one namespace (or '*' for list) for GitOps inspection")?;

        match (args.provider.as_str(), args.action.as_str()) {
            ("argocd", "list") => {
                if !state.policy.is_argocd_active(&state.capabilities) {
                    return Err("Argo CD operations are disabled by policy or not detected in cluster".into());
                }
                if args.name.is_some() {
                    return Err("gitops action='list' does not accept name".into());
                }
                let query = ToolCall {
                    id: call.id.clone(),
                    name: "list_resources".into(),
                    arguments: json!({
                        "group": "argoproj.io",
                        "version": "v1alpha1",
                        "kind": "Application",
                        "namespace": namespace,
                        "fields": [
                            "metadata.name",
                            "status.health.status",
                            "status.sync.status",
                            "spec.source.repoURL",
                            "spec.source.path",
                            "spec.destination.namespace"
                        ]
                    }),
                };
                let page = Box::pin(self.execute_inner(session, &query, &silent_events())).await?;
                let apps = page["items"]
                    .as_array()
                    .ok_or("Invalid Argo CD page")?
                    .iter()
                    .map(|item| {
                        json!({
                            "name": item["metadata"]["name"],
                            "namespace": item["metadata"]["namespace"],
                            "health": item["status"]["health"]["status"],
                            "sync": item["status"]["sync"]["status"],
                            "repoURL": item["spec"]["source"]["repoURL"],
                            "path": item["spec"]["source"]["path"],
                            "destinationNamespace": item["spec"]["destination"]["namespace"]
                        })
                    })
                    .collect::<Vec<_>>();
                bounded_result(json!({
                    "provider": "argocd",
                    "action": "list",
                    "applications": apps,
                    "count": apps.len(),
                    "hasMore": page["hasMore"],
                    "evidence": {
                        "capturedAt": page["capturedAt"],
                        "completeness": "partial",
                        "coverage": "Policy-projected bounded GitOps inspection; use generic list_resources for further pages"
                    }
                }))
            }
            ("argocd", "get") => {
                if !state.policy.is_argocd_active(&state.capabilities) {
                    return Err("Argo CD operations are disabled by policy or not detected in cluster".into());
                }
                let name = args
                    .name
                    .filter(|n| !n.is_empty())
                    .ok_or("Application name is required for gitops action='get'")?;
                let query = ToolCall {
                    id: call.id.clone(),
                    name: "get_resource".into(),
                    arguments: json!({
                        "group": "argoproj.io",
                        "version": "v1alpha1",
                        "kind": "Application",
                        "namespace": namespace,
                        "name": name,
                        "fields": [
                            "status.health",
                            "status.sync",
                            "status.operationState",
                            "spec.source",
                            "spec.destination",
                            "status.conditions",
                            "status.resources"
                        ]
                    }),
                };
                let page = Box::pin(self.execute_inner(session, &query, &silent_events())).await?;
                let item = &page["resource"];
                bounded_result(json!({
                    "provider": "argocd",
                    "action": "get",
                    "application": name,
                    "namespace": namespace,
                    "health": item["status"]["health"],
                    "sync": item["status"]["sync"],
                    "operationState": item["status"]["operationState"],
                    "source": item["spec"]["source"],
                    "destination": item["spec"]["destination"],
                    "conditions": item["status"]["conditions"],
                    "managedResources": item["status"]["resources"],
                    "fieldAccess": page["fieldAccess"],
                    "evidence": {
                        "capturedAt": page["capturedAt"],
                        "completeness": "partial",
                        "coverage": "Policy-projected GitOps resource; omitted fields are unknown"
                    }
                }))
            }
            ("flux", "list") => {
                if !state.policy.is_flux_active(&state.capabilities) {
                    return Err("Flux operations are disabled by policy or not detected in cluster".into());
                }
                if args.name.is_some() {
                    return Err("gitops action='list' does not accept name".into());
                }
                let kinds = match args.kind.as_deref() {
                    Some(
                        kind @ ("HelmRelease"
                        | "Kustomization"
                        | "GitRepository"
                        | "OCIRepository"
                        | "HelmRepository"
                        | "HelmChart"
                        | "Bucket"),
                    ) => vec![kind],
                    None => vec!["HelmRelease", "Kustomization", "GitRepository"],
                    _ => return Err("Unsupported Flux kind".into()),
                };
                let mut items = Vec::new();
                let mut unavailable = Vec::new();
                for kind in kinds {
                    let (group, version) = resolve_flux_gvk(&client, kind).await?;
                    let query = ToolCall {
                        id: call.id.clone(),
                        name: "list_resources".into(),
                        arguments: json!({
                            "group": group,
                            "version": version,
                            "kind": kind,
                            "namespace": namespace,
                            "fields": [
                                "metadata.name",
                                "spec.suspend",
                                "status.conditions",
                                "status.lastAppliedRevision",
                                "status.lastAttemptedRevision",
                                "status.artifact"
                            ]
                        }),
                    };
                    match Box::pin(self.execute_inner(session, &query, &silent_events())).await {
                        Ok(page) => {
                            if page["hasMore"] == true {
                                unavailable.push(format!("{kind}: additional pages"));
                            }
                            if page["fieldAccess"]["denied"]
                                .as_array()
                                .is_some_and(|fields| {
                                    fields.iter().any(|field| field == "status.conditions")
                                })
                            {
                                unavailable
                                    .push(format!("{kind}: status.conditions denied by policy"));
                            }
                            for item in page["items"].as_array().ok_or("Invalid Flux page")? {
                                let ready = item["status"]["conditions"]
                                    .as_array()
                                    .and_then(|cs| cs.iter().find(|c| c["type"] == "Ready"));
                                items.push(json!({
                                    "kind": kind,
                                    "apiVersion": format!("{group}/{version}"),
                                    "name": item["metadata"]["name"],
                                    "namespace": item["metadata"]["namespace"],
                                    "conditions": item["status"]["conditions"],
                                    "ready": ready.map(|c| &c["status"]),
                                    "message": ready.map(|c| &c["message"]),
                                    "suspended": item["spec"]["suspend"],
                                    "lastAppliedRevision": item["status"]["lastAppliedRevision"],
                                    "lastAttemptedRevision": item["status"]["lastAttemptedRevision"],
                                    "artifact": item["status"]["artifact"]
                                }));
                            }
                        }
                        Err(_) => unavailable.push(format!("{kind}: unavailable or denied")),
                    }
                }
                bounded_result(json!({
                    "provider": "flux",
                    "action": "list",
                    "resources": items,
                    "count": items.len(),
                    "unavailable": unavailable,
                    "evidence": {
                        "capturedAt": stamp(),
                        "completeness": "partial",
                        "coverage": "Bounded policy-projected Flux inspection; unavailable is not an empty healthy result"
                    }
                }))
            }
            ("flux", "get") => {
                if !state.policy.is_flux_active(&state.capabilities) {
                    return Err("Flux operations are disabled by policy or not detected in cluster".into());
                }
                let kind = args
                    .kind
                    .filter(|k| !k.is_empty())
                    .ok_or("Flux kind is required for gitops action='get'")?;
                let name = args
                    .name
                    .filter(|n| !n.is_empty())
                    .ok_or("Resource name is required for gitops action='get'")?;
                let (group, version) = resolve_flux_gvk(&client, &kind).await?;
                let query = ToolCall {
                    id: call.id.clone(),
                    name: "get_resource".into(),
                    arguments: json!({
                        "group": group,
                        "version": version,
                        "kind": kind,
                        "namespace": namespace,
                        "name": name,
                        "fields": [
                            "spec.suspend",
                            "spec.sourceRef",
                            "status.conditions",
                            "status.lastAppliedRevision",
                            "status.lastAttemptedRevision",
                            "status.inventory",
                            "status.artifact",
                            "spec.dependsOn",
                            "spec.path",
                            "status.failures",
                            "status.installFailures",
                            "status.upgradeFailures",
                            "status.lastHandledReconcileAt",
                            "status.lastHandledResetAt"
                        ]
                    }),
                };
                let page = Box::pin(self.execute_inner(session, &query, &silent_events())).await?;
                let item = &page["resource"];
                bounded_result(json!({
                    "provider": "flux",
                    "action": "get",
                    "kind": kind,
                    "apiVersion": format!("{group}/{version}"),
                    "name": name,
                    "namespace": namespace,
                    "suspended": item["spec"]["suspend"],
                    "sourceRef": item["spec"]["sourceRef"],
                    "conditions": item["status"]["conditions"],
                    "lastAppliedRevision": item["status"]["lastAppliedRevision"],
                    "lastAttemptedRevision": item["status"]["lastAttemptedRevision"],
                    "inventory": item["status"]["inventory"],
                    "artifact": item["status"]["artifact"],
                    "dependsOn": item["spec"]["dependsOn"],
                    "path": item["spec"]["path"],
                    "failures": item["status"]["failures"],
                    "installFailures": item["status"]["installFailures"],
                    "upgradeFailures": item["status"]["upgradeFailures"],
                    "lastHandledReconcileAt": item["status"]["lastHandledReconcileAt"],
                    "lastHandledResetAt": item["status"]["lastHandledResetAt"],
                    "fieldAccess": page["fieldAccess"],
                    "evidence": {
                        "capturedAt": page["capturedAt"],
                        "completeness": "partial",
                        "coverage": "Policy-projected GitOps resource; omitted fields are unknown"
                    }
                }))
            }
            _ => Err("Unsupported gitops provider/action; provider must be argocd or flux, action must be list or get".into()),
        }
    }

    pub async fn review_plan_call(
        &self,
        session: &Session,
        mut call: ToolCall,
    ) -> Result<(ToolCall, Target, WriteOperation), String> {
        self.ensure_connection(session).await?;
        let state = session.control()?;
        if state.mode == AgentMode::ReadOnly || state.phase != AgentPhase::Action {
            return Err("Review for execution requires Ask/Accept and Action".into());
        }
        let (target, _, requested, _) =
            parse_mutation(&state.policy, &session.scope, state.mode, &call)?;
        let reader = resource_access(
            self.client
                .clone()
                .ok_or("Cluster connection unavailable")?,
            &target,
        )
        .await?;
        let before = match reader.get(&target.name, true).await {
            Ok(value) => Some(value),
            Err(kube::Error::Api(e)) if e.code == 404 => None,
            Err(_) => return Err("Cannot inspect target identity for plan review".into()),
        };
        let op = requested.unwrap_or(if before.is_some() {
            WriteOperation::Update
        } else {
            WriteOperation::Create
        });
        state
            .policy
            .check_write(state.mode, &session.scope, &target, op)?;
        if let Some(before) = before {
            let uid = before["metadata"]["uid"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Missing target UID")?;
            let version = before["metadata"]["resourceVersion"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Missing resource version")?;
            if call.arguments["expectedUid"]
                .as_str()
                .is_some_and(|expected| expected != uid)
            {
                return Err("Planned target was recreated; refresh investigation and plan".into());
            }
            call.arguments["expectedUid"] = json!(uid);
            call.arguments["expectedResourceVersion"] = json!(version);
        } else {
            if op != WriteOperation::Create {
                return Err("Planned target no longer exists".into());
            }
            call.arguments["expectedAbsent"] = json!(true);
        }
        Ok((call, target, op))
    }

    async fn mutate(
        &self,
        session: &Session,
        call: &ToolCall,
        client: Client,
        emit: &EventSink,
    ) -> Result<Value, String> {
        let state = session.control()?;
        if state.phase != AgentPhase::Action || state.mode == AgentMode::ReadOnly {
            return Err("Kubernetes modifications are strictly prohibited during the Plan phase or in Read only mode".into());
        }
        let (target, yaml, requested_op, replicas) =
            parse_mutation(&state.policy, &session.scope, state.mode, call)?;
        let resource = reference(&session.scope.context, &target, None);
        let _gate = self.consent.acquire(&resource)?;
        let reader = tokio::time::timeout(
            Duration::from_secs(15),
            resource_access(client.clone(), &target),
        )
        .await
        .map_err(|_| "API discovery timed out")??;
        let before =
            tokio::time::timeout(Duration::from_secs(15), reader.get_optional(&target.name))
                .await
                .map_err(|_| "Mutation preparation timed out")?
                .map_err(|_| "Cannot read target for mutation preparation")?;
        if call.arguments["expectedAbsent"] == true && before.is_some() {
            return Err("A resource appeared after plan review; nothing was overwritten".into());
        }
        if let Some(uid) = call.arguments["expectedUid"].as_str() {
            if before.as_ref().and_then(|o| o.metadata.uid.as_deref()) != Some(uid) {
                return Err("Resource was replaced after plan review; review again".into());
            }
        }
        if let Some(version) = call.arguments["expectedResourceVersion"].as_str() {
            if before
                .as_ref()
                .and_then(|o| o.metadata.resource_version.as_deref())
                != Some(version)
            {
                return Err("Resource changed after plan review; review again".into());
            }
        }
        let op = requested_op.unwrap_or(if before.is_some() {
            WriteOperation::Update
        } else {
            WriteOperation::Create
        });
        state
            .policy
            .check_write(state.mode, &session.scope, &target, op)?;
        let pinned = reference(
            &session.scope.context,
            &target,
            before.as_ref().and_then(|o| o.metadata.uid.clone()),
        );
        let version = before
            .as_ref()
            .and_then(|o| o.metadata.resource_version.clone())
            .unwrap_or_default();
        let intent = if let Some(manifest) = yaml {
            MutationIntent::Manifest {
                context: session.scope.context.clone(),
                manifest,
                target: before.as_ref().map(|_| ManifestTarget {
                    resource: pinned.clone(),
                    resource_version: version.clone(),
                }),
            }
        } else {
            match op {
                WriteOperation::Scale => MutationIntent::Scale {
                    resource: pinned.clone(),
                    resource_version: version,
                    replicas: replicas.unwrap() as i32,
                },
                WriteOperation::Restart => MutationIntent::Action {
                    resource: pinned.clone(),
                    resource_version: version,
                    action: ResourceAction::Restart,
                },
                WriteOperation::Delete => MutationIntent::Delete {
                    resource: pinned.clone(),
                    resource_version: version,
                },
                _ => return Err("Unsupported AI mutation".into()),
            }
        };
        let prepared = PreparedMutation::prepare(client, intent)
            .await
            .map_err(error_message)?;
        if state.policy.requires_confirmation(state.mode, &call.name) {
            emit(AgentEvent::Status {
                status: "awaiting_approval".into(),
            });
            let mut cancellation = session.cancellation();
            let started = tokio::time::Instant::now();
            let approval = tokio::select! {
                biased;
                _=cancelled(&mut cancellation)=>Err("Change cancelled before dispatch".to_owned()),
                result=self.consent.confirm(&pinned,prepared.review().into(),Some(prepared.details()))=>result,
            };
            let waited = started.elapsed();
            self.budget.exclude_approval_wait(waited);
            session.exclude_approval_wait(waited);
            let approved = approval?;
            if !approved {
                return Err("User declined the change. Nothing was changed".into());
            }
        }
        session.authorize_dispatch(state.revision, &target, op)?;
        emit(AgentEvent::Status {
            status: "executing".into(),
        });
        let operation_id = format!("{}-{}-{}", session.id, stamp(), call.id);
        self.journal(json!({"id":operation_id,"session":session.id,"target":target,"operation":op,"mode":state.mode,"status":"dispatching","at":stamp()})).await?;
        // Check again after the journal await. From here this is an in-flight
        // operation and must finish with a receipt, even when Stop is pressed.
        session.authorize_dispatch(state.revision, &target, op)?;
        let outcome = prepared
            .commit_guarded(|| {
                session
                    .authorize_dispatch(state.revision, &target, op)
                    .map_err(|message| kubiki_core::core::mutations::cancelled(&pinned, &message))
            })
            .await;
        let status = match &outcome {
            Ok(_) => "accepted",
            Err(_)
                if self
                    .write_rejected
                    .load(std::sync::atomic::Ordering::SeqCst) =>
            {
                "cancelled"
            }
            Err(e) if e.code == kubiki_core::core::api::ApiErrorCode::Cancelled => "cancelled",
            Err(e) if e.status.is_some_and(|s| s >= 500) => "uncertain",
            Err(_) => "failed",
        };
        let audit = self
            .journal(json!({"id":operation_id,"status":status,"at":stamp()}))
            .await;
        emit(AgentEvent::Status {
            status: "running".into(),
        });
        if audit.is_err() {
            return Ok(
                json!({"operationId":operation_id,"status":"uncertain","target":target,"warning":"The request was dispatched but its durable receipt could not be recorded. Inspect current state; do not retry automatically"}),
            );
        }
        match outcome {
            Ok(object) => {
                if let Some(operation) =
                    AcceptedOperation::new(operation_id.clone(), call, target.clone(), &object)
                {
                    self.accepted_operations
                        .lock()
                        .map_err(|_| "Accepted operation registry unavailable")?
                        .save(operation);
                }
                Ok(
                    json!({"operationId":operation_id,"status":"accepted","target":target,"uid":object["metadata"]["uid"],"generation":object["metadata"]["generation"],"message":"Kubernetes API accepted the change. Verify this operationId; API acceptance does not establish rollout completion or application health"}),
                )
            }
            Err(error) => Ok(
                json!({"operationId":operation_id,"status":status,"target":target,"error":if status=="cancelled" {"Change cancelled before HTTP dispatch".to_owned()}else{error_message(error)},"retry":false}),
            ),
        }
    }

    async fn journal(&self, record: Value) -> Result<(), String> {
        let path = self.journal.clone();
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|_| "Cannot create AI operation journal")?;
            }
            let mut options = std::fs::OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(path)
                .map_err(|_| "Cannot open AI operation journal")?;
            let line = record.to_string() + "\n";
            file.write_all(line.as_bytes())
                .and_then(|_| file.sync_data())
                .map_err(|_| "Cannot persist AI operation journal")
        })
        .await
        .map_err(|_| "AI journal task failed")?
        .map_err(str::to_owned)
    }
}

async fn timed_read<T, F>(
    session: &Session,
    cancelled_message: &str,
    timeout_message: &str,
    future: F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let mut cancellation = session.cancellation();
    tokio::select! {
        biased;
        _ = cancelled(&mut cancellation) => Err(cancelled_message.into()),
        result = tokio::time::timeout(Duration::from_secs(20), future) => {
            result.map_err(|_| timeout_message.to_string())?
        }
    }
}

fn reference(context: &str, target: &Target, uid: Option<String>) -> ResourceRef {
    ResourceRef {
        query: ResourceQuery {
            context: context.into(),
            group: target.group.clone(),
            version: target.version.clone(),
            kind: target.kind.clone(),
            namespace: target.namespace.clone(),
        },
        name: target.name.clone(),
        uid,
    }
}

fn reject_privileged_manifest(value: &Value) -> Result<(), String> {
    fn visit(value: &Value) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(k, v)| {
                ([
                    "hostNetwork",
                    "hostPID",
                    "hostIPC",
                    "shareProcessNamespace",
                    "privileged",
                    "allowPrivilegeEscalation",
                ]
                .contains(&k.as_str())
                    && v == true)
                    || (k == "automountServiceAccountToken" && v != false)
                    || (k == "runAsUser" && v.as_i64() == Some(0))
                    || (k == "procMount" && v.as_str() != Some("Default"))
                    || (k == "seccompProfile"
                        && v.get("type").and_then(Value::as_str) == Some("Unconfined"))
                    || [
                        "hostPath",
                        "nodeName",
                        "capabilities",
                        "hostPort",
                        "serviceAccountName",
                        "serviceAccount",
                        "serviceAccountToken",
                        "csi",
                    ]
                    .contains(&k.as_str())
                    || visit(v)
            }),
            Value::Array(items) => items.iter().any(visit),
            _ => false,
        }
    }
    if visit(value) {
        return Err("This manifest requests host, service-account or elevated container capabilities outside the AI write surface. Review it manually in the YAML editor".into());
    }
    Ok(())
}

fn check_manifest_data_access(
    value: &Value,
    policy: &AgentPolicy,
    scope: &AgentScope,
    target: &Target,
) -> Result<(), String> {
    let check = |kind: &str, name: Option<&str>| -> Result<(), String> {
        let referenced = Target {
            group: String::new(),
            version: "v1".into(),
            kind: kind.into(),
            namespace: target.namespace.clone(),
            name: name
                .filter(|name| !name.is_empty())
                .ok_or("A referenced Secret/ConfigMap must have a name")?
                .into(),
        };
        policy.check_scope(scope, &referenced)?;
        if policy.access(&referenced, true) != DataAccess::Content {
            return Err("This workload would consume Secret/ConfigMap contents that the AI policy does not permit. Grant an exact content-access rule or review the manifest manually".into());
        }
        Ok(())
    };
    if target.kind == "Ingress" {
        if let Some(tls_entries) = value.pointer("/spec/tls").and_then(Value::as_array) {
            for entry in tls_entries {
                if let Some(secret_name) = entry.get("secretName").and_then(Value::as_str) {
                    if !secret_name.is_empty() {
                        check("Secret", Some(secret_name))?;
                    }
                }
            }
        }
    }
    if value.pointer("/spec/template/spec").is_some()
        && value.pointer("/spec/template/spec/automountServiceAccountToken")
            != Some(&Value::Bool(false))
    {
        return Err("AI workload manifests must explicitly set spec.template.spec.automountServiceAccountToken: false".into());
    }
    let Some(spec) = value.pointer("/spec/template/spec") else {
        return Ok(());
    };
    // Use Kubernetes' schema: SecretVolumeSource uses secretName, while
    // SecretProjection uses name. Unknown fields must never select the grant.
    let pod: k8s_openapi::api::core::v1::PodSpec = serde_json::from_value(spec.clone())
        .map_err(|_| "Invalid workload Pod spec")?;
    for pull_secret in pod.image_pull_secrets.iter().flatten() {
        check("Secret", Some(&pull_secret.name))?;
    }
    for volume in pod.volumes.iter().flatten() {
        if let Some(secret) = &volume.secret {
            check("Secret", secret.secret_name.as_deref())?;
        }
        if let Some(config) = &volume.config_map {
            check("ConfigMap", Some(&config.name))?;
        }
        if let Some(af) = &volume.azure_file {
            check("Secret", Some(&af.secret_name))?;
        }
        if let Some(ceph) = &volume.cephfs {
            if let Some(sr) = &ceph.secret_ref {
                check("Secret", Some(&sr.name))?;
            }
        }
        if let Some(flex) = &volume.flex_volume {
            if let Some(sr) = &flex.secret_ref {
                check("Secret", Some(&sr.name))?;
            }
        }
        if let Some(iscsi) = &volume.iscsi {
            if let Some(sr) = &iscsi.secret_ref {
                check("Secret", Some(&sr.name))?;
            }
        }
        if let Some(rbd) = &volume.rbd {
            if let Some(sr) = &rbd.secret_ref {
                check("Secret", Some(&sr.name))?;
            }
        }
        if let Some(sio) = &volume.scale_io {
            check("Secret", Some(&sio.secret_ref.name))?;
        }
        if let Some(sos) = &volume.storageos {
            if let Some(sr) = &sos.secret_ref {
                check("Secret", Some(&sr.name))?;
            }
        }
        for source in volume.projected.iter().flat_map(|p| p.sources.iter().flatten()) {
            if let Some(secret) = &source.secret {
                check("Secret", Some(&secret.name))?;
            }
            if let Some(config) = &source.config_map {
                check("ConfigMap", Some(&config.name))?;
            }
        }
    }
    for container in pod.containers.iter().chain(pod.init_containers.iter().flatten()) {
        for env in container.env.iter().flatten() {
            if let Some(source) = &env.value_from {
                if let Some(secret) = &source.secret_key_ref {
                    check("Secret", Some(&secret.name))?;
                }
                if let Some(config) = &source.config_map_key_ref {
                    check("ConfigMap", Some(&config.name))?;
                }
            }
        }
        for source in container.env_from.iter().flatten() {
            if let Some(secret) = &source.secret_ref {
                check("Secret", Some(&secret.name))?;
            }
            if let Some(config) = &source.config_map_ref {
                check("ConfigMap", Some(&config.name))?;
            }
        }
    }
    for container in pod.ephemeral_containers.iter().flatten() {
        for env in container.env.iter().flatten() {
            if let Some(source) = &env.value_from {
                if let Some(secret) = &source.secret_key_ref {
                    check("Secret", Some(&secret.name))?;
                }
                if let Some(config) = &source.config_map_key_ref {
                    check("ConfigMap", Some(&config.name))?;
                }
            }
        }
        for source in container.env_from.iter().flatten() {
            if let Some(secret) = &source.secret_ref {
                check("Secret", Some(&secret.name))?;
            }
            if let Some(config) = &source.config_map_ref {
                check("ConfigMap", Some(&config.name))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn linked_diagnostic_pages_never_get_denied_bodies_or_leak_excluded_event_messages() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let body_reads = Arc::new(AtomicUsize::new(0));
        let seen = body_reads.clone();
        let client = Client::new(
            tower::service_fn(move |request: http::Request<kube::client::Body>| {
                let seen = seen.clone();
                async move {
                    let metadata = request
                        .headers()
                        .get("accept")
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|v| v.contains("PartialObjectMetadata"));
                    if !metadata {
                        seen.fetch_add(1, Ordering::SeqCst);
                    }
                    let value = if metadata {
                        json!({"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadataList","metadata":{},"items":[{"metadata":{"name":"event","namespace":"apps","uid":"event-uid"}}]})
                    } else {
                        json!({"apiVersion":"v1","kind":"EventList","metadata":{},"items":[{"apiVersion":"v1","kind":"Event","metadata":{"name":"event","namespace":"apps","uid":"event-uid"},"reason":"ProvisioningFailed","message":"private-admission-message"}]})
                    };
                    Ok::<_, std::convert::Infallible>(
                        http::Response::builder()
                            .header("content-type", "application/json")
                            .body(kube::client::Body::from(
                                serde_json::to_vec(&value).unwrap(),
                            ))
                            .unwrap(),
                    )
                }
            }),
            "apps",
        );
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "Event".into(),
            namespace: Some("apps".into()),
            name: "".into(),
        };
        let scope = AgentScope {
            context: "prod".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        };
        let reader = resource_access(client.clone(), &target).await.unwrap();
        let policy = AgentPolicy {
            rules: vec![ResourceRule {
                group: "".into(),
                kind: "Event".into(),
                namespace: "apps".into(),
                name: "*".into(),
                read: DataAccess::None,
                writes: vec![],
            }],
            ..Default::default()
        };
        let page = projected_page(
            &client,
            &reader,
            &policy,
            &scope,
            &target,
            &ListParams::default().limit(20),
            false,
        )
        .await
        .unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.omitted, 1);
        assert_eq!(body_reads.load(Ordering::SeqCst), 0);
        let policy = AgentPolicy {
            denied_paths: vec!["/message".into()],
            ..Default::default()
        };
        let page = projected_page(
            &client,
            &reader,
            &policy,
            &scope,
            &target,
            &ListParams::default().limit(20),
            false,
        )
        .await
        .unwrap();
        let diag = pvc_diagnostics(
            &json!({"status":{"phase":"Pending"}}),
            None,
            Some(&page.items),
        );
        assert!(!diag.to_string().contains("private-admission-message"));
    }

    #[test]
    fn ownership_queries_respect_excluded_relation_fields() {
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: Some("apps".into()),
            name: "web".into(),
        };
        let metadata:kube::core::ObjectMeta=serde_json::from_value(json!({"name":"web","ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"owner","uid":"owner-id","controller":true}]})).unwrap();
        assert!(permitted_owner(
            &AgentPolicy::default(),
            &target,
            &metadata,
            &["owner-id".into()]
        ));
        let policy = AgentPolicy {
            denied_paths: vec!["/metadata/ownerReferences".into()],
            ..AgentPolicy::default()
        };
        assert!(!permitted_owner(
            &policy,
            &target,
            &metadata,
            &["owner-id".into()]
        ));
    }

    #[test]
    fn query_filters_cannot_infer_excluded_fields() {
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: Some("apps".into()),
            name: "".into(),
        };
        let policy = AgentPolicy {
            denied_paths: vec!["/status/phase".into(), "/metadata/labels/private".into()],
            ..AgentPolicy::default()
        };
        assert!(validate_query_filters(&policy, &target, true, Some("app=web"), None).is_err());
        assert!(
            validate_query_filters(&policy, &target, true, None, Some("status.phase=Running"))
                .is_err()
        );
        assert!(
            validate_query_filters(
                &AgentPolicy::default(),
                &target,
                true,
                Some("app=web"),
                Some("status.phase=Pending")
            )
            .is_ok()
        );
        assert!(
            validate_query_filters(
                &AgentPolicy::default(),
                &target,
                true,
                Some("password=secret"),
                None
            )
            .is_err()
        );
        let crd = Target { group:"helm.toolkit.fluxcd.io".into(),version:"v2".into(),kind:"HelmRelease".into(), ..target.clone() };
        assert!(validate_query_filters(&AgentPolicy::default(), &crd, false, None, Some("spec.values.private=guess")).is_err());
        assert!(validate_query_filters(&AgentPolicy::default(), &crd, false, None, Some("metadata.name=web")).is_ok());
    }

    #[test]
    fn byte_truncation_is_explicitly_partial_even_without_an_api_next_page() {
        let result =
            bounded_result(json!({"items":[{"value":"x".repeat(64001)}],"hasMore":false})).unwrap();
        assert_eq!(result["completeness"], "partial");
        assert_eq!(result["hasMore"], true);
        assert_eq!(result["truncated"], true);
    }

    #[test]
    fn diagnostic_projection_does_not_expose_denied_status_or_configuration() {
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: Some("apps".into()),
            name: "web".into(),
        };
        let policy = AgentPolicy {
            denied_paths: vec!["/status/containerStatuses".into(), "/metadata/uid".into()],
            ..AgentPolicy::default()
        };
        let object: DynamicObject = serde_json::from_value(json!({
            "apiVersion":"v1", "kind":"Pod", "metadata":{"name":"web","uid":"hidden"},
            "spec":{"containers":[{"name":"app","env":[{"name":"PASSWORD","value":"secret"}],"command":["sensitive"]}]},
            "status":{"phase":"Running","containerStatuses":[{"name":"app","state":{"terminated":{"message":"private"}}}]}
        })).unwrap();
        let projected = diagnostic_projection(&policy, &target, &object).unwrap();
        assert!(projected.pointer("/metadata/uid").is_none());
        assert!(projected.pointer("/status/containerStatuses").is_none());
        assert!(projected.pointer("/spec/containers/0/command").is_none());
        assert!(
            projected
                .pointer("/spec/containers/0/env/0/value")
                .is_none()
        );
        assert_eq!(projected["status"]["phase"], "Running");
        let secret = Target {
            kind: "Secret".into(),
            ..target
        };
        assert!(diagnostic_projection(&policy, &secret, &object).is_err());
    }

    #[test]
    fn agent_templates_cannot_request_host_or_service_account_capabilities() {
        for spec in [
            json!({"hostNetwork":true}),
            json!({"hostPID":true}),
            json!({"shareProcessNamespace":true}),
            json!({"containers":[{"securityContext":{"privileged":true}}]}),
            json!({"containers":[{"securityContext":{"runAsUser":0}}]}),
            json!({"containers":[{"securityContext":{"procMount":"Unmasked"}}]}),
            json!({"containers":[{"securityContext":{"seccompProfile":{"type":"Unconfined"}}}]}),
            json!({"containers":[{"ports":[{"hostPort":8080}]}]}),
            json!({"volumes":[{"hostPath":{"path":"/"}}]}),
            json!({"serviceAccountName":"admin"}),
            json!({"serviceAccount":"admin"}),
            json!({"automountServiceAccountToken":true}),
        ] {
            assert!(
                reject_privileged_manifest(&json!({"spec":{"template":{"spec":spec}}})).is_err()
            );
        }
        assert!(reject_privileged_manifest(&json!({"spec":{"template":{"spec":{"automountServiceAccountToken":false,"containers":[{"name":"app","image":"example:1","securityContext":{"allowPrivilegeEscalation":false,"runAsUser":1000,"procMount":"Default","seccompProfile":{"type":"RuntimeDefault"}}}]}}}})).is_ok());
    }

    #[test]
    fn resource_identities_cannot_escape_kubernetes_paths() {
        let mut target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: Some("apps".into()),
            name: "web".into(),
        };
        assert!(validate_target(&target, true).is_ok());
        for name in [".", "..", "../secrets", "web?watch=true", "web\nsecret", ""] {
            target.name = name.into();
            assert!(validate_target(&target, true).is_err());
        }
        target.name = "web".into();
        target.namespace = Some("../other".into());
        assert!(validate_target(&target, true).is_err());
        assert!(serde_json::from_value::<ResourceArgs>(json!({"group":"","version":"v1","kind":"Pod","namespace":"apps","name":"web","approved":true})).is_err());
    }

    #[test]
    fn workload_writes_cannot_bypass_secret_and_config_read_permissions() {
        let policy = AgentPolicy::default();
        let scope = AgentScope {
            context: "prod".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        };
        let target = Target {
            group: "apps".into(),
            version: "v1".into(),
            kind: "Deployment".into(),
            namespace: Some("apps".into()),
            name: "web".into(),
        };
        let mut manifest = json!({"spec":{"template":{"spec":{"automountServiceAccountToken":false,"containers":[{"name":"app","envFrom":[{"secretRef":{"name":"creds"}}]}]}}}});
        assert!(check_manifest_data_access(&manifest, &policy, &scope, &target).is_err());
        let policy = AgentPolicy {
            secrets: DataAccess::Content,
            ..policy
        };
        assert!(check_manifest_data_access(&manifest, &policy, &scope, &target).is_ok());
        manifest["spec"]["template"]["spec"]["automountServiceAccountToken"] = Value::Null;
        assert!(check_manifest_data_access(&manifest, &policy, &scope, &target).is_err());
    }

    #[test]
    fn workload_references_check_schema_fields_even_when_unknown_fields_spoof_a_grant() {
        let scope = AgentScope { context: "prod".into(), namespaces: vec!["apps".into()], all_namespaces: false };
        let target = Target { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), namespace: Some("apps".into()), name: "web".into() };
        // secrets: None is a hard ceiling; per-Secret exceptions require secrets >= Metadata + rules.
        let hard_denied = AgentPolicy {
            secrets: DataAccess::None,
            rules: vec![ResourceRule { group: "".into(), kind: "Secret".into(), namespace: "apps".into(), name: "allowed".into(), read: DataAccess::Content, writes: vec![] }],
            ..Default::default()
        };
        let manifest = |volume: Value| json!({"spec":{"template":{"spec":{"automountServiceAccountToken":false,"containers":[{"name":"app"}],"volumes":[volume]}}}});
        assert!(check_manifest_data_access(&manifest(json!({"name":"data","secret":{"secretName":"allowed"}})), &hard_denied, &scope, &target).is_err());

        let policy = AgentPolicy {
            secrets: DataAccess::Metadata,
            rules: vec![
                ResourceRule { group: "".into(), kind: "Secret".into(), namespace: "apps".into(), name: "allowed".into(), read: DataAccess::Content, writes: vec![] },
                ResourceRule { group: "".into(), kind: "Secret".into(), namespace: "*".into(), name: "*".into(), read: DataAccess::None, writes: vec![] },
            ],
            ..Default::default()
        };
        for volume in [
            json!({"name":"data","secret":{"secretName":"allowed"}}),
            json!({"name":"data","projected":{"sources":[{"secret":{"name":"allowed"}}]}}),
        ] {
            assert!(check_manifest_data_access(&manifest(volume), &policy, &scope, &target).is_ok());
        }
        for volume in [
            json!({"name":"data","secret":{"secretName":"denied","name":"allowed"}}),
            json!({"name":"data","projected":{"sources":[{"secret":{"name":"denied","secretName":"allowed"}}]}}),
            json!({"name":"data","projected":{"sources":[{"secret":{"secretName":"allowed"}}]}}),
            json!({"name":"data","projected":{"sources":[{"configMap":{"name":"denied"}}]}}),
        ] {
            assert!(check_manifest_data_access(&manifest(volume), &policy, &scope, &target).is_err());
        }
        // imagePullSecrets and Ingress TLS secretName must also be authorized.
        let pull_manifest = json!({"spec":{"template":{"spec":{"automountServiceAccountToken":false,"imagePullSecrets":[{"name":"denied"}],"containers":[{"name":"app"}]}}}});
        assert!(check_manifest_data_access(&pull_manifest, &policy, &scope, &target).is_err());
        let ingress_target = Target { group: "networking.k8s.io".into(), version: "v1".into(), kind: "Ingress".into(), namespace: Some("apps".into()), name: "web".into() };
        let ingress_manifest = json!({"spec":{"tls":[{"secretName":"denied"}]}});
        assert!(check_manifest_data_access(&ingress_manifest, &policy, &scope, &ingress_target).is_err());
        let ingress_allowed = json!({"spec":{"tls":[{"secretName":"allowed"}]}});
        assert!(check_manifest_data_access(&ingress_allowed, &policy, &scope, &ingress_target).is_ok());

        let full = AgentPolicy { secrets: DataAccess::Content, config_maps: DataAccess::Content, ..Default::default() };
        assert!(check_manifest_data_access(&manifest(json!({"name":"data","projected":{"sources":[{"secret":{"name":"creds"}},{"configMap":{"name":"config"}}]}})), &full, &scope, &target).is_ok());
        // Arbitrary ConfigMap payload keys are data, not workload references.
        assert!(check_manifest_data_access(&json!({"data":{"secret":"text","configMap":{"text":"value"}}}), &policy, &scope, &target).is_ok());
    }
}

impl KubernetesTools {
    /// Each invocation/run gets fresh budgets while the connection pool remains shared.
    pub fn scoped(
        session: &Session,
        pool: kubiki_core::cluster::client::ClusterClientPool,
        client: Option<Client>,
        generation: Option<u64>,
        consent: std::sync::Arc<dyn Consent>,
        journal: PathBuf,
        read_permits: std::sync::Arc<tokio::sync::Semaphore>,
    ) -> Result<Self, String> {
        Self::scoped_with_cache(
            session,
            pool,
            client,
            generation,
            consent,
            journal,
            read_permits,
            std::sync::Arc::new(kubiki_core::core::read_cache::ReadCache::default()),
        )
    }

    pub fn scoped_with_cache(
        session: &Session,
        pool: kubiki_core::cluster::client::ClusterClientPool,
        client: Option<Client>,
        generation: Option<u64>,
        consent: std::sync::Arc<dyn Consent>,
        journal: PathBuf,
        read_permits: std::sync::Arc<tokio::sync::Semaphore>,
        cache: std::sync::Arc<kubiki_core::core::read_cache::ReadCache>,
    ) -> Result<Self, String> {
        let budget = std::sync::Arc::new(kubiki_core::core::read_budget::ReadBudget::new(
            128,
            16 * 1024 * 1024,
            4 * 1024 * 1024,
            Duration::from_secs(180),
        ));
        let rejected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let invalidated = session.clone();
        let guarded = session.clone();
        let revision = session.control()?.revision;
        let signal = rejected.clone();
        let client = match client {
            Some(client) => {
                let generation = generation.ok_or("Missing pinned connection generation")?;
                let pinned = pool.pin_client(
                    client,
                    session.scope.context.clone(),
                    generation,
                    std::sync::Arc::new(move || invalidated.invalidate()),
                    std::sync::Arc::new(move || {
                        let valid = guarded.control().is_ok_and(|s| {
                            s.active
                                && !s.invalidated
                                && s.revision == revision
                                && s.phase == AgentPhase::Action
                                && s.mode != AgentMode::ReadOnly
                                && !*guarded.cancellation().borrow()
                        });
                        if !valid {
                            signal.store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                        valid
                    }),
                );
                Some(cache.wrap(budget.wrap(pinned)))
            }
            None => None,
        };
        Ok(Self {
            pool,
            client,
            connection_generation: generation,
            consent,
            journal,
            budget,
            write_rejected: rejected,
            read_permits,
            accepted_operations: session.accepted_operations.clone(),
        })
    }
}
