use crate::core::api::{ApiError, ApiErrorCode, ResourceQuery, validate_query};
use crate::informer::delta::{WatchEvent, WatchMessage, WatchPhase, WatchScope};
use crate::informer::reconcile::Reconciler;
use crate::informer::store::ResourceStore;
use futures::StreamExt;
use kube::api::WatchParams;
use kube::core::{ApiResource, DynamicObject, WatchEvent as KubeWatchEvent};
use kube::runtime::{
    WatchStreamExt,
    watcher::{self, Event},
};
use kube::{Api, Client};
use serde_json::{Map, Value};
use std::{collections::HashMap, future::Future, sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, mpsc},
    task::JoinHandle,
};
use tracing::Instrument;

pub const WATCH_QUEUE_CAPACITY: usize = 256;
// Below kube-rs' default 295s read timeout. Watch renewal resumes the current RV;
// renewing every 30s creates unnecessary API requests in quiet clusters.
pub const WATCH_TIMEOUT_SECONDS: u32 = 290;
// The expanded API catalog fans out namespaced collections for selected namespaces.
const MAX_WATCHERS: usize = 512;

#[derive(Debug, Clone, Default)]
pub struct WatchFilter {
    pub label_selector: Option<String>,
    pub field_selector: Option<String>,
}

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
        self.start_watch_filtered(owner, id, query, WatchFilter::default(), client)
            .await
    }

    pub async fn start_watch_filtered<F>(
        &self,
        owner: &str,
        id: &str,
        query: ResourceQuery,
        filter: WatchFilter,
        client: F,
    ) -> Result<mpsc::Receiver<WatchMessage>, ApiError>
    where
        F: Future<Output = Result<Client, ApiError>> + Send + 'static,
    {
        validate_query(&query)?;
        self.start_resolved_watch_filtered(owner, id, query, filter, async move {
            client.await.map(|client| (client, None))
        })
        .await
    }

    /// The resolver must validate the requested GVK/scope against a live CRD.
    /// Reserve before resolution so cancellation also aborts discovery/auth.
    pub async fn start_resolved_watch<F>(
        &self,
        owner: &str,
        id: &str,
        query: ResourceQuery,
        client: F,
    ) -> Result<mpsc::Receiver<WatchMessage>, ApiError>
    where
        F: Future<Output = Result<(Client, Option<(ApiResource, bool)>), ApiError>>
            + Send
            + 'static,
    {
        self.start_resolved_watch_filtered(owner, id, query, WatchFilter::default(), client)
            .await
    }

    pub async fn start_resolved_watch_filtered<F>(
        &self,
        owner: &str,
        id: &str,
        query: ResourceQuery,
        filter: WatchFilter,
        client: F,
    ) -> Result<mpsc::Receiver<WatchMessage>, ApiError>
    where
        F: Future<Output = Result<(Client, Option<(ApiResource, bool)>), ApiError>>
            + Send
            + 'static,
    {
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
        let handle = tokio::spawn(
            async move {
                run_watch(store, task_scope, filter, client, tx).await;
            }
            .in_current_span(),
        );
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
                .and_then(|fields| fields.0.as_object())
                .is_some_and(|map| map.contains_key("f:data") || map.contains_key("f:binaryData"))
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

#[derive(Clone, Default)]
struct SummaryMeta {
    secret_type: Option<String>,
    data_keys: Option<u64>,
    size_bytes: Option<u64>,
}

fn percent_encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn extract_payload_updated_at(metadata: &Map<String, Value>) -> Option<String> {
    let entries = metadata.get("managedFields")?.as_array()?;
    let mut latest: Option<(chrono::DateTime<chrono::Utc>, String)> = None;
    for entry in entries {
        let Some(fields) = entry.get("fieldsV1").and_then(Value::as_object) else {
            continue;
        };
        if !fields.contains_key("f:data") && !fields.contains_key("f:binaryData") {
            continue;
        }
        let Some(time_str) = entry.get("time").and_then(Value::as_str) else {
            continue;
        };
        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(time_str) {
            let utc = parsed.with_timezone(&chrono::Utc);
            if latest.as_ref().is_none_or(|(prev, _)| utc > *prev) {
                latest = Some((utc, time_str.to_owned()));
            }
        }
    }
    latest.map(|(_, s)| s)
}

/// Replace bulky Secret/ConfigMap payload maps with compact key count + size metadata so
/// table watches never serialize megabytes of Helm/TLS/config blobs across IPC.
fn summarize_payload_value(value: &mut Value, kind: &str) -> SummaryMeta {
    let mut meta = SummaryMeta::default();
    let Some(obj) = value.as_object_mut() else {
        return meta;
    };
    let data_updated_at = obj
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(extract_payload_updated_at);
    if let Some(md) = obj.get_mut("metadata").and_then(Value::as_object_mut) {
        md.remove("managedFields");
    }
    let mut keys: u64 = 0;
    let mut size: u64 = 0;
    if kind == "Secret" {
        meta.secret_type = obj.get("type").and_then(Value::as_str).map(str::to_owned);
        if let Some(Value::Object(data)) = obj.remove("data") {
            keys += data.len() as u64;
            for val in data.values() {
                if let Some(s) = val.as_str() {
                    size += ((s.len() as u64) * 3) / 4;
                }
            }
        }
        if let Some(Value::Object(string_data)) = obj.remove("stringData") {
            keys += string_data.len() as u64;
            for val in string_data.values() {
                if let Some(s) = val.as_str() {
                    size += s.len() as u64;
                }
            }
        }
    } else {
        if let Some(Value::Object(data)) = obj.remove("data") {
            keys += data.len() as u64;
            for val in data.values() {
                if let Some(s) = val.as_str() {
                    size += s.len() as u64;
                }
            }
        }
        if let Some(Value::Object(binary_data)) = obj.remove("binaryData") {
            keys += binary_data.len() as u64;
            for val in binary_data.values() {
                if let Some(s) = val.as_str() {
                    size += ((s.len() as u64) * 3) / 4;
                }
            }
        }
    }
    meta.data_keys = Some(keys);
    meta.size_bytes = Some(size);
    let mut summary = Map::new();
    summary.insert("dataKeys".into(), Value::from(keys));
    summary.insert("sizeBytes".into(), Value::from(size));
    if let Some(updated_at) = data_updated_at {
        summary.insert("dataUpdatedAt".into(), Value::String(updated_at));
    }
    obj.insert("_kubikiSummary".into(), Value::Object(summary));
    meta
}

fn build_summary_object(kind: &str, mut metadata: Value, meta: &SummaryMeta) -> Value {
    if let Some(md) = metadata.as_object_mut() {
        md.remove("managedFields");
    }
    let mut obj = Map::new();
    obj.insert("apiVersion".into(), Value::String("v1".into()));
    obj.insert("kind".into(), Value::String(kind.to_owned()));
    obj.insert("metadata".into(), metadata);
    if kind == "Secret" {
        if let Some(ref secret_type) = meta.secret_type {
            obj.insert("type".into(), Value::String(secret_type.clone()));
        }
    }
    let mut summary = Map::new();
    if let Some(keys) = meta.data_keys {
        summary.insert("dataKeys".into(), Value::from(keys));
    }
    if let Some(size) = meta.size_bytes {
        summary.insert("sizeBytes".into(), Value::from(size));
    }
    obj.insert("_kubikiSummary".into(), Value::Object(summary));
    Value::Object(obj)
}

fn parse_table_columns(body: &Value) -> (Option<usize>, Option<usize>) {
    let mut type_col = None;
    let mut data_col = None;
    if let Some(cols) = body.get("columnDefinitions").and_then(Value::as_array) {
        for (idx, col) in cols.iter().enumerate() {
            if let Some(name) = col.get("name").and_then(Value::as_str) {
                if name.eq_ignore_ascii_case("type") {
                    type_col = Some(idx);
                } else if name.eq_ignore_ascii_case("data") {
                    data_col = Some(idx);
                }
            }
        }
    }
    (type_col, data_col)
}

fn parse_table_row_summary(
    row: &Value,
    kind: &str,
    type_col: Option<usize>,
    data_col: Option<usize>,
) -> SummaryMeta {
    let cells = row.get("cells").and_then(Value::as_array);
    let secret_type = if kind == "Secret" {
        type_col
            .and_then(|idx| cells.and_then(|c| c.get(idx)))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    } else {
        None
    };
    let data_keys = data_col
        .and_then(|idx| cells.and_then(|c| c.get(idx)))
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
        });
    SummaryMeta {
        secret_type,
        data_keys,
        size_bytes: None,
    }
}

