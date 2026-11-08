use kubiki_core::cluster::{client::ClusterClientPool, kubeconfig::KubeConfigManager};
use kubiki_tools::kubernetes::{HostConsent, KubernetesTools};
use kubiki_tools::*;
use serde_json::{Value, json};
use std::sync::Arc;
fn tools(session: &Session, values: std::collections::HashMap<String, Value>) -> KubernetesTools {
    let client = kube::Client::new(
        tower::service_fn(move |request: http::Request<kube::client::Body>| {
            assert_eq!(request.method(), http::Method::GET);
            let path = request.uri().path();
            if path.ends_with("/log") {
                let query = request.uri().query().unwrap_or("");
                assert!(query.contains("previous=true"), "{query}");
                assert!(query.contains("tailLines=80"), "{query}");
                assert!(query.contains("container=agent"), "{query}");
            }
            assert!(
                !path.contains("deployments/agent-abcde"),
                "Never invent a Deployment target"
            );
            let v = values
                .get(path)
                .unwrap_or_else(|| panic!("Unexpected read {path}"))
                .clone();
            async move {
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .header("content-type", "application/json")
                        .body(kube::client::Body::from(serde_json::to_vec(&v).unwrap()))
                        .unwrap(),
                )
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
        std::env::temp_dir().join("kubiki-receipt-fixture.jsonl"),
        Arc::new(tokio::sync::Semaphore::new(2)),
    )
    .unwrap();
    tools.client = Some(client);
    tools
}

fn session(denied: Vec<String>) -> Session {
    Session::new(
        "graph".into(),
        "test".into(),
        AgentScope {
            context: "fixture".into(),
            namespaces: vec!["apps".into()],
            all_namespaces: false,
        },
        AgentPolicy {
            confirm_reads: false,
            workload_configuration: true,
            denied_paths: denied,
            ..Default::default()
        },
        ClusterCapabilities::default(),
    )
}
fn values(owner_uid: &str) -> std::collections::HashMap<String, Value> {
    std::collections::HashMap::from([
        (
            "/api/v1/namespaces/apps/pods/agent-abcde".into(),
            json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"agent-abcde","namespace":"apps","uid":"pod-id","ownerReferences":[{"apiVersion":"apps/v1","kind":"DaemonSet","name":"agent","uid":"ds-id","controller":true}]},"spec":{"nodeName":"private-node","containers":[{"name":"agent","image":"fixture"}]},"status":{"phase":"Running","containerStatuses":[{"name":"agent","restartCount":5,"state":{"waiting":{"reason":"CrashLoopBackOff"}}}]}}),
        ),
        (
            "/apis/apps/v1/namespaces/apps/daemonsets/agent".into(),
            json!({"apiVersion":"apps/v1","kind":"DaemonSet","metadata":{"name":"agent","namespace":"apps","uid":owner_uid}}),
        ),
        (
            "/api/v1/namespaces/apps/events".into(),
            json!({"apiVersion":"v1","kind":"EventList","metadata":{},"items":[]}),
        ),
    ])
}
async fn execute(tools: &KubernetesTools, session: &Session, name: &str, extra: Value) -> Value {
    let mut arguments = json!({"group":"","version":"v1","kind":"Pod","namespace":"apps","name":"agent-abcde","uid":"pod-id"});
    for (k, v) in extra.as_object().unwrap() {
        arguments[k] = v.clone();
    }
    let emit: EventSink = Arc::new(|_| {});
    tools
        .execute(
            session,
            &ToolCall {
                id: "graph".into(),
                name: name.into(),
                arguments,
            },
            &emit,
        )
        .await
        .unwrap()
}
#[tokio::test]
async fn follows_daemonset_and_does_not_read_denied_cluster_nodes() {
    let s = session(vec![]);
    let t = tools(&s, values("ds-id"));
    let r = execute(&t, &s, "get_neighborhood", json!({})).await;
    assert_eq!(r["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(r["edges"][0]["to"]["kind"], "DaemonSet");
    assert_eq!(r["edges"][0]["state"], "uid_verified");
    assert_eq!(r["omitted"][0]["target"]["kind"], "Node");
}
#[tokio::test]
async fn rejects_replaced_owners_and_respects_hidden_references() {
    let s = session(vec![]);
    let t = tools(&s, values("replacement"));
    let r = execute(&t, &s, "get_neighborhood", json!({})).await;
    assert_eq!(r["nodes"].as_array().unwrap().len(), 1);
    assert!(r["edges"].as_array().unwrap().is_empty());
    let s = session(vec!["/metadata/ownerReferences".into()]);
    let mut v = values("ds-id");
    v.remove("/apis/apps/v1/namespaces/apps/daemonsets/agent");
    let t = tools(&s, v);
    let r = execute(&t, &s, "get_neighborhood", json!({})).await;
    assert_eq!(r["nodes"].as_array().unwrap().len(), 1);
}
#[tokio::test]
async fn bundle_exposes_health_owner_and_partial_evidence() {
    let s = session(vec![]);
    let t = tools(&s, values("ds-id"));
    let r = execute(&t, &s, "diagnose_resource", json!({"includeLogs":false})).await;
    assert_eq!(r["diagnostic"]["containers"][0]["restartCount"], 5);
    assert_eq!(r["neighborhood"]["edges"][0]["to"]["kind"], "DaemonSet");
    assert_eq!(r["logs"]["collected"], false);
    assert_eq!(r["completeness"], "partial");
}
#[tokio::test]
async fn node_budget_is_explicit_and_expandable() {
    let s = session(vec![]);
    let t = tools(&s, values("ds-id"));
    let r = execute(&t, &s, "get_neighborhood", json!({"maxNodes":1})).await;
    assert_eq!(r["truncated"], true);
    assert_eq!(r["nodes"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn traverses_replicaset_deployment_chain_and_terminates_cycles() {
    let s = session(vec![]);
    let mut v = values("ds-id");
    v.get_mut("/api/v1/namespaces/apps/pods/agent-abcde")
        .unwrap()["metadata"]["ownerReferences"] = json!([{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"rs","uid":"rs-id","controller":true}]);
    v.insert("/apis/apps/v1/namespaces/apps/replicasets/rs".into(), json!({"apiVersion":"apps/v1","kind":"ReplicaSet","metadata":{"name":"rs","namespace":"apps","uid":"rs-id","ownerReferences":[{"apiVersion":"apps/v1","kind":"Deployment","name":"web","uid":"deploy-id","controller":true}]}}));
    // A malformed cycle must retain its evidence but never cause an unbounded traversal.
    v.insert("/apis/apps/v1/namespaces/apps/deployments/web".into(), json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"apps","uid":"deploy-id","ownerReferences":[{"apiVersion":"v1","kind":"Pod","name":"agent-abcde","uid":"pod-id"}]}}));
    let t = tools(&s, v);
    let r = execute(&t, &s, "get_neighborhood", json!({"hops":4})).await;
    assert_eq!(r["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(r["edges"].as_array().unwrap().len(), 3);
    assert!(
        r["edges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["state"] == "uid_verified")
    );
}

#[tokio::test]
async fn reverse_service_selectors_are_distinct_from_ownership_and_preserve_pagination() {
    let s = session(vec![]);
    let mut v = values("ds-id");
    v.get_mut("/api/v1/namespaces/apps/pods/agent-abcde")
        .unwrap()["metadata"]["labels"] = json!({"app":"agent"});
    let svc = json!({"apiVersion":"v1","kind":"Service","metadata":{"name":"svc","namespace":"apps","uid":"svc-id"},"spec":{"selector":{"app":"agent"}}});
    v.insert("/api/v1/namespaces/apps/services".into(),json!({"apiVersion":"v1","kind":"ServiceList","metadata":{"continue":"next-page"},"items":[svc.clone(),{"apiVersion":"v1","kind":"Service","metadata":{"name":"other","namespace":"apps","uid":"other"},"spec":{"selector":{"app":"unrelated"}}}]}));
    v.insert("/api/v1/namespaces/apps/services/svc".into(), svc);
    let t = tools(&s, v);
    let r = execute(&t, &s, "get_neighborhood", json!({"hops":1})).await;
    let edge = r["edges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["to"]["kind"] == "Service")
        .unwrap();
    assert_eq!(edge["relation"], "selectedBy");
    assert_eq!(edge["to"]["name"], "svc");
    assert_eq!(r["truncated"], true);
    assert_eq!(r["continuationQueries"][0]["tool"], "list_resources");
    assert!(r["continuationQueries"][0]["arguments"]["cursor"].is_string());
}

#[tokio::test]
async fn crashing_container_bundle_uses_uid_bound_previous_logs() {
    let s = session(vec![]);
    let mut policy = s.control().unwrap().policy;
    policy.logs = true;
    let s = Session::new(
        s.id.clone(),
        s.owner.clone(),
        s.scope.clone(),
        policy,
        ClusterCapabilities::default(),
    );
    let mut v = values("ds-id");
    v.insert(
        "/api/v1/namespaces/apps/pods/agent-abcde/log".into(),
        json!("fatal: cannot connect to backend"),
    );
    let t = tools(&s, v);
    let r = execute(&t, &s, "diagnose_resource", json!({})).await;
    assert_eq!(r["logs"]["containers"][0]["container"], "agent");
    assert!(
        r["logs"].to_string().contains("cannot connect to backend"),
        "{r}"
    );
}

fn discovery(v: &mut std::collections::HashMap<String, Value>, resources: Value) {
    v.insert("/apis".into(), json!({"kind":"APIGroupList","groups":[{"name":"example.io","versions":[{"groupVersion":"example.io/v1","version":"v1"}],"preferredVersion":{"groupVersion":"example.io/v1","version":"v1"}}]}));
    v.insert(
        "/api".into(),
        json!({"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}),
    );
    v.insert(
        "/api/v1".into(),
        json!({"kind":"APIResourceList","groupVersion":"v1","resources":[]}),
    );
    v.insert(
        "/apis/example.io/v1".into(),
        json!({"kind":"APIResourceList","groupVersion":"example.io/v1","resources":resources}),
    );
}
#[tokio::test]
async fn discovers_cluster_scoped_custom_owner_and_checks_policy_before_reading_it() {
    let base = session(vec![]);
    let mut policy = base.control().unwrap().policy;
    policy.cluster_resources = true;
    let s = Session::new(
        base.id,
        base.owner,
        base.scope,
        policy,
        ClusterCapabilities::default(),
    );
    let mut v = values("ds-id");
    v.get_mut("/api/v1/namespaces/apps/pods/agent-abcde")
        .unwrap()["metadata"]["ownerReferences"] = json!([{"apiVersion":"example.io/v1","kind":"ClusterController","name":"owner","uid":"custom-id","controller":true}]);
    discovery(
        &mut v,
        json!([{"name":"clustercontrollers","singularName":"clustercontroller","kind":"ClusterController","namespaced":false,"verbs":["get","list"]}]),
    );
    v.insert("/apis/example.io/v1/clustercontrollers/owner".into(),json!({"apiVersion":"example.io/v1","kind":"ClusterController","metadata":{"name":"owner","uid":"custom-id"}}));
    // The node is deliberately omitted to isolate the custom owner traversal.
    v.get_mut("/api/v1/namespaces/apps/pods/agent-abcde")
        .unwrap()["spec"]
        .as_object_mut()
        .unwrap()
        .remove("nodeName");
    let t = tools(&s, v);
    let r = execute(&t, &s, "get_neighborhood", json!({})).await;
    assert_eq!(r["nodes"].as_array().unwrap().len(), 2, "{r}");
    assert_eq!(r["edges"][0]["to"]["namespace"], Value::Null);
    assert_eq!(r["edges"][0]["state"], "uid_verified");
}
#[tokio::test]
async fn dynamic_catalog_exposes_every_kind_through_pages() {
    let s = session(vec![]);
    let mut v = values("ds-id");
    discovery(&mut v,json!((0..125).map(|n|json!({"name":format!("widgets{n}"),"singularName":format!("widget{n}"),"kind":format!("Widget{n}"),"namespaced":true,"verbs":["get","list"]})).collect::<Vec<_>>()));
    let t = tools(&s, v);
    let emit: EventSink = Arc::new(|_| {});
    let mut kinds = std::collections::HashSet::new();
    for page in 0..2 {
        let r = t
            .execute(
                &s,
                &ToolCall {
                    id: "catalog".into(),
                    name: "resource_catalog".into(),
                    arguments: json!({"discover":true,"group":"example.io","page":page}),
                },
                &emit,
            )
            .await
            .unwrap();
        assert_eq!(r["hasMore"], page == 0);
        for item in r["resources"].as_array().unwrap() {
            kinds.insert(item["kind"].as_str().unwrap().to_owned());
        }
    }
    assert_eq!(kinds.len(), 125);
}
