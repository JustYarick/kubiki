//! Opt-in local diagnostics. No payloads or free-form error/message fields cross this boundary.
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, mpsc},
    time::{Duration, Instant},
};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context, prelude::*};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContractLimits {
    memory_records: usize,
    native_queue_records: usize,
    native_events_per_second: u32,
    journal_file_bytes: u64,
    text_bytes: usize,
    route_bytes: usize,
}
#[derive(Deserialize)]
struct ContractAttributes {
    text: Vec<String>,
    number: Vec<String>,
    boolean: Vec<String>,
    route: String,
}
#[derive(Deserialize)]
struct Contract {
    levels: BTreeMap<String, u8>,
    events: BTreeMap<String, bool>,
    attributes: ContractAttributes,
    limits: ContractLimits,
}
fn contract() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/diagnostics-contract.json"))
            .expect("bundled diagnostic contract")
    })
}
type Attributes = BTreeMap<String, Value>;
fn random_hex<const N: usize>() -> Option<String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).ok()?;
    if bytes.iter().all(|byte| *byte == 0) {
        return None;
    }
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
static GLOBAL: OnceLock<Diagnostics> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    schema_version: u8,
    sequence: u64,
    timestamp: String,
    observed_timestamp: String,
    severity_text: String,
    severity_number: u8,
    event_name: String,
    body: String,
    source: String,
    resource: BTreeMap<String, String>,
    instrumentation_scope: Scope,
    attributes: Attributes,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    span_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Scope {
    name: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    epoch: u64,
    enabled: bool,
    journal_path: Option<String>,
    journal_available: bool,
    dropped: u64,
    queue_dropped: u64,
    io_failures: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearResult {
    #[serde(flatten)]
    status: Status,
    cleared: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    #[serde(flatten)]
    status: Status,
    records: Vec<Record>,
    next_sequence: u64,
}
#[derive(Default)]
struct State {
    owners: HashMap<String, u64>,
    revisions: HashMap<String, u64>,
    next_lease: u64,
    epoch: u64,
    sequence: u64,
    records: VecDeque<Record>,
    dropped: u64,
    queue_dropped: u64,
    io_failures: u64,
    root: Option<PathBuf>,
    journal_available: bool,
    rate_start: Option<Instant>,
    rate_count: u32,
}
impl State {
    fn status(&self, owner: &str) -> Status {
        Status {
            epoch: self.owners.get(owner).copied().unwrap_or(0),
            enabled: self.owners.contains_key(owner),
            journal_path: self
                .root
                .as_ref()
                .map(|root| root.join("application.jsonl").display().to_string()),
            journal_available: self.journal_available,
            dropped: self.dropped,
            queue_dropped: self.queue_dropped,
            io_failures: self.io_failures,
        }
    }
}
enum Output {
    Record(u64, Record),
    Wake,
    Clear(mpsc::Sender<io::Result<()>>),
    #[cfg(test)]
    Flush(mpsc::Sender<()>),
}
#[derive(Clone)]
pub struct Diagnostics {
    state: Arc<Mutex<State>>,
    output: mpsc::SyncSender<Output>,
}
fn lock(state: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn severity(level: &str) -> Option<u8> {
    contract().levels.get(level).copied()
}
fn valid_trace(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && value.bytes().any(|b| b != b'0')
}
fn safe_attributes(input: Attributes) -> Attributes {
    input
        .into_iter()
        .filter(|(key, value)| {
            let text = contract().attributes.text.contains(key);
            if text {
                return value.as_str().is_some_and(|s| {
                    !s.is_empty()
                        && s.len() <= contract().limits.text_bytes
                        && !s.starts_with('/')
                        && !s.contains("://")
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_.:/@-".contains(&b))
                });
            }
            if key == &contract().attributes.route {
                return value.as_str().is_some_and(|s| {
                    s.len() <= contract().limits.route_bytes
                        && s.starts_with('/')
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_/{}.-".contains(&b))
                });
            }
            if contract().attributes.boolean.contains(key) {
                return value.is_boolean();
            }
            let number = contract().attributes.number.contains(key);
            number
                && value
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&n))
        })
        .collect()
}
impl Diagnostics {
    fn new(root: Option<PathBuf>) -> Self {
        let state = Arc::new(Mutex::new(State {
            root,
            ..State::default()
        }));
        let (output, receiver) = mpsc::sync_channel(contract().limits.native_queue_records);
        let worker = state.clone();
        if std::thread::Builder::new()
            .name("kubiki-diagnostics".into())
            .spawn(move || output_worker(worker, receiver))
            .is_err()
        {
            lock(&state).io_failures = 1;
        }
        Self { state, output }
    }
    fn configure(&self, owner: &str, enabled: bool, revision: u64) -> Status {
        let status = {
            let mut state = lock(&self.state);
            if state
                .revisions
                .get(owner)
                .is_some_and(|previous| revision <= *previous)
            {
                return state.status(owner);
            }
            state.revisions.insert(owner.into(), revision);
            if enabled {
                if state.owners.is_empty() {
                    state.epoch += 1;
                    state.records.clear();
                    state.dropped = 0;
                    state.queue_dropped = 0;
                    state.io_failures = 0;
                    state.rate_start = None;
                    state.rate_count = 0;
                }
                state.next_lease += 1;
                let lease = state.next_lease;
                state.owners.insert(owner.into(), lease);
            } else {
                state.owners.remove(owner);
                if state.owners.is_empty() {
                    state.epoch += 1;
                    state.records.clear();
                    state.journal_available = false;
                }
            }
            kubiki_core::cluster::http_diagnostics::set_enabled(!state.owners.is_empty());
            state.status(owner)
        };
        let _ = self.output.try_send(Output::Wake);
        status
    }
    fn emit(&self, mut record: Record, expected_epoch: Option<u64>, owner: Option<(&str, u64)>) {
        let epoch;
        {
            let mut state = lock(&self.state);
            if state.owners.is_empty()
                || expected_epoch.is_some_and(|epoch| epoch != state.epoch)
                || owner.is_some_and(|(owner, lease)| state.owners.get(owner) != Some(&lease))
            {
                return;
            }
            if state
                .rate_start
                .is_none_or(|start| start.elapsed() >= Duration::from_secs(1))
            {
                state.rate_start = Some(Instant::now());
                state.rate_count = 0;
            }
            state.rate_count += 1;
            if state.rate_count > contract().limits.native_events_per_second {
                state.dropped += 1;
                return;
            }
            state.sequence += 1;
            record.sequence = state.sequence;
            epoch = state.epoch;
            if state.records.len() == contract().limits.memory_records {
                state.records.pop_front();
                state.dropped += 1;
            }
            state.records.push_back(record.clone());
        }
        if self.output.try_send(Output::Record(epoch, record)).is_err() {
            lock(&self.state).queue_dropped += 1;
        }
    }
    fn native(
        &self,
        event: &str,
        level: &str,
        attributes: Attributes,
        trace: Option<(&str, &str)>,
        expected_epoch: Option<u64>,
    ) {
        if let Some(record) = make_record(event, level, attributes, "native", None, trace) {
            self.emit(record, expected_epoch, None);
        }
    }
    fn exchange(
        &self,
        owner: &str,
        epoch: u64,
        after: u64,
        records: Vec<Record>,
    ) -> Result<Batch, String> {
        if records.len() > 100 {
            return Err("Diagnostic batch exceeds 100 records".into());
        }
        if lock(&self.state).owners.get(owner) != Some(&epoch) {
            return Err("Diagnostic capture is disabled or replaced".into());
        }
        for record in records {
            if record.schema_version != 1
                || record.timestamp.len() > 40
                || chrono::DateTime::parse_from_rfc3339(&record.timestamp).is_err()
            {
                lock(&self.state).dropped += 1;
                continue;
            }
            let trace = record.trace_id.as_deref().zip(record.span_id.as_deref());
            if let Some(safe) = make_record(
                &record.event_name,
                &record.severity_text,
                record.attributes,
                "frontend",
                Some(record.timestamp),
                trace,
            ) {
                self.emit(safe, None, Some((owner, epoch)));
            } else {
                lock(&self.state).dropped += 1;
            }
        }
        let state = lock(&self.state);
        let records: Vec<_> = state
            .records
            .iter()
            .filter(|record| record.sequence > after)
            .take(250)
            .cloned()
            .collect();
        let next_sequence = records
            .last()
            .map_or(after.min(state.sequence), |record| record.sequence);
        Ok(Batch {
            status: state.status(owner),
            records,
            next_sequence,
        })
    }
    fn clear(
        &self,
        owner: &str,
        lease: u64,
    ) -> Result<(Status, mpsc::Receiver<io::Result<()>>), String> {
        let mut state = lock(&self.state);
        if state.owners.get(owner) != Some(&lease) {
            return Err("Diagnostic capture is disabled or replaced".into());
        }
        let (send, receive) = mpsc::channel();
        self.output
            .try_send(Output::Clear(send))
            .map_err(|_| "Diagnostic output is busy; retry clearing".to_string())?;
        state.epoch += 1;
        state.next_lease += 1;
        let lease = state.next_lease;
        state.owners.insert(owner.into(), lease);
        state.records.clear();
        state.dropped = 0;
        Ok((state.status(owner), receive))
    }
}
fn make_record(
    event: &str,
    level: &str,
    attributes: Attributes,
    source: &str,
    time: Option<String>,
    trace: Option<(&str, &str)>,
) -> Option<Record> {
    let severity_number = severity(level)?;
    if !contract().events.contains_key(event) {
        return None;
    }
    let trace = trace.filter(|(trace, span)| valid_trace(trace, 32) && valid_trace(span, 16));
    let now = timestamp();
    Some(Record {
        schema_version: 1,
        sequence: 0,
        timestamp: time.unwrap_or_else(|| now.clone()),
        observed_timestamp: now,
        severity_text: level.into(),
        severity_number,
        event_name: event.into(),
        body: event.replace('.', " "),
        source: source.into(),
        resource: BTreeMap::from([
            ("service.name".into(), "kubiki".into()),
            ("service.version".into(), env!("CARGO_PKG_VERSION").into()),
        ]),
        instrumentation_scope: Scope {
            name: format!("kubiki.{source}"),
        },
        attributes: safe_attributes(attributes),
        trace_id: trace.map(|(trace, _)| trace.into()),
        span_id: trace.map(|(_, span)| span.into()),
    })
}

