# Application diagnostics

Enable **Settings → Developer → Developer mode** to start a local application
capture. **Application Logs** opens as a workspace tab and appears in the activity
bar and command palette. **Open Application Logs** in the same settings page
returns to it. Disabling Developer mode closes its tabs, clears the WebView
buffer and revokes that window's native capture lease. It does not delete files
already written. The existing demo-cluster and SDK Diagnostics behavior remains.

## Investigate a problem

1. Enable Developer mode before reproducing the problem.
2. Reproduce it through the normal resource, Helm, terminal, extension or AI UI.
3. Open **Application Logs**. Filter by minimum severity, source, operation,
   context, error code or trace ID. Select a row to inspect its structured record;
   **Filter trace** follows the same operation across layers.
4. **Pause view** freezes only the displayed snapshot. Collection, console output
   and file output continue. **Follow** controls whether the table follows new rows.
5. **Export JSONL** downloads all currently retained records, independently of the
   display filters and paused view. **Copy record** copies only the selected event.
6. **Clear buffer** clears the frontend view and its pending forwarding queue.
   Desktop **Clear saved logs** also clears the process's native buffer and its
   rotating files, replaces the initiating window's lease and continues capture.
   File cleanup errors are displayed; they do not stop normal application work.

Collection runs while the log tab is closed or hidden. Closing the tab does not
turn Developer mode off. On startup the activity-bar entry is restored without
replacing the user's selected workspace document. The log viewer uses the shared
workbench panel registry, theme controls and a virtualized event table.

## Console and local files

Frontend events are mirrored to the WebView/browser console as one JSON object
per message, prefixed with `[kubiki.diagnostics]`. Native events delivered to the
viewer use the same console prefix. The native output worker writes admitted
frontend and native records as plain JSONL to process **stderr**, so an AI agent
can inspect the running desktop process's terminal output.

Desktop capture also writes `diagnostics/application.jsonl` underneath Tauri's
per-user application log directory. The view shows the actual resolved path and
provides **Copy path**; it is not a caller-selectable filesystem path. Follow it
from a terminal using the displayed location:

```sh
tail -F '/path/shown/in/Application Logs/application.jsonl'
```

There are at most three files: `application.jsonl`, `application.1.jsonl` and
`application.2.jsonl`, each at most 2 MiB (6 MiB total). Rotation is local; it has
no network exporter. On Unix the diagnostics directory is `0700` and files are
`0600`. Windows uses the app log directory's inherited user-profile permissions;
installed-platform ACL behavior needs platform validation. The writer refuses an
existing symbolic current log file.

Browser development uses the console and in-memory buffer; it cannot write the
native journal. Its console is accessible to browser tooling such as
`agent-browser --session YOUR_SESSION console`. Export JSONL for offline analysis.
A native connection or file failure is reported in the view; memory collection
and browser console output remain available.

## What is recorded

- Frontend native IPC commands: start, completion, cancellation/failure and duration;
  command names are recorded, argument and result bodies are excluded.
- Browser read-bridge operations: the same operation lifecycle and classified
  HTTP failures. A `traceparent` header correlates a diagnostic request; it grants
  no permissions and is not forwarded as Kubernetes authentication.
- Actual native Kubernetes client HTTP requests: method, templated route,
  API group/version, namespace, resource plural/name, subresource, operation,
  watch/pagination booleans, numeric page limit, response status and duration.
  Each LIST page and watch establishment/reconnection is a separate request.
  The observation sits below read caches and policy/budget adapters, so cache hits
  and policy-rejected operations do not masquerade as network requests.
- Resource watch lifecycle, bounded batch counts and status error codes; workspace
  navigation and cluster/scope changes.
- Unhandled frontend errors/rejections and React error boundaries: error category,
  known exception type and available source line/column, without raw messages or
  stack bodies.
- Existing application Rust `tracing` events: static target/source location and
  explicitly admitted scalar fields. Free-form messages and formatted errors
  are intentionally not copied into the diagnostic pipeline.

`kubernetes.request.succeeded` means HTTP response headers were received without
an HTTP error status. Its duration is time to response headers, including client
queueing; it is not body-download duration, watch lifetime or workload health.
Cancelled requests before response headers emit `kubernetes.request.cancelled`.
Later body/decoding errors belong to the enclosing read/watch lifecycle. WebSocket
observations describe the handshake, not terminal input/output.

The browser bridge invokes external `kubectl`; browser diagnostics observe the
bridge operation, not every internal request of that child process. Helm also
uses an external CLI: its IPC/read operation is observed, while HTTP requests
inside the Helm executable are not intercepted. Standalone core clients contain
the same optional HTTP observation boundary, but the desktop Developer-mode
controller is what enables it in this application.

## Format and correlation

The shared versioned contract is
[`shared/diagnostics-contract.json`](../shared/diagnostics-contract.json).
Frontend and Rust use it for event names, admitted attributes, severity mappings
and bounds. The envelope follows the field semantics of the
[OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/):
UTC RFC3339 occurrence/observation timestamps, severity text/number, event name,
body, resource, instrumentation scope, attributes and optional trace/span IDs.
It is a local JSONL envelope, **not an OTLP wire payload or a full OTel SDK**.

