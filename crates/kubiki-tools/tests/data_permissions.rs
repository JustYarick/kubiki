use kubiki_core::cluster::{client::ClusterClientPool, kubeconfig::KubeConfigManager};
use kubiki_tools::kubernetes::{HostConsent, KubernetesTools};
use kubiki_tools::*;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

fn session(policy: AgentPolicy) -> Session {
    Session::new(
        "permissions".into(),
        "test".into(),
        AgentScope {
            context: "fixture".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        },
        policy,
        ClusterCapabilities::all(),
    )
}

fn tools(session: &Session, reads: Arc<AtomicUsize>) -> KubernetesTools {
    let client = kube::Client::new(
        tower::service_fn(move |_: http::Request<kube::client::Body>| {
            reads.fetch_add(1, Ordering::SeqCst);
            async {
                Ok::<_, std::convert::Infallible>(http::Response::builder().header("content-type", "application/json")
                .body(kube::client::Body::from(serde_json::to_vec(&json!({
                    "apiVersion":"v1","kind":"Event","metadata":{"name":"fixture","namespace":"apps","uid":"uid"},"message":"event-content"
                })).unwrap())).unwrap())
            }
        }),
        "apps",
    );
    let mut tools = KubernetesTools::scoped(
        session,
        ClusterClientPool::new(KubeConfigManager::new()),
        None,
        None,
        Arc::new(HostConsent::default()),
        std::env::temp_dir().join("unused-permission-test-journal"),
        Arc::new(tokio::sync::Semaphore::new(2)),
    )
    .unwrap();
    tools.client = Some(client);
    tools
}

