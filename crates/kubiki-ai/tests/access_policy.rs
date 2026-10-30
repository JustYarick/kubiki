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
