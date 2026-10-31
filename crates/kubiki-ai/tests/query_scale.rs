//! Offline query/evidence evaluations. These do not measure API-server or LLM latency.
use kubiki_ai::*;
use serde_json::{Value, json};

fn target() -> Target {
    Target {
        group: "".into(),
        version: "v1".into(),
        kind: "Pod".into(),
        namespace: Some("apps".into()),
        name: "web".into(),
    }
}
#[test]
fn diagnostic_profiles_preserve_pending_crash_oom_and_image_pull_evidence() {
    let selection = FieldSelection::new(&profile_fields("health").unwrap().unwrap()).unwrap();
    for (reason, state) in [
        (
            "Unschedulable",
            json!({"phase":"Pending","conditions":[{"type":"PodScheduled","status":"False","reason":"Unschedulable"}]}),
        ),
        (
            "CrashLoopBackOff",
            json!({"containerStatuses":[{"name":"app","state":{"waiting":{"reason":"CrashLoopBackOff"}},"restartCount":4}]}),
        ),
        (
            "OOMKilled",
            json!({"containerStatuses":[{"name":"app","lastState":{"terminated":{"reason":"OOMKilled","exitCode":137}}}]}),
        ),
        (
            "ImagePullBackOff",
            json!({"containerStatuses":[{"name":"app","state":{"waiting":{"reason":"ImagePullBackOff"}}}]}),
        ),
    ] {
        let source = json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"web","namespace":"apps","uid":"1"},"status":state});
        let projected = AgentPolicy::default()
            .project(&target(), &source, true)
            .unwrap();
        let selected = selection.apply(&projected);
        assert!(
            selected.to_string().contains(reason),
            "lost diagnostic evidence: {reason}"
        );
    }
}
#[test]
fn scoped_fields_and_aggregation_stay_bounded_at_ten_thousand_objects() {
    let policy = AgentPolicy::default();
    let fields = FieldSelection::new(&[
        "spec.containers[*].name".into(),
        "spec.containers[*].image".into(),
        "status.phase".into(),
    ])
    .unwrap();
    let env_from: Vec<Value> = (0..32)
        .map(|i| json!({"configMapRef":{"name":format!("shared-configuration-{i}")}}))
        .collect();
    let source = json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"web","namespace":"apps","uid":"1"},"spec":{"containers":[{"name":"app","image":"app:1","envFrom":env_from,"resources":{"requests":{"cpu":"100m","memory":"128Mi"}},"volumeMounts":[{"name":"config","mountPath":"/etc/app"}]}]},"status":{"phase":"Pending","conditions":[{"type":"PodScheduled","status":"False","message":"insufficient cpu"}]}});
    for count in [1, 10, 1000, 10_000] {
        let mut original_bytes = 0;
        let mut selected_bytes = 0;
        let mut summary = ResourceSummary::new("phase").unwrap();
        for _ in 0..count {
            let projected = policy.project(&target(), &source, true).unwrap();
            let selected = fields.apply(&projected);
            original_bytes += projected.to_string().len();
            selected_bytes += selected.to_string().len();
            summary.add(&selected);
        }
        assert!(
            selected_bytes * 100 <= original_bytes * 30,
            "field projection must reduce payload by at least 70%"
        );
        assert_eq!(summary.value()["counts"]["Pending"], count);
        assert!(summary.value().to_string().len() < 2000);
        println!(
            "objects={count} baseline_bytes={original_bytes} selected_bytes={selected_bytes} summary_bytes={}",
            summary.value().to_string().len()
        );
    }
}
#[test]
fn denied_evidence_is_not_reintroduced_by_profiles_or_aggregation() {
    let policy = AgentPolicy {
        denied_paths: vec!["/status/phase".into(), "/spec/containers/0/image".into()],
        ..Default::default()
    };
    let source = json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"web"},"status":{"phase":"Failed"},"spec":{"containers":[{"name":"app","image":"private"}]}});
    let filtered = policy.project(&target(), &source, true).unwrap();
    let selected = FieldSelection::new(&["status.phase".into(), "spec.containers[*].image".into()])
        .unwrap()
        .apply(&filtered);
    let mut summary = ResourceSummary::new("phase").unwrap();
    summary.add(&selected);
    assert_eq!(summary.value()["counts"]["unknown"], 1);
    assert!(!selected.to_string().contains("private"));
}
