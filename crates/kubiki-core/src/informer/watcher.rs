use crate::core::api::{ApiError, ApiErrorCode, ResourceQuery, validate_query};
use crate::informer::delta::{WatchEvent, WatchMessage, WatchPhase, WatchScope};
use crate::informer::reconcile::Reconciler;
use crate::informer::store::ResourceStore;
use futures::StreamExt;
use kube::core::{ApiResource, DynamicObject};
use kube::runtime::{
    WatchStreamExt,
    watcher::{self, Event},
};
use kube::{Api, Client};
use std::{collections::HashMap, future::Future, sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, mpsc},
    task::JoinHandle,
};

pub const WATCH_QUEUE_CAPACITY: usize = 256;
// Below kube-rs' default 295s read timeout. Watch renewal resumes the current RV;
// renewing every 30s creates unnecessary API requests in quiet clusters.
pub const WATCH_TIMEOUT_SECONDS: u32 = 290;
// The expanded API catalog fans out namespaced collections for selected namespaces.
const MAX_WATCHERS: usize = 512;

struct ActiveWatch {
    owner: String,
    scope: WatchScope,
    handle: JoinHandle<()>,
}
struct Inner {
    active: Mutex<HashMap<String, ActiveWatch>>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for watch in self.active.get_mut().values() {
            watch.handle.abort();
        }
    }
}

#[derive(Clone)]
pub struct InformerManager {
    store: ResourceStore,
    inner: Arc<Inner>,
}

/// Exact REST scope, no metadata.namespace field selector on an all-namespaces endpoint.
pub fn resource_api(client: Client, query: &ResourceQuery) -> Result<Api<DynamicObject>, ApiError> {
    let resource = validate_query(query)?;
    let api_version = if query.group.is_empty() {
        query.version.clone()
    } else {
        format!("{}/{}", query.group, query.version)
    };
    let resource = ApiResource {
        group: query.group.clone(),
        version: query.version.clone(),
        api_version,
        kind: query.kind.clone(),
        plural: resource.plural.clone(),
    };
    Ok(match &query.namespace {
        Some(namespace) => Api::namespaced_with(client, namespace, &resource),
        None => Api::all_with(client, &resource),
    })
}

impl InformerManager {
    pub fn new(store: ResourceStore) -> Self {
        Self {
            store,
            inner: Arc::new(Inner {
                active: Mutex::new(HashMap::new()),
            }),
        }
    }
    pub fn store(&self) -> &ResourceStore {
        &self.store
    }

    /// Reserve before client construction. Stop can cancel auth/config initialization too.
    pub async fn start_watch<F>(
        &self,
        owner: &str,
        id: &str,
        query: ResourceQuery,
        client: F,
    ) -> Result<mpsc::Receiver<WatchMessage>, ApiError>
    where
        F: Future<Output = Result<Client, ApiError>> + Send + 'static,
    {
        validate_query(&query)?;
        if id.is_empty()
            || id.len() > 128
            || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err(ApiError::from_status(
                400,
                "Invalid watch subscription ID",
                "watch",
                Some(&query.context),
            ));
        }
        let key = format!("{owner}:{id}");
        let mut active = self.inner.active.lock().await;
        if active.contains_key(&key) {
            return Err(ApiError::from_status(
                409,
                "Watch subscription already exists",
                "watch",
                Some(&query.context),
            ));
        }
        if active.len() >= MAX_WATCHERS {
            return Err(ApiError::from_status(
                429,
                "Too many active resource watches",
                "watch",
                Some(&query.context),
            ));
        }
        let scope = WatchScope {
            subscription_id: key.clone(),
            query,
        };
        let store = self.store.clone();
        let (tx, rx) = mpsc::channel(WATCH_QUEUE_CAPACITY);
        let task_scope = scope.clone();
        let handle = tokio::spawn(async move {
            run_watch(store, task_scope, client, tx).await;
        });
        active.insert(
            key,
            ActiveWatch {
                owner: owner.into(),
                scope,
                handle,
            },
        );
        Ok(rx)
    }

    /// Abort and join while holding the registry lock: a reused ID cannot race old writes.
    pub async fn stop_watch(&self, owner: &str, id: &str) {
        let mut active = self.inner.active.lock().await;
        if let Some(watch) = active.remove(&format!("{owner}:{id}")) {
            watch.handle.abort();
            let _ = watch.handle.await;
            self.store.remove(&watch.scope).await;
        }
    }

    pub async fn stop_owner(&self, owner: &str) {
        let mut active = self.inner.active.lock().await;
        let keys: Vec<_> = active
            .iter()
            .filter(|(_, watch)| watch.owner == owner)
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            if let Some(watch) = active.remove(&key) {
                watch.handle.abort();
                let _ = watch.handle.await;
                self.store.remove(&watch.scope).await;
            }
        }
    }

    pub async fn active_count(&self) -> usize {
        self.inner.active.lock().await.len()
    }
}

