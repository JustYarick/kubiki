//! Fast direct Kubernetes storage reads for Helm 3/4 releases (`Secret` and `ConfigMap` drivers).
//! Avoids spawning the `helm` CLI, writing temporary kubeconfigs, and decoding superseded revisions.
//! Uses Kubernetes MVCC `(context, uid, resourceVersion)` caching so unchanged releases and
//! revisions require zero full Secret downloads on refresh, and coalesces concurrent document reads
//! (`values`, `manifest`, `hooks`, `notes`) for the same revision into a single Secret GET.
use super::model::{HelmRelease, HelmReleaseHistory};
use super::reader::{HelmDocument, HelmReader};
use base64::Engine;
use flate2::read::GzDecoder;
use k8s_openapi::api::core::v1::{ConfigMap, Secret};
use kube::{Api, Client, api::ListParams};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::Read;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_RELEASE_JSON_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_META_CACHE_ENTRIES: usize = 4096;
const MAX_CONTENT_CACHE_ENTRIES: usize = 16;
const MAX_CACHED_CONTENT_BYTES: usize = 16 * 1024 * 1024;
const CONTENT_CACHE_TTL: Duration = Duration::from_secs(15);
const INDIVIDUAL_FETCH_THRESHOLD_RELEASES: usize = 8;
const INDIVIDUAL_FETCH_THRESHOLD_HISTORY: usize = 4;

#[derive(Clone, Hash, PartialEq, Eq)]
struct MetaCacheKey {
    context: String,
    uid: String,
    resource_version: String,
}

#[derive(Clone)]
struct CachedReleaseMeta {
    chart: String,
    app_version: String,
    status: String,
    updated: String,
    description: String,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct ContentCacheKey {
    context: String,
    namespace: String,
    name: String,
    revision: u32,
}

#[derive(Clone)]
struct DecodedReleaseContent {
    values_yaml: String,
    manifest: String,
    hooks: String,
    notes: String,
}

impl DecodedReleaseContent {
    fn document(&self, document: HelmDocument) -> &str {
        match document {
            HelmDocument::Values => &self.values_yaml,
            HelmDocument::Manifest => &self.manifest,
            HelmDocument::Hooks => &self.hooks,
            HelmDocument::Notes => &self.notes,
        }
    }

    fn approx_bytes(&self) -> usize {
        self.values_yaml.len() + self.manifest.len() + self.hooks.len() + self.notes.len()
    }
}

struct CachedReleaseContent {
    resource_version: Option<String>,
    fetched_at: Instant,
    decoded: Arc<DecodedReleaseContent>,
}

#[derive(Default)]
struct CacheState {
    meta: HashMap<MetaCacheKey, CachedReleaseMeta>,
    meta_order: VecDeque<MetaCacheKey>,
    /// Tracks latest observed `resourceVersion` per `(context, namespace, object_name)` so
    /// in-place Secret updates (e.g. `pending-upgrade` -> `deployed`) immediately invalidate content.
    latest_rv: HashMap<(String, String, String), String>,
    content: HashMap<ContentCacheKey, CachedReleaseContent>,
    content_order: VecDeque<ContentCacheKey>,
    content_locks: HashMap<ContentCacheKey, Arc<tokio::sync::Mutex<()>>>,
}

/// Bounded in-memory cache for Helm storage reads keyed by Kubernetes `(context, uid, rv)`.
#[derive(Default)]
pub struct HelmStorageCache {
    state: Mutex<CacheState>,
}

impl HelmStorageCache {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, CacheState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn record_rv(&self, context: &str, namespace: &str, object_name: &str, rv: &str) {
        if rv.is_empty() {
            return;
        }
        let mut state = self.lock_state();
        if state.latest_rv.len() > MAX_META_CACHE_ENTRIES * 2 {
            state.latest_rv.clear();
        }
        state.latest_rv.insert(
            (
                context.to_owned(),
                namespace.to_owned(),
                object_name.to_owned(),
            ),
            rv.to_owned(),
        );
    }

    fn get_meta(&self, context: &str, uid: &str, rv: &str) -> Option<CachedReleaseMeta> {
        if uid.is_empty() || rv.is_empty() {
            return None;
        }
        let key = MetaCacheKey {
            context: context.to_owned(),
            uid: uid.to_owned(),
            resource_version: rv.to_owned(),
        };
        self.lock_state().meta.get(&key).cloned()
    }

    fn insert_meta(&self, context: &str, uid: &str, rv: &str, value: CachedReleaseMeta) {
        if uid.is_empty() || rv.is_empty() {
            return;
        }
        let key = MetaCacheKey {
            context: context.to_owned(),
            uid: uid.to_owned(),
            resource_version: rv.to_owned(),
        };
        let mut state = self.lock_state();
        if !state.meta.contains_key(&key) {
            state.meta_order.push_back(key.clone());
        }
        state.meta.insert(key, value);
        while state.meta.len() > MAX_META_CACHE_ENTRIES {
            if let Some(oldest) = state.meta_order.pop_front() {
                state.meta.remove(&oldest);
            } else {
                break;
            }
        }
    }

