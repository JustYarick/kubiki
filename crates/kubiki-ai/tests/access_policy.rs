use kubiki_ai::*;
use serde_json::json;

fn scope() -> AgentScope {
    AgentScope {
        context: "prod".into(),
        namespaces: vec!["apps".into()],
        all_namespaces: false,
    }
}
fn target(kind: &str) -> Target {
    Target {
        group: if kind == "Deployment" { "apps" } else { "" }.into(),
        version: "v1".into(),
        kind: kind.into(),
        namespace: Some("apps".into()),
        name: "web".into(),
    }
}

#[test]
fn read_only_and_default_permissions_block_every_write() {
    let policy = AgentPolicy::default();
    for mode in [AgentMode::ReadOnly, AgentMode::Ask, AgentMode::Accept] {
        for operation in [
            WriteOperation::Create,
            WriteOperation::Update,
            WriteOperation::Delete,
            WriteOperation::Scale,
            WriteOperation::Restart,
        ] {
            assert!(
                policy
                    .check_write(mode, &scope(), &target("Deployment"), operation)
                    .is_err()
            );
        }
    }
    let policy = AgentPolicy {
        writes: vec![WriteOperation::Scale],
        ..Default::default()
    };
    assert!(
        policy
            .check_write(
                AgentMode::ReadOnly,
                &scope(),
                &target("Deployment"),
                WriteOperation::Scale
            )
            .is_err()
    );
    assert!(
        policy
            .check_write(
                AgentMode::Ask,
                &scope(),
                &target("Deployment"),
                WriteOperation::Scale
            )
            .is_ok()
    );
    assert!(
        policy
            .check_write(
                AgentMode::Accept,
                &scope(),
                &target("Deployment"),
                WriteOperation::Scale
            )
            .is_ok()
    );
    assert!(
        policy
            .check_write(
                AgentMode::Accept,
                &scope(),
                &target("Deployment"),
                WriteOperation::Delete
            )
            .is_err()
    );
}

#[test]
fn namespace_and_context_limits_cannot_be_expanded_by_resource_rules() {
    let policy = AgentPolicy {
        contexts: vec!["prod*".into()],
        namespaces: vec!["apps".into()],
        writes: vec![WriteOperation::Create],
        ..Default::default()
    };
    let mut outside = target("Deployment");
    outside.namespace = Some("other".into());
    assert!(
        policy
            .check_write(
                AgentMode::Accept,
                &scope(),
                &outside,
                WriteOperation::Create
            )
            .is_err()
    );
    let broad_scope = AgentScope {
        all_namespaces: true,
        ..scope()
    };
    assert!(policy.check_scope(&broad_scope, &outside).is_err());
    let other_context = AgentScope {
        context: "development".into(),
        ..scope()
    };
    assert!(
        policy
            .check_scope(&other_context, &target("Deployment"))
            .is_err()
    );
    let mut node = target("Node");
    node.namespace = None;
    assert!(policy.check_scope(&scope(), &node).is_err());
    assert!(
        AgentPolicy {
            cluster_resources: true,
            ..policy
        }
        .check_scope(&scope(), &node)
        .is_ok()
    );
}

#[test]
fn secrets_and_configs_have_independent_defaults_and_exact_exceptions() {
    let mut policy = AgentPolicy::default();
    assert_eq!(policy.access(&target("Secret"), true), DataAccess::None);
    assert_eq!(
        policy.access(&target("ConfigMap"), true),
        DataAccess::Metadata
    );
    policy.rules.push(ResourceRule {
        group: "".into(),
        kind: "Secret".into(),
        namespace: "apps".into(),
        name: "web".into(),
        read: DataAccess::Content,
        writes: vec![],
    });
    let source = json!({"kind":"Secret","apiVersion":"v1","metadata":{"name":"web","namespace":"apps","annotations":{"private":"value"}},"data":{"token":"encoded-secret"}});
    assert_eq!(
        policy.project(&target("Secret"), &source, true).unwrap()["data"]["token"],
        "encoded-secret"
    );
    let other = Target {
        name: "database".into(),
        ..target("Secret")
    };
    assert!(policy.project(&other, &source, true).is_err());
    let metadata = policy.project(&target("ConfigMap"), &source, true).unwrap();
    assert!(metadata.get("data").is_none());
    assert!(metadata["metadata"].get("annotations").is_none());
    // Generic write grants never enable Secret or RBAC writes.
    policy.writes = vec![WriteOperation::Create];
    assert!(
        policy
            .check_write(
                AgentMode::Accept,
                &scope(),
                &target("Secret"),
                WriteOperation::Create
            )
            .is_err()
    );
}

