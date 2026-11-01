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

#[test]
fn service_pvc_and_rollout_diagnostics_preserve_reproducible_evidence() {
    // 1. Unready Service with 0 endpoints and matching pods failing readiness probe
    let svc = json!({
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {"name": "api-service", "namespace": "apps", "uid": "svc-1"},
        "spec": {
            "type": "ClusterIP",
            "clusterIP": "10.96.10.5",
            "selector": {"app": "api"},
            "ports": [{"name": "http", "port": 80, "targetPort": 8080}]
        }
    });
    let pods = [
        json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {"name": "api-pod-0", "namespace": "apps", "uid": "pod-0"},
            "spec": {"containers": [{"name": "api", "ports": [{"containerPort": 8080}]}]},
            "status": {
                "phase": "Running",
                "conditions": [{"type": "Ready", "status": "False"}, {"type": "ContainersReady", "status": "False"}]
            }
        })
    ];
    let svc_diag = service_diagnostics(&svc, None, Some(&pods));
    let svc_issues: Vec<&str> = svc_diag["issuesSummary"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(svc_issues.iter().any(|i| i.contains("Ready=False")));

    // 2. Stuck PVC (WaitForFirstConsumer and StorageClass pending)
    let pvc = json!({
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {"name": "data-pvc", "namespace": "apps", "uid": "pvc-1"},
        "spec": {
            "storageClassName": "standard-wait",
            "accessModes": ["ReadWriteOnce"],
            "resources": {"requests": {"storage": "50Gi"}}
        },
        "status": {"phase": "Pending"}
    });
    let pvc_events = [json!({
        "reason": "WaitForFirstConsumer",
        "message": "waiting for first consumer to be created before binding"
    })];
    let pvc_diag = pvc_diagnostics(&pvc, None, Some(&pvc_events));
    assert_eq!(pvc_diag["phase"], "Pending");
    assert_eq!(pvc_diag["storageClassName"], "standard-wait");
    let pvc_issues: Vec<&str> = pvc_diag["issuesSummary"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(pvc_issues.iter().any(|i| i.contains("Waiting for first consumer")));

    // 3. Rollout problem: Deployment generation 3, observedGeneration 2, ready 1/3, progressing failure
    let deployment = json!({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": "api-deploy", "namespace": "apps", "uid": "dep-1", "generation": 3},
        "spec": {"replicas": 3},
        "status": {
            "observedGeneration": 2,
            "replicas": 3,
            "readyReplicas": 1,
            "updatedReplicas": 1,
            "availableReplicas": 1,
            "conditions": [
                {"type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded", "message": "ReplicaSet timed out"}
            ]
        }
    });
    let deploy_health = workload_health("Deployment", &deployment);
    assert_eq!(deploy_health["rolloutState"], "failed");
    let deploy_issues: Vec<&str> = deploy_health["issuesSummary"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(deploy_issues.iter().any(|i| i.contains("Controller reports a failure condition")));
}