fn api_error_from_status_body(status: u16, body: &[u8], query: &ResourceQuery) -> ApiError {
    if let Ok(resp) = serde_json::from_slice::<kube::error::ErrorResponse>(body) {
        if resp.code == 410 {
            return ApiError::new(
                ApiErrorCode::Unavailable,
                resp.message,
                "watch",
                Some(&query.context),
                Some(410),
            )
            .with_resource(query);
        }
        return ApiError::from_status(resp.code, resp.message, "watch", Some(&query.context))
            .with_resource(query);
    }
    let message = String::from_utf8_lossy(body).trim().to_owned();
    let message = if message.is_empty() {
        format!("Kubernetes API returned HTTP {status}")
    } else {
        message
    };
    ApiError::from_status(status, message, "watch", Some(&query.context)).with_resource(query)
}

enum TableListOutcome {
    Page {
        items: Vec<(String, Value, SummaryMeta)>,
        resource_version: Option<String>,
        continuation: Option<String>,
    },
    FallbackFullWatch,
    Error(ApiError),
}

async fn fetch_summary_list_page(
    client: &Client,
    query: &ResourceQuery,
    plural: &str,
    filter: &WatchFilter,
    continue_token: Option<&str>,
) -> TableListOutcome {
    let base_path = match &query.namespace {
        Some(ns) => format!("/api/v1/namespaces/{ns}/{plural}"),
        None => format!("/api/v1/{plural}"),
    };
    let mut pairs: Vec<(&str, String)> = vec![("includeObject", "Metadata".into())];
    if let Some(tok) = continue_token {
        pairs.push(("continue", percent_encode_query_value(tok)));
    } else {
        pairs.push(("resourceVersion", "0".into()));
        pairs.push(("resourceVersionMatch", "NotOlderThan".into()));
    }
    if let Some(labels) = filter
        .label_selector
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        pairs.push(("labelSelector", percent_encode_query_value(labels)));
    }
    if let Some(fields) = filter
        .field_selector
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        pairs.push(("fieldSelector", percent_encode_query_value(fields)));
    }
    let qs = pairs
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let uri = format!("{base_path}?{qs}");
    let req = match http::Request::builder()
        .method(http::Method::GET)
        .uri(&uri)
        .header(
            http::header::ACCEPT,
            "application/json;as=Table;v=v1;g=meta.k8s.io, application/json",
        )
        .body(kube::client::Body::empty())
    {
        Ok(req) => req,
        Err(err) => {
            return TableListOutcome::Error(
                ApiError::new(
                    ApiErrorCode::Internal,
                    err.to_string(),
                    "watch",
                    Some(&query.context),
                    None,
                )
                .with_resource(query),
            );
        }
    };
    let resp = match client.send(req).await {
        Ok(resp) => resp,
        Err(err) => {
            return TableListOutcome::Error(watch_error(
                watcher::Error::InitialListFailed(err),
                query,
            ));
        }
    };
    let status = resp.status();
    let bytes = match resp.into_body().collect_bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            return TableListOutcome::Error(watch_error(
                watcher::Error::InitialListFailed(err),
                query,
            ));
        }
    };
    if !status.is_success() {
        if matches!(status.as_u16(), 400 | 406) {
            return TableListOutcome::FallbackFullWatch;
        }
        return TableListOutcome::Error(api_error_from_status_body(status.as_u16(), &bytes, query));
    }
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(val) => val,
        Err(err) => {
            return TableListOutcome::Error(
                ApiError::new(
                    ApiErrorCode::Unavailable,
                    err.to_string(),
                    "watch",
                    Some(&query.context),
                    None,
                )
                .with_resource(query),
            );
        }
    };
    let resource_version = body
        .pointer("/metadata/resourceVersion")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let continuation = body
        .pointer("/metadata/continue")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    let mut out = Vec::new();
    if body.get("kind").and_then(Value::as_str) == Some("Table") {
        let (type_col, data_col) = parse_table_columns(&body);
        if let Some(rows) = body.get("rows").and_then(Value::as_array) {
            out.reserve(rows.len());
            for row in rows {
                let Some(metadata) = row
                    .get("object")
                    .and_then(|o| o.get("metadata"))
                    .cloned()
                    .filter(Value::is_object)
                else {
                    continue;
                };
                let uid = metadata
                    .get("uid")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let meta = parse_table_row_summary(row, &query.kind, type_col, data_col);
                let val = build_summary_object(&query.kind, metadata, &meta);
                out.push((uid, val, meta));
            }
        }
        return TableListOutcome::Page {
            items: out,
            resource_version,
            continuation,
        };
    }

    if let Some(items) = body.get("items").and_then(Value::as_array) {
        out.reserve(items.len());
        for mut item in items.iter().cloned() {
            let meta = summarize_payload_value(&mut item, &query.kind);
            let uid = item
                .pointer("/metadata/uid")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            out.push((uid, item, meta));
        }
        return TableListOutcome::Page {
            items: out,
            resource_version,
            continuation,
        };
    }

    TableListOutcome::FallbackFullWatch
}