struct Journal {
    file: File,
    root: PathBuf,
    bytes: u64,
}
fn private_root(root: &Path) -> io::Result<()> {
    fs::create_dir_all(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
impl Journal {
    fn open(root: &Path) -> io::Result<Self> {
        private_root(root)?;
        let path = root.join("application.jsonl");
        if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(io::Error::other("Refusing symbolic diagnostic file"));
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(0o600);
            if path.exists() {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
            }
        }
        let file = options.open(path)?;
        let bytes = file.metadata()?.len();
        Ok(Self {
            file,
            root: root.into(),
            bytes,
        })
    }
    fn write(mut self, line: &[u8]) -> io::Result<Self> {
        if self.bytes + line.len() as u64 > contract().limits.journal_file_bytes {
            let root = self.root.clone();
            drop(self.file);
            let oldest = root.join("application.2.jsonl");
            if oldest.exists() {
                fs::remove_file(&oldest)?;
            }
            let previous = root.join("application.1.jsonl");
            if previous.exists() {
                fs::rename(previous, &oldest)?;
            }
            fs::rename(
                root.join("application.jsonl"),
                root.join("application.1.jsonl"),
            )?;
            self = Self::open(&root)?;
        }
        self.file.write_all(line)?;
        self.bytes += line.len() as u64;
        Ok(self)
    }
    fn clear(root: &Path) -> io::Result<()> {
        for name in [
            "application.jsonl",
            "application.1.jsonl",
            "application.2.jsonl",
        ] {
            match fs::remove_file(root.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}
fn output_worker(state: Arc<Mutex<State>>, receiver: mpsc::Receiver<Output>) {
    let mut journal: Option<Journal> = None;
    let mut epoch = 0;
    loop {
        let message = receiver.recv_timeout(Duration::from_millis(250));
        if matches!(message, Err(mpsc::RecvTimeoutError::Disconnected)) {
            break;
        }
        let (active, current, root) = {
            let state = lock(&state);
            (!state.owners.is_empty(), state.epoch, state.root.clone())
        };
        if current != epoch || !active {
            journal = None;
            epoch = current;
            if active {
                journal = root.as_deref().and_then(|root| Journal::open(root).ok());
                let mut state = lock(&state);
                state.journal_available = journal.is_some();
                if journal.is_none() {
                    state.io_failures += 1;
                }
            }
        }
        match message {
            Ok(Output::Record(record_epoch, record)) if active && record_epoch == current => {
                if let Ok(mut line) = serde_json::to_vec(&record) {
                    line.push(b'\n');
                    if io::stderr().lock().write_all(&line).is_err() {
                        lock(&state).io_failures += 1;
                    }
                    if let Some(file) = journal.take() {
                        match file.write(&line) {
                            Ok(file) => journal = Some(file),
                            Err(_) => {
                                let mut state = lock(&state);
                                state.io_failures += 1;
                                state.journal_available = false;
                            }
                        }
                    }
                }
            }
            Ok(Output::Clear(reply)) => {
                journal = None;
                let result = root.as_deref().map_or(Ok(()), Journal::clear);
                if result.is_err() {
                    lock(&state).io_failures += 1;
                }
                // Reopen on the next worker iteration, after the deletion boundary.
                epoch = current.wrapping_sub(1);
                let _ = reply.send(result);
            }
            #[cfg(test)]
            Ok(Output::Flush(reply)) => {
                let _ = reply.send(());
            }
            _ => {}
        }
    }
}

struct TraceLayer {
    logs: Diagnostics,
}
#[derive(Clone)]
struct CaptureSpan {
    epoch: Option<u64>,
    trace: Option<(String, String)>,
}
struct SafeFields(Attributes);
impl SafeFields {
    fn admitted(field: &Field) -> bool {
        let name = field.name();
        matches!(name, "event_name" | "trace_id" | "span_id")
            || name == contract().attributes.route
            || contract().attributes.text.iter().any(|key| key == name)
            || contract().attributes.number.iter().any(|key| key == name)
            || contract().attributes.boolean.iter().any(|key| key == name)
    }
    fn insert(&mut self, field: &Field, value: Value) {
        if Self::admitted(field) {
            self.0.insert(field.name().into(), value);
        }
    }
}
impl Visit for SafeFields {
    fn record_debug(&mut self, _field: &Field, _value: &dyn std::fmt::Debug) {} // messages, errors and payloads
    fn record_str(&mut self, field: &Field, value: &str) {
        if Self::admitted(field) && value.len() <= contract().limits.route_bytes {
            self.0.insert(field.name().into(), json!(value));
        }
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.insert(field, json!(value));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.insert(field, json!(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.insert(field, json!(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.insert(field, json!(value));
    }
}
impl<S> Layer<S> for TraceLayer
where
    S: Subscriber + for<'lookup> tracing_subscriber::registry::LookupSpan<'lookup>,
{
    fn enabled(&self, metadata: &tracing::Metadata<'_>, _context: Context<'_, S>) -> bool {
        metadata.target().starts_with("kubiki")
    }
    fn on_new_span(
        &self,
        attributes: &tracing::span::Attributes<'_>,
        id: &tracing::Id,
        context: Context<'_, S>,
    ) {
        let Some(span) = context.span(id) else {
            return;
        };
        let parent = span
            .parent()
            .and_then(|parent| parent.extensions().get::<CaptureSpan>().cloned());
        let mut fields = SafeFields(BTreeMap::new());
        attributes.record(&mut fields);
        let explicit = fields
            .0
            .get("trace_id")
            .and_then(Value::as_str)
            .zip(fields.0.get("span_id").and_then(Value::as_str))
            .filter(|(trace, span)| valid_trace(trace, 32) && valid_trace(span, 16))
            .map(|(trace, span)| (trace.into(), span.into()));
        let state = lock(&self.logs.state);
        let epoch = parent.as_ref().map_or_else(
            || (!state.owners.is_empty()).then_some(state.epoch),
            |parent| parent.epoch,
        );
        let trace = if epoch.is_some() {
            explicit
                .or_else(|| {
                    parent
                        .and_then(|parent| parent.trace)
                        .and_then(|(trace, _)| Some((trace, random_hex::<8>()?)))
                })
                .or_else(|| Some((random_hex::<16>()?, random_hex::<8>()?)))
        } else {
            None
        };
        span.extensions_mut().insert(CaptureSpan { epoch, trace });
    }
    fn on_event(&self, event: &Event<'_>, context: Context<'_, S>) {
        let capture = context.event_scope(event).and_then(|mut scope| {
            scope.find_map(|span| span.extensions().get::<CaptureSpan>().cloned())
        });
        let epoch = {
            let state = lock(&self.logs.state);
            if state.owners.is_empty() {
                return;
            }
            state.epoch
        };
        if capture
            .as_ref()
            .is_some_and(|capture| capture.epoch != Some(epoch))
        {
            return;
        }
        let mut fields = SafeFields(BTreeMap::new());
        event.record(&mut fields);
        let event_name = fields
            .0
            .remove("event_name")
            .and_then(|name| name.as_str().map(str::to_owned))
            .unwrap_or_else(|| "native.tracing".into());
        if fields.0.get("error.code").and_then(Value::as_str) == Some("none") {
            fields.0.remove("error.code");
        }
        if fields
            .0
            .get("http.response.status_code")
            .and_then(Value::as_u64)
            == Some(0)
        {
            fields.0.remove("http.response.status_code");
        }
        fields
            .0
            .insert("target".into(), json!(event.metadata().target()));
        if let Some(file) = event
            .metadata()
            .file()
            .and_then(|path| path.rsplit('/').next())
        {
            fields.0.insert("code.file.name".into(), json!(file));
        }
        if let Some(line) = event.metadata().line() {
            fields.0.insert("code.line.number".into(), json!(line));
        }
        let trace = capture
            .as_ref()
            .and_then(|capture| capture.trace.as_ref())
            .map(|(trace, span)| (trace.as_str(), span.as_str()));
        self.logs.native(
            &event_name,
            event.metadata().level().as_str(),
            fields.0,
            trace,
            Some(epoch),
        );
    }
}
pub fn initialize(root: Option<PathBuf>) {
    let logs = Diagnostics::new(root);
    let _ = GLOBAL.set(logs.clone());
    // No global EnvFilter: enabling/disabling must work without rebuilding static callsites.
    let _ = tracing_subscriber::registry()
        .with(TraceLayer { logs })
        .try_init();
}
pub fn stop_owner(owner: &str) {
    if let Some(logs) = GLOBAL.get() {
        let revision = lock(&logs.state)
            .revisions
            .get(owner)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        logs.configure(owner, false, revision);
    }
}

pub struct ReadDiagnostic {
    start: Instant,
    epoch: u64,
    fields: Attributes,
    trace: Option<(String, String)>,
    finished: bool,
}
impl ReadDiagnostic {
    pub fn start(operation: &str, context: Option<&str>, request_id: Option<&str>) -> Option<Self> {
        let logs = GLOBAL.get()?;
        let epoch = {
            let state = lock(&logs.state);
            if state.owners.is_empty() {
                return None;
            }
            state.epoch
        };
        let trace = request_id
            .map(|id| id.replace('-', ""))
            .filter(|id| valid_trace(id, 32))
            .and_then(|id| Some((id, random_hex::<8>()?)));
        let mut fields = BTreeMap::from([
            ("operation".into(), json!(operation)),
            ("transport".into(), json!("native")),
        ]);
        if let Some(context) = context {
            fields.insert("context".into(), json!(context));
        }
        let result = Self {
            start: Instant::now(),
            epoch,
            fields,
            trace,
            finished: false,
        };
        result.emit("operation.started", "DEBUG", BTreeMap::new());
        Some(result)
    }
    pub fn span(&self) -> tracing::Span {
        if let Some((trace, span)) = &self.trace {
            tracing::debug_span!(target: "kubiki_lib::diagnostics", "native.read", trace_id = trace.as_str(), span_id = span.as_str())
        } else {
            tracing::debug_span!(target: "kubiki_lib::diagnostics", "native.read")
        }
    }
    fn emit(&self, event: &str, level: &str, extra: Attributes) {
        if let Some(logs) = GLOBAL.get() {
            let mut fields = self.fields.clone();
            fields.extend(extra);
            let trace = self
                .trace
                .as_ref()
                .map(|(trace, span)| (trace.as_str(), span.as_str()));
            logs.native(event, level, fields, trace, Some(self.epoch));
        }
    }
    pub fn finish<T>(&mut self, result: &Result<T, kubiki_core::core::api::ApiError>) {
        self.finished = true;
        let duration = self.start.elapsed().as_secs_f64() * 1000.0;
        let mut fields = BTreeMap::from([("duration_ms".into(), json!(duration))]);
        let (event, level) = match result {
            Ok(_) => ("operation.succeeded", "DEBUG"),
            Err(error) => {
                if let Ok(code) = serde_json::to_value(&error.code) {
                    fields.insert("error.code".into(), code);
                }
                if let Some(status) = error.status {
                    fields.insert("http.response.status_code".into(), json!(status));
                }
                if error.code == kubiki_core::core::api::ApiErrorCode::Cancelled {
                    ("operation.cancelled", "DEBUG")
                } else {
                    ("operation.failed", "ERROR")
                }
            }
        };
        self.emit(event, level, fields);
        if duration >= 2000.0 {
            self.emit(
                "operation.slow",
                "WARN",
                BTreeMap::from([("duration_ms".into(), json!(duration))]),
            );
        }
    }
}
impl Drop for ReadDiagnostic {
    fn drop(&mut self) {
        if !self.finished {
            self.emit(
                "operation.cancelled",
                "DEBUG",
                BTreeMap::from([(
                    "duration_ms".into(),
                    json!(self.start.elapsed().as_secs_f64() * 1000.0),
                )]),
            );
        }
    }
}

#[tauri::command]
pub fn diagnostics_configure(
    window: tauri::WebviewWindow,
    enabled: bool,
    revision: u64,
) -> Result<Status, String> {
    Ok(GLOBAL
        .get()
        .ok_or("Diagnostics unavailable")?
        .configure(window.label(), enabled, revision))
}
#[tauri::command]
pub fn diagnostics_exchange(
    window: tauri::WebviewWindow,
    epoch: u64,
    after_sequence: u64,
    records: Vec<Record>,
) -> Result<Batch, String> {
    GLOBAL.get().ok_or("Diagnostics unavailable")?.exchange(
        window.label(),
        epoch,
        after_sequence,
        records,
    )
}
#[tauri::command]
pub async fn diagnostics_clear(
    window: tauri::WebviewWindow,
    epoch: u64,
) -> Result<ClearResult, String> {
    let logs = GLOBAL.get().ok_or("Diagnostics unavailable")?;
    let (_, done) = logs.clear(window.label(), epoch)?;
    let cleared = tokio::task::spawn_blocking(move || {
        matches!(done.recv_timeout(Duration::from_secs(5)), Ok(Ok(())))
    })
    .await
    .unwrap_or(false);
    if !cleared {
        lock(&logs.state).io_failures += 1;
    }
    // Return the new lease even after an I/O failure, so a failed clear never strands the live stream.
    Ok(ClearResult {
        status: lock(&logs.state).status(window.label()),
        cleared,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_DIR: AtomicU64 = AtomicU64::new(1);
    static SERIAL: Mutex<()> = Mutex::new(());
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "kubiki-diagnostics-test-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn flush(logs: &Diagnostics) {
        let (send, done) = mpsc::channel();
        logs.output.send(Output::Flush(send)).unwrap();
        done.recv_timeout(Duration::from_secs(5)).unwrap();
    }
    fn record() -> Record {
        make_record(
            "operation.failed",
            "ERROR",
            BTreeMap::from([("operation".into(), json!("get_resource"))]),
            "frontend",
            None,
            None,
        )
        .unwrap()
    }
    #[test]
    fn payloads_headers_errors_and_injected_control_characters_never_reach_output() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let fields = BTreeMap::from([
            ("operation".into(), json!("get_resource")),
            ("context".into(), json!("testbed")),
            ("message".into(), json!("Bearer synthetic-private-value")),
            ("authorization".into(), json!("synthetic-private-value")),
            ("error".into(), json!({"token":"synthetic-private-value"})),
            ("namespace".into(), json!("bad\nforged")),
            (
                "http.route".into(),
                json!("/api/{version}/namespaces/{namespace}/{resource}/{name}"),
            ),
            ("http.request.method".into(), json!("PATCH")),
            ("k8s.watch".into(), json!(false)),
            ("duration_ms".into(), json!(5.5)),
        ]);
        let record =
            make_record("operation.failed", "ERROR", fields, "native", None, None).unwrap();
        let text = serde_json::to_string(&record).unwrap();
        assert!(!text.contains("synthetic-private-value"));
        assert!(!text.contains("forged"));
        assert_eq!(record.attributes["http.request.method"], "PATCH");
        assert_eq!(record.attributes["k8s.watch"], false);
        assert_eq!(record.severity_number, 17);
    }
    #[test]
    fn windows_have_revocable_leases_and_out_of_order_configuration_is_ignored() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let root = Directory::new();
        let logs = Diagnostics::new(Some(root.0.clone()));
        let first = logs.configure("one", true, 10);
        logs.configure("two", true, 11);
        let replaced = logs.configure("one", true, 12);
        assert_ne!(first.epoch, replaced.epoch);
        assert!(logs.configure("one", false, 9).enabled);
        assert!(
            logs.exchange("one", first.epoch, 0, vec![record()])
                .is_err()
        );
        logs.configure("one", false, 13);
        assert!(!logs.configure("one", true, 12).enabled);
        assert!(logs.exchange("two", 2, 0, vec![record()]).is_ok());
        logs.configure("two", false, 14);
        flush(&logs);
        assert!(lock(&logs.state).records.is_empty());
    }
    #[test]
    fn frontend_body_and_resource_claims_are_reconstructed_and_late_batches_rejected() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let root = Directory::new();
        let logs = Diagnostics::new(Some(root.0.clone()));
        let lease = logs.configure("one", true, 1);
        let mut input = record();
        input.body = "synthetic-private-value".into();
        input
            .resource
            .insert("token".into(), "synthetic-private-value".into());
        input.source = "native".into();
        let batch = logs
            .exchange("one", lease.epoch, 0, vec![input.clone()])
            .unwrap();
        assert_eq!(batch.records[0].source, "frontend");
        assert!(
            !serde_json::to_string(&batch.records)
                .unwrap()
                .contains("synthetic-private-value")
        );
        logs.configure("one", false, 2);
        assert!(logs.exchange("one", lease.epoch, 0, vec![input]).is_err());
        flush(&logs);
    }
    #[test]
    fn memory_rate_and_output_backpressure_are_bounded_without_blocking_producers() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        // A disconnected worker deterministically exercises the nonblocking failure path.
        let (output, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let logs = Diagnostics {
            state: Arc::new(Mutex::new(State::default())),
            output,
        };
        logs.configure("one", true, 1);
        for i in 0..2500 {
            if i % 500 == 0 {
                lock(&logs.state).rate_start = None;
            }
            logs.emit(record(), None, None);
        }
        let state = lock(&logs.state);
        assert_eq!(state.records.len(), contract().limits.memory_records);
        assert_eq!(state.dropped, 500);
        assert_eq!(state.queue_dropped, 2500);
        drop(state);
        for _ in 0..2000 {
            logs.emit(record(), None, None);
        }
        assert!(lock(&logs.state).dropped > 500);
    }
    #[test]
    fn file_failure_is_visible_and_does_not_break_memory_collection() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let root = Directory::new();
        fs::create_dir_all(&root.0).unwrap();
        let impossible = root.0.join("not-a-directory");
        fs::write(&impossible, "fixture").unwrap();
        let logs = Diagnostics::new(Some(impossible));
        let lease = logs.configure("one", true, 1);
        logs.exchange("one", lease.epoch, 0, vec![record()])
            .unwrap();
        flush(&logs);
        let state = lock(&logs.state);
        assert_eq!(state.records.len(), 1);
        assert!(!state.journal_available);
        assert!(state.io_failures > 0);
    }
    #[test]
    fn journal_rotation_retains_three_private_files_and_clear_invalidates_old_batches() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let root = Directory::new();
        let mut journal = Journal::open(&root.0).unwrap();
        let line = [b'x'; 1024];
        for _ in 0..((contract().limits.journal_file_bytes as usize / line.len()) * 4 + 2) {
            journal = journal.write(&line).unwrap();
        }
        drop(journal);
        for name in [
            "application.jsonl",
            "application.1.jsonl",
            "application.2.jsonl",
        ] {
            let metadata = fs::metadata(root.0.join(name)).unwrap();
            assert!(metadata.len() <= contract().limits.journal_file_bytes);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
            }
        }
        let logs = Diagnostics::new(Some(root.0.clone()));
        let lease = logs.configure("one", true, 1);
        logs.exchange("one", lease.epoch, 0, vec![record()])
            .unwrap();
        flush(&logs);
        let (status, done) = logs.clear("one", lease.epoch).unwrap();
        done.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        assert!(
            logs.exchange("one", lease.epoch, 0, vec![record()])
                .is_err()
        );
        assert!(
            logs.exchange("one", status.epoch, 0, vec![])
                .unwrap()
                .records
                .is_empty()
        );
        assert!(!root.0.join("application.1.jsonl").exists());
        logs.configure("one", false, 2);
        flush(&logs);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn actual_kubernetes_http_requests_share_trace_without_leaking_query_headers_or_body() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let root = Directory::new();
        let logs = Diagnostics::new(Some(root.0.clone()));
        logs.configure("one", true, 1);
        let subscriber = tracing_subscriber::registry().with(TraceLayer { logs: logs.clone() });
        let _default = tracing::subscriber::set_default(subscriber);
        let raw = kube::Client::new(
            tower::service_fn(|request: http::Request<kube::client::Body>| async move {
                assert_eq!(
                    request.headers()["authorization"],
                    "Bearer synthetic-private-value"
                );
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(403)
                        .body(kube::client::Body::from(
                            b"synthetic-private-value".to_vec(),
                        ))
                        .unwrap(),
                )
            }),
            "default",
        );
        let client = kubiki_core::cluster::http_diagnostics::instrument_client(raw, "testbed");
        let read = tracing::debug_span!(target: "kubiki_lib::diagnostics", "native.read", trace_id = "0123456789abcdef0123456789abcdef", span_id = "0123456789abcdef");
        use tracing::Instrument;
        let response = client.send(http::Request::builder().method("PATCH").uri("/api/v1/namespaces/qa/secrets/synthetic?fieldManager=synthetic-private-value&continue=private&limit=50")
            .header("authorization", "Bearer synthetic-private-value").body(kube::client::Body::from(b"synthetic-private-value".to_vec())).unwrap()).instrument(read).await.unwrap();
        assert_eq!(response.status(), 403);
        assert_eq!(
            response.into_body().collect_bytes().await.unwrap().as_ref(),
            b"synthetic-private-value"
        );
        let records = lock(&logs.state).records.clone();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].event_name, "kubernetes.request.started");
        assert_eq!(records[1].event_name, "kubernetes.request.failed");
        assert_eq!(
            records[1].trace_id.as_deref(),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert_eq!(records[0].span_id, records[1].span_id);
        assert_ne!(records[1].span_id.as_deref(), Some("0123456789abcdef"));
        assert_eq!(records[1].attributes["http.response.status_code"], 403);
        assert_eq!(records[1].attributes["k8s.list.paginated"], true);
        assert!(
            !serde_json::to_string(&records)
                .unwrap()
                .contains("synthetic-private-value")
        );
        logs.configure("one", false, 2);
        flush(&logs);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_http_attempt_is_recorded_without_polling_a_response_body() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let root = Directory::new();
        let logs = Diagnostics::new(Some(root.0.clone()));
        logs.configure("one", true, 1);
        let _default = tracing::subscriber::set_default(
            tracing_subscriber::registry().with(TraceLayer { logs: logs.clone() }),
        );
        let raw = kube::Client::new(
            tower::service_fn(|_: http::Request<kube::client::Body>| {
                std::future::pending::<
                    Result<http::Response<kube::client::Body>, std::convert::Infallible>,
                >()
            }),
            "default",
        );
        let client = kubiki_core::cluster::http_diagnostics::instrument_client(raw, "testbed");
        let request = client.send(
            http::Request::builder()
                .uri("/api/v1/pods?watch=true")
                .body(kube::client::Body::empty())
                .unwrap(),
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(10), request)
                .await
                .is_err()
        );
        let records = lock(&logs.state).records.clone();
        assert_eq!(records.len(), 2);
        assert_eq!(records[1].event_name, "kubernetes.request.cancelled");
        assert_eq!(records[1].attributes["k8s.watch"], true);
        assert_eq!(records[1].attributes["error.code"], "cancelled");
        logs.configure("one", false, 2);
        flush(&logs);
    }
    #[cfg(unix)]
    #[test]
    fn existing_symbolic_log_file_is_not_followed() {
        let root = Directory::new();
        fs::create_dir_all(&root.0).unwrap();
        let outside = root.0.join("outside");
        fs::write(&outside, "unchanged").unwrap();
        std::os::unix::fs::symlink(&outside, root.0.join("application.jsonl")).unwrap();
        assert!(Journal::open(&root.0).is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "unchanged");
    }
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "read-only live Kubernetes /version probe; requires KUBIKI_DIAGNOSTICS_TEST_CONTEXT"]
    async fn live_cluster_http_diagnostics_read_only() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let context =
            std::env::var("KUBIKI_DIAGNOSTICS_TEST_CONTEXT").expect("explicit test context");
        let root = Directory::new();
        let logs = Diagnostics::new(Some(root.0.clone()));
        logs.configure("one", true, 1);
        let _default = tracing::subscriber::set_default(
            tracing_subscriber::registry().with(TraceLayer { logs: logs.clone() }),
        );
        let pool = kubiki_core::ClusterClientPool::new(kubiki_core::KubeConfigManager::new());
        let result = tokio::time::timeout(Duration::from_secs(20), pool.check_health(&context))
            .await
            .expect("cluster read timeout");
        assert!(result.is_ok(), "read-only cluster version check failed");
        let records = lock(&logs.state).records.clone();
        assert!(
            records
                .iter()
                .any(|record| record.event_name == "kubernetes.request.succeeded"
                    && record.attributes.get("http.response.status_code") == Some(&json!(200))
                    && record.attributes.get("http.route") == Some(&json!("/version")))
        );
        flush(&logs);
        let text = fs::read_to_string(root.0.join("application.jsonl")).unwrap();
        assert!(!text.contains("certificate-authority-data"));
        assert!(!text.contains("authorization"));
        println!(
            "Read-only cluster /version returned 200; correlated HTTP metadata reached native memory, stderr and JSONL"
        );
        logs.configure("one", false, 2);
        flush(&logs);
    }
}