async fn emit(tx: &mpsc::Sender<WatchMessage>, sequence: &mut u64, event: WatchEvent) -> bool {
    *sequence += 1;
    tx.send(WatchMessage {
        sequence: *sequence,
        event,
    })
    .await
    .is_ok()
}
async fn status(
    tx: &mpsc::Sender<WatchMessage>,
    sequence: &mut u64,
    phase: WatchPhase,
    error: Option<ApiError>,
) -> bool {
    emit(tx, sequence, WatchEvent::Status { phase, error }).await
}

fn watch_error(error: watcher::Error, query: &ResourceQuery) -> ApiError {
    let result = match error {
        watcher::Error::InitialListFailed(kube::Error::Api(error))
        | watcher::Error::WatchStartFailed(kube::Error::Api(error))
        | watcher::Error::WatchFailed(kube::Error::Api(error))
        | watcher::Error::WatchError(error) => {
            if error.code == 410 {
                ApiError::new(
                    ApiErrorCode::Unavailable,
                    error.message,
                    "watch",
                    Some(&query.context),
                    Some(410),
                )
            } else {
                ApiError::from_status(error.code, error.message, "watch", Some(&query.context))
            }
        }
        error => ApiError::new(
            ApiErrorCode::Unavailable,
            error.to_string(),
            "watch",
            Some(&query.context),
            None,
        ),
    };
    result.with_resource(query)
}

/// Drop server bookkeeping from cached objects. ConfigMap and Secret keep only the
/// timestamps of writers that own their payload, so consumers can tell when the
/// data last changed; the field sets themselves are never retained.
fn prune_managed_fields(obj: &mut DynamicObject, kind: &str) {
    let Some(entries) = obj.metadata.managed_fields.take() else {
        return;
    };
    if !matches!(kind, "ConfigMap" | "Secret") {
        return;
    }
    let kept: Vec<_> = entries
        .into_iter()
        .filter(|entry| {
            entry
                .fields_v1
                .as_ref()
                .and_then(|fields| serde_json::to_string(fields).ok())
                .is_some_and(|text| text.contains("\"f:data\"") || text.contains("\"f:binaryData\""))
        })
        .map(|mut entry| {
            entry.fields_v1 = None;
            entry
        })
        .collect();
    if !kept.is_empty() {
        obj.metadata.managed_fields = Some(kept);
    }
}

fn strip_crd_schemas(obj: &mut DynamicObject) {
    if let Some(spec) = obj.data.get_mut("spec").and_then(|s| s.as_object_mut()) {
        spec.remove("validation");
        if let Some(versions) = spec.get_mut("versions").and_then(|v| v.as_array_mut()) {
            for version in versions {
                if let Some(version_obj) = version.as_object_mut() {
                    version_obj.remove("schema");
                }
            }
        }
    }
}

