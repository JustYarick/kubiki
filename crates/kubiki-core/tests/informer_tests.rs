use kube::runtime::watcher::Event;
use kubiki_core::core::api::ResourceQuery;
use kubiki_core::informer::{
    delta::{ResourceDelta, WatchScope},
    reconcile::Reconciler,
    store::ResourceStore,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn query(namespace: Option<&str>) -> ResourceQuery {
    ResourceQuery {
        context: "test".into(),
        group: "".into(),
        version: "v1".into(),
        kind: "Pod".into(),
        namespace: namespace.map(str::to_owned),
    }
}
fn pod(uid: &str) -> Value {
    json!({ "metadata": { "uid": uid, "name": "web", "namespace": "backend", "resourceVersion": "opaque-rv" } })
}
fn uids(items: &[Value]) -> BTreeSet<String> {
    items
        .iter()
        .map(|v| v["metadata"]["uid"].as_str().unwrap().into())
        .collect()
}

#[tokio::test]
async fn initial_list_and_relist_are_atomic_and_remove_objects_deleted_while_disconnected() {
    let scope = WatchScope {
        subscription_id: "one".into(),
        query: query(None),
    };
    let store = ResourceStore::new();
    let mut reconcile = Reconciler::new(scope.query.clone());
    assert!(store.snapshot(&scope).await.is_none());
    for uid in ["old-a", "old-b"] {
        if uid == "old-a" {
            assert!(reconcile.consume(Event::Init).unwrap().is_none());
        }
        assert!(
            reconcile
                .consume(Event::InitApply(pod(uid)))
                .unwrap()
                .is_none()
        );
        assert!(store.snapshot(&scope).await.is_none());
    }
    let delta = reconcile.consume(Event::InitDone).unwrap().unwrap();
    store.apply_delta(&scope, &delta).await;
    assert_eq!(
        uids(&store.snapshot(&scope).await.unwrap()),
        BTreeSet::from(["old-a".into(), "old-b".into()])
    );
    reconcile.consume(Event::Init).unwrap();
    reconcile.consume(Event::InitApply(pod("old-a"))).unwrap();
    reconcile.consume(Event::InitApply(pod("new-c"))).unwrap();
    assert_eq!(store.snapshot(&scope).await.unwrap().len(), 2);
    let delta = reconcile.consume(Event::InitDone).unwrap().unwrap();
    store.apply_delta(&scope, &delta).await;
    assert_eq!(
        uids(&store.snapshot(&scope).await.unwrap()),
        BTreeSet::from(["old-a".into(), "new-c".into()])
    );
    reconcile.consume(Event::Init).unwrap();
    store
        .apply_delta(
            &scope,
            &reconcile.consume(Event::InitDone).unwrap().unwrap(),
        )
        .await;
    assert_eq!(store.snapshot(&scope).await, Some(vec![]));
}

#[test]
fn a_cancelled_or_failed_list_never_commits_partial_data() {
    let mut reconcile = Reconciler::new(query(None));
    reconcile.consume(Event::Init).unwrap();
    reconcile.consume(Event::InitApply(pod("partial"))).unwrap();
    reconcile.discard_pending();
    assert!(reconcile.consume(Event::InitDone).is_err());
    reconcile.consume(Event::Init).unwrap();
    reconcile
        .consume(Event::InitApply(pod("another-partial")))
        .unwrap();
    reconcile.consume(Event::Init).unwrap();
    reconcile
        .consume(Event::InitApply(pod("complete")))
        .unwrap();
    let Some(ResourceDelta::Restarted { items }) = reconcile.consume(Event::InitDone).unwrap()
    else {
        panic!("Missing snapshot")
    };
    assert_eq!(uids(&items), BTreeSet::from(["complete".into()]));
}

#[test]
fn bad_gvk_namespace_or_missing_uid_poison_the_list_instead_of_committing_a_subset() {
    for invalid in [
        json!({"metadata":{"name":"web","namespace":"backend"}}),
        json!({"metadata":{"name":"web","uid":"bad","namespace":"other"}}),
        json!({"kind":"Secret","metadata":{"name":"web","uid":"bad","namespace":"backend"}}),
        json!({"apiVersion":"example.com/v1","metadata":{"name":"web","uid":"bad","namespace":"backend"}}),
    ] {
        let mut reconcile = Reconciler::new(query(Some("backend")));
        reconcile.consume(Event::Init).unwrap();
        reconcile.consume(Event::InitApply(pod("valid"))).unwrap();
        assert!(reconcile.consume(Event::InitApply(invalid)).is_err());
        assert!(reconcile.consume(Event::InitDone).is_err());
    }
}

#[test]
fn live_updates_are_uid_bound_and_fill_missing_type_metadata() {
    let mut reconcile = Reconciler::new(query(None));
    assert!(reconcile.consume(Event::Apply(pod("early"))).is_err());
    reconcile.consume(Event::Init).unwrap();
    reconcile.consume(Event::InitDone).unwrap();
    let Some(ResourceDelta::Applied { data }) =
        reconcile.consume(Event::Apply(pod("replacement"))).unwrap()
    else {
        panic!("Expected apply")
    };
    assert_eq!(data["kind"], "Pod");
    assert_eq!(data["apiVersion"], "v1");
    assert_eq!(data["metadata"]["resourceVersion"], "opaque-rv");
    assert_eq!(
        reconcile.consume(Event::Delete(pod("old-uid"))).unwrap(),
        Some(ResourceDelta::Deleted {
            uid: "old-uid".into()
        })
    );
}

#[test]
fn empty_relist_and_updates_during_init_produce_one_complete_snapshot() {
    let mut reconcile = Reconciler::new(query(None));
    reconcile.consume(Event::Init).unwrap();
    reconcile.consume(Event::InitApply(pod("deleted"))).unwrap();
    assert!(
        reconcile
            .consume(Event::Delete(pod("deleted")))
            .unwrap()
            .is_none()
    );
    assert!(
        reconcile
            .consume(Event::Apply(pod("added")))
            .unwrap()
            .is_none()
    );
    let Some(ResourceDelta::Restarted { items }) = reconcile.consume(Event::InitDone).unwrap()
    else {
        panic!("Expected complete snapshot")
    };
    assert_eq!(uids(&items), BTreeSet::from(["added".into()]));
}