Trace IDs use 32 lowercase nonzero hexadecimal digits and span IDs use 16, following
[W3C Trace Context](https://www.w3.org/TR/trace-context/). Frontend managed read
request UUIDs supply the trace ID across IPC without changing cancellation identity;
native HTTP spans inherit it and receive distinct OS-random span IDs. Native-only
HTTP operations receive their own random trace IDs. Slow operations (at least two
seconds) also emit `operation.slow`. A JSONL example:

```json
{"schemaVersion":1,"sequence":42,"timestamp":"2026-11-18T12:00:00.000Z","observedTimestamp":"2026-11-18T12:00:00.001Z","severityText":"WARN","severityNumber":13,"eventName":"kubernetes.request.failed","body":"kubernetes request failed","source":"native","resource":{"service.name":"kubiki","service.version":"0.1.0"},"instrumentationScope":{"name":"kubiki.native"},"attributes":{"context":"testbed","http.request.method":"GET","http.route":"/api/{version}/namespaces/{namespace}/{resource}","http.response.status_code":403,"namespace":"qa","k8s.resource.plural":"pods"},"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef"}
```

Sequence numbers are scoped to their producer. Native poll cursors are monotonic
within the native process; a combined frontend export can contain frontend and
native sequences. Use source, timestamp and trace/span IDs when joining records.
Capture is a best-effort diagnostic observation, not a transactional audit journal
or proof that a Kubernetes mutation became healthy. Keep operation receipts and
post-mutation verification as separate authoritative mechanisms.

## Data and operational limits

The design follows [OWASP Logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
for data exclusion, injection prevention, bounded collection and failure testing.
The pipeline admits a closed set of scalar operational attributes. It does not
stringify arbitrary errors, console arguments, request/response objects or events.
It excludes headers, query values/selectors/cursors, kubeconfigs, credentials,
Secret/ConfigMap contents, manifests, Helm values, provider payloads/prompts,
conversation text, workload logs and terminal bytes. This is an instrumentation
contract, not general-purpose DLP for arbitrary third-party logging.

Context, namespace and resource identifiers remain local operational metadata;
review exported files before sharing them. Existing browser-engine console output
and external CLI output are outside this structured pipeline. No remote telemetry
or AI-provider call is enabled by Developer mode.

Bounds and failure behavior:

- Frontend and native memory buffers retain at most 2,000 records each. Evictions
  are counted. UI subscriptions publish at most every 100 ms; hidden views stop
  subscribing and rows are virtualized.
- Frontend admission is capped at 300 events/second and native admission at 600.
  Rate-limited events are counted rather than silently claiming full coverage.
- Forwarding queues hold at most 500 frontend and 512 native records. Batches
  carry at most 100 frontend records and poll at most 250 native records every
  250 ms. Backpressure discards records instead of blocking application producers.
- The native output worker owns file and stderr I/O. Slow stderr or disk failures
  can lose output records; counters and the in-memory view expose this. A broken
  sink never changes Kubernetes authorization or retries an operation.
- Per-window leases and monotonic configuration revisions reject stale batches
  and out-of-order enable/disable responses, including hot reload. Disabling the
  final developer window clears the native buffer and stops admitting records.
  Other developer windows can continue their process-wide capture.
- Logs emitted before capture activation, during bounded overload, on abrupt
  process termination or while a sink is unavailable may be missing. No
  crash-durability, tamper-proof storage or complete request-history guarantee is made.

## Implementation and verification

Frontend model/collector/runtime live in `src/core/diagnostics/`; the native
transport is `src/providers/diagnostics.ts`, with instrumented IPC in
`diagnostic_invoke.ts`. `DiagnosticLogsView` owns presentation only.
`src-tauri/src/diagnostics.rs` owns native leases, safe record construction,
`tracing` projection, buffer and output worker. Shared Kubernetes HTTP observation
lives in `crates/kubiki-core/src/cluster/http_diagnostics.rs`.
See [ADR-014](decisions/014-local-developer-diagnostics.md) for alternatives and costs.

```sh
pnpm typecheck
pnpm exec vitest run tests/unit/application_diagnostics.test.ts tests/unit/diagnostics_transport.test.ts tests/unit/read_transport.test.ts
pnpm test:e2e tests/e2e/diagnostics.spec.ts
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib diagnostics
cargo test --locked --manifest-path crates/kubiki-core/Cargo.toml http_diagnostics
```

Tests use synthetic secrets, local HTTP fixtures and actual temporary files. They
cover trace correlation through the HTTP client, unchanged response bodies,
redaction, cancellation, buffer/rate/backpressure bounds, private rotation,
failed file sinks, revoked leases, stale replies, export and Developer-mode tab
lifecycle. Validate installed WebViews, Windows ACLs and macOS/Windows stderr
availability on those platforms; Linux/browser results do not establish them.

An optional, ignored native integration probe performs only `GET /version` and
checks that HTTP metadata reaches memory, stderr and a temporary private journal.
Run it only against an explicitly selected test cluster:

```sh
KUBIKI_DIAGNOSTICS_TEST_CONTEXT=testbed cargo test --locked --manifest-path src-tauri/Cargo.toml --lib diagnostics::tests::live_cluster_http_diagnostics_read_only -- --exact --ignored --nocapture
```