async fn run_watch<F>(
    store: ResourceStore,
    scope: WatchScope,
    client: F,
    tx: mpsc::Sender<WatchMessage>,
) where
    F: Future<Output = Result<Client, ApiError>>,
{
    let mut sequence = 0;
    if !status(&tx, &mut sequence, WatchPhase::Connecting, None).await {
        return;
    }
    let initialized = tokio::select! {
        _ = tx.closed() => return,
        result = tokio::time::timeout(Duration::from_secs(15), client) => result,
    };
    let client = match initialized {
        Ok(Ok(client)) => client,
        result => {
            let error = match result {
                Ok(Err(error)) => error,
                _ => ApiError::from_status(
                    504,
                    "Watch client initialization timed out",
                    "watch",
                    Some(&scope.query.context),
                ),
            };
            status(
                &tx,
                &mut sequence,
                WatchPhase::Failed,
                Some(error.with_resource(&scope.query)),
            )
            .await;
            return;
        }
    };
    // watcher filters bookmarks/connection establishment. Observe successful watch headers so
    // a quiet, recovered stream can leave Reconnecting without waiting for an object mutation.
    let (connected_tx, mut connected_rx) = mpsc::channel(1);
    let namespace = client.default_namespace().to_owned();
    let observed = tower::service_fn(move |request: http::Request<kube::client::Body>| {
        let client = client.clone();
        let connected = connected_tx.clone();
        async move {
            let watch = request
                .uri()
                .query()
                .is_some_and(|query| query.split('&').any(|part| part == "watch=true"));
            let response = client.send(request).await?;
            if watch && response.status().is_success() {
                let _ = connected.send(()).await;
            }
            Ok::<_, kube::Error>(response)
        }
    });
    let client = Client::new(observed, namespace);
    let api = match resource_api(client, &scope.query) {
        Ok(api) => api,
        Err(error) => {
            status(&tx, &mut sequence, WatchPhase::Failed, Some(error)).await;
            return;
        }
    };
    let stream = watcher::watcher(
        api,
        watcher::Config::default()
            .timeout(WATCH_TIMEOUT_SECONDS),
    )
    .default_backoff();
    tokio::pin!(stream);
    let mut reconcile = Reconciler::new(scope.query.clone());
    let mut phase = WatchPhase::Connecting;
    loop {
        let event = tokio::select! {
            _ = tx.closed() => return,
            Some(()) = connected_rx.recv() => {
                if phase == WatchPhase::Reconnecting {
                    phase = WatchPhase::Live;
                    if !status(&tx, &mut sequence, phase.clone(), None).await { return; }
                }
                continue;
            },
            event = stream.next() => event,
        };
        match event {
            Some(Ok(event)) => {
                let event = match event {
                    Event::Init => {
                        phase = WatchPhase::Syncing;
                        if !status(&tx, &mut sequence, phase.clone(), None).await {
                            return;
                        }
                        Event::Init
                    }
                    Event::InitDone => Event::InitDone,
                    Event::Apply(mut value) => {
                        prune_managed_fields(&mut value, &scope.query.kind);
                        if scope.query.kind == "CustomResourceDefinition" {
                            strip_crd_schemas(&mut value);
                        }
                        Event::Apply(serde_json::to_value(value).expect("DynamicObject is JSON"))
                    }
                    Event::InitApply(mut value) => {
                        prune_managed_fields(&mut value, &scope.query.kind);
                        if scope.query.kind == "CustomResourceDefinition" {
                            strip_crd_schemas(&mut value);
                        }
                        Event::InitApply(
                            serde_json::to_value(value).expect("DynamicObject is JSON"),
                        )
                    }
                    Event::Delete(value) => {
                        Event::Delete(serde_json::to_value(value).expect("DynamicObject is JSON"))
                    }
                };
                match reconcile.consume(event) {
                    Ok(Some(delta)) => {
                        store.apply_delta(&scope, &delta).await;
                        if !emit(&tx, &mut sequence, WatchEvent::Delta(delta)).await {
                            return;
                        }
                        if phase != WatchPhase::Live {
                            phase = WatchPhase::Live;
                            if !status(&tx, &mut sequence, phase.clone(), None).await {
                                return;
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        reconcile.discard_pending();
                        status(&tx, &mut sequence, WatchPhase::Failed, Some(error)).await;
                        return;
                    }
                }
            }
            Some(Err(error)) => {
                // Headers and a body error can arrive in one poll; never let that stale success
                // clear the newer error on the next turn.
                while connected_rx.try_recv().is_ok() {}
                reconcile.discard_pending();
                let error = watch_error(error, &scope.query);
                let terminal = matches!(error.status, Some(400 | 401 | 403 | 404 | 422));
                phase = if terminal {
                    WatchPhase::Failed
                } else {
                    WatchPhase::Reconnecting
                };
                if !status(&tx, &mut sequence, phase.clone(), Some(error)).await || terminal {
                    return;
                }
            }
            None => {
                let error = ApiError::new(
                    ApiErrorCode::Unavailable,
                    "Resource watch stream ended",
                    "watch",
                    Some(&scope.query.context),
                    None,
                )
                .with_resource(&scope.query);
                status(&tx, &mut sequence, WatchPhase::Failed, Some(error)).await;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_crd_schemas() {
        let mut obj: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "apiextensions.k8s.io/v1",
            "kind": "CustomResourceDefinition",
            "metadata": { "name": "tests.example.com" },
            "spec": {
                "group": "example.com",
                "validation": {
                    "openAPIV3Schema": {
                        "type": "object",
                        "properties": { "foo": { "type": "string" } }
                    }
                },
                "versions": [
                    {
                        "name": "v1",
                        "served": true,
                        "storage": true,
                        "schema": {
                            "openAPIV3Schema": {
                                "type": "object",
                                "properties": { "bar": { "type": "integer" } }
                            }
                        }
                    },
                    {
                        "name": "v2",
                        "served": true,
                        "storage": false,
                        "schema": {
                            "openAPIV3Schema": {
                                "type": "object"
                            }
                        }
                    }
                ]
            }
        }))
        .unwrap();

        strip_crd_schemas(&mut obj);

        assert!(obj.data["spec"].get("validation").is_none());
        assert_eq!(obj.data["spec"]["group"], "example.com");
        let versions = obj.data["spec"]["versions"].as_array().unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0]["name"], "v1");
        assert!(versions[0].get("schema").is_none());
        assert_eq!(versions[1]["name"], "v2");
        assert!(versions[1].get("schema").is_none());
    }

    #[test]
    fn prune_managed_fields_keeps_only_data_writer_times_for_config() {
        let source = serde_json::json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "app", "managedFields": [
                { "manager": "kubectl", "operation": "Update", "apiVersion": "v1", "time": "2026-01-02T00:00:00Z", "fieldsType": "FieldsV1", "fieldsV1": { "f:data": { "f:A": {} } } },
                { "manager": "labeler", "operation": "Update", "apiVersion": "v1", "time": "2026-01-03T00:00:00Z", "fieldsType": "FieldsV1", "fieldsV1": { "f:metadata": { "f:labels": {} } } }
            ] },
            "data": { "A": "1" }
        });
        let mut config: DynamicObject = serde_json::from_value(source.clone()).unwrap();
        prune_managed_fields(&mut config, "ConfigMap");
        let kept = config.metadata.managed_fields.unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].manager.as_deref(), Some("kubectl"));
        assert!(kept[0].fields_v1.is_none());

        let mut pod: DynamicObject = serde_json::from_value(source).unwrap();
        prune_managed_fields(&mut pod, "Pod");
        assert!(pod.metadata.managed_fields.is_none());
    }
}