#[test]
fn first_matching_rule_wins_and_can_deny_a_single_object() {
    let mut policy = AgentPolicy {
        writes: vec![WriteOperation::Restart],
        ..Default::default()
    };
    policy.rules.push(ResourceRule {
        group: "*".into(),
        kind: "*".into(),
        namespace: "apps".into(),
        name: "web".into(),
        read: DataAccess::None,
        writes: vec![],
    });
    policy.rules.push(ResourceRule {
        group: "*".into(),
        kind: "*".into(),
        namespace: "*".into(),
        name: "*".into(),
        read: DataAccess::Content,
        writes: vec![WriteOperation::Restart],
    });
    assert_eq!(policy.access(&target("Deployment"), true), DataAccess::None);
    assert!(
        policy
            .check_write(
                AgentMode::Accept,
                &scope(),
                &target("Deployment"),
                WriteOperation::Restart
            )
            .is_err()
    );
    let other = Target {
        name: "other".into(),
        ..target("Deployment")
    };
    assert!(
        policy
            .check_write(AgentMode::Accept, &scope(), &other, WriteOperation::Restart)
            .is_ok()
    );
}

#[test]
fn sensitive_workload_fields_annotations_and_denied_subtrees_are_removed() {
    let policy = AgentPolicy {
        denied_paths: vec![
            "/spec/template/spec/containers/0/image".into(),
            "/status/private".into(),
        ],
        ..Default::default()
    };
    let source = json!({"kind":"Deployment","apiVersion":"apps/v1","metadata":{"name":"web","annotations":{"kubectl.kubernetes.io/last-applied-configuration":"secret"},"managedFields":[{"fieldsV1":{"data":"secret"}}]},"spec":{"template":{"metadata":{"annotations":{"x":"secret"}},"spec":{"containers":[{"name":"app","image":"private-image","command":["echo","secret"],"args":["secret"],"env":[{"name":"PASSWORD","value":"secret"},{"name":"FROM_SECRET","valueFrom":{"secretKeyRef":{"name":"creds","key":"password"}}}]}]}}},"status":{"private":{"deep":"secret"},"replicas":1}});
    let result = policy
        .project(&target("Deployment"), &source, true)
        .unwrap();
    let text = result.to_string();
    assert!(!text.contains("private-image"));
    assert!(
        result["spec"]["template"]["spec"]["containers"][0]
            .get("command")
            .is_none()
    );
    assert!(
        result["spec"]["template"]["spec"]["containers"][0]["env"][0]
            .get("value")
            .is_none()
    );
    assert_eq!(
        result["spec"]["template"]["spec"]["containers"][0]["env"][1]["valueFrom"]["secretKeyRef"]
            ["name"],
        "creds"
    );
    assert!(result["status"].get("private").is_none());
    assert!(!text.contains("annotations"));
    assert!(!text.contains("managedFields"));
}

#[test]
fn custom_resource_contents_are_not_included_without_an_explicit_grant() {
    let t = Target {
        group: "example.com".into(),
        kind: "Database".into(),
        ..target("Secret")
    };
    let source = json!({"apiVersion":"example.com/v1","kind":"Database","metadata":{"name":"web"},"spec":{"credentials":{"opaqueKey":"private"}}});
    let policy = AgentPolicy::default();
    assert!(
        policy
            .project(&t, &source, false)
            .unwrap()
            .get("spec")
            .is_none()
    );
    // A curated registry entry must not silently turn a third-party CRD into
    // a trusted native Kubernetes schema.
    assert_eq!(policy.access(&t, true), DataAccess::Metadata);
}