    fn content_lock(&self, key: &ContentCacheKey) -> Arc<tokio::sync::Mutex<()>> {
        let mut state = self.lock_state();
        if state.content_locks.len() > 128 {
            state
                .content_locks
                .retain(|_, lock| Arc::strong_count(lock) > 1);
        }
        state
            .content_locks
            .entry(key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn get_content(
        &self,
        key: &ContentCacheKey,
        object_name: &str,
    ) -> Option<Arc<DecodedReleaseContent>> {
        let state = self.lock_state();
        let entry = state.content.get(key)?;
        if entry.fetched_at.elapsed() >= CONTENT_CACHE_TTL {
            return None;
        }
        if let Some(known_rv) = state.latest_rv.get(&(
            key.context.clone(),
            key.namespace.clone(),
            object_name.to_owned(),
        )) {
            if entry.resource_version.as_deref() != Some(known_rv.as_str()) {
                return None;
            }
        }
        Some(entry.decoded.clone())
    }

    fn insert_content(
        &self,
        key: ContentCacheKey,
        object_name: &str,
        resource_version: Option<String>,
        decoded: Arc<DecodedReleaseContent>,
    ) {
        if decoded.approx_bytes() > MAX_CACHED_CONTENT_BYTES {
            return;
        }
        let mut state = self.lock_state();
        if let Some(ref rv) = resource_version {
            if !rv.is_empty() {
                state.latest_rv.insert(
                    (
                        key.context.clone(),
                        key.namespace.clone(),
                        object_name.to_owned(),
                    ),
                    rv.clone(),
                );
            }
        }
        state.content_order.retain(|existing| existing != &key);
        state.content_order.push_back(key.clone());
        state.content.insert(
            key,
            CachedReleaseContent {
                resource_version,
                fetched_at: Instant::now(),
                decoded,
            },
        );
        while state.content.len() > MAX_CONTENT_CACHE_ENTRIES {
            if let Some(oldest) = state.content_order.pop_front() {
                state.content.remove(&oldest);
            } else {
                break;
            }
        }
    }

    pub fn invalidate_context(&self, context: &str) {
        let mut state = self.lock_state();
        state.meta.retain(|k, _| k.context != context);
        state.meta_order.retain(|k| k.context != context);
        state.latest_rv.retain(|(ctx, _, _), _| ctx != context);
        state.content.retain(|k, _| k.context != context);
        state.content_order.retain(|k| k.context != context);
    }

    pub fn invalidate_all(&self) {
        let mut state = self.lock_state();
        state.meta.clear();
        state.meta_order.clear();
        state.latest_rv.clear();
        state.content.clear();
        state.content_order.clear();
    }
}

static GLOBAL_CACHE: OnceLock<HelmStorageCache> = OnceLock::new();

fn global_cache() -> &'static HelmStorageCache {
    GLOBAL_CACHE.get_or_init(HelmStorageCache::default)
}

/// Evict cached Helm release metadata and documents for a specific Kubernetes context.
pub fn invalidate_context(context: &str) {
    global_cache().invalidate_context(context);
}

/// Evict all cached Helm storage entries (for example after changing kubeconfig paths).
pub fn invalidate_all() {
    global_cache().invalidate_all();
}

#[derive(Deserialize)]
struct ReleasePayloadMeta {
    chart: Option<ChartMetaWrap>,
    info: Option<ReleaseInfoMeta>,
}

#[derive(Deserialize)]
struct ChartMetaWrap {
    metadata: Option<ChartMeta>,
}

#[derive(Deserialize)]
struct ChartMeta {
    name: Option<String>,
    version: Option<String>,
    #[serde(rename = "appVersion")]
    app_version: Option<String>,
}

#[derive(Deserialize)]
struct ReleaseInfoMeta {
    last_deployed: Option<String>,
    status: Option<String>,
    description: Option<String>,
}

#[derive(Deserialize)]
struct ReleasePayloadFull {
    config: Option<serde_json::Value>,
    manifest: Option<String>,
    hooks: Option<Vec<ReleaseHook>>,
    info: Option<ReleaseInfoFull>,
}

#[derive(Deserialize)]
struct ReleaseInfoFull {
    notes: Option<String>,
}

#[derive(Deserialize)]
struct ReleaseHook {
    path: Option<String>,
    manifest: Option<String>,
}

fn decode_release_json_bytes(raw: &[u8]) -> Option<Vec<u8>> {
    let decoded = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
    if decoded.len() >= 2 && decoded[0] == 0x1f && decoded[1] == 0x8b {
        let mut decoder = GzDecoder::new(decoded.as_slice()).take(MAX_RELEASE_JSON_BYTES + 1);
        let mut out = Vec::new();
        decoder.read_to_end(&mut out).ok()?;
        if out.len() as u64 > MAX_RELEASE_JSON_BYTES {
            return None;
        }
        Some(out)
    } else if decoded.len() as u64 <= MAX_RELEASE_JSON_BYTES {
        Some(decoded)
    } else {
        None
    }
}

/// Decode a Helm 3/4 `data.release` payload (already base64-decoded once by Kubernetes Secret
/// deserialization, or raw string in ConfigMap) into minimal chart/info metadata.
fn decode_release_meta(raw: &[u8]) -> Option<ReleasePayloadMeta> {
    let json_bytes = decode_release_json_bytes(raw)?;
    serde_json::from_slice(&json_bytes).ok()
}

fn decode_release_content(raw: &[u8]) -> Option<DecodedReleaseContent> {
    let json_bytes = decode_release_json_bytes(raw)?;
    let full: ReleasePayloadFull = serde_json::from_slice(&json_bytes).ok()?;
    let values_yaml = match full.config {
        None | Some(serde_json::Value::Null) => "{}\n".to_owned(),
        Some(serde_json::Value::Object(ref map)) if map.is_empty() => "{}\n".to_owned(),
        Some(ref value) => serde_yaml::to_string(value).ok()?,
    };
    let manifest = full.manifest.unwrap_or_default();
    let notes = full.info.and_then(|info| info.notes).unwrap_or_default();
    let hooks = full
        .hooks
        .unwrap_or_default()
        .into_iter()
        .filter_map(|hook| {
            let body = hook.manifest.unwrap_or_default();
            if body.trim().is_empty() {
                return None;
            }
            let mut section = String::from("---\n");
            if let Some(path) = hook.path.filter(|p| !p.is_empty()) {
                section.push_str("# Source: ");
                section.push_str(&path);
                section.push('\n');
            }
            section.push_str(&body);
            if !section.ends_with('\n') {
                section.push('\n');
            }
            Some(section)
        })
        .collect::<Vec<_>>()
        .join("");

    Some(DecodedReleaseContent {
        values_yaml,
        manifest,
        hooks,
        notes,
    })
}

fn format_chart(meta: Option<&ChartMeta>) -> (String, String) {
    let Some(meta) = meta else {
        return (String::new(), String::new());
    };
    let chart = match (meta.name.as_deref(), meta.version.as_deref()) {
        (Some(n), Some(v)) if !n.is_empty() && !v.is_empty() => format!("{n}-{v}"),
        (Some(n), _) => n.to_owned(),
        _ => String::new(),
    };
    let app_version = meta.app_version.clone().unwrap_or_default();
    (chart, app_version)
}

fn format_modified_at(labels: &BTreeMap<String, String>) -> String {
    labels
        .get("modifiedAt")
        .and_then(|s| s.parse::<i64>().ok())
        .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

struct StorageEntry {
    uid: String,
    resource_version: String,
    object_name: String,
    namespace: String,
    name: String,
    version: i32,
    status: String,
    modified_at: String,
    payload: Vec<u8>,
}

struct MetaEntry {
    uid: String,
    resource_version: String,
    object_name: String,
    namespace: String,
    name: String,
    version: i32,
    status: String,
    modified_at: String,
}

fn meta_entry_from_object_meta(meta: kube::core::ObjectMeta) -> Option<MetaEntry> {
    let labels = meta.labels?;
    let name = labels.get("name")?.clone();
    let version = labels.get("version")?.parse::<i32>().ok()?;
    let object_name = meta.name?;
    let namespace = meta.namespace.unwrap_or_default();
    let uid = meta.uid.unwrap_or_default();
    let resource_version = meta.resource_version.unwrap_or_default();
    let status = labels.get("status").cloned().unwrap_or_default();
    let modified_at = format_modified_at(&labels);
    Some(MetaEntry {
        uid,
        resource_version,
        object_name,
        namespace,
        name,
        version,
        status,
        modified_at,
    })
}

fn build_cached_meta(entry: &StorageEntry) -> CachedReleaseMeta {
    let meta = decode_release_meta(&entry.payload);
    let (chart, app_version) =
        format_chart(meta.as_ref().and_then(|m| m.chart.as_ref()?.metadata.as_ref()));
    let info = meta.as_ref().and_then(|m| m.info.as_ref());
    let status = info
        .and_then(|i| i.status.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| entry.status.clone());
    let updated = info
        .and_then(|i| i.last_deployed.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| entry.modified_at.clone());
    let description = info
        .and_then(|i| i.description.clone())
        .unwrap_or_default();
    CachedReleaseMeta {
        chart,
        app_version,
        status,
        updated,
        description,
    }
}

async fn list_secret_metadata(
    client: &Client,
    namespace: Option<&str>,
    label_selector: &str,
) -> Result<Vec<MetaEntry>, kube::Error> {
    let api: Api<Secret> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    let mut entries = Vec::new();
    let mut cont: Option<String> = None;
    for _ in 0..20 {
        let mut lp = ListParams::default()
            .labels(label_selector)
            .fields("type=helm.sh/release.v1");
        lp = if let Some(ref token) = cont {
            lp.continue_token(token)
        } else {
            lp.match_any()
        };
        let list = api.list_metadata(&lp).await?;
        for item in list.items {
            if let Some(entry) = meta_entry_from_object_meta(item.metadata) {
                entries.push(entry);
            }
        }
        cont = list.metadata.continue_.filter(|s| !s.is_empty());
        if cont.is_none() {
            break;
        }
    }
    Ok(entries)
}

async fn list_configmap_metadata(
    client: &Client,
    namespace: Option<&str>,
    label_selector: &str,
) -> Result<Vec<MetaEntry>, kube::Error> {
    let api: Api<ConfigMap> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    let mut entries = Vec::new();
    let mut cont: Option<String> = None;
    for _ in 0..20 {
        let mut lp = ListParams::default().labels(label_selector);
        lp = if let Some(ref token) = cont {
            lp.continue_token(token)
        } else {
            lp.match_any()
        };
        let list = api.list_metadata(&lp).await?;
        for item in list.items {
            if let Some(entry) = meta_entry_from_object_meta(item.metadata) {
                entries.push(entry);
            }
        }
        cont = list.metadata.continue_.filter(|s| !s.is_empty());
        if cont.is_none() {
            break;
        }
    }
    Ok(entries)
}

async fn list_secret_entries(
    client: &Client,
    namespace: Option<&str>,
    label_selector: &str,
) -> Result<Vec<StorageEntry>, kube::Error> {
    let api: Api<Secret> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    let mut entries = Vec::new();
    let mut cont: Option<String> = None;
    for _ in 0..20 {
        let mut lp = ListParams::default()
            .labels(label_selector)
            .fields("type=helm.sh/release.v1");
        lp = if let Some(ref token) = cont {
            lp.continue_token(token)
        } else {
            lp.match_any()
        };
        let list = api.list(&lp).await?;
        for secret in list.items {
            let Some(meta) = meta_entry_from_object_meta(secret.metadata) else {
                continue;
            };
            let payload = secret
                .data
                .and_then(|mut d| d.remove("release"))
                .map(|b| b.0)
                .unwrap_or_default();
            entries.push(StorageEntry {
                uid: meta.uid,
                resource_version: meta.resource_version,
                object_name: meta.object_name,
                namespace: meta.namespace,
                name: meta.name,
                version: meta.version,
                status: meta.status,
                modified_at: meta.modified_at,
                payload,
            });
        }
        cont = list.metadata.continue_.filter(|s| !s.is_empty());
        if cont.is_none() {
            break;
        }
    }
    Ok(entries)
}

async fn list_configmap_entries(
    client: &Client,
    namespace: Option<&str>,
    label_selector: &str,
) -> Result<Vec<StorageEntry>, kube::Error> {
    let api: Api<ConfigMap> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    let mut entries = Vec::new();
    let mut cont: Option<String> = None;
    for _ in 0..20 {
        let mut lp = ListParams::default().labels(label_selector);
        lp = if let Some(ref token) = cont {
            lp.continue_token(token)
        } else {
            lp.match_any()
        };
        let list = api.list(&lp).await?;
        for cm in list.items {
            let Some(meta) = meta_entry_from_object_meta(cm.metadata) else {
                continue;
            };
            let payload = cm
                .data
                .and_then(|mut d| d.remove("release"))
                .map(|s| s.into_bytes())
                .unwrap_or_default();
            entries.push(StorageEntry {
                uid: meta.uid,
                resource_version: meta.resource_version,
                object_name: meta.object_name,
                namespace: meta.namespace,
                name: meta.name,
                version: meta.version,
                status: meta.status,
                modified_at: meta.modified_at,
                payload,
            });
        }
        cont = list.metadata.continue_.filter(|s| !s.is_empty());
        if cont.is_none() {
            break;
        }
    }
    Ok(entries)
}

async fn fetch_single_entry(
    client: Client,
    meta: MetaEntry,
    use_configmaps: bool,
) -> Option<StorageEntry> {
    if use_configmaps {
        let api: Api<ConfigMap> = Api::namespaced(client, &meta.namespace);
        let cm = api.get(&meta.object_name).await.ok()?;
        let rv = cm
            .metadata
            .resource_version
            .unwrap_or(meta.resource_version);
        let uid = cm.metadata.uid.unwrap_or(meta.uid);
        let payload = cm
            .data
            .and_then(|mut d| d.remove("release"))
            .map(|s| s.into_bytes())
            .unwrap_or_default();
        Some(StorageEntry {
            uid,
            resource_version: rv,
            object_name: meta.object_name,
            namespace: meta.namespace,
            name: meta.name,
            version: meta.version,
            status: meta.status,
            modified_at: meta.modified_at,
            payload,
        })
    } else {
        let api: Api<Secret> = Api::namespaced(client, &meta.namespace);
        let secret = api.get(&meta.object_name).await.ok()?;
        let rv = secret
            .metadata
            .resource_version
            .unwrap_or(meta.resource_version);
        let uid = secret.metadata.uid.unwrap_or(meta.uid);
        let payload = secret
            .data
            .and_then(|mut d| d.remove("release"))
            .map(|b| b.0)
            .unwrap_or_default();
        Some(StorageEntry {
            uid,
            resource_version: rv,
            object_name: meta.object_name,
            namespace: meta.namespace,
            name: meta.name,
            version: meta.version,
            status: meta.status,
            modified_at: meta.modified_at,
            payload,
        })
    }
}

/// Fast release inventory via the warm Kubernetes client.
/// Uses metadata-only discovery first, reuses cached metadata for unchanged `(context, uid, rv)`
/// revisions, and only fetches changed/new active revisions. Returns `None` when RBAC denies
/// Secret/ConfigMap reads so callers can fall back to the Helm CLI.
pub async fn list_releases_fast(
    client: &Client,
    context: &str,
    namespace: Option<&str>,
) -> Option<Vec<HelmRelease>> {
    list_releases_fast_with_cache(client, context, namespace, global_cache()).await
}

pub async fn list_releases_fast_with_cache(
    client: &Client,
    context: &str,
    namespace: Option<&str>,
    cache: &HelmStorageCache,
) -> Option<Vec<HelmRelease>> {
    use futures::StreamExt;
    let mut use_configmaps = false;
    let meta_entries = match list_secret_metadata(client, namespace, "owner=helm").await {
        Ok(list) if !list.is_empty() => list,
        Ok(_) => match list_configmap_metadata(client, namespace, "owner=helm").await {
            Ok(cm_list) => {
                use_configmaps = !cm_list.is_empty();
                cm_list
            }
            Err(_) => Vec::new(),
        },
        Err(_) => return None,
    };
    if meta_entries.is_empty() {
        return Some(Vec::new());
    }

    let mut latest_meta: BTreeMap<(String, String), MetaEntry> = BTreeMap::new();
    for entry in meta_entries {
        cache.record_rv(
            context,
            &entry.namespace,
            &entry.object_name,
            &entry.resource_version,
        );
        let key = (entry.namespace.clone(), entry.name.clone());
        match latest_meta.get(&key) {
            Some(existing) if existing.version >= entry.version => {}
            _ => {
                latest_meta.insert(key, entry);
            }
        }
    }

    let mut releases_by_key: BTreeMap<(String, String), HelmRelease> = BTreeMap::new();
    let mut misses: BTreeMap<(String, String), MetaEntry> = BTreeMap::new();

    for (key, meta) in latest_meta {
        if let Some(cached) = cache.get_meta(context, &meta.uid, &meta.resource_version) {
            releases_by_key.insert(
                key,
                HelmRelease {
                    name: meta.name,
                    namespace: meta.namespace,
                    revision: meta.version.to_string(),
                    updated: cached.updated,
                    status: cached.status,
                    chart: cached.chart,
                    app_version: cached.app_version,
                },
            );
        } else {
            misses.insert(key, meta);
        }
    }

    if !misses.is_empty() {
        let mut fetched_entries: BTreeMap<(String, String), StorageEntry> = BTreeMap::new();

        // Warm incremental refresh: fetch only the few changed releases directly instead of
        // re-downloading every active release payload across the cluster.
        if misses.len() <= INDIVIDUAL_FETCH_THRESHOLD_RELEASES {
            let fetched: Vec<Option<StorageEntry>> = futures::stream::iter(misses.into_values())
                .map(|meta| fetch_single_entry(client.clone(), meta, use_configmaps))
                .buffer_unordered(8)
                .collect()
                .await;
            for entry in fetched.into_iter().flatten() {
                fetched_entries.insert((entry.namespace.clone(), entry.name.clone()), entry);
            }
        } else {
            let active_entries = if use_configmaps {
                list_configmap_entries(client, namespace, "owner=helm,status!=superseded")
                    .await
                    .ok()?
            } else {
                list_secret_entries(client, namespace, "owner=helm,status!=superseded")
                    .await
                    .ok()?
            };
            for entry in active_entries {
                let key = (entry.namespace.clone(), entry.name.clone());
                if let Some(target) = misses.get(&key) {
                    if entry.version == target.version && entry.object_name == target.object_name {
                        fetched_entries.insert(key, entry);
                    }
                }
            }
            // Fetch only the rare latest revisions filtered out by `status!=superseded`.
            let remaining: Vec<MetaEntry> = misses
                .into_iter()
                .filter(|(k, _)| !fetched_entries.contains_key(k))
                .map(|(_, v)| v)
                .collect();
            if !remaining.is_empty() {
                let fetched: Vec<Option<StorageEntry>> = futures::stream::iter(remaining)
                    .map(|meta| fetch_single_entry(client.clone(), meta, use_configmaps))
                    .buffer_unordered(8)
                    .collect()
                    .await;
                for entry in fetched.into_iter().flatten() {
                    fetched_entries.insert((entry.namespace.clone(), entry.name.clone()), entry);
                }
            }
        }

        for (key, entry) in fetched_entries {
            let decoded = build_cached_meta(&entry);
            cache.record_rv(
                context,
                &entry.namespace,
                &entry.object_name,
                &entry.resource_version,
            );
            cache.insert_meta(context, &entry.uid, &entry.resource_version, decoded.clone());
            releases_by_key.insert(
                key,
                HelmRelease {
                    name: entry.name,
                    namespace: entry.namespace,
                    revision: entry.version.to_string(),
                    updated: decoded.updated,
                    status: decoded.status,
                    chart: decoded.chart,
                    app_version: decoded.app_version,
                },
            );
        }
    }

    Some(releases_by_key.into_values().collect())
}

/// Fast release revision history via the warm Kubernetes client.
/// Uses metadata-only discovery + MVCC `(context, uid, rv)` caching so already-seen revisions
/// (including the latest revision decoded by `list_releases_fast`) require zero payload downloads.
/// Returns `None` on validation/RBAC errors so callers can fall back to the Helm CLI.
pub async fn release_history_fast(
    client: &Client,
    context: &str,
    namespace: &str,
    name: &str,
) -> Option<Vec<HelmReleaseHistory>> {
    release_history_fast_with_cache(client, context, namespace, name, global_cache()).await
}

pub async fn release_history_fast_with_cache(
    client: &Client,
    context: &str,
    namespace: &str,
    name: &str,
    cache: &HelmStorageCache,
) -> Option<Vec<HelmReleaseHistory>> {
    use futures::StreamExt;
    HelmReader::release(context, namespace, name).ok()?;
    let selector = format!("owner=helm,name={name}");
    let mut use_configmaps = false;
    let meta_entries = match list_secret_metadata(client, Some(namespace), &selector).await {
        Ok(list) if !list.is_empty() => list,
        Ok(_) => match list_configmap_metadata(client, Some(namespace), &selector).await {
            Ok(cm_list) if !cm_list.is_empty() => {
                use_configmaps = true;
                cm_list
            }
            _ => return None,
        },
        Err(_) => return None,
    };

    let mut history_by_rev: BTreeMap<i32, HelmReleaseHistory> = BTreeMap::new();
    let mut misses: Vec<MetaEntry> = Vec::new();

    for meta in meta_entries {
        cache.record_rv(
            context,
            &meta.namespace,
            &meta.object_name,
            &meta.resource_version,
        );
        if let Some(cached) = cache.get_meta(context, &meta.uid, &meta.resource_version) {
            history_by_rev.insert(
                meta.version,
                HelmReleaseHistory {
                    revision: meta.version,
                    updated: cached.updated,
                    status: cached.status,
                    chart: cached.chart,
                    app_version: cached.app_version,
                    description: cached.description,
                },
            );
        } else {
            misses.push(meta);
        }
    }

    if !misses.is_empty() {
        let fetched_entries: Vec<StorageEntry> = if misses.len() <= INDIVIDUAL_FETCH_THRESHOLD_HISTORY
        {
            futures::stream::iter(misses)
                .map(|meta| fetch_single_entry(client.clone(), meta, use_configmaps))
                .buffer_unordered(4)
                .collect::<Vec<_>>()
                .await
                .into_iter()
                .flatten()
                .collect()
        } else if use_configmaps {
            list_configmap_entries(client, Some(namespace), &selector)
                .await
                .ok()?
        } else {
            list_secret_entries(client, Some(namespace), &selector)
                .await
                .ok()?
        };

        for entry in fetched_entries {
            if history_by_rev.contains_key(&entry.version) {
                continue;
            }
            let decoded = build_cached_meta(&entry);
            cache.record_rv(
                context,
                &entry.namespace,
                &entry.object_name,
                &entry.resource_version,
            );
            cache.insert_meta(context, &entry.uid, &entry.resource_version, decoded.clone());
            history_by_rev.insert(
                entry.version,
                HelmReleaseHistory {
                    revision: entry.version,
                    updated: decoded.updated,
                    status: decoded.status,
                    chart: decoded.chart,
                    app_version: decoded.app_version,
                    description: decoded.description,
                },
            );
        }
    }

    if history_by_rev.is_empty() {
        return None;
    }
    Some(history_by_rev.into_values().collect())
}

/// Fast direct Kubernetes storage read for `helm get values|manifest|hooks|notes`.
/// Fetches `sh.helm.release.v1.{name}.v{revision}` once, decodes all 4 documents, caches them
/// briefly (coalescing parallel reads like `manifest` + `hooks`), and avoids spawning `helm`.
/// Returns `None` on RBAC denial, unknown storage driver, or oversized documents so callers can
/// fall back to `HelmReader::content`.
pub async fn release_content_fast(
    client: &Client,
    context: &str,
    namespace: &str,
    name: &str,
    revision: u32,
    document: HelmDocument,
) -> Option<String> {
    release_content_fast_with_cache(
        client,
        context,
        namespace,
        name,
        revision,
        document,
        global_cache(),
    )
    .await
}

pub async fn release_content_fast_with_cache(
    client: &Client,
    context: &str,
    namespace: &str,
    name: &str,
    revision: u32,
    document: HelmDocument,
    cache: &HelmStorageCache,
) -> Option<String> {
    HelmReader::release(context, namespace, name).ok()?;
    if revision == 0 {
        return None;
    }
    let object_name = format!("sh.helm.release.v1.{name}.v{revision}");
    let cache_key = ContentCacheKey {
        context: context.to_owned(),
        namespace: namespace.to_owned(),
        name: name.to_owned(),
        revision,
    };

    if let Some(decoded) = cache.get_content(&cache_key, &object_name) {
        let text = decoded.document(document);
        return (text.len() <= MAX_DOCUMENT_BYTES).then(|| text.to_owned());
    }

    // Coalesce parallel requests for the same revision (e.g. ReleaseEvidence loading manifest + hooks).
    let revision_lock = cache.content_lock(&cache_key);
    let _guard = revision_lock.lock().await;

    if let Some(decoded) = cache.get_content(&cache_key, &object_name) {
        let text = decoded.document(document);
        return (text.len() <= MAX_DOCUMENT_BYTES).then(|| text.to_owned());
    }

    let (rv, payload) = match Api::<Secret>::namespaced(client.clone(), namespace)
        .get(&object_name)
        .await
    {
        Ok(secret) => {
            if secret.type_.as_deref() != Some("helm.sh/release.v1") {
                return None;
            }
            let rv = secret.metadata.resource_version;
            let payload = secret.data.and_then(|mut d| d.remove("release"))?.0;
            (rv, payload)
        }
        Err(kube::Error::Api(ae)) if ae.code == 404 => {
            let cm = Api::<ConfigMap>::namespaced(client.clone(), namespace)
                .get(&object_name)
                .await
                .ok()?;
            let rv = cm.metadata.resource_version;
            let payload = cm
                .data
                .and_then(|mut d| d.remove("release"))?
                .into_bytes();
            (rv, payload)
        }
        Err(_) => return None,
    };

    let decoded = Arc::new(decode_release_content(&payload)?);
    cache.insert_content(cache_key, &object_name, rv, decoded.clone());
    let text = decoded.document(document);
    (text.len() <= MAX_DOCUMENT_BYTES).then(|| text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use kube::client::Body;
    use serde_json::json;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn encode_release_secret_data(payload: &serde_json::Value) -> String {
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(payload.to_string().as_bytes()).unwrap();
        let b64_inner = base64::engine::general_purpose::STANDARD.encode(enc.finish().unwrap());
        // Kubernetes Secret JSON base64-encodes `data.*` on top of Helm's own base64(gzip(json)).
        base64::engine::general_purpose::STANDARD.encode(b64_inner)
    }

    #[test]
    fn decodes_gzipped_base64_helm_release_metadata_without_manifest_overhead() {
        let payload = json!({
            "name": "ingress",
            "info": {
                "last_deployed": "2026-11-20T09:00:00Z",
                "status": "deployed",
                "description": "Upgrade complete"
            },
            "chart": {
                "metadata": {
                    "name": "ingress-nginx",
                    "version": "4.11.0",
                    "appVersion": "1.11.0"
                },
                "templates": [{"name": "huge.yaml", "data": "ignored"}]
            },
            "manifest": "apiVersion: v1\nkind: Service\n"
        });
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(payload.to_string().as_bytes()).unwrap();
        let gzipped = encoder.finish().unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(gzipped);

        let meta = decode_release_meta(b64.as_bytes()).unwrap();
        let (chart, app_version) = format_chart(meta.chart.as_ref().and_then(|c| c.metadata.as_ref()));
        assert_eq!(chart, "ingress-nginx-4.11.0");
        assert_eq!(app_version, "1.11.0");
        let info = meta.info.unwrap();
        assert_eq!(info.status.as_deref(), Some("deployed"));
        assert_eq!(info.description.as_deref(), Some("Upgrade complete"));
    }

    /// WHY THIS TEST EXISTS:
    /// Cold-start inventory on a cluster with many releases must use 1 metadata list +
    /// 1 filtered batch list (`status!=superseded`) rather than downloading superseded history
    /// tarballs, while still recovering the rare case where a release's latest revision itself is
    /// `superseded`.
    #[tokio::test]
    async fn list_releases_fast_skips_superseded_revisions_and_recovers_superseded_latest() {
        let make_payload = |chart: &str, ver: &str, status: &str| {
            encode_release_secret_data(&json!({
                "name": chart,
                "info": { "last_deployed": "2026-11-20T10:00:00Z", "status": status },
                "chart": { "metadata": { "name": chart, "version": ver, "appVersion": "1.0" } }
            }))
        };

        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let service = tower::service_fn(move |req: http::Request<Body>| {
            let uri = req.uri().to_string();
            let accept = req
                .headers()
                .get(http::header::ACCEPT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            seen.lock().unwrap().push((uri.clone(), accept.clone()));
            let payload_active = make_payload("nginx", "2.0.0", "deployed");
            let payload_old_only = make_payload("legacy", "1.0.0", "superseded");
            async move {
                let body = if accept.contains("PartialObjectMetadata") {
                    // > 8 releases triggers the batch `status!=superseded` path.
                    let mut items = vec![
                        json!({ "metadata": { "uid": "u-web-1", "resourceVersion": "1", "name": "sh.helm.release.v1.web.v1", "namespace": "prod", "labels": { "owner": "helm", "name": "web", "version": "1", "status": "superseded" } } }),
                        json!({ "metadata": { "uid": "u-web-2", "resourceVersion": "2", "name": "sh.helm.release.v1.web.v2", "namespace": "prod", "labels": { "owner": "helm", "name": "web", "version": "2", "status": "deployed" } } }),
                        json!({ "metadata": { "uid": "u-old-1", "resourceVersion": "3", "name": "sh.helm.release.v1.old.v1", "namespace": "prod", "labels": { "owner": "helm", "name": "old", "version": "1", "status": "superseded" } } }),
                    ];
                    for i in 0..8 {
                        items.push(json!({
                            "metadata": {
                                "uid": format!("u-app-{i}"),
                                "resourceVersion": "10",
                                "name": format!("sh.helm.release.v1.app-{i}.v1"),
                                "namespace": "prod",
                                "labels": { "owner": "helm", "name": format!("app-{i}"), "version": "1", "status": "deployed" }
                            }
                        }));
                    }
                    json!({
                        "apiVersion": "meta.k8s.io/v1",
                        "kind": "PartialObjectMetadataList",
                        "metadata": { "resourceVersion": "10" },
                        "items": items
                    })
                } else if uri.contains("status%21%3Dsuperseded") || uri.contains("status!=superseded") {
                    let mut items = vec![json!({
                        "apiVersion": "v1",
                        "kind": "Secret",
                        "metadata": { "uid": "u-web-2", "resourceVersion": "2", "name": "sh.helm.release.v1.web.v2", "namespace": "prod", "labels": { "owner": "helm", "name": "web", "version": "2", "status": "deployed" } },
                        "type": "helm.sh/release.v1",
                        "data": { "release": payload_active }
                    })];
                    for i in 0..8 {
                        items.push(json!({
                            "apiVersion": "v1",
                            "kind": "Secret",
                            "metadata": { "uid": format!("u-app-{i}"), "resourceVersion": "10", "name": format!("sh.helm.release.v1.app-{i}.v1"), "namespace": "prod", "labels": { "owner": "helm", "name": format!("app-{i}"), "version": "1", "status": "deployed" } },
                            "type": "helm.sh/release.v1",
                            "data": { "release": payload_active }
                        }));
                    }
                    json!({
                        "apiVersion": "v1",
                        "kind": "SecretList",
                        "metadata": { "resourceVersion": "10" },
                        "items": items
                    })
                } else if uri.ends_with("/sh.helm.release.v1.old.v1") {
                    json!({
                        "apiVersion": "v1",
                        "kind": "Secret",
                        "metadata": { "uid": "u-old-1", "resourceVersion": "3", "name": "sh.helm.release.v1.old.v1", "namespace": "prod", "labels": { "owner": "helm", "name": "old", "version": "1", "status": "superseded" } },
                        "type": "helm.sh/release.v1",
                        "data": { "release": payload_old_only }
                    })
                } else {
                    panic!("Unexpected request: {uri} ({accept})");
                };
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(200)
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(&body).unwrap()))
                        .unwrap(),
                )
            }
        });
        let cache = HelmStorageCache::default();
        let client = Client::new(service, "default");
        let releases = list_releases_fast_with_cache(&client, "prod-ctx", Some("prod"), &cache)
            .await
            .unwrap();
        assert_eq!(releases.len(), 10);
        let web = releases.iter().find(|r| r.name == "web").unwrap();
        assert_eq!(web.revision, "2");
        assert_eq!(web.chart, "nginx-2.0.0");
        let old = releases.iter().find(|r| r.name == "old").unwrap();
        assert_eq!(old.revision, "1");
        assert_eq!(old.chart, "legacy-1.0.0");

        let recorded = requests.lock().unwrap();
        assert_eq!(recorded.len(), 3);
        assert!(recorded[0].1.contains("PartialObjectMetadata"));
        assert!(recorded[1].0.contains("status") && recorded[1].0.contains("superseded"));
        assert!(recorded[2].0.ends_with("/sh.helm.release.v1.old.v1"));
    }

    /// WHY THIS TEST EXISTS:
    /// Polling Helm inventory every 30s or switching between Overview/Releases must NOT re-download
    /// megabytes of release Secrets when `(uid, resourceVersion)` has not changed, and must still
    /// pick up an external upgrade immediately when `resourceVersion` bumps.
    #[tokio::test]
    async fn mvcc_cache_eliminates_payload_downloads_when_unchanged_and_refreshes_on_rv_bump() {
        let rv = Arc::new(AtomicUsize::new(1));
        let payload_requests = Arc::new(AtomicUsize::new(0));
        let rv_clone = rv.clone();
        let payload_clone = payload_requests.clone();

        let service = tower::service_fn(move |req: http::Request<Body>| {
            let uri = req.uri().to_string();
            let accept = req
                .headers()
                .get(http::header::ACCEPT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            let current_rv = rv_clone.load(Ordering::SeqCst);
            let payload_count = payload_clone.clone();
            async move {
                let body = if accept.contains("PartialObjectMetadata") {
                    json!({
                        "apiVersion": "meta.k8s.io/v1",
                        "kind": "PartialObjectMetadataList",
                        "metadata": { "resourceVersion": current_rv.to_string() },
                        "items": [{
                            "metadata": {
                                "uid": "u-api-1",
                                "resourceVersion": current_rv.to_string(),
                                "name": "sh.helm.release.v1.api.v1",
                                "namespace": "prod",
                                "labels": { "owner": "helm", "name": "api", "version": "1", "status": "deployed" }
                            }
                        }]
                    })
                } else {
                    payload_count.fetch_add(1, Ordering::SeqCst);
                    let status = if current_rv == 1 { "pending-upgrade" } else { "deployed" };
                    let data = encode_release_secret_data(&json!({
                        "name": "api",
                        "info": { "last_deployed": "2026-11-20T10:00:00Z", "status": status },
                        "chart": { "metadata": { "name": "api", "version": "1.0.0", "appVersion": "1.0" } }
                    }));
                    json!({
                        "apiVersion": "v1",
                        "kind": "Secret",
                        "metadata": {
                            "uid": "u-api-1",
                            "resourceVersion": current_rv.to_string(),
                            "name": "sh.helm.release.v1.api.v1",
                            "namespace": "prod",
                            "labels": { "owner": "helm", "name": "api", "version": "1", "status": status }
                        },
                        "type": "helm.sh/release.v1",
                        "data": { "release": data }
                    })
                };
                assert!(!uri.is_empty());
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(200)
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(&body).unwrap()))
                        .unwrap(),
                )
            }
        });

