//! Agent tools compose existing core operations. No shell, arbitrary HTTP or
//! renderer-supplied authorization enters this boundary.
use crate::mutation_guard::MutationGuard;
use async_trait::async_trait;
use kube::{
    Client,
    api::{DynamicObject, ListParams},
};
use kubiki_ai::*;
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
use tauri::Manager;

#[derive(Clone)]
pub struct AcceptedIdentity {
    uid: String,
    generation: Option<u64>,
}

pub struct KubernetesTools {
    pub window: tauri::WebviewWindow,
    pub client: Option<Client>,
    pub connection_generation: Option<u64>,
    pub write_rejected: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub budget: std::sync::Arc<kubiki_core::core::read_budget::ReadBudget>,
    pub journal: PathBuf,
    pub read_permits: std::sync::Arc<tokio::sync::Semaphore>,
    pub accepted_identities:
        std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, AcceptedIdentity>>>,
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

impl ResourceArgs {
    fn target(&self) -> Target {
        Target {
            group: self.group.clone(),
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
        self.accepted_identities.lock().ok()?.get(id).map(|identity| identity.uid.clone())
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
            "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet"
        ) {
            let mut arguments =
                serde_json::to_value(target).map_err(|_| "Cannot encode verification target")?;
            arguments["uid"] = json!(uid);
            arguments["timeoutSeconds"] = json!(20);
            let generation = self.accepted_identities.lock().ok()
                .and_then(|ids| ids.get(&format!("call:{}", call.id)).filter(|identity| identity.uid == uid).and_then(|identity| identity.generation));
            let Some(generation) = generation else {
                return Ok(json!({"verification":"unavailable","observation":"Accepted workload generation is unavailable"}));
            };
            arguments["expectedGeneration"] = json!(generation);
            if let Some(yaml) = call.arguments["yaml"].as_str() {
                let desired: Value = serde_yaml::from_str(yaml).map_err(|_| "Invalid reviewed YAML")?;
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
        let mutation = matches!(call.name.as_str(), "apply_manifest" | "scale_workload" | "restart_workload" | "delete_resource");
        // Mutations request consent after preparing their exact native diff.
        // Internal reads belonging to one approved tool do not prompt again.
        if !mutation && call.name != "ask_user" && control.policy.requires_confirmation(control.mode, &call.name) {
            if !tool_definitions(&control.policy, control.mode, control.phase, &control.capabilities).iter().any(|tool| tool.name == call.name) {
                return Err("Tool is unavailable in the current access policy".into());
            }
            let target = Target {
                group: call.arguments["group"].as_str().unwrap_or("").into(),
                version: call.arguments["version"].as_str().unwrap_or("v1").into(),
                kind: call.arguments["kind"].as_str().unwrap_or("Agent tool").into(),
                namespace: call.arguments["namespace"].as_str().map(str::to_owned),
                name: call.arguments["name"].as_str().unwrap_or(&call.name).into(),
            };
            let resource = reference(&session.scope.context, &target, None);
            let summary = format!("Run {}? Results are shared with the selected model.\n{}", call.name, serde_json::to_string_pretty(&call.arguments).unwrap_or_default());
            emit(AgentEvent::Status { status: "awaiting_approval".into() });
            let started = tokio::time::Instant::now();
            let mut cancellation = session.cancellation();
            let decision = tokio::select! {
                biased;
                _ = cancelled(&mut cancellation) => Err("Tool cancelled before dispatch".to_owned()),
                result = crate::mutation_guard::confirm_action(self.window.clone(), &resource, summary, "AI_TOOL") => result.map_err(error_message),
            };
            self.budget.exclude_approval_wait(started.elapsed());
            session.exclude_approval_wait(started.elapsed());
            if !decision? { return Err("User declined this tool. Continue without it or ask for an alternative".into()); }
            self.ensure_connection(session).await?;
            if session.control()?.revision != control.revision { return Err("Permissions changed; request the tool again".into()); }
            emit(AgentEvent::Status { status: "running".into() });
        }
        if !parallel_read_tool(&call.name) {
            return self.execute_inner(session, call, emit).await;
        }
        if self.budget.expired()
            && !matches!(
                call.name.as_str(),
                "get_evidence" | "get_plan" | "resource_catalog"
            )
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
            let reads = self.window.state::<crate::read_tasks::ReadTasks>();
            let mut result = reads
                .run(
                    self.window.label(),
                    None,
                    Some(&session.scope.context),
                    &call.name,
                    Duration::from_secs(25),
                    async {
                        self.execute_inner(session, call, emit)
                            .await
                            .map_err(|message| {
                                kubiki_core::core::api::ApiError::from_status(
                                    503,
                                    message,
                                    &call.name,
                                    Some(&session.scope.context),
                                )
                            })
                    },
                )
                .await
                .map_err(|error| error.message)?;
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
            let pool = self
                .window
                .state::<kubiki_core::cluster::client::ClusterClientPool>();
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
            #[serde(deny_unknown_fields)]
            struct Proposal {
                title: String,
                yaml: String,
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
            return Ok(
                json!({"proposal":true,"title":proposal.title,"yaml":proposal.yaml,"executed":false}),
            );
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
                timeout_seconds: Option<u64>,
                expected_replicas: Option<u32>,
                expected_generation: Option<u64>,
                desired_state: Option<Value>,
            }
            let args: Args = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid verification request")?;
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
                if args.expected_generation.is_some_and(|generation| page["resource"]["metadata"]["generation"].as_u64().is_some_and(|current| current != generation)) {
                    return Ok(json!({"verification":"pending","observation":"Workload changed after the accepted operation; inspect before continuing"}));
                }
                let desired_matches = args.desired_state.as_ref().is_none_or(|desired| {
                    let observed = &page["resource"];
                    (desired["spec"].is_null() || contains_desired_fields(&desired["spec"], &observed["spec"]))
                        && ["labels", "annotations"].iter().all(|key| desired["metadata"][key].is_null() || contains_desired_fields(&desired["metadata"][key], &observed["metadata"][key]))
                });
                let verified = desired_matches && accepted_generation_matches(&page["resource"], args.expected_generation) && controller_verified(
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
        let client = self
            .client
            .clone()
            .ok_or("Start a conversation bound to a Kubernetes context to use cluster tools")?;
        if call.name == "resource_catalog" {
            if call.arguments.as_object().is_none_or(|o| !o.is_empty()) {
                return Err("Catalog takes no arguments".into());
            }
            return Ok(
                json!({"resources":resource_types(),"coverage":"Kubiki built-in registry; CRDs can also be read by known group/version/kind subject to policy"}),
            );
        }
        if call.name == "list_namespaces" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Args {
                cursor: Option<String>,
                page_size: Option<u32>,
            }
            let args: Args = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid namespace query")?;
            let size = args.page_size.unwrap_or(200);
            if !(1..=200).contains(&size)
                || !state
                    .policy
                    .contexts
                    .iter()
                    .any(|p| kubiki_ai::matches(p, &session.scope.context))
            {
                return Err("Namespace query is outside policy or page limits".into());
            }
            let mut binding = call.arguments.clone();
            binding.as_object_mut().unwrap().remove("cursor");
            let binding = json!({"tool":"list_namespaces","arguments":binding});
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
            let mut cancellation = session.cancellation();
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
                        let fetched = reader.page(&params, true).await.map_err(query_list_error)?;
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
                            .any(|p| kubiki_ai::matches(p, &name))
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
                        let source =
                            json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":name}});
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
                Ok(
                    json!({"source":if session.scope.all_namespaces {"kubernetesMetadata"}else{"conversationScope"},"namespaces":names,"hasMore":more,"cursor":cursor,"capturedAt":captured_at,"omittedByPolicy":omitted,"completeness":if more||omitted>0 {"partial"}else{"complete"},"coverage":"Namespace names only, projected by allowed scope and policy; missing names do not prove absence"}),
                )
            };
            return tokio::select! {biased; _=cancelled(&mut cancellation)=>Err("Namespace discovery cancelled".into()), result=tokio::time::timeout(Duration::from_secs(20),read)=>result.map_err(|_|"Namespace discovery timed out")?};
        }
        if [
            "get_logs",
            "get_events",
            "get_metrics",
            "get_events_timeline",
        ]
        .contains(&call.name.as_str())
        {
            return self.read_diagnostic(session, call, client).await;
        }
        if call.name == "get_pod_diagnostics" {
            return self.read_pod_diagnostics(session, call, client).await;
        }
        if call.name == "get_workload_diagnostics" {
            return self.read_workload_diagnostics(session, call, client).await;
        }
        if call.name == "get_node_diagnostics" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Args {
                name: String,
            }
            let args: Args =
                serde_json::from_value(call.arguments.clone()).map_err(|_| "Invalid Node query")?;
            let page=self.linked_read(session,"get_resource",json!({"group":"","version":"v1","kind":"Node","namespace":null,"name":args.name,"fields":["spec.unschedulable","spec.taints","status.conditions","status.capacity","status.allocatable"]})).await?;
            return bounded_result(
                json!({"node":node_diagnostics(&page["resource"]),"evidence":{"context":session.scope.context,"kind":"Node","name":page["resource"]["metadata"]["name"],"uid":page["resource"]["metadata"]["uid"],"capturedAt":page["capturedAt"],"completeness":"partial"}}),
            );
        }
        if call.name == "get_config_diagnostics" {
            let args: ResourceArgs = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid configuration query")?;
            if !matches!(
                args.kind.as_str(),
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
            let fields = [
                "spec",
                "spec.template.spec",
                "spec.jobTemplate.spec.template.spec",
            ]
            .into_iter()
            .flat_map(|prefix| {
                [
                    "containers[*].name",
                    "containers[*].envFrom",
                    "containers[*].env[*].valueFrom",
                    "initContainers[*].name",
                    "initContainers[*].envFrom",
                    "initContainers[*].env[*].valueFrom",
                    "volumes[*].configMap",
                    "volumes[*].secret",
                    "imagePullSecrets",
                ]
                .into_iter()
                .map(move |field| format!("{prefix}.{field}"))
            })
            .collect::<Vec<_>>();
            let page=self.linked_read(session,"get_resource",json!({"group":args.group,"version":args.version,"kind":args.kind,"namespace":args.namespace,"name":args.name,"fields":fields})).await?;
            let root = &page["resource"];
            let pod_spec = if args.kind == "Pod" {
                &root["spec"]
            } else if args.kind == "CronJob" {
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
                    let target = Target {
                        group: "".into(),
                        version: "v1".into(),
                        kind: kind.into(),
                        namespace: args.namespace.clone(),
                        name: name.into(),
                    };
                    let content = state.policy.access(&target, true) == DataAccess::Content;
                    let fields = if content && reference["key"].is_string() {
                        json!(["data", "binaryData"])
                    } else {
                        json!(["metadata.name"])
                    };
                    match self.linked_read(session,"get_resource",json!({"group":"","version":"v1","kind":kind,"namespace":args.namespace,"name":name,"fields":fields})).await {
                        Ok(found)=>{let item=&found["resource"];let key=reference["key"].as_str();let present=key.is_some_and(|key|item["data"].get(key).is_some()||item["binaryData"].get(key).is_some());checks.push(json!({"kind":kind,"name":name,"key":key,"object":"observed","keyStatus":if present{"present"}else{"unknownOrMissing"},"capturedAt":found["capturedAt"]}));}
                        Err(error)=>checks.push(json!({"kind":kind,"name":name,"object":if error.contains("HTTP 404"){"notFound"}else{"unavailableOrDenied"},"reason":error})),
                    }
                }
            }
            return bounded_result(
                json!({"references":references,"checks":checks,"examined":examined,"evidence":{"context":session.scope.context,"kind":args.kind,"namespace":args.namespace,"name":args.name,"capturedAt":page["capturedAt"],"completeness":"partial","coverage":"Projected references and at most 20 distinct exact checks; secret/configuration values are never returned, absent/filtered keys remain unknown"}}),
            );
        }
        if call.name == "get_service_diagnostics" {
            return self.read_service_diagnostics(session, call, client).await;
        }
        if call.name == "get_pvc_diagnostics" {
            return self.read_pvc_diagnostics(session, call, client).await;
        }
        if call.name == "list_helm_releases" {
            return self.list_helm_releases(session, call, client).await;
        }
        if call.name == "get_helm_release" {
            return self.get_helm_release(session, call, client).await;
        }
        if call.name == "list_argocd_apps" {
            return self.list_argocd_apps(session, call, client).await;
        }
        if call.name == "get_argocd_app" {
            return self.get_argocd_app(session, call, client).await;
        }
        if call.name == "list_flux_resources" {
            return self.list_flux_resources(session, call, client).await;
        }
        if call.name == "get_flux_resource" {
            return self.get_flux_resource(session, call, client).await;
        }
        if [
            "apply_manifest",
            "scale_workload",
            "restart_workload",
            "delete_resource",
            "sync_argocd_app",
            "reconcile_flux_resource",
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
                    "node" => "scheduling",
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
            result["error"] = json!(failure);
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
            group: args.group,
            version: args.version,
            kind: args.kind,
            namespace: args.namespace,
            name: args.name,
        };
        validate_target(&target, call.name == "get_resource")?;
        state.policy.check_scope(&session.scope, &target)?;
        let mut cancellation = session.cancellation();
        let read = async {
            let query = ResourceQuery {
                context: session.scope.context.clone(),
                group: target.group.clone(),
                version: target.version.clone(),
                kind: target.kind.clone(),
                namespace: target.namespace.clone(),
            };
            let known = kubiki_core::core::api::resource_type(&target.kind)
                .is_some_and(|resource| resource.group == target.group);
            if call.name == "get_resource"
                && state.policy.access(&target, known) == DataAccess::None
            {
                return Err("Reading this resource is disabled by policy".into());
            }
            let reader =
                kubiki_core::core::access::ResourceAccess::new(client, &query, false).await?;
            let builtin = reader.builtin;
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
                    json!({"capturedAt":stamp(),"resource":data,"coverage":"Policy-filtered live Kubernetes read; omitted fields are not evidence of absence"}),
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
                    let mut page =
                        projected_page(&reader, &state.policy, &target, &params, metadata_only)
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
                let (items, mut tail) = split_page(pending, 48_000)?;
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
                    json!({"scope":{"namespace":target.namespace,"kind":target.kind,"labelSelector":args.label_selector,"fieldSelector":args.field_selector},"capturedAt":captured_at,"returned":items.len(),"items":items,"omittedByPolicy":omitted,"hasMore":has_more,"cursor":cursor,"completeness":if has_more || omitted > 0 {"partial"} else {"complete"},"coverage":"Policy-projected bounded page; cursor retains byte-limited tail before the next Kubernetes page"}),
                )
            } else {
                Err("Unknown AI tool".into())
            }
        };
        tokio::select! { biased; _ = cancelled(&mut cancellation) => Err("Read cancelled".into()), result = tokio::time::timeout(Duration::from_secs(20), read) => result.map_err(|_| "AI resource read timed out")? }
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
    reader: &kubiki_core::core::access::ResourceAccess,
    policy: &AgentPolicy,
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
    for item in page.items {
        let actual = Target {
            name: item["metadata"]["name"].as_str().unwrap_or_default().into(),
            ..target.clone()
        };
        let access = policy.access(&actual, reader.builtin);
        if access == DataAccess::None {
            omitted += 1;
            continue;
        }
        let value = if !full_list && access == DataAccess::Content && !metadata_only {
            let object = reader
                .get(&actual.name, false)
                .await
                .map_err(|_| "Resource changed or access was denied during list")?;
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
fn flux_gvk(kind: &str) -> Result<(&'static str, &'static str), String> {
    match kind {
        "HelmRelease" => Ok(("helm.toolkit.fluxcd.io", "v2")),
        "Kustomization" => Ok(("kustomize.toolkit.fluxcd.io", "v1")),
        "GitRepository" => Ok(("source.toolkit.fluxcd.io", "v1")),
        _ => Err("Unsupported Flux kind".into()),
    }
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
            if [
                "token",
                "password",
                "clientKeyData",
                "clientCertificateData",
                "authorization",
            ]
            .iter()
            .any(|v| key.eq_ignore_ascii_case(v))
            {
                return Err("Selector references a sensitive field".into());
            }
        }
    }
    if let Some(selector) = fields {
        for term in selector.split(',') {
            let key = term.split(['=', '!']).next().unwrap_or("").trim();
            let path = format!("/{}", key.replace('.', "/"));
            if key.split('.').any(|part| {
                [
                    "token",
                    "password",
                    "clientKeyData",
                    "clientCertificateData",
                    "authorization",
                    "managedFields",
                ]
                .iter()
                .any(|v| part.eq_ignore_ascii_case(v))
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
            }) || (!key.starts_with("metadata.")
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
    } else if call.name == "sync_argocd_app" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            namespace: String,
            name: String,
            #[allow(dead_code)]
            hard: Option<bool>,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid sync_argocd_app arguments")?;
        let target = Target {
            group: "argoproj.io".into(),
            version: "v1alpha1".into(),
            kind: "Application".into(),
            namespace: Some(args.namespace),
            name: args.name,
        };
        (target, None, Some(WriteOperation::Update), None)
    } else if call.name == "reconcile_flux_resource" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            kind: String,
            namespace: String,
            name: String,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid reconcile_flux_resource arguments")?;
        let (group, version) = match args.kind.as_str() {
            "HelmRelease" => ("helm.toolkit.fluxcd.io", "v2"),
            "Kustomization" => ("kustomize.toolkit.fluxcd.io", "v1"),
            _ => return Err("kind must be 'HelmRelease' or 'Kustomization'".into()),
        };
        let target = Target {
            group: group.into(),
            version: version.into(),
            kind: args.kind,
            namespace: Some(args.namespace),
            name: args.name,
        };
        (target, None, Some(WriteOperation::Update), None)
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
            tail_lines: Option<i64>,
            since_seconds: Option<i64>,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid diagnostic arguments")?;
        if call.name != "get_logs" && (args.tail_lines.is_some() || args.since_seconds.is_some()) {
            return Err("Log options only apply to get_logs".into());
        }
        if args.tail_lines.is_some_and(|n| !(1..=500).contains(&n))
            || args
                .since_seconds
                .is_some_and(|n| !(1..=86400).contains(&n))
        {
            return Err("Logs require tailLines 1–500 and sinceSeconds 1–86400".into());
        }
        let state = session.control()?;
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: if call.name == "get_events" || call.name == "get_events_timeline" {
                "Event"
            } else {
                "Pod"
            }
            .into(),
            namespace: Some(args.namespace.clone()),
            name: args.name.clone().unwrap_or_default(),
        };
        validate_target(&target, call.name == "get_logs")?;
        state.policy.check_scope(&session.scope, &target)?;
        let mut cancellation = session.cancellation();
        let read = async {
            if call.name == "get_logs" {
                if !state.policy.logs || state.policy.access(&target, true) != DataAccess::Content {
                    return Err("Pod logs are disabled by policy".into());
                }
                let request = kubiki_core::pod_ops::logs::LogSliceRequest {
                    resource: reference(&session.scope.context, &target, args.uid),
                    container: args.container.ok_or("Container is required")?,
                    previous: args.previous.unwrap_or(false),
                    tail_lines: Some(args.tail_lines.unwrap_or(150)),
                    since_time: None,
                    since_seconds: Some(args.since_seconds.unwrap_or(3600)),
                };
                let logs = request.read(client).await.map_err(error_message)?;
                Ok(
                    json!({"capturedAt":stamp(),"logs":logs.chars().take(24000).collect::<String>(),"tailLines":args.tail_lines.unwrap_or(150),"sinceSeconds":args.since_seconds.unwrap_or(3600),"coverage":"Bounded container log window; capped at 24000 characters; absence is not proof of health"}),
                )
            } else if call.name == "get_events" {
                if !state.policy.events {
                    return Err("Events are disabled by policy".into());
                }
                if args.uid.is_some()
                    || args.container.is_some()
                    || args.previous.is_some()
                    || args.limit.is_some()
                {
                    return Err("Unexpected Event arguments".into());
                }
                let query = ResourceQuery {
                    context: session.scope.context.clone(),
                    group: target.group.clone(),
                    version: target.version.clone(),
                    kind: target.kind.clone(),
                    namespace: target.namespace.clone(),
                };
                let reader =
                    kubiki_core::core::access::ResourceAccess::new(client, &query, false).await?;
                let mut params = ListParams::default().limit(50);
                if !target.name.is_empty() {
                    let selector = format!("involvedObject.name={}", target.name);
                    validate_query_filters(&state.policy, &target, true, None, Some(&selector))?;
                    params = params.fields(&selector);
                }
                let page = projected_page(&reader, &state.policy, &target, &params, false).await?;
                bounded_result(
                    json!({"capturedAt":page.captured_at,"items":page.items,"hasMore":page.continuation.is_some(),"omittedByPolicy":page.omitted,"coverage":"Policy-projected bounded Events; no complete absence claim"}),
                )
            } else if call.name == "get_events_timeline" {
                if !state.policy.events {
                    return Err("Events are disabled by policy".into());
                }
                if args.container.is_some() || args.previous.is_some() {
                    return Err("Unexpected arguments for events timeline".into());
                }
                let query = ResourceQuery {
                    context: session.scope.context.clone(),
                    group: target.group.clone(),
                    version: target.version.clone(),
                    kind: target.kind.clone(),
                    namespace: target.namespace.clone(),
                };
                let reader =
                    kubiki_core::core::access::ResourceAccess::new(client, &query, false).await?;
                let limit = args.limit.unwrap_or(40).clamp(1, 100);
                let mut params = ListParams::default().limit(limit);
                let mut filters = Vec::new();
                if !target.name.is_empty() {
                    filters.push(format!("involvedObject.name={}", target.name));
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
                if !filters.is_empty() {
                    let selector = filters.join(",");
                    validate_query_filters(&state.policy, &target, true, None, Some(&selector))?;
                    params = params.fields(&selector);
                }
                let page = projected_page(&reader, &state.policy, &target, &params, false).await?;
                let mut timeline = Vec::new();
                for value in page.items {
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
                    let actual = Target {
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
                        .map(|s| s.to_string());
                    let last_ts = data
                        .get("lastTimestamp")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string())
                        .or_else(|| {
                            data.get("eventTime")
                                .and_then(Value::as_str)
                                .map(|s| s.to_string())
                        });
                    let involved = data.get("involvedObject").cloned().unwrap_or(json!({}));
                    let component = data
                        .get("source")
                        .and_then(|s| s.get("component"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();

                    timeline.push(json!({
                        "type": event_type,
                        "reason": reason,
                        "message": message,
                        "count": count,
                        "firstTimestamp": first_ts,
                        "lastTimestamp": last_ts,
                        "involvedObject": {
                            "kind": involved.get("kind"),
                            "name": involved.get("name"),
                            "uid": involved.get("uid"),
                            "fieldPath": involved.get("fieldPath"),
                        },
                        "component": component,
                    }));
                }
                // Sort by lastTimestamp descending so newest events appear first
                timeline.sort_by(|a, b| {
                    let ts_a = a.get("lastTimestamp").and_then(Value::as_str).unwrap_or("");
                    let ts_b = b.get("lastTimestamp").and_then(Value::as_str).unwrap_or("");
                    ts_b.cmp(ts_a)
                });
                bounded_result(json!({
                    "diagnostic": "events_timeline",
                    "evidence": {
                        "namespace": args.namespace,
                        "name": args.name,
                        "uid": args.uid,
                        "capturedAt": stamp(),
                        "total": timeline.len(),
                        "completeness":"partial", "coverage":"Policy-projected bounded timeline; missing fields and expired Events are unknown"
                    },
                    "timeline": timeline,
                }))
            } else {
                if !state.policy.metrics
                    || args.uid.is_some()
                    || args.container.is_some()
                    || args.previous.is_some()
                    || args.limit.is_some()
                {
                    return Err("Metrics are disabled or arguments are invalid".into());
                }
                if state
                    .policy
                    .denied_paths
                    .iter()
                    .any(|p| p == "/status" || p == "/status/metrics")
                {
                    return Err("Metrics fields are disabled by policy".into());
                }
                let metrics = if !target.name.is_empty() {
                    if state.policy.access(&target, true) != DataAccess::Content {
                        return Err("Pod metrics require content access".into());
                    }
                    vec![
                        kubiki_core::metrics::client::MetricsService::get_pod_metric(
                            &client,
                            &args.namespace,
                            &target.name,
                        )
                        .await
                        .map_err(|_| "Pod metrics unavailable or denied")?,
                    ]
                } else {
                    if !state.policy.collection_content_allowed(&target, true) {
                        return Err("Per-resource rules require an exact Pod name for metrics; query permitted identities first".into());
                    }
                    kubiki_core::metrics::client::MetricsService::get_pod_metrics(
                        &client,
                        Some(&args.namespace),
                    )
                    .await
                    .map_err(|_| "Metrics API unavailable or denied")?
                };
                let more = metrics.len() > 50;
                let mut items = Vec::new();
                for metric in metrics.into_iter().take(50) {
                    let target = Target {
                        name: metric.name.clone(),
                        ..target.clone()
                    };
                    let value = json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":metric.name,"namespace":metric.namespace},"status":{"metrics":metric}});
                    let projected = state.policy.project(&target, &value, true)?;
                    if let Some(metric) = projected.pointer("/status/metrics") {
                        items.push(metric.clone());
                    }
                }
                Ok(
                    json!({"capturedAt":stamp(),"metrics":items,"hasMore":more,"completeness":"partial","coverage":"Policy-projected current Pod metrics under /status/metrics; a single snapshot cannot justify historical rightsizing"}),
                )
            }
        };
        tokio::select! { biased; _ = cancelled(&mut cancellation) => Err("Read cancelled".into()), result = tokio::time::timeout(Duration::from_secs(20), read) => result.map_err(|_| "Diagnostic read timed out")? }
    }

    async fn read_pod_diagnostics(
        &self,
        session: &Session,
        call: &ToolCall,
        client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            namespace: String,
            name: String,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid pod diagnostics arguments")?;
        let state = session.control()?;
        if !state.policy.resources {
            return Err("Resource access is disabled by policy".into());
        }
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: Some(args.namespace.clone()),
            name: args.name.clone(),
        };
        validate_target(&target, true)?;
        state.policy.check_scope(&session.scope, &target)?;
        if state.policy.access(&target, true) != DataAccess::Content {
            return Err(
                "Pod diagnostics require content access; use get_resource for permitted metadata"
                    .into(),
            );
        }

        let mut cancellation = session.cancellation();
        let read = async {
            let api_dyn = resource_access(client.clone(), &target).await?;
            let pod = api_dyn
                .get_object(&args.name)
                .await
                .map_err(|_| "Pod not found or access denied")?;

            let projected = diagnostic_projection(&state.policy, &target, &pod)?;
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
            let pod_ip = status
                .get("podIP")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let host_ip = status
                .get("hostIP")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let node_name = spec
                .get("nodeName")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let restart_policy = spec.get("restartPolicy").and_then(Value::as_str);

            let mut issues = Vec::new();

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

            bounded_result(json!({
                "diagnostic": "pod_diagnostics",
                "evidence": {
                    "kind": "Pod",
                    "namespace": args.namespace,
                    "name": args.name,
                    "uid": uid,
                    "resourceVersion": resource_version,
                    "capturedAt": stamp(),
                    "completeness": "partial",
                    "coverage": "Policy-filtered diagnostic projection; omitted fields and bounded child selections do not establish absence"
                },
                "phase": phase,
                "nodeName": node_name,
                "podIP": pod_ip,
                "hostIP": host_ip,
                "restartPolicy": restart_policy,
                "issuesSummary": issues,
                "conditions": conditions_summary,
                "initContainers": init_containers,
                "containers": containers,
            }))
        };
        tokio::select! { biased; _ = cancelled(&mut cancellation) => Err("Pod diagnostics cancelled".into()), result = tokio::time::timeout(Duration::from_secs(20), read) => result.map_err(|_| "Pod diagnostics timed out")? }
    }

    async fn read_workload_diagnostics(
        &self,
        session: &Session,
        call: &ToolCall,
        client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Args {
            group: String,
            version: String,
            kind: String,
            namespace: String,
            name: String,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid workload diagnostics arguments")?;
        let state = session.control()?;
        if !state.policy.resources {
            return Err("Resource access is disabled by policy".into());
        }
        let target = Target {
            group: args.group,
            version: args.version,
            kind: args.kind,
            namespace: Some(args.namespace.clone()),
            name: args.name.clone(),
        };
        validate_target(&target, true)?;
        state.policy.check_scope(&session.scope, &target)?;
        if state.policy.access(&target, true) != DataAccess::Content {
            return Err("Workload diagnostics require content access; use get_resource for permitted metadata".into());
        }

        let mut cancellation = session.cancellation();
        let read = async {
            let api_dyn = resource_access(client.clone(), &target).await?;
            let obj = api_dyn
                .get_object(&args.name)
                .await
                .map_err(|_| "Workload not found or access denied")?;

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
                    namespace: Some(args.namespace.clone()),
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
                                        "desired": rs_desired,
                                        "current": rs_current,
                                        "ready": rs_ready,
                                    }));
                                }
                            }
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
                        namespace: Some(args.namespace.clone()),
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
                                let mut pod_issues = Vec::new();
                                for (key, is_init) in [
                                    ("initContainerStatuses", true),
                                    ("containerStatuses", false),
                                ] {
                                    container_diagnostics(
                                        &pod.data["status"][key],
                                        is_init,
                                        &mut pod_issues,
                                    );
                                }
                                let pod_issue =
                                    (!pod_issues.is_empty()).then(|| pod_issues.join("; "));
                                child_pods_summary.push(json!({
                                    "name": pod_name,
                                    "phase": pod_phase,
                                    "issue": pod_issue,
                                }));
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
                    "namespace": args.namespace,
                    "name": args.name,
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
        tokio::select! { biased; _ = cancelled(&mut cancellation) => Err("Workload diagnostics cancelled".into()), result = tokio::time::timeout(Duration::from_secs(20), read) => result.map_err(|_| "Workload diagnostics timed out")? }
    }

    // Compose generic projected reads so policy, selectors, UID checks, paging and
    // uniform-LIST optimization have exactly one implementation.
    async fn linked_read(
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

    async fn read_service_diagnostics(
        &self,
        session: &Session,
        call: &ToolCall,
        _client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            namespace: String,
            name: String,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid service diagnostics arguments")?;
        let state = session.control()?;
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "Service".into(),
            namespace: Some(args.namespace.clone()),
            name: args.name.clone(),
        };
        validate_target(&target, true)?;
        state.policy.check_scope(&session.scope, &target)?;
        if state.policy.access(&target, true) != DataAccess::Content {
            return Err("Service diagnostics require content access".into());
        }
        let root = self.linked_read(session, "get_resource", json!({"group":"","version":"v1","kind":"Service","namespace":args.namespace,"name":args.name,"fields":["spec.type","spec.clusterIP","spec.selector","spec.ports","spec.externalName","spec.publishNotReadyAddresses","status.loadBalancer"]})).await?;
        let service = &root["resource"];
        let mut coverage = json!({});
        let mut slices = None;
        let mut pods = None;
        if service["spec"]["type"] != "ExternalName" {
            let result = self.linked_read(session, "list_resources", json!({"group":"discovery.k8s.io","version":"v1","kind":"EndpointSlice","namespace":args.namespace,"labelSelector":format!("kubernetes.io/service-name={}",args.name),"pageSize":10,"fields":["metadata.ownerReferences","endpoints[*].conditions","ports"]})).await;
            match result {
                Ok(mut page) => {
                    let service_uid = service["metadata"]["uid"].as_str();
                    if let Some(items) = page["items"].as_array_mut() {
                        // A known conflicting owner belongs to a previous Service incarnation.
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
                match self.linked_read(session, "list_resources", json!({"group":"","version":"v1","kind":"Pod","namespace":args.namespace,"labelSelector":selector,"pageSize":20,"fields":["status.phase","status.conditions","spec.containers[*].name","spec.containers[*].ports"]})).await {
                    Ok(page) => { pods = page["items"].as_array().cloned(); coverage["pods"]=page; }
                    Err(error) => coverage["pods"]=json!({"completeness":"unavailable","reason":error}),
                }
            } else {
                coverage["pods"] = json!({"completeness":"unavailable","reason":"No usable permitted selector; no broad Pod scan performed"});
            }
        }
        let diag = service_diagnostics(service, slices.as_ref(), pods.as_deref());
        // Do not duplicate all child bodies in evidence. Keep filters/cursors/time/counts.
        for key in ["pods", "endpointSlices"] {
            if let Some(map) = coverage[key].as_object_mut() {
                map.remove("items");
            }
        }
        bounded_result(
            json!({"diagnostic":"service_diagnostics","service":diag,"components":coverage,"evidence":{"context":session.scope.context,"kind":"Service","namespace":args.namespace,"name":args.name,"uid":service["metadata"]["uid"],"resourceVersion":service["metadata"]["resourceVersion"],"capturedAt":root["capturedAt"],"completeness":"partial","coverage":"Scoped policy-projected observations; endpoint readiness does not establish connectivity or application health"}}),
        )
    }

    async fn read_pvc_diagnostics(
        &self,
        session: &Session,
        call: &ToolCall,
        _client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            namespace: String,
            name: String,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid PVC diagnostics arguments")?;
        let state = session.control()?;
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: "PersistentVolumeClaim".into(),
            namespace: Some(args.namespace.clone()),
            name: args.name.clone(),
        };
        validate_target(&target, true)?;
        state.policy.check_scope(&session.scope, &target)?;
        if state.policy.access(&target, true) != DataAccess::Content {
            return Err("PVC diagnostics require content access".into());
        }
        let root=self.linked_read(session,"get_resource",json!({"group":"","version":"v1","kind":"PersistentVolumeClaim","namespace":args.namespace,"name":args.name,"fields":["spec.volumeName","spec.storageClassName","spec.resources.requests.storage","spec.accessModes","status.phase","status.capacity","status.conditions"]})).await?;
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
                match self.linked_read(session,"list_resources",json!({"group":"","version":"v1","kind":"Event","namespace":args.namespace,"labelSelector":"","fieldSelector":selector,"pageSize":20,"fields":["involvedObject.uid","reason","message","type","lastTimestamp","eventTime"]})).await {
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
            json!({"diagnostic":"pvc_diagnostics","pvc":diag,"components":components,"evidence":{"context":session.scope.context,"kind":"PersistentVolumeClaim","namespace":args.namespace,"name":args.name,"uid":pvc["metadata"]["uid"],"resourceVersion":pvc["metadata"]["resourceVersion"],"capturedAt":root["capturedAt"],"completeness":"partial","coverage":"Projected claim, exact volume/class and UID-bound Events; unavailable fields do not establish absence"}}),
        )
    }

    async fn list_helm_releases(
        &self,
        session: &Session,
        call: &ToolCall,
        _client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            namespace: Option<String>,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid list_helm_releases arguments")?;
        let state = session.control()?;
        if !state.policy.is_helm_active(&state.capabilities) {
            return Err("Helm operations are disabled by policy or not detected in cluster".into());
        }
        let namespace = args
            .namespace
            .or_else(|| session.working_scope.lock().ok()?.namespace.clone())
            .ok_or("Choose one namespace for Helm inspection")?;
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
        let reader = kubiki_core::core::access::ResourceAccess::new(_client, &query, false).await?;
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
        bounded_result(
            json!({"releases":items,"count":items.len(),"hasMore":page.continuation.is_some(),"evidence":{"context":session.scope.context,"namespace":namespace,"capturedAt":stamp(),"completeness":"partial","coverage":"Policy-projected Release metadata from at most 50 Helm storage metadata entries; revision is highest observed in this page, not a complete history. No Secret bodies fetched."}}),
        )
    }

    async fn get_helm_release(
        &self,
        session: &Session,
        call: &ToolCall,
        _client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            namespace: String,
            name: String,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid get_helm_release arguments")?;
        let state = session.control()?;
        if !state.policy.is_helm_active(&state.capabilities) {
            return Err("Helm operations are disabled by policy or not detected in cluster".into());
        }
        let target = Target {
            group: "helm.sh".into(),
            version: "v1".into(),
            kind: "Release".into(),
            namespace: Some(args.namespace.clone()),
            name: args.name.clone(),
        };
        state.policy.check_scope(&session.scope, &target)?;

        if state.policy.access(&target, false) != DataAccess::Content {
            return Err(
                "Helm release values/history require content access to this helm.sh Release".into(),
            );
        }
        let pool = self
            .window
            .state::<kubiki_core::cluster::client::ClusterClientPool>();
        let reader = crate::helm_commands::cluster_reader(&pool)
            .await
            .map_err(error_message)?
            .with_read_timeout(Duration::from_secs(20));
        self.ensure_connection(session).await?;
        let history = reader
            .history(&session.scope.context, &args.namespace, &args.name)
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
                &args.namespace,
                &args.name,
                revision,
                kubiki_core::helm::reader::HelmDocument::Values,
            )
            .await
            .map_err(error_message)?;
        let values: Value = serde_yaml::from_str(&values)
            .map_err(|_| "Cannot parse Helm values for policy projection")?;
        let value = json!({"apiVersion":"helm.sh/v1","kind":"Release","metadata":{"name":args.name,"namespace":args.namespace},"spec":{"values":values},"status":{"history":history}});
        let projected = state.policy.project(&target, &value, false)?;
        bounded_result(
            json!({"release":args.name,"namespace":args.namespace,"values":projected["spec"]["values"],"history":projected["status"]["history"],"evidence":{"context":session.scope.context,"revision":revision,"capturedAt":stamp(),"completeness":"partial","coverage":"Context-pinned, policy-projected Helm release; omitted configuration is unknown"}}),
        )
    }

    async fn list_argocd_apps(
        &self,
        session: &Session,
        call: &ToolCall,
        _client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            namespace: Option<String>,
        }
        let args: Args =
            serde_json::from_value(call.arguments.clone()).map_err(|_| "Invalid Argo CD query")?;
        let namespace = args
            .namespace
            .or_else(|| session.working_scope.lock().ok()?.namespace.clone())
            .ok_or("Choose one namespace for Argo CD inspection")?;
        let query = ToolCall {
            id: call.id.clone(),
            name: "list_resources".into(),
            arguments: json!({"group":"argoproj.io","version":"v1alpha1","kind":"Application","namespace":namespace,"fields":["metadata.name","status.health.status","status.sync.status","spec.source.repoURL","spec.source.path","spec.destination.namespace"]}),
        };
        let page = Box::pin(self.execute_inner(session, &query, &silent_events())).await?;
        let apps=page["items"].as_array().ok_or("Invalid Argo CD page")?.iter().map(|item| json!({"name":item["metadata"]["name"],"namespace":item["metadata"]["namespace"],"health":item["status"]["health"]["status"],"sync":item["status"]["sync"]["status"],"repoURL":item["spec"]["source"]["repoURL"],"path":item["spec"]["source"]["path"],"destinationNamespace":item["spec"]["destination"]["namespace"]})).collect::<Vec<_>>();
        bounded_result(
            json!({"applications":apps,"count":apps.len(),"hasMore":page["hasMore"],"evidence":{"capturedAt":page["capturedAt"],"completeness":"partial","coverage":"Policy-projected bounded GitOps inspection; use generic list_resources for further pages"}}),
        )
    }

    async fn get_argocd_app(
        &self,
        session: &Session,
        call: &ToolCall,
        _client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            namespace: String,
            name: String,
        }
        let args: Args =
            serde_json::from_value(call.arguments.clone()).map_err(|_| "Invalid Argo CD query")?;
        let query = ToolCall {
            id: call.id.clone(),
            name: "get_resource".into(),
            arguments: json!({"group":"argoproj.io","version":"v1alpha1","kind":"Application","namespace":args.namespace,"name":args.name,"fields":["status.health","status.sync","spec.source","spec.destination","status.conditions","status.resources"]}),
        };
        let page = Box::pin(self.execute_inner(session, &query, &silent_events())).await?;
        let item = &page["resource"];
        bounded_result(
            json!({"application":args.name,"namespace":args.namespace,"health":item["status"]["health"],"sync":item["status"]["sync"],"source":item["spec"]["source"],"destination":item["spec"]["destination"],"conditions":item["status"]["conditions"],"managedResources":item["status"]["resources"],"evidence":{"capturedAt":page["capturedAt"],"completeness":"partial","coverage":"Policy-projected GitOps resource; omitted fields are unknown"}}),
        )
    }

    async fn list_flux_resources(
        &self,
        session: &Session,
        call: &ToolCall,
        _client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            namespace: Option<String>,
            kind: Option<String>,
        }
        let args: Args =
            serde_json::from_value(call.arguments.clone()).map_err(|_| "Invalid Flux query")?;
        let namespace = args
            .namespace
            .or_else(|| session.working_scope.lock().ok()?.namespace.clone())
            .ok_or("Choose one namespace for Flux inspection")?;
        let kinds = match args.kind.as_deref() {
            Some(kind @ ("HelmRelease" | "Kustomization" | "GitRepository")) => vec![kind],
            None => vec!["HelmRelease", "Kustomization", "GitRepository"],
            _ => return Err("Unsupported Flux kind".into()),
        };
        let mut items = Vec::new();
        let mut unavailable = Vec::new();
        for kind in kinds {
            let (group, version) = flux_gvk(kind)?;
            let query = ToolCall {
                id: call.id.clone(),
                name: "list_resources".into(),
                arguments: json!({"group":group,"version":version,"kind":kind,"namespace":namespace,"fields":["metadata.name","spec.suspend","status.conditions","status.lastAppliedRevision"]}),
            };
            match Box::pin(self.execute_inner(session, &query, &silent_events())).await {
                Ok(page) => {
                    if page["hasMore"] == true {
                        unavailable.push(format!("{kind}: additional pages"));
                    }
                    for item in page["items"].as_array().ok_or("Invalid Flux page")? {
                        let ready = item["status"]["conditions"]
                            .as_array()
                            .and_then(|cs| cs.iter().find(|c| c["type"] == "Ready"));
                        items.push(json!({"kind":kind,"name":item["metadata"]["name"],"namespace":item["metadata"]["namespace"],"ready":ready.map(|c|&c["status"]),"message":ready.map(|c|&c["message"]),"suspended":item["spec"]["suspend"],"lastAppliedRevision":item["status"]["lastAppliedRevision"]}));
                    }
                }
                Err(_) => unavailable.push(format!("{kind}: unavailable or denied")),
            }
        }
        bounded_result(
            json!({"resources":items,"count":items.len(),"unavailable":unavailable,"evidence":{"capturedAt":stamp(),"completeness":"partial","coverage":"Bounded policy-projected Flux inspection; unavailable is not an empty healthy result"}}),
        )
    }

    async fn get_flux_resource(
        &self,
        session: &Session,
        call: &ToolCall,
        _client: Client,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            kind: String,
            namespace: String,
            name: String,
        }
        let args: Args =
            serde_json::from_value(call.arguments.clone()).map_err(|_| "Invalid Flux query")?;
        let (group, version) = flux_gvk(&args.kind)?;
        let query = ToolCall {
            id: call.id.clone(),
            name: "get_resource".into(),
            arguments: json!({"group":group,"version":version,"kind":args.kind,"namespace":args.namespace,"name":args.name,"fields":["spec.suspend","spec.sourceRef","status.conditions","status.lastAppliedRevision","status.lastAttemptedRevision","status.inventory"]}),
        };
        let page = Box::pin(self.execute_inner(session, &query, &silent_events())).await?;
        let item = &page["resource"];
        bounded_result(
            json!({"kind":args.kind,"name":args.name,"namespace":args.namespace,"suspended":item["spec"]["suspend"],"sourceRef":item["spec"]["sourceRef"],"conditions":item["status"]["conditions"],"lastAppliedRevision":item["status"]["lastAppliedRevision"],"lastAttemptedRevision":item["status"]["lastAttemptedRevision"],"inventory":item["status"]["inventory"],"evidence":{"capturedAt":page["capturedAt"],"completeness":"partial","coverage":"Policy-projected GitOps resource; omitted fields are unknown"}}),
        )
    }

    pub(crate) async fn review_plan_call(
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
        let guard = self.window.state::<MutationGuard>();
        let _gate = guard.acquire(&resource).map_err(error_message)?;
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
                WriteOperation::Update if call.name == "sync_argocd_app" => {
                    let hard = call
                        .arguments
                        .get("hard")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    MutationIntent::Action {
                        resource: pinned.clone(),
                        resource_version: version,
                        action: ResourceAction::ArgoRefresh { hard },
                    }
                }
                WriteOperation::Update if call.name == "reconcile_flux_resource" => {
                    let mut after = before.as_ref().cloned().ok_or("Target not found")?;
                    let now = chrono::Utc::now().to_rfc3339();
                    if after.data.get("metadata").is_none() {
                        after.data["metadata"] = json!({});
                    }
                    if after.data["metadata"].get("annotations").is_none() {
                        after.data["metadata"]["annotations"] = json!({});
                    }
                    after.data["metadata"]["annotations"]["reconcile.fluxcd.io/requestedAt"] =
                        json!(now);
                    MutationIntent::Manifest {
                        context: session.scope.context.clone(),
                        manifest: serde_yaml::to_string(&after.data)
                            .map_err(|_| "Failed to format manifest")?,
                        target: Some(ManifestTarget {
                            resource: pinned.clone(),
                            resource_version: version.clone(),
                        }),
                    }
                }
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
                result=crate::mutation_guard::confirm_details(self.window.clone(),&pinned,prepared.review().into(),Some(prepared.details()))=>result.map_err(error_message),
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
        if let Ok(object) = &outcome {
            if let Some(uid) = object["metadata"]["uid"].as_str() {
                if let Ok(mut identities) = self.accepted_identities.lock() {
                    let identity = AcceptedIdentity { uid: uid.to_owned(), generation: object["metadata"]["generation"].as_u64() };
                    identities.insert(operation_id.clone(), identity.clone());
                    identities.insert(format!("call:{}", call.id), identity);
                }
            }
        }
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
            Ok(_) => Ok(
                json!({"operationId":operation_id,"status":"accepted","target":target,"message":"Kubernetes API accepted the change. This does not establish rollout completion or application health"}),
            ),
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
                    "privileged",
                    "allowPrivilegeEscalation",
                ]
                .contains(&k.as_str())
                    && v == true)
                    || (k == "automountServiceAccountToken" && v != false)
                    || [
                        "hostPath",
                        "nodeName",
                        "capabilities",
                        "hostPort",
                        "serviceAccountName",
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
    if value.pointer("/spec/template/spec").is_some()
        && value.pointer("/spec/template/spec/automountServiceAccountToken")
            != Some(&Value::Bool(false))
    {
        return Err("AI workload manifests must explicitly set spec.template.spec.automountServiceAccountToken: false".into());
    }
    fn visit(
        value: &Value,
        policy: &AgentPolicy,
        scope: &AgentScope,
        target: &Target,
    ) -> Result<(), String> {
        if let Some(map) = value.as_object() {
            for (key, value) in map {
                let reference = match key.as_str() {
                    "secretKeyRef" | "secretRef" => Some(("Secret", value["name"].as_str())),
                    "secret" if value.is_object() => Some(("Secret", value["secretName"].as_str())),
                    "configMapKeyRef" | "configMapRef" => {
                        Some(("ConfigMap", value["name"].as_str()))
                    }
                    "configMap" if value.is_object() => Some(("ConfigMap", value["name"].as_str())),
                    _ => None,
                };
                if let Some((kind, name)) = reference {
                    let referenced = Target {
                        group: "".into(),
                        version: "v1".into(),
                        kind: kind.into(),
                        namespace: target.namespace.clone(),
                        name: name
                            .ok_or("A referenced Secret/ConfigMap must have a name")?
                            .into(),
                    };
                    policy.check_scope(scope, &referenced)?;
                    if policy.access(&referenced, true) != DataAccess::Content {
                        return Err("This workload would consume Secret/ConfigMap contents that the AI policy does not permit. Grant an exact content-access rule or review the manifest manually".into());
                    }
                }
                visit(value, policy, scope, target)?;
            }
        } else if let Some(items) = value.as_array() {
            for item in items {
                visit(item, policy, scope, target)?;
            }
        }
        Ok(())
    }
    visit(value, policy, scope, target)
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
        let reader = resource_access(client, &target).await.unwrap();
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
            &reader,
            &policy,
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
            &reader,
            &policy,
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
            json!({"containers":[{"securityContext":{"privileged":true}}]}),
            json!({"containers":[{"ports":[{"hostPort":8080}]}]}),
            json!({"volumes":[{"hostPath":{"path":"/"}}]}),
            json!({"serviceAccountName":"admin"}),
            json!({"automountServiceAccountToken":true}),
        ] {
            assert!(
                reject_privileged_manifest(&json!({"spec":{"template":{"spec":spec}}})).is_err()
            );
        }
        assert!(reject_privileged_manifest(&json!({"spec":{"template":{"spec":{"automountServiceAccountToken":false,"containers":[{"name":"app","image":"example:1","securityContext":{"allowPrivilegeEscalation":false}}]}}}})).is_ok());
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
        let mut manifest = json!({"spec":{"template":{"spec":{"automountServiceAccountToken":false,"containers":[{"envFrom":[{"secretRef":{"name":"creds"}}]}]}}}});
        assert!(check_manifest_data_access(&manifest, &policy, &scope, &target).is_err());
        let policy = AgentPolicy {
            secrets: DataAccess::Content,
            ..policy
        };
        assert!(check_manifest_data_access(&manifest, &policy, &scope, &target).is_ok());
        manifest["spec"]["template"]["spec"]["automountServiceAccountToken"] = Value::Null;
        assert!(check_manifest_data_access(&manifest, &policy, &scope, &target).is_err());
    }
}