#[test]
fn wildcard_matching_does_not_interpret_regular_expressions() {
    for (pattern, value, expected) in [
        ("*", "", true),
        ("team-*", "team-a", true),
        ("prod*east", "prod-eu-east", true),
        ("prod*east", "prod-west", false),
        (".*", "anything", false),
        ("", "", true),
        ("a**b", "axxb", true),
    ] {
        assert_eq!(matches(pattern, value), expected, "{pattern} / {value}");
    }
}

#[test]
fn full_collection_reads_are_only_used_when_no_identity_exception_can_apply() {
    let mut policy = AgentPolicy::default();
    let pod = target("Pod");
    assert!(policy.collection_content_allowed(&pod, true));
    assert!(!policy.collection_content_allowed(&target("Secret"), true));
    policy.rules.push(ResourceRule {
        group: "*".into(),
        kind: "Pod".into(),
        namespace: "apps".into(),
        name: "private-*".into(),
        read: DataAccess::None,
        writes: vec![],
    });
    assert!(!policy.collection_content_allowed(&pod, true));
    assert!(policy.collection_content_allowed(&target("Deployment"), true));
}

#[test]
fn prompt_policy_summary_stays_small_without_disclosing_exact_resource_rules() {
    let mut policy = AgentPolicy::default();
    for i in 0..100 {
        policy.rules.push(ResourceRule {
            group: "*".into(),
            kind: "Secret".into(),
            namespace: "apps".into(),
            name: format!("private-resource-{i}"),
            read: DataAccess::None,
            writes: vec![],
        });
    }
    let summary = policy.prompt_summary();
    assert!(summary.to_string().len() < 1024);
    assert_eq!(summary["resourceRuleCount"], 100);
    assert!(!summary.to_string().contains("private-resource"));
    assert_eq!(
        policy.access(
            &Target {
                name: "private-resource-0".into(),
                ..target("Secret")
            },
            true
        ),
        DataAccess::None
    );
}

#[test]
fn policy_explain_access_and_validate_rules_detect_shadowing_and_provide_rationale() {
    let mut policy = AgentPolicy::default();
    policy.rules.push(ResourceRule {
        group: "".into(),
        kind: "Secret".into(),
        namespace: "apps".into(),
        name: "nexus-creds".into(),
        read: DataAccess::Content,
        writes: vec![],
    });
    // Add a second rule that is completely shadowed
    policy.rules.push(ResourceRule {
        group: "".into(),
        kind: "Secret".into(),
        namespace: "apps".into(),
        name: "nexus-creds".into(),
        read: DataAccess::None,
        writes: vec![],
    });
    // Add broad wildcard rule
    policy.rules.push(ResourceRule {
        group: "*".into(),
        kind: "*".into(),
        namespace: "*".into(),
        name: "*".into(),
        read: DataAccess::Content,
        writes: vec![],
    });

    // 1. Validation detects shadowed rule and broad wildcard permission
    let issues = policy.validate_rules();
    assert_eq!(issues.len(), 2);
    assert_eq!(issues[0].kind, "shadowed");
    assert!(
        issues[0]
            .message
            .contains("completely shadowed by earlier Rule #0")
    );
    assert_eq!(issues[1].kind, "broad_permission");

    // 2. Explanation for exact Secret with rule match
    let target_secret = Target {
        group: "".into(),
        version: "v1".into(),
        kind: "Secret".into(),
        namespace: Some("apps".into()),
        name: "nexus-creds".into(),
    };
    let expl = policy.explain_access(
        AgentMode::ReadOnly,
        AgentPhase::Plan,
        &scope(),
        &target_secret,
        true,
        None,
    );
    assert!(expl.allowed);
    assert!(expl.scope_allowed);
    assert_eq!(expl.matched_rule_index, Some(0));
    assert_eq!(expl.data_access, DataAccess::Content);
    assert!(expl.explanation.contains("Matched rule #0"));

    // 3. Explanation for write check in ReadOnly mode
    let target_deploy = Target {
        group: "apps".into(),
        version: "v1".into(),
        kind: "Deployment".into(),
        namespace: Some("apps".into()),
        name: "web".into(),
    };
    let expl_write = policy.explain_access(
        AgentMode::ReadOnly,
        AgentPhase::Plan,
        &scope(),
        &target_deploy,
        true,
        Some(WriteOperation::Scale),
    );
    assert!(!expl_write.allowed);
    assert!(!expl_write.write_allowed);
    assert!(expl_write.explanation.contains("Plan phase forbids writes"));
}