        let cache = HelmStorageCache::default();
        let client = Client::new(service, "default");

        // 1. Cold read fetches payload once.
        let first = list_releases_fast_with_cache(&client, "prod", Some("prod"), &cache)
            .await
            .unwrap();
        assert_eq!(first[0].status, "pending-upgrade");
        assert_eq!(payload_requests.load(Ordering::SeqCst), 1);

        // 2. Warm repeat read with identical RV performs ZERO payload GETs.
        let second = list_releases_fast_with_cache(&client, "prod", Some("prod"), &cache)
            .await
            .unwrap();
        assert_eq!(second[0].status, "pending-upgrade");
        assert_eq!(payload_requests.load(Ordering::SeqCst), 1);

        // 3. RV bump immediately fetches the updated Secret once.
        rv.store(2, Ordering::SeqCst);
        let third = list_releases_fast_with_cache(&client, "prod", Some("prod"), &cache)
            .await
            .unwrap();
        assert_eq!(third[0].status, "deployed");
        assert_eq!(payload_requests.load(Ordering::SeqCst), 2);
    }

    /// WHY THIS TEST EXISTS:
    /// Reading `Values`, `Manifest`, `Hooks`, and `Notes` (including parallel `manifest` + `hooks`
    /// requests from ReleaseEvidence) must read the Helm storage Secret directly once without
    /// spawning `helm` CLI or fetching the Secret 4 separate times.
    #[tokio::test]
    async fn release_content_fast_decodes_all_documents_and_coalesces_into_single_secret_get() {
        let get_count = Arc::new(AtomicUsize::new(0));
        let counter = get_count.clone();
        let data = encode_release_secret_data(&json!({
            "name": "web",
            "config": { "replicaCount": 3, "image": { "tag": "1.27" } },
            "manifest": "---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\n",
            "hooks": [{
                "path": "web/templates/test-hook.yaml",
                "manifest": "apiVersion: v1\nkind: Pod\nmetadata:\n  name: web-test"
            }],
            "info": {
                "notes": "Visit http://web.prod.svc"
            }
        }));

        let service = tower::service_fn(move |_req: http::Request<Body>| {
            let counter = counter.clone();
            let data = data.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                let body = json!({
                    "apiVersion": "v1",
                    "kind": "Secret",
                    "metadata": {
                        "uid": "u-web-2",
                        "resourceVersion": "42",
                        "name": "sh.helm.release.v1.web.v2",
                        "namespace": "prod"
                    },
                    "type": "helm.sh/release.v1",
                    "data": { "release": data }
                });
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(200)
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(&body).unwrap()))
                        .unwrap(),
                )
            }
        });

        let cache = HelmStorageCache::default();
        let client = Client::new(service, "default");

        let (manifest, hooks) = tokio::join!(
            release_content_fast_with_cache(
                &client,
                "prod",
                "prod",
                "web",
                2,
                HelmDocument::Manifest,
                &cache,
            ),
            release_content_fast_with_cache(
                &client,
                "prod",
                "prod",
                "web",
                2,
                HelmDocument::Hooks,
                &cache,
            )
        );
        let values = release_content_fast_with_cache(
            &client,
            "prod",
            "prod",
            "web",
            2,
            HelmDocument::Values,
            &cache,
        )
        .await
        .unwrap();
        let notes = release_content_fast_with_cache(
            &client,
            "prod",
            "prod",
            "web",
            2,
            HelmDocument::Notes,
            &cache,
        )
        .await
        .unwrap();

        assert_eq!(get_count.load(Ordering::SeqCst), 1);
        assert!(manifest.unwrap().contains("kind: Service"));
        let hooks = hooks.unwrap();
        assert!(hooks.contains("# Source: web/templates/test-hook.yaml"));
        assert!(hooks.contains("name: web-test"));
        assert!(values.contains("replicaCount: 3"));
        assert_eq!(notes, "Visit http://web.prod.svc");
    }

    /// WHY THIS TEST EXISTS:
    /// Opening a release's History tab after listing inventory must reuse cached revisions by
    /// `(context, uid, rv)`, fetch only uncached older revisions, and issue ZERO payload GETs
    /// on subsequent History reads when no revision changed.
    #[tokio::test]
    async fn release_history_fast_reuses_cached_revisions_and_avoids_n_plus_1_on_repeat() {
        let payload_gets = Arc::new(AtomicUsize::new(0));
        let gets_clone = payload_gets.clone();

        let service = tower::service_fn(move |req: http::Request<Body>| {
            let uri = req.uri().to_string();
            let accept = req
                .headers()
                .get(http::header::ACCEPT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            let gets = gets_clone.clone();
            async move {
                let body = if accept.contains("PartialObjectMetadata") {
                    json!({
                        "apiVersion": "meta.k8s.io/v1",
                        "kind": "PartialObjectMetadataList",
                        "metadata": { "resourceVersion": "20" },
                        "items": [
                            { "metadata": { "uid": "u-web-1", "resourceVersion": "11", "name": "sh.helm.release.v1.web.v1", "namespace": "prod", "labels": { "owner": "helm", "name": "web", "version": "1", "status": "superseded" } } },
                            { "metadata": { "uid": "u-web-2", "resourceVersion": "20", "name": "sh.helm.release.v1.web.v2", "namespace": "prod", "labels": { "owner": "helm", "name": "web", "version": "2", "status": "deployed" } } }
                        ]
                    })
                } else if uri.ends_with("/sh.helm.release.v1.web.v1") {
                    gets.fetch_add(1, Ordering::SeqCst);
                    let data = encode_release_secret_data(&json!({
                        "name": "web",
                        "info": { "last_deployed": "2026-11-19T10:00:00Z", "status": "superseded", "description": "Install complete" },
                        "chart": { "metadata": { "name": "nginx", "version": "1.0.0", "appVersion": "1.25" } }
                    }));
                    json!({
                        "apiVersion": "v1",
                        "kind": "Secret",
                        "metadata": { "uid": "u-web-1", "resourceVersion": "11", "name": "sh.helm.release.v1.web.v1", "namespace": "prod", "labels": { "owner": "helm", "name": "web", "version": "1", "status": "superseded" } },
                        "type": "helm.sh/release.v1",
                        "data": { "release": data }
                    })
                } else if uri.ends_with("/sh.helm.release.v1.web.v2") {
                    gets.fetch_add(1, Ordering::SeqCst);
                    let data = encode_release_secret_data(&json!({
                        "name": "web",
                        "info": { "last_deployed": "2026-11-20T10:00:00Z", "status": "deployed", "description": "Upgrade complete" },
                        "chart": { "metadata": { "name": "nginx", "version": "2.0.0", "appVersion": "1.27" } }
                    }));
                    json!({
                        "apiVersion": "v1",
                        "kind": "Secret",
                        "metadata": { "uid": "u-web-2", "resourceVersion": "20", "name": "sh.helm.release.v1.web.v2", "namespace": "prod", "labels": { "owner": "helm", "name": "web", "version": "2", "status": "deployed" } },
                        "type": "helm.sh/release.v1",
                        "data": { "release": data }
                    })
                } else {
                    panic!("Unexpected request: {uri} ({accept})");
                };
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(200)
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(&body).unwrap()))
                        .unwrap(),
                )
            }
        });

        let cache = HelmStorageCache::default();
        let client = Client::new(service, "default");

        // Inventory caches latest rev (v2) with 1 payload GET.
        let releases = list_releases_fast_with_cache(&client, "prod", Some("prod"), &cache)
            .await
            .unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(payload_gets.load(Ordering::SeqCst), 1);

        // First history read reuses cached v2 and fetches ONLY uncached v1 (+1 GET -> total 2).
        let history = release_history_fast_with_cache(&client, "prod", "prod", "web", &cache)
            .await
            .unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].revision, 1);
        assert_eq!(history[0].description, "Install complete");
        assert_eq!(history[1].revision, 2);
        assert_eq!(history[1].description, "Upgrade complete");
        assert_eq!(payload_gets.load(Ordering::SeqCst), 2);

        // Repeat history read hits MVCC cache for both revisions -> ZERO additional payload GETs.
        let history_again = release_history_fast_with_cache(&client, "prod", "prod", "web", &cache)
            .await
            .unwrap();
        assert_eq!(history_again.len(), 2);
        assert_eq!(payload_gets.load(Ordering::SeqCst), 2);
    }
}