async fn fetch_single_table_summary(
    client: &Client,
    kind: &str,
    plural: &str,
    namespace: &str,
    name: &str,
) -> Option<SummaryMeta> {
    let uri = format!("/api/v1/namespaces/{namespace}/{plural}/{name}?includeObject=Metadata");
    let req = http::Request::builder()
        .method(http::Method::GET)
        .uri(&uri)
        .header(
            http::header::ACCEPT,
            "application/json;as=Table;v=v1;g=meta.k8s.io",
        )
        .body(kube::client::Body::empty())
        .ok()?;
    let resp = tokio::time::timeout(Duration::from_secs(3), client.send(req))
        .await
        .ok()?
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = tokio::time::timeout(Duration::from_secs(3), resp.into_body().collect_bytes())
        .await
        .ok()?
        .ok()?;
    let body: Value = serde_json::from_slice(&bytes).ok()?;
    if body.get("kind").and_then(Value::as_str) == Some("Table") {
        let (type_col, data_col) = parse_table_columns(&body);
        let row = body.get("rows")?.as_array()?.first()?;
        return Some(parse_table_row_summary(row, kind, type_col, data_col));
    }
    None
}

async fn run_summary_watch(
    store: &ResourceStore,
    scope: &WatchScope,
    filter: &WatchFilter,
    client: &Client,
    api: &Api<DynamicObject>,
    namespaced: bool,
    connected_rx: &mut mpsc::Receiver<()>,
    tx: &mpsc::Sender<WatchMessage>,
    sequence: &mut u64,
) -> bool {
    let plural = if scope.query.kind == "Secret" {
        "secrets"
    } else {
        "configmaps"
    };
    let mut reconcile = Reconciler::with_scope(scope.query.clone(), namespaced);
    let mut phase = WatchPhase::Connecting;
    let mut resource_version: Option<String> = None;
    let mut summary_cache: HashMap<String, SummaryMeta> = HashMap::new();
    let mut backoff_ms: u64 = 1_000;

    let mut wp = WatchParams::default().timeout(WATCH_TIMEOUT_SECONDS);
    if let Some(labels) = filter
        .label_selector
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        wp = wp.labels(labels);
    }
    if let Some(fields) = filter
        .field_selector
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        wp = wp.fields(fields);
    }

    loop {
        if resource_version.is_none() {
            phase = WatchPhase::Syncing;
            if !status(tx, sequence, phase.clone(), None).await {
                return true;
            }
            if let Err(err) = reconcile.consume(Event::Init) {
                status(tx, sequence, WatchPhase::Failed, Some(err)).await;
                return true;
            }
            let mut next_cache: HashMap<String, SummaryMeta> = HashMap::new();
            let mut continuation: Option<String> = None;
            let mut listed_rv: Option<String> = None;
            let mut list_error: Option<ApiError> = None;
            loop {
                let outcome = tokio::select! {
                    _ = tx.closed() => return true,
                    res = fetch_summary_list_page(client, &scope.query, plural, filter, continuation.as_deref()) => res,
                };
                match outcome {
                    TableListOutcome::FallbackFullWatch => return false,
                    TableListOutcome::Error(err) => {
                        list_error = Some(err);
                        break;
                    }
                    TableListOutcome::Page {
                        items,
                        resource_version: page_rv,
                        continuation: next_cont,
                    } => {
                        if let Some(rv) = page_rv {
                            listed_rv = Some(rv);
                        }
                        for (uid, val, meta) in items {
                            if !uid.is_empty() {
                                next_cache.insert(uid, meta);
                            }
                            if let Err(err) = reconcile.consume(Event::InitApply(val)) {
                                reconcile.discard_pending();
                                status(tx, sequence, WatchPhase::Failed, Some(err)).await;
                                return true;
                            }
                        }
                        continuation = next_cont;
                        if continuation.is_none() {
                            break;
                        }
                    }
                }
            }
            if let Some(err) = list_error {
                reconcile.discard_pending();
                let terminal = matches!(err.status, Some(400 | 401 | 403 | 404 | 422));
                phase = if terminal {
                    WatchPhase::Failed
                } else {
                    WatchPhase::Reconnecting
                };
                if !status(tx, sequence, phase.clone(), Some(err)).await || terminal {
                    return true;
                }
                tokio::select! {
                    _ = tx.closed() => return true,
                    _ = tokio::time::sleep(Duration::from_millis(backoff_ms)) => {}
                }
                backoff_ms = (backoff_ms * 2).min(15_000);
                continue;
            }
            let Some(rv) = listed_rv else {
                reconcile.discard_pending();
                let err = ApiError::new(
                    ApiErrorCode::Unavailable,
                    "Kubernetes list did not return a resourceVersion",
                    "watch",
                    Some(&scope.query.context),
                    None,
                )
                .with_resource(&scope.query);
                phase = WatchPhase::Reconnecting;
                if !status(tx, sequence, phase.clone(), Some(err)).await {
                    return true;
                }
                tokio::select! {
                    _ = tx.closed() => return true,
                    _ = tokio::time::sleep(Duration::from_millis(backoff_ms)) => {}
                }
                backoff_ms = (backoff_ms * 2).min(15_000);
                continue;
            };
            match reconcile.consume(Event::InitDone) {
                Ok(Some(delta)) => {
                    store.apply_delta(scope, &delta).await;
                    if !emit(tx, sequence, WatchEvent::Delta(delta)).await {
                        return true;
                    }
                    if phase != WatchPhase::Live {
                        phase = WatchPhase::Live;
                        if !status(tx, sequence, phase.clone(), None).await {
                            return true;
                        }
                    }
                }
                Ok(None) => {}
                Err(err) => {
                    reconcile.discard_pending();
                    status(tx, sequence, WatchPhase::Failed, Some(err)).await;
                    return true;
                }
            }
            summary_cache = next_cache;
            resource_version = Some(rv);
            backoff_ms = 1_000;
        }

        let current_rv = resource_version.as_deref().unwrap_or("0");
        let watch_stream = tokio::select! {
            _ = tx.closed() => return true,
            res = api.watch_metadata(&wp, current_rv) => res,
        };
        let stream = match watch_stream {
            Ok(stream) => {
                backoff_ms = 1_000;
                stream
            }
            Err(err) => {
                while connected_rx.try_recv().is_ok() {}
                let api_err = watch_error(watcher::Error::WatchStartFailed(err), &scope.query);
                if api_err.status == Some(410) {
                    resource_version = None;
                }
                let terminal = matches!(api_err.status, Some(400 | 401 | 403 | 404 | 422));
                phase = if terminal {
                    WatchPhase::Failed
                } else {
                    WatchPhase::Reconnecting
                };
                if !status(tx, sequence, phase.clone(), Some(api_err)).await || terminal {
                    return true;
                }
                tokio::select! {
                    _ = tx.closed() => return true,
                    _ = tokio::time::sleep(Duration::from_millis(backoff_ms)) => {}
                }
                backoff_ms = (backoff_ms * 2).min(15_000);
                continue;
            }
        };
        tokio::pin!(stream);
        let mut need_backoff = false;
        loop {
            let next = tokio::select! {
                _ = tx.closed() => return true,
                Some(()) = connected_rx.recv() => {
                    if phase == WatchPhase::Reconnecting {
                        phase = WatchPhase::Live;
                        if !status(tx, sequence, phase.clone(), None).await { return true; }
                    }
                    continue;
                }
                item = stream.next() => item,
            };
            match next {
                Some(Ok(KubeWatchEvent::Bookmark(bm))) => {
                    if !bm.metadata.resource_version.is_empty() {
                        resource_version = Some(bm.metadata.resource_version);
                    }
                }
                Some(Ok(KubeWatchEvent::Added(partial) | KubeWatchEvent::Modified(partial))) => {
                    if let Some(rv) = partial
                        .metadata
                        .resource_version
                        .as_deref()
                        .filter(|s| !s.is_empty())
                    {
                        resource_version = Some(rv.to_owned());
                    }
                    let uid = partial.metadata.uid.clone().unwrap_or_default();
                    let name = partial.metadata.name.clone().unwrap_or_default();
                    let ns = partial.metadata.namespace.clone().unwrap_or_default();
                    let fetched = if !ns.is_empty() && !name.is_empty() {
                        tokio::select! {
                            _ = tx.closed() => return true,
                            res = fetch_single_table_summary(client, &scope.query.kind, plural, &ns, &name) => res,
                        }
                    } else {
                        None
                    };
                    let meta = if let Some(fresh) = fetched {
                        if !uid.is_empty() {
                            summary_cache.insert(uid.clone(), fresh.clone());
                        }
                        fresh
                    } else if let Some(cached) = summary_cache.get(&uid) {
                        cached.clone()
                    } else {
                        let inferred_type = if scope.query.kind == "Secret"
                            && partial
                                .metadata
                                .labels
                                .as_ref()
                                .and_then(|l| l.get("owner"))
                                .map(String::as_str)
                                == Some("helm")
                        {
                            Some("helm.sh/release.v1".into())
                        } else {
                            None
                        };
                        SummaryMeta {
                            secret_type: inferred_type,
                            data_keys: None,
                            size_bytes: None,
                        }
                    };
                    let md_val =
                        serde_json::to_value(partial.metadata).expect("ObjectMeta is JSON");
                    let obj = build_summary_object(&scope.query.kind, md_val, &meta);
                    match reconcile.consume(Event::Apply(obj)) {
                        Ok(Some(delta)) => {
                            store.apply_delta(scope, &delta).await;
                            if !emit(tx, sequence, WatchEvent::Delta(delta)).await {
                                return true;
                            }
                            if phase != WatchPhase::Live {
                                phase = WatchPhase::Live;
                                if !status(tx, sequence, phase.clone(), None).await {
                                    return true;
                                }
                            }
                        }
                        Ok(None) => {}
                        Err(err) => {
                            reconcile.discard_pending();
                            status(tx, sequence, WatchPhase::Failed, Some(err)).await;
                            return true;
                        }
                    }
                }
                Some(Ok(KubeWatchEvent::Deleted(partial))) => {
                    if let Some(rv) = partial
                        .metadata
                        .resource_version
                        .as_deref()
                        .filter(|s| !s.is_empty())
                    {
                        resource_version = Some(rv.to_owned());
                    }
                    if let Some(uid) = partial.metadata.uid.as_deref() {
                        summary_cache.remove(uid);
                    }
                    let md_val =
                        serde_json::to_value(partial.metadata).expect("ObjectMeta is JSON");
                    let obj = build_summary_object(
                        &scope.query.kind,
                        md_val,
                        &SummaryMeta::default(),
                    );
                    match reconcile.consume(Event::Delete(obj)) {
                        Ok(Some(delta)) => {
                            store.apply_delta(scope, &delta).await;
                            if !emit(tx, sequence, WatchEvent::Delta(delta)).await {
                                return true;
                            }
                        }
                        Ok(None) => {}
                        Err(err) => {
                            reconcile.discard_pending();
                            status(tx, sequence, WatchPhase::Failed, Some(err)).await;
                            return true;
                        }
                    }
                }
                Some(Ok(KubeWatchEvent::Error(err))) => {
                    while connected_rx.try_recv().is_ok() {}
                    let api_err = watch_error(watcher::Error::WatchError(err), &scope.query);
                    if api_err.status == Some(410) {
                        resource_version = None;
                    }
                    let terminal = matches!(api_err.status, Some(400 | 401 | 403 | 404 | 422));
                    phase = if terminal {
                        WatchPhase::Failed
                    } else {
                        WatchPhase::Reconnecting
                    };
                    if !status(tx, sequence, phase.clone(), Some(api_err)).await || terminal {
                        return true;
                    }
                    need_backoff = true;
                    break;
                }
                Some(Err(err)) => {
                    while connected_rx.try_recv().is_ok() {}
                    let api_err = watch_error(watcher::Error::WatchFailed(err), &scope.query);
                    if api_err.status == Some(410) {
                        resource_version = None;
                    }
                    let terminal = matches!(api_err.status, Some(400 | 401 | 403 | 404 | 422));
                    phase = if terminal {
                        WatchPhase::Failed
                    } else {
                        WatchPhase::Reconnecting
                    };
                    if !status(tx, sequence, phase.clone(), Some(api_err)).await || terminal {
                        return true;
                    }
                    need_backoff = true;
                    break;
                }
                None => {
                    // Clean server timeout (290s) — resume watch immediately from latest RV.
                    break;
                }
            }
        }
        if need_backoff {
            tokio::select! {
                _ = tx.closed() => return true,
                _ = tokio::time::sleep(Duration::from_millis(backoff_ms)) => {}
            }
            backoff_ms = (backoff_ms * 2).min(15_000);
        }
    }
}