#[test]
fn selected_field_permissions_never_restore_denied_data_or_allow_hidden_filters() {
    let pod = target("Pod");
    let policy = AgentPolicy {
        allowed_fields: vec!["spec.containers[*].image".into()],
        denied_paths: vec!["/spec/containers/0/image".into()],
        ..Default::default()
    };
    let out=policy.project(&pod,&json!({"metadata":{"name":"web","labels":{"private":"hidden"}},"spec":{"containers":[{"image":"excluded","resources":{"limits":{"cpu":"1"}}}]},"status":{"phase":"Running"}}),true).unwrap();
    assert!(!out.to_string().contains("excluded"));
    assert!(out.get("status").is_none());
    assert!(!policy.filter_field_allowed("metadata.labels"));
    assert!(!policy.filter_field_allowed("status.phase"));
    let metadata = AgentPolicy {
        allowed_fields: vec!["metadata.name".into()],
        ..Default::default()
    };
    assert_eq!(metadata.access(&pod, true), DataAccess::Metadata);
}
#[test]
fn deny_priority_is_explicitly_versioned_and_never_silently_changes_legacy_rules() {
    let mut policy = AgentPolicy {
        rules: vec![
            ResourceRule {
                group: "*".into(),
                kind: "*".into(),
                namespace: "*".into(),
                name: "*".into(),
                read: DataAccess::Content,
                writes: vec![WriteOperation::Scale],
            },
            ResourceRule {
                group: "*".into(),
                kind: "Deployment".into(),
                namespace: "apps".into(),
                name: "web".into(),
                read: DataAccess::None,
                writes: vec![],
            },
        ],
        ..Default::default()
    };
    let deployment = target("Deployment");
    assert_eq!(policy.access(&deployment, true), DataAccess::Content);
    policy.rule_resolution = RuleResolution::DenyOverrides;
    assert!(policy.validate().is_err());
    policy.schema_version = 2;
    policy.validate().unwrap();
    assert_eq!(policy.access(&deployment, true), DataAccess::None);
    assert!(
        policy
            .check_write(
                AgentMode::Accept,
                &scope(),
                &deployment,
                WriteOperation::Scale
            )
            .is_err()
    );
    assert_eq!(
        policy
            .explain_access(
                AgentMode::Ask,
                AgentPhase::Action,
                &scope(),
                &deployment,
                true,
                None
            )
            .matched_rule_index,
        Some(1)
    );
}

#[test]
fn confirmation_mode_applies_to_reads_and_writes_without_granting_access() {
    let mut policy = AgentPolicy::default();
    for tool in ["get_resource", "get_logs", "delete_resource", "propose_plan"] {
        assert!(policy.requires_confirmation(AgentMode::Ask, tool));
        assert!(!policy.requires_confirmation(AgentMode::Accept, tool));
    }
    policy.always_ask = vec!["get_logs".into(), "delete_resource".into()];
    assert!(policy.requires_confirmation(AgentMode::Accept, "get_logs"));
    assert!(policy.requires_confirmation(AgentMode::Accept, "delete_resource"));
    assert!(!policy.requires_confirmation(AgentMode::Accept, "get_resource"));
    assert!(policy.writes.is_empty());
    let restored: AgentPolicy = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(restored.always_ask.is_empty());
}