#[tokio::test]
async fn category_denials_block_generic_reads_and_lists_before_http_even_with_content_rules() {
    let policy = AgentPolicy {
        events: false,
        metrics: false,
        confirm_reads: false,
        custom_resources: DataAccess::Content,
        rules: vec![ResourceRule {
            group: "*".into(),
            kind: "*".into(),
            namespace: "*".into(),
            name: "*".into(),
            read: DataAccess::Content,
            writes: vec![],
        }],
        ..Default::default()
    };
    let session = session(policy);
    let reads = Arc::new(AtomicUsize::new(0));
    let tools = tools(&session, reads.clone());
    let _running = session.begin_run(0).unwrap();
    let emit: EventSink = Arc::new(|_| {});
    for (group, version, kind) in [
        ("", "v1", "Event"),
        ("events.k8s.io", "v1", "Event"),
        ("metrics.k8s.io", "v1beta1", "PodMetrics"),
    ] {
        for name in ["get_resource", "list_resources"] {
            let mut args = json!({"group":group,"version":version,"kind":kind,"namespace":"apps"});
            if name == "get_resource" {
                args["name"] = json!("fixture");
            }
            let result = tools
                .execute(
                    &session,
                    &ToolCall {
                        id: name.into(),
                        name: name.into(),
                        arguments: args,
                    },
                    &emit,
                )
                .await;
            assert!(result.unwrap_err().contains("disabled by policy"));
        }
    }
    assert_eq!(reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn policy_change_revokes_cached_payloads_without_reusing_evidence_ids() {
    let session = session(AgentPolicy {
        confirm_reads: false,
        ..Default::default()
    });
    let reads = Arc::new(AtomicUsize::new(0));
    let tools = tools(&session, reads.clone());
    let emit: EventSink = Arc::new(|_| {});
    let run = session.begin_run(0).unwrap();
    let old = tools.execute(&session, &ToolCall {id:"read".into(), name:"get_resource".into(), arguments:json!({"group":"","version":"v1","kind":"Event","namespace":"apps","name":"fixture"})}, &emit).await.unwrap();
    let id = session.save_evidence(0, &old).unwrap().unwrap();
    drop(run);
    let mut policy = session.control().unwrap().policy;
    policy.events = false;
    session.set_policy(policy).unwrap();
    assert!(session.save_evidence(0, &old).is_err());
    let revision = session.control().unwrap().revision;
    let _run = session.begin_run(revision).unwrap();
    let result = tools
        .execute(
            &session,
            &ToolCall {
                id: "cached".into(),
                name: "get_evidence".into(),
                arguments: json!({"evidenceId":id}),
            },
            &emit,
        )
        .await;
    assert!(result.is_err());
    let fresh = session
        .save_evidence(revision, &json!({"observation":"permitted"}))
        .unwrap()
        .unwrap();
    assert_ne!(id, fresh);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}

#[test]
fn diagnostic_crds_expose_status_without_values_and_preserve_explicit_denials() {
    let target = Target { group:"helm.toolkit.fluxcd.io".into(), version:"v2".into(), kind:"HelmRelease".into(), namespace:Some("apps".into()),name:"web".into() };
    let source = json!({"apiVersion":"helm.toolkit.fluxcd.io/v2","kind":"HelmRelease","metadata":{"name":"web"},"spec":{"values":{"password":"private"},"dependsOn":[{"name":"database"}],"chart":{"spec":{"valuesFiles":["private.yaml"]}}},"status":{"conditions":[{"type":"Ready","status":"False","reason":"RetriesExceeded"}],"installFailures":1,"lastAttemptedRevision":"1.2.3"}});
    let policy = AgentPolicy::default();
    let result = policy.project(&target,&source,false).unwrap();
    assert_eq!(result["status"]["installFailures"],1);
    assert_eq!(result["spec"]["dependsOn"][0]["name"],"database");
    assert!(result["spec"].get("values").is_none());
    assert!(result["spec"].get("chart").is_none());
    let fields = vec!["status.conditions".into(),"spec.values".into()];
    assert_eq!(policy.denied_fields(&target,false,&fields),vec!["spec.values"]);
    let metadata = AgentPolicy { custom_resources:DataAccess::Metadata, ..Default::default() };
    assert_eq!(metadata.denied_fields(&target,false,&fields),fields);
    let denied = AgentPolicy { rules:vec![ResourceRule {group:target.group.clone(),kind:target.kind.clone(),namespace:"*".into(),name:"*".into(),read:DataAccess::None,writes:vec![]}],..Default::default() };
    assert!(denied.project(&target,&source,false).is_err());
    assert_eq!(denied.denied_fields(&target,false,&fields),fields);
    let pod_target = Target { group:"".into(), version:"v1".into(), kind:"Pod".into(), namespace:Some("apps".into()), name:"web".into() };
    let restricted = AgentPolicy::default();
    assert_eq!(
        restricted.denied_fields(&pod_target, true, &[
            "metadata.name".into(),
            "metadata.annotations".into(),
            "spec.containers[*].command".into(),
            "spec.containers[*].env[*].value".into(),
            "spec.containers[*].image".into(),
        ]),
        vec![
            "metadata.annotations".to_string(),
            "spec.containers[*].command".to_string(),
            "spec.containers[*].env[*].value".to_string(),
        ]
    );
    let excluded = AgentPolicy { denied_paths:vec!["/status/conditions".into()],..Default::default() };
    assert!(excluded.project(&target,&source,false).unwrap()["status"].get("conditions").is_none());
    assert_eq!(excluded.denied_fields(&target,false,&["status.conditions[*].message".into()]),vec!["status.conditions[*].message"]);
}

#[tokio::test]
async fn exact_read_reports_when_all_requested_fields_are_denied() {
    let session = session(AgentPolicy { confirm_reads:false,rules:vec![ResourceRule { group:"".into(),kind:"Event".into(),namespace:"apps".into(),name:"fixture".into(),read:DataAccess::Metadata,writes:vec![] }], ..Default::default() });
    let tools = tools(&session, Arc::new(AtomicUsize::new(0)));
    let _run = session.begin_run(0).unwrap();
    let emit: EventSink = Arc::new(|_| {});
    let result = tools.execute(&session, &ToolCall { id:"read".into(),name:"get_resource".into(),arguments:json!({"group":"","version":"v1","kind":"Event","namespace":"apps","name":"fixture","fields":["status.conditions"]}) }, &emit).await.unwrap();
    assert_eq!(result["fieldAccess"]["allRequestedFieldsDenied"],true);
    assert_eq!(result["fieldAccess"]["denied"],json!(["status.conditions"]));
    assert!(result["resource"].get("status").is_none());
    assert_eq!(result["resource"]["metadata"]["name"],"fixture");
}

#[tokio::test]
async fn secrets_none_is_hard_ceiling_and_blocks_list_oracle_before_http() {
    let policy = AgentPolicy {
        secrets: DataAccess::None,
        confirm_reads: false,
        rules: vec![ResourceRule {
            group: "*".into(),
            kind: "*".into(),
            namespace: "*".into(),
            name: "*".into(),
            read: DataAccess::Content,
            writes: vec![],
        }],
        ..Default::default()
    };
    let session = session(policy);
    let reads = Arc::new(AtomicUsize::new(0));
    let tools = tools(&session, reads.clone());
    let _run = session.begin_run(0).unwrap();
    let emit: EventSink = Arc::new(|_| {});

    for (name, args) in [
        ("get_resource", json!({"group":"","version":"v1","kind":"Secret","namespace":"apps","name":"db-creds"})),
        ("list_resources", json!({"group":"","version":"v1","kind":"Secret","namespace":"apps","labelSelector":"app=db"})),
    ] {
        let err = tools
            .execute(&session, &ToolCall { id: name.into(), name: name.into(), arguments: args }, &emit)
            .await
            .unwrap_err();
        assert!(err.contains("disabled by policy"), "{name}: {err}");
    }
    assert_eq!(reads.load(Ordering::SeqCst), 0, "Secret list/get must not issue HTTP calls when secrets=None");
}

#[test]
fn deny_overrides_takes_minimum_read_and_intersects_writes() {
    let policy = AgentPolicy {
        schema_version: 2,
        rule_resolution: RuleResolution::DenyOverrides,
        read_only: false,
        secrets: DataAccess::Metadata,
        rules: vec![
            ResourceRule {
                group: "apps".into(),
                kind: "Deployment".into(),
                namespace: "apps".into(),
                name: "*".into(),
                read: DataAccess::Content,
                writes: vec![WriteOperation::Scale, WriteOperation::Restart],
            },
            ResourceRule {
                group: "apps".into(),
                kind: "Deployment".into(),
                namespace: "apps".into(),
                name: "critical-*".into(),
                read: DataAccess::Metadata,
                writes: vec![WriteOperation::Restart],
            },
        ],
        ..Default::default()
    };
    let scope = AgentScope { context: "prod".into(), namespaces: vec!["apps".into()], all_namespaces: false };
    let target = Target {
        group: "apps".into(),
        version: "v1".into(),
        kind: "Deployment".into(),
        namespace: Some("apps".into()),
        name: "critical-api".into(),
    };
    assert_eq!(policy.access(&target, true), DataAccess::Metadata);
    assert!(policy.check_write(AgentMode::Ask, &scope, &target, WriteOperation::Scale).is_err());
    assert!(policy.check_write(AgentMode::Ask, &scope, &target, WriteOperation::Restart).is_ok());
}

#[test]
fn wildcard_denied_paths_and_http_headers_and_volume_secrets_scrub_correctly() {
    let pod_target = Target {
        group: "".into(),
        version: "v1".into(),
        kind: "Pod".into(),
        namespace: Some("apps".into()),
        name: "web".into(),
    };
    let pod = json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": "web", "namespace": "apps"},
        "spec": {
            "volumes": [
                {"name": "certs", "secret": {"secretName": "tls-certs"}},
                {"name": "proj", "projected": {"sources": [{"secret": {"name": "proj-secret"}}]}}
            ],
            "containers": [
                {
                    "name": "app",
                    "image": "example:1",
                    "env": [{"name": "A", "value": "secret1"}],
                    "livenessProbe": {
                        "httpGet": {
                            "path": "/healthz",
                            "httpHeaders": [{"name": "X-Auth", "value": "bearer-leak"}]
                        }
                    }
                },
                {
                    "name": "sidecar",
                    "image": "sidecar:1",
                    "env": [{"name": "B", "value": "secret2"}]
                }
            ]
        }
    });
    let policy = AgentPolicy {
        workload_configuration: false,
        denied_paths: vec!["/spec/containers/*/env".into()],
        ..Default::default()
    };
    let projected = policy.project(&pod_target, &pod, true).unwrap();
    // Wildcard denied_paths removes env from ALL containers
    assert!(projected.pointer("/spec/containers/0/env").is_none());
    assert!(projected.pointer("/spec/containers/1/env").is_none());
    // Probe httpHeaders[].value is scrubbed when workload_configuration is false
    assert_eq!(projected.pointer("/spec/containers/0/livenessProbe/httpGet/httpHeaders/0/name"), Some(&json!("X-Auth")));
    assert!(projected.pointer("/spec/containers/0/livenessProbe/httpGet/httpHeaders/0/value").is_none());
    // Kubernetes Volume.secret and Projected.sources[].secret schema references remain intact
    assert_eq!(projected.pointer("/spec/volumes/0/secret/secretName"), Some(&json!("tls-certs")));
    assert_eq!(projected.pointer("/spec/volumes/1/projected/sources/0/secret/name"), Some(&json!("proj-secret")));

    // Sensitive string keys in ConfigMap / Helm values ARE scrubbed
    let cm_target = Target { kind: "ConfigMap".into(), ..pod_target };
    let cm_policy = AgentPolicy { config_maps: DataAccess::Content, ..Default::default() };
    let cm = json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"cfg"},"data":{"public":"ok","api_key":"leak","secret":"leak2","db_password":"leak3"}});
    let cm_out = cm_policy.project(&cm_target, &cm, true).unwrap();
    assert_eq!(cm_out["data"]["public"], "ok");
    assert!(cm_out["data"].get("api_key").is_none());
    assert!(cm_out["data"].get("secret").is_none());
    assert!(cm_out["data"].get("db_password").is_none());
}