async fn run_watch<F>(
    store: ResourceStore,
    scope: WatchScope,
    filter: WatchFilter,
    client: F,
    tx: mpsc::Sender<WatchMessage>,
) where
    F: Future<Output = Result<(Client, Option<(ApiResource, bool)>), ApiError>>,
{
    let mut sequence = 0;
    if !status(&tx, &mut sequence, WatchPhase::Connecting, None).await {
        return;
    }
    let initialized = tokio::select! {
        _ = tx.closed() => return,
        result = tokio::time::timeout(Duration::from_secs(15), client) => result,
    };
    let (client, resolved) = match initialized {
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
    let namespaced = resolved
        .as_ref()
        .map(|(_, namespaced)| *namespaced)
        .unwrap_or_else(|| {
            crate::core::api::resource_type(&scope.query.kind).is_some_and(|r| r.namespaced)
        });
    let api_result = if let Some((resource, _)) = resolved {
        Ok(if let Some(namespace) = &scope.query.namespace {
            Api::namespaced_with(client.clone(), namespace, &resource)
        } else {
            Api::all_with(client.clone(), &resource)
        })
    } else {
        resource_api(client.clone(), &scope.query)
    };
    let api = match api_result {
        Ok(api) => api,
        Err(error) => {
            status(&tx, &mut sequence, WatchPhase::Failed, Some(error)).await;
            return;
        }
    };
    let is_payload_resource =
        scope.query.group.is_empty() && matches!(scope.query.kind.as_str(), "Secret" | "ConfigMap");
    if is_payload_resource {
        if run_summary_watch(
            &store,
            &scope,
            &filter,
            &client,
            &api,
            namespaced,
            &mut connected_rx,
            &tx,
            &mut sequence,
        )
        .await
        {
            return;
        }
    }
    let mut config = watcher::Config::default().timeout(WATCH_TIMEOUT_SECONDS);
    // Keep pagination on CRDs (large OpenAPI schemas); serve all other resources
    // directly from apiserver's watch cache in one compressed response.
    if scope.query.kind != "CustomResourceDefinition" {
        config.page_size = None;
        config = config.any_semantic();
    }
    if let Some(labels) = filter
        .label_selector
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        config = config.labels(labels);
    }
    if let Some(fields) = filter
        .field_selector
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        config = config.fields(fields);
    }
    let stream = watcher::watcher(api, config).default_backoff();
    tokio::pin!(stream);
    let mut reconcile = Reconciler::with_scope(scope.query.clone(), namespaced);
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
                        let mut json =
                            serde_json::to_value(value).expect("DynamicObject is JSON");
                        if is_payload_resource {
                            summarize_payload_value(&mut json, &scope.query.kind);
                        }
                        Event::Apply(json)
                    }
                    Event::InitApply(mut value) => {
                        prune_managed_fields(&mut value, &scope.query.kind);
                        if scope.query.kind == "CustomResourceDefinition" {
                            strip_crd_schemas(&mut value);
                        }
                        let mut json =
                            serde_json::to_value(value).expect("DynamicObject is JSON");
                        if is_payload_resource {
                            summarize_payload_value(&mut json, &scope.query.kind);
                        }
                        Event::InitApply(json)
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
