//! Agent tools compose existing core operations. No shell, arbitrary HTTP or
//! renderer-supplied authorization enters this boundary.
use crate::mutation_guard::MutationGuard;
use async_trait::async_trait;
use kube::{
    Api, Client,
    api::{ApiResource, DynamicObject, ListParams},
    discovery::{Discovery, Scope},
};
use kubiki_ai::*;
use kubiki_core::core::{
    api::{ResourceQuery, ResourceRef, resource_type, resource_types},
    mutations::{ManifestTarget, MutationIntent, PreparedMutation, ResourceAction},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

pub struct KubernetesTools {
    pub window: tauri::WebviewWindow,
    pub client: Option<Client>,
    pub journal: PathBuf,
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
        || !segment(&target.name, !named)
        || target
            .namespace
            .as_ref()
            .is_some_and(|s| !segment(s, false))
    {
        return Err("Invalid resource identity".into());
    }
    Ok(())
}

async fn api(client: Client, target: &Target) -> Result<(Api<DynamicObject>, bool), String> {
    validate_target(target, false)?;
    let builtin = resource_type(&target.kind).filter(|r| r.group == target.group);
    let (ar, namespaced) = if let Some(known) = builtin {
        if known.version != target.version {
            // Discovery validates non-default served versions too.
            let discovery = Discovery::new(client.clone())
                .filter(&[&target.group])
                .run()
                .await
                .map_err(|_| "API discovery failed")?;
            let group = discovery
                .groups()
                .find(|g| g.name() == target.group)
                .ok_or("Unknown API group")?;
            group
                .resources_by_stability()
                .into_iter()
                .find(|(r, _)| r.kind == target.kind && r.version == target.version)
                .map(|(r, c)| (r, c.scope == Scope::Namespaced))
                .ok_or("Unsupported resource version")?
        } else {
            (
                ApiResource {
                    group: target.group.clone(),
                    version: target.version.clone(),
                    api_version: if target.group.is_empty() {
                        target.version.clone()
                    } else {
                        format!("{}/{}", target.group, target.version)
                    },
                    kind: target.kind.clone(),
                    plural: known.plural.clone(),
                },
                known.namespaced,
            )
        }
    } else {
        let discovery = Discovery::new(client.clone())
            .filter(&[&target.group])
            .run()
            .await
            .map_err(|_| "API discovery failed")?;
        let group = discovery
            .groups()
            .find(|g| g.name() == target.group)
            .ok_or("Unknown API group")?;
        group
            .resources_by_stability()
            .into_iter()
            .find(|(r, _)| r.kind == target.kind && r.version == target.version)
            .map(|(r, c)| (r, c.scope == Scope::Namespaced))
            .ok_or("Unknown resource kind/version")?
    };
    if namespaced != target.namespace.is_some() {
        return Err("Specify one explicit namespace for namespaced resources; cluster resources require null namespace".into());
    }
    let resource_api = if let Some(ns) = &target.namespace {
        Api::namespaced_with(client, ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };
    Ok((resource_api, builtin.is_some()))
}

#[async_trait]
impl ToolExecutor for KubernetesTools {
    async fn execute(
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
        if !tool_definitions(&state.policy, state.mode, state.phase)
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
            if call.arguments.as_object().is_none_or(|o| !o.is_empty())
                || !state
                    .policy
                    .contexts
                    .iter()
                    .any(|p| kubiki_ai::matches(p, &session.scope.context))
            {
                return Err(
                    "Namespace discovery is outside policy or has invalid arguments".into(),
                );
            }
            let mut cancellation = session.cancellation();
            let read = async {
                let (names, more) = if session.scope.all_namespaces {
                    let namespaces: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client);
                    let page=namespaces.list_metadata(&ListParams::default().limit(200)).await.map_err(|_| "Namespace discovery is denied or unavailable. Use an explicitly selected namespace scope")?;
                    (
                        page.items
                            .into_iter()
                            .filter_map(|n| n.metadata.name)
                            .collect::<Vec<_>>(),
                        page.metadata.continue_.is_some_and(|s| !s.is_empty()),
                    )
                } else {
                    (session.scope.namespaces.clone(), false)
                };
                let names: Vec<_> = names
                    .into_iter()
                    .filter(|name| {
                        state
                            .policy
                            .namespaces
                            .iter()
                            .any(|p| kubiki_ai::matches(p, name))
                            && state.policy.access(
                                &Target {
                                    group: "".into(),
                                    version: "v1".into(),
                                    kind: "Namespace".into(),
                                    namespace: None,
                                    name: name.clone(),
                                },
                                true,
                            ) != DataAccess::None
                    })
                    .collect();
                Ok(
                    json!({"namespaces":names,"hasMore":more,"coverage":"Namespace names only; filtered by conversation scope and access policy; capped at 200"}),
                )
            };
            return tokio::select! { biased; _=cancelled(&mut cancellation)=>Err("Namespace discovery cancelled".into()), result=tokio::time::timeout(Duration::from_secs(20),read)=>result.map_err(|_| "Namespace discovery timed out")? };
        }
        if ["get_logs", "get_events", "get_metrics"].contains(&call.name.as_str()) {
            return self.read_diagnostic(session, call, client).await;
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
        let args: ResourceArgs = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid resource tool arguments")?;
        if args.replicas.is_some() {
            return Err("Read tools do not accept replicas".into());
        }
        let target = args.target();
        validate_target(&target, call.name == "get_resource")?;
        state.policy.check_scope(&session.scope, &target)?;
        let mut cancellation = session.cancellation();
        let read = async {
            let (api, builtin) = api(client, &target).await?;
            if call.name == "get_resource" {
                // Do not fetch an explicitly denied exact resource.
                if state.policy.access(&target, builtin) == DataAccess::None {
                    return Err("Reading this resource is disabled by policy".into());
                }
                let value = if state.policy.access(&target, builtin) == DataAccess::Metadata {
                    let object = api
                        .get_metadata(&target.name)
                        .await
                        .map_err(|_| "Resource metadata read failed")?;
                    json!({"apiVersion":if target.group.is_empty() {target.version.clone()} else {format!("{}/{}",target.group,target.version)},"kind":target.kind,"metadata":object.metadata})
                } else {
                    serde_json::to_value(
                        api.get(&target.name).await.map_err(
                            |_| "Resource read failed; check identity and Kubernetes RBAC",
                        )?,
                    )
                    .map_err(|_| "Cannot encode resource")?
                };
                let data = state.policy.project(&target, &value, builtin)?;
                bounded_result(
                    json!({"capturedAt":stamp(),"resource":data,"coverage":"Policy-filtered live Kubernetes read; omitted fields are not evidence of absence"}),
                )
            } else if call.name == "list_resources" {
                if !target.name.is_empty() {
                    return Err("Use get_resource for an exact object".into());
                }
                // Discover identities without fetching Secret/ConfigMap contents.
                // Fetch complete objects only after the exact rule grants content.
                let page = api
                    .list_metadata(&ListParams::default().limit(50))
                    .await
                    .map_err(|_| "Resource list failed; check identity and Kubernetes RBAC")?;
                let mut omitted = 0;
                let mut items = Vec::new();
                for item in page.items {
                    let actual = Target {
                        name: item.metadata.name.clone().unwrap_or_default(),
                        ..target.clone()
                    };
                    let access = state.policy.access(&actual, builtin);
                    if access == DataAccess::None {
                        omitted += 1;
                        continue;
                    }
                    let value = if access == DataAccess::Content {
                        serde_json::to_value(
                            api.get(&actual.name)
                                .await
                                .map_err(|_| "Resource changed or access was denied during list")?,
                        )
                        .map_err(|_| "Cannot encode resource")?
                    } else {
                        json!({"apiVersion":if target.group.is_empty() {target.version.clone()} else {format!("{}/{}",target.group,target.version)},"kind":target.kind,"metadata":item.metadata})
                    };
                    match state.policy.project(&actual, &value, builtin) {
                        Ok(data) => items.push(data),
                        Err(_) => omitted += 1,
                    }
                }
                bounded_result(
                    json!({"capturedAt":stamp(),"items":items,"omittedByPolicy":omitted,"hasMore":page.metadata.continue_.is_some_and(|s| !s.is_empty()),"coverage":"First 50 objects only; filtered by policy"}),
                )
            } else {
                Err("Unknown AI tool".into())
            }
        };
        tokio::select! { biased; _ = cancelled(&mut cancellation) => Err("Read cancelled".into()), result = tokio::time::timeout(Duration::from_secs(20), read) => result.map_err(|_| "AI resource read timed out")? }
    }
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
        #[serde(deny_unknown_fields)]
        struct Args {
            namespace: String,
            name: Option<String>,
            uid: Option<String>,
            container: Option<String>,
            previous: Option<bool>,
        }
        let args: Args = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid diagnostic arguments")?;
        let state = session.control()?;
        let target = Target {
            group: "".into(),
            version: "v1".into(),
            kind: if call.name == "get_events" {
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
                if !state.policy.logs || state.policy.access(&target, true) == DataAccess::None {
                    return Err("Pod logs are disabled by policy".into());
                }
                let request = kubiki_core::pod_ops::logs::LogSliceRequest {
                    resource: reference(&session.scope.context, &target, args.uid),
                    container: args.container.ok_or("Container is required")?,
                    previous: args.previous.unwrap_or(false),
                    tail_lines: Some(150),
                    since_time: None,
                    since_seconds: Some(3600),
                };
                let logs = request.read(client).await.map_err(error_message)?;
                Ok(
                    json!({"capturedAt":stamp(),"logs":logs.chars().take(24000).collect::<String>(),"coverage":"Last 150 lines within 1 hour; capped at 24000 characters; untrusted text may contain sensitive data"}),
                )
            } else if call.name == "get_events" {
                if !state.policy.events {
                    return Err("Events are disabled by policy".into());
                }
                if args.uid.is_some() || args.container.is_some() || args.previous.is_some() {
                    return Err("Unexpected Event arguments".into());
                }
                let (api, _) = api(client, &target).await?;
                let mut params = ListParams::default().limit(50);
                if !target.name.is_empty() {
                    params = params.fields(&format!("involvedObject.name={}", target.name));
                }
                let page = api.list(&params).await.map_err(|_| "Cannot read Events")?;
                let mut items = Vec::new();
                for item in page.items {
                    let actual = Target {
                        name: item.metadata.name.clone().unwrap_or_default(),
                        ..target.clone()
                    };
                    if state.policy.access(&actual, true) == DataAccess::None {
                        continue;
                    }
                    let value = serde_json::to_value(item).map_err(|_| "Cannot encode Event")?;
                    // Events inherit the data projection and explicit denied paths too.
                    items.push(state.policy.project(&actual, &value, true)?);
                }
                bounded_result(
                    json!({"capturedAt":stamp(),"items":items,"hasMore":page.metadata.continue_.is_some_and(|s| !s.is_empty()),"coverage":"First 50 matching Events; may include previous resource incarnations; compare involvedObject.uid"}),
                )
            } else {
                if !state.policy.metrics
                    || args.name.is_some()
                    || args.uid.is_some()
                    || args.container.is_some()
                    || args.previous.is_some()
                {
                    return Err("Metrics are disabled or arguments are invalid".into());
                }
                let metrics = kubiki_core::metrics::client::MetricsService::get_pod_metrics(
                    &client,
                    Some(&args.namespace),
                )
                .await
                .map_err(|_| "Metrics API is unavailable or denied")?;
                let items: Vec<_> = metrics
                    .into_iter()
                    .filter(|m| {
                        state.policy.access(
                            &Target {
                                name: m.name.clone(),
                                ..target.clone()
                            },
                            true,
                        ) != DataAccess::None
                    })
                    .take(50)
                    .collect();
                Ok(
                    json!({"capturedAt":stamp(),"metrics":items,"coverage":"Up to 50 permitted Pod metrics in one namespace"}),
                )
            }
        };
        tokio::select! { biased; _ = cancelled(&mut cancellation) => Err("Read cancelled".into()), result = tokio::time::timeout(Duration::from_secs(20), read) => result.map_err(|_| "Diagnostic read timed out")? }
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
        let (target, yaml, requested_op, replicas) = if call.name == "apply_manifest" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Manifest {
                yaml: String,
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
            check_manifest_data_access(&value, &state.policy, &session.scope, &target)?;
            if value["spec"]["replicas"]
                .as_u64()
                .is_some_and(|n| n > u64::from(state.policy.max_replicas))
            {
                return Err("Manifest replica count exceeds the AI policy limit".into());
            }
            if target.kind == "HorizontalPodAutoscaler"
                && value["spec"]["maxReplicas"]
                    .as_u64()
                    .is_some_and(|n| n > u64::from(state.policy.max_replicas))
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
            if op == WriteOperation::Scale
                && args.replicas.is_none_or(|r| r > state.policy.max_replicas)
            {
                return Err("Replica count exceeds the AI policy limit or is missing".into());
            }
            if op != WriteOperation::Scale && args.replicas.is_some() {
                return Err("Unexpected replicas argument".into());
            }
            (args.target(), None, Some(op), args.replicas)
        };
        validate_target(&target, true)?;
        if let Some(op) = requested_op {
            state
                .policy
                .check_write(state.mode, &session.scope, &target, op)?;
        } else if state
            .policy
            .check_write(state.mode, &session.scope, &target, WriteOperation::Create)
            .is_err()
            && state
                .policy
                .check_write(state.mode, &session.scope, &target, WriteOperation::Update)
                .is_err()
        {
            return Err("Manifest create/update is disabled by policy".into());
        }
        let resource = reference(&session.scope.context, &target, None);
        let guard = self.window.state::<MutationGuard>();
        let _gate = guard.acquire(&resource).map_err(error_message)?;
        let (api, _) = tokio::time::timeout(Duration::from_secs(15), api(client.clone(), &target))
            .await
            .map_err(|_| "API discovery timed out")??;
        let before = tokio::time::timeout(Duration::from_secs(15), api.get_opt(&target.name))
            .await
            .map_err(|_| "Mutation preparation timed out")?
            .map_err(|_| "Cannot read target for mutation preparation")?;
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
        if state.mode == AgentMode::Ask {
            emit(AgentEvent::Status {
                status: "awaiting_approval".into(),
            });
            let mut cancellation = session.cancellation();
            let approved = tokio::select! {
                biased;
                _ = cancelled(&mut cancellation) => return Err("Change cancelled before dispatch".into()),
                result = crate::mutation_guard::confirm_details(self.window.clone(), &pinned, prepared.review().into(), Some(prepared.details())) => result.map_err(error_message)?,
            };
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
                json!({"operationId":operation_id,"status":status,"target":target,"error":error_message(error),"retry":false}),
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
        for name in ["../secrets", "web?watch=true", "web\nsecret", ""] {
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
