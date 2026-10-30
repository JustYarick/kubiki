use kubiki_ai::*;

#[test]
fn session_starts_in_read_only_and_plan_by_default() {
    let session = Session::new(
        "test-session".into(),
        "win".into(),
        AgentScope::default(),
        AgentPolicy::default(),
    );
    let control = session.control().unwrap();
    assert_eq!(control.mode, AgentMode::ReadOnly);
    assert_eq!(control.phase, AgentPhase::Plan);
}

#[test]
fn plan_phase_omits_every_write_tool_even_in_accept_mode() {
    let policy = AgentPolicy {
        writes: vec![WriteOperation::Scale, WriteOperation::Restart],
        ..Default::default()
    };
    // In Plan phase, write tools are not offered
    let plan_tools = tool_definitions(&policy, AgentMode::Accept, AgentPhase::Plan);
    assert!(!plan_tools.iter().any(|t| t.name == "scale_workload"));
    assert!(!plan_tools.iter().any(|t| t.name == "restart_workload"));
    assert!(!plan_tools.iter().any(|t| t.name == "apply_manifest"));
    assert!(!plan_tools.iter().any(|t| t.name == "delete_resource"));

    // In Action phase with Accept mode, write tools ARE offered
    let action_tools = tool_definitions(&policy, AgentMode::Accept, AgentPhase::Action);
    assert!(action_tools.iter().any(|t| t.name == "scale_workload"));
    assert!(action_tools.iter().any(|t| t.name == "restart_workload"));
}

#[test]
fn action_phase_is_rejected_in_read_only_mode() {
    let session = Session::new(
        "test-session".into(),
        "win".into(),
        AgentScope::default(),
        AgentPolicy::default(),
    );
    assert!(session.phase(AgentPhase::Action).is_err());
    assert_eq!(session.control().unwrap().phase, AgentPhase::Plan);

    // Switch to Ask mode first
    session.mode(AgentMode::Ask).unwrap();
    assert!(session.phase(AgentPhase::Action).is_ok());
    assert_eq!(session.control().unwrap().phase, AgentPhase::Action);
}

#[test]
fn switching_to_read_only_downgrades_action_to_plan() {
    let session = Session::new(
        "test-session".into(),
        "win".into(),
        AgentScope::default(),
        AgentPolicy::default(),
    );
    session.mode(AgentMode::Accept).unwrap();
    session.phase(AgentPhase::Action).unwrap();
    assert_eq!(session.control().unwrap().phase, AgentPhase::Action);

    // Downgrade to ReadOnly
    session.mode(AgentMode::ReadOnly).unwrap();
    let control = session.control().unwrap();
    assert_eq!(control.mode, AgentMode::ReadOnly);
    assert_eq!(control.phase, AgentPhase::Plan);
}

#[test]
fn stop_does_not_reset_phase() {
    let session = Session::new(
        "test-session".into(),
        "win".into(),
        AgentScope::default(),
        AgentPolicy::default(),
    );
    session.mode(AgentMode::Ask).unwrap();
    session.phase(AgentPhase::Action).unwrap();
    assert_eq!(session.control().unwrap().phase, AgentPhase::Action);

    // Stopping generation retains user's chosen phase
    session.stop();
    let control = session.control().unwrap();
    assert_eq!(control.phase, AgentPhase::Action);
}

#[test]
fn authorize_dispatch_strictly_rejects_plan_phase() {
    let session = Session::new(
        "test-session".into(),
        "win".into(),
        AgentScope {
            context: "prod".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        },
        AgentPolicy {
            writes: vec![WriteOperation::Scale],
            ..Default::default()
        },
    );
    session.mode(AgentMode::Accept).unwrap();
    let target = Target {
        group: "apps".into(),
        version: "v1".into(),
        kind: "Deployment".into(),
        namespace: Some("apps".into()),
        name: "web".into(),
    };
    // Revision is 1 (from mode switch), but phase is still Plan
    let revision = session.control().unwrap().revision;
    let err = session
        .authorize_dispatch(revision, &target, WriteOperation::Scale)
        .unwrap_err();
    assert!(err.contains("strictly prohibited during the Plan phase") || err.contains("Plan phase"));
}