#[tokio::test]
async fn helm_storage_exposes_all_revisions_and_conflicts_without_secret_bodies_while_values_requires_toggle() {
    let policy = AgentPolicy {
        confirm_reads: false,
        secrets: DataAccess::None,
        custom_resources: DataAccess::Content,
        helm_values: false,
        ..Default::default()
    };
    let session = session(policy);
    let client = kube::Client::new(
        tower::service_fn(|request: http::Request<kube::client::Body>| async move {
            let accept = request.headers().get("accept").and_then(|v| v.to_str().ok()).unwrap_or("");
            assert!(accept.contains("PartialObjectMetadata"), "Helm storage must only fetch metadata, got {accept}");
            let body = json!({
                "apiVersion": "meta.k8s.io/v1",
                "kind": "PartialObjectMetadataList",
                "metadata": {},
                "items": [
                    {"metadata": {"name": "sh.helm.release.v1.app.v1", "namespace": "apps", "labels": {"owner": "helm", "name": "app", "version": "1", "status": "superseded"}}},
                    {"metadata": {"name": "sh.helm.release.v1.app.v2", "namespace": "apps", "labels": {"owner": "helm", "name": "app", "version": "2", "status": "deployed"}}},
                    {"metadata": {"name": "sh.helm.release.v1.app.v3", "namespace": "apps", "labels": {"owner": "helm", "name": "app", "version": "3", "status": "pending-upgrade"}}}
                ]
            });
            Ok::<_, std::convert::Infallible>(
                http::Response::builder()
                    .header("content-type", "application/json")
                    .body(kube::client::Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
        }),
        "apps",
    );
    let mut tools = KubernetesTools::scoped(
        &session,
        ClusterClientPool::new(KubeConfigManager::new()),
        None,
        None,
        Arc::new(HostConsent::default()),
        std::env::temp_dir().join("helm-storage-test"),
        Arc::new(tokio::sync::Semaphore::new(2)),
    )
    .unwrap();
    tools.client = Some(client);
    let _run = session.begin_run(0).unwrap();
    let emit: EventSink = Arc::new(|_| {});

    // action="storage" works even with secrets=None & helm_values=false
    let storage = tools
        .execute(
            &session,
            &ToolCall { id: "h1".into(), name: "helm".into(), arguments: json!({"action":"storage","namespace":"apps","name":"app"}) },
            &emit,
        )
        .await
        .unwrap();
    assert_eq!(storage["storagePresent"], true);
    assert_eq!(storage["hasConflict"], true);
    assert_eq!(storage["revisions"].as_array().unwrap().len(), 3);
    assert_eq!(storage["latest"]["revision"], 3);
    assert_eq!(storage["latest"]["status"], "pending-upgrade");

    // action="values" MUST be blocked when helm_values=false, even with custom_resources=Content!
    let err = tools
        .execute(
            &session,
            &ToolCall { id: "h2".into(), name: "helm".into(), arguments: json!({"action":"values","namespace":"apps","name":"app"}) },
            &emit,
        )
        .await
        .unwrap_err();
    assert!(err.contains("helmValues"), "{err}");
}

#[tokio::test]
async fn cross_namespace_list_and_summarize_by_node_and_cluster_info_session() {
    let session = Session::new(
        "cross-ns".into(),
        "test".into(),
        AgentScope { context: "fixture".into(), namespaces: vec![], all_namespaces: true },
        AgentPolicy { confirm_reads: false, ..Default::default() },
        ClusterCapabilities::all(),
    );
    let client = kube::Client::new(
        tower::service_fn(|request: http::Request<kube::client::Body>| async move {
            assert_eq!(request.uri().path(), "/api/v1/pods");
            let body = json!({
                "apiVersion": "v1",
                "kind": "PodList",
                "metadata": {},
                "items": [
                    {"apiVersion":"v1","kind":"Pod","metadata":{"name":"p1","namespace":"ns-a","uid":"u1"},"spec":{"nodeName":"node-1"},"status":{"phase":"Running"}},
                    {"apiVersion":"v1","kind":"Pod","metadata":{"name":"p2","namespace":"ns-b","uid":"u2"},"spec":{"nodeName":"node-1"},"status":{"phase":"Failed","reason":"Evicted"}},
                    {"apiVersion":"v1","kind":"Pod","metadata":{"name":"p3","namespace":"ns-b","uid":"u3"},"spec":{"nodeName":"node-2"},"status":{"phase":"Pending"}},
                    {"apiVersion":"v1","kind":"Pod","metadata":{"name":"ds-pending","namespace":"kube-system","uid":"u4"},"spec":{"affinity":{"nodeAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":{"nodeSelectorTerms":[{"matchFields":[{"key":"metadata.name","operator":"In","values":["node-3"]}]}]}}}},"status":{"phase":"Pending"}}
                ]
            });
            Ok::<_, std::convert::Infallible>(
                http::Response::builder()
                    .header("content-type", "application/json")
                    .body(kube::client::Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
        }),
        "default",
    );
    let mut tools = KubernetesTools::scoped(
        &session,
        ClusterClientPool::new(KubeConfigManager::new()),
        None,
        None,
        Arc::new(HostConsent::default()),
        std::env::temp_dir().join("cross-ns-test"),
        Arc::new(tokio::sync::Semaphore::new(2)),
    )
    .unwrap();
    tools.client = Some(client);
    let _run = session.begin_run(0).unwrap();
    let emit: EventSink = Arc::new(|_| {});

    let info = tools
        .execute(&session, &ToolCall { id: "ci".into(), name: "cluster_info".into(), arguments: json!({}) }, &emit)
        .await
        .unwrap();
    assert_eq!(info["view"], "session");
    assert_eq!(info["context"], "fixture");
    assert_eq!(info["policy"]["helmValues"], false);

    let summary = tools
        .execute(
            &session,
            &ToolCall {
                id: "sum".into(),
                name: "summarize_resources".into(),
                arguments: json!({"group":"","version":"v1","kind":"Pod","namespace":"*","groupBy":"nodeName"}),
            },
            &emit,
        )
        .await
        .unwrap();
    assert!(summary.get("error").is_none(), "successful summarize_resources must not emit error: null");
    assert_eq!(summary["objectsExamined"], 4);
    assert_eq!(summary["counts"]["node-1"], 2);
    assert_eq!(summary["counts"]["node-2"], 1);
    assert_eq!(summary["counts"]["unscheduled:node-3"], 1);
}

#[test]
fn expanded_diagnostic_crds_expose_argocd_cert_manager_gateway_keda_without_values() {
    let policy = AgentPolicy::default();
    let argo_target = Target { group: "argoproj.io".into(), version: "v1alpha1".into(), kind: "Application".into(), namespace: Some("argocd".into()), name: "app".into() };
    let argo = json!({"apiVersion":"argoproj.io/v1alpha1","kind":"Application","metadata":{"name":"app"},"spec":{"source":{"repoURL":"https://git/repo","path":"charts/app","helm":{"values":"secret: value"}}},"status":{"health":{"status":"Degraded"},"sync":{"status":"OutOfSync"}}});
    let proj = policy.project(&argo_target, &argo, false).unwrap();
    assert_eq!(proj["status"]["health"]["status"], "Degraded");
    assert_eq!(proj["spec"]["source"]["repoURL"], "https://git/repo");
    assert!(proj["spec"]["source"].get("helm").is_none());

    let cert_target = Target { group: "cert-manager.io".into(), version: "v1".into(), kind: "Certificate".into(), namespace: Some("apps".into()), name: "tls".into() };
    let cert = json!({"apiVersion":"cert-manager.io/v1","kind":"Certificate","metadata":{"name":"tls"},"spec":{"secretName":"tls-secret","dnsNames":["a.example.com"]},"status":{"conditions":[{"type":"Ready","status":"False","message":"ACME challenge failed"}]}});
    let cert_proj = policy.project(&cert_target, &cert, false).unwrap();
    assert_eq!(cert_proj["status"]["conditions"][0]["message"], "ACME challenge failed");
}

#[test]
fn denial_hints_point_to_exact_settings_toggles_for_annotations_flux_and_secrets() {
    let mut policy = AgentPolicy::default();
    policy.annotations = false;
    policy.custom_resources = DataAccess::Metadata;
    policy.secrets = DataAccess::None;

    let svc = Target { group: "".into(), version: "v1".into(), kind: "Service".into(), namespace: Some("istio-system".into()), name: "istio-gateway".into() };
    let svc_hints = policy.denial_hints(&svc, true, &["metadata.annotations".into()]);
    assert!(svc_hints.iter().any(|h| h["setting"] == "Annotations" && h["location"].as_str().unwrap_or("").contains("Settings → AI / MCP Access")));

    let hr = Target { group: "helm.toolkit.fluxcd.io".into(), version: "v2".into(), kind: "HelmRelease".into(), namespace: Some("istio-system".into()), name: "istio-gateway".into() };
    let hr_hints = policy.denial_hints(&hr, false, &["status.conditions".into()]);
    assert!(hr_hints.iter().any(|h| h["setting"] == "Custom resources" && h["recommendedAction"].as_str().unwrap_or("").contains("Diagnostic fields")));

    let secret = Target { group: "".into(), version: "v1".into(), kind: "Secret".into(), namespace: Some("default".into()), name: "db".into() };
    let err = policy.resource_denial_message(&secret, true);
    assert!(err.contains("Settings → AI / MCP Access → Data & Categories → Secrets"));
}
