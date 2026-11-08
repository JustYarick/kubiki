# Integrated AI agent

Implementation snapshot: **2026-11-01**, checked against the repository, not a
live-cluster performance benchmark. Backend Plan/Action phases, Pod/workload
diagnostics, structured compaction and frontend conversation persistence already exist.
Generic UI/agent reads now share core ResourceAccess, with field selection,
pagination and working-scope defaults. Specialized readers use the same core transport and pinned connection generation.
Live-cluster/model evaluation and optional informer reuse remain separate work.

Kubiki's integrated agent has its own workspace tab and a shared runtime for
ordinary chat, resource investigation and resource generation. It calls model
APIs directly. Cluster tools run through the embedded Kubiki MCP dispatcher and
the headless `kubiki-tools` library. Generic tools use typed Kubernetes APIs;
the integrated agent exposes no arbitrary shell or third-party MCP connections.
Helm diagnostics delegate to the existing
`HelmReader` for explicitly permitted release content. Inventory uses Kubernetes
metadata-only reads of Helm storage labels; it never loads Secret bodies.
The existing external CLI snapshot analysis is a separate
feature described in [AI analysis](AI_ANALYSIS.md).

The current investigation/result and execution format is specified in
[AI_PLAN_CONTRACT.md](AI_PLAN_CONTRACT.md).

## Getting started

1. Open **AI Agent** in the activity bar, then **AI settings**. The same settings
   are available under **Settings → AI assistant**.
2. Add a provider connection, review its protocol and API root, and save it.
   Supply an API key for an authenticated endpoint. Keys are stored through the
   native OS credential store, separately from configuration and conversation data.
3. Select **Load models** and choose an available model. **Use as default** saves
   the connection, model and optional generation settings for new conversations.
4. Configure **Agent permissions**. Secret contents, ConfigMap contents, Pod
   logs, inline environment values, container commands and annotations are
   excluded by default. All write permissions start disabled.
5. Start a conversation. Select **General chat · no cluster** for ordinary
   questions without requiring a cluster connection, or keep the selected
   cluster/namespace scope. The default is **Plan + Ask**; the creation UI
   also permits an explicit mode/phase selection.

The browser preview does not connect to model providers, persist credentials or
execute agent tools. Real connections require a rebuilt desktop backend with the
new AI commands.

## Entry points

- **AI Agent**: independent conversations for questions, investigation and creation.
- **Investigate with AI** in a resource's **What's wrong** block: opens a
  conversation pinned to that resource's context and namespace. Only identity
  is attached; live object fields must pass through native read policy. It guides the
  agent to gather evidence (starting with `diagnose_resource`), deliver a diagnosis and
  uncertainty, and propose a structured remediation `PlanArtifact` when remediation or
  follow-up checks are warranted (while allowing direct answers in Plan/Investigate mode
  when no plan artifact is needed). Internal reasoning/Markdown headings never gain a Plan badge.
- **Create with AI** in resource lists: opens a creation conversation. For
  example, request a Nexus deployment, discuss image/version/storage/exposure,
  and receive a YAML proposal. A multi-namespace selection is not silently
  reduced to its first namespace.

Text streams into the chat, with Markdown, code copying and structured tool
results. For reasoning models (such as DeepSeek-R1, Qwen-2.5, or Ollama reasoning models),
the model's `<think>...</think>` or `<thought>...</thought>` stream is dynamically
extracted and rendered as an interactive, collapsible `<ThinkingBlock />` component
that indicates active thinking while streaming and collapses completed reasoning.
This thought process is strictly informative and separate from remediation plans.
Generated YAML is a **proposal**, not evidence of a deployment. In
Action a proposal can be passed back to the agent for application through
the same guarded mutation tools. The application never executes a Markdown code
block directly. Remote images and raw HTML in model output are not loaded.

## Modes and permissions

The composer has two independent controls: **Plan / Action** and **Ask / Auto accept**.
New and restored conversations start in **Plan + Ask**. Plan forbids all writes.
Ask requests consent for model tools; **Confirmations → Ask permission for reads**
controls whether reads also prompt (enabled by default for existing settings).
Turn it off to confirm changes only. Auto accept runs
permitted tools automatically. The question tool is already an explicit user interaction.
In settings, **Always ask** selects tools that must request consent in either mode.
These settings never grant data access or write permissions. Internal reads belonging
to a single approved diagnostic or mutation are covered by that operation, rather
than opening a prompt for every HTTP request. Read-only wire values are retained
solely for legacy compatibility; Action still serializes as `tooling`.

Plans have one **Apply selected steps** action. Native review prepares and pins the
operations automatically, then execution asks for exact native mutation previews
when the confirmation policy requires it. Auto accept skips those prompts unless
the tool is in Always ask. Merely switching to Action never executes a proposal.

Changing to Auto accept does not enable disabled operations or expand data access.
Kubernetes RBAC and admission still apply. The model cannot change mode, edit
policy, approve its own confirmation or change a saved endpoint. Legacy external
MCP/command settings are retained as inert JSON for migration and never executed.

The backend owns mode and scope. A cluster client is pinned to each cluster
conversation; changing the global cluster selector does not retarget it. Choose scope before the first message. Changing provider/model starts a fresh
native session in the same transcript; previous evidence remains historical. General chat supports proposals and installed skill references; it does not expose
cluster tools. Turning tool use off omits all tools.

Changing mode or pressing Stop cancels pending generation/review and revokes
unissued writes. Authorization is checked again after commit's final live reads,
immediately before the mutation request. An already dispatched request can still
finish, so Stop waits for its receipt rather than claiming it was undone.
Closing the workspace tab stops active runs; switching to another tab does not.

Access controls are independent:

- Resource, Event, log and metrics tools can be enabled separately.
- Cluster-scoped object reads require a separate permission. Namespace-name
  discovery only returns names allowed by the conversation scope, namespace
  patterns and resource rules; it does not return namespace contents.
- Secrets, ConfigMaps and custom resources each have **No access**, **Metadata
  only**, and **Contents** levels. Metadata reads use Kubernetes metadata APIs
  rather than downloading and then hiding Secret/ConfigMap bodies.
- Inline environment values/commands and annotations have separate switches.
- Context and namespace patterns bound every cluster tool. `*` matches any text;
  empty lists deny access. A conversation's pinned scope remains an upper bound.
- Resource rules match group, kind, namespace and name. The **first matching rule**
  overrides read/write defaults for that object. Put exact exceptions first.
  Global tool switches and scope limits still apply.
- Excluded JSON pointer paths remove fields/subtrees from resource responses,
  including explicitly permitted Secret contents. They are not regular expressions.
- Write controls independently allow create, update, delete, scale and restart.
  The replica limit also applies to explicit workload replicas in manifests.

For example, keep Secret access disabled and add a rule for group `""`, kind
`Secret`, namespace `backend`, name `nexus-credentials`, read `Contents`, with
no writes. That permits this one Secret without opening all Secret contents.
Changing data policy cancels current work and applies the new policy to the same
native session. Evidence, query cursors and reviewed plans are revoked; delayed
read results cannot repopulate those stores. The transcript remains visible, but
the next model request starts with fresh context so old sensitive tool payloads
are not replayed under the new policy. The interface identifies this context reset.
Instructions, provider endpoints and credential changes still invalidate sessions.
Changing only default model/options does not retarget existing conversations.

Event and Metrics category denials apply to generic resource reads and lists too,
including `events.k8s.io/Event` and `metrics.k8s.io` resources. Per-resource content
grants do not override these category denials. Explicit empty write permissions
and disabled log/cluster access survive loading and saving unchanged; disabling
Read-only does not add write grants.

Logs, Events, labels and arbitrary configuration can contain sensitive text.
Filtering is not a general data-loss-prevention system. Read permissions govern
the agent's tool responses; granting workload writes also permits deploying
container code with the privileges admitted by the cluster. Use namespace/RBAC/
admission boundaries for that execution environment.

## Providers and dynamic models

| Protocol | Discovery | Generation | Connection examples |
| --- | --- | --- | --- |
| OpenAI Responses | `GET /models` | `POST /responses`, SSE | OpenAI |
| OpenAI-compatible | `GET /models` | `POST /chat/completions`, SSE | OpenRouter, DeepSeek, Mistral, Groq, Gemini's OpenAI endpoint, LM Studio, vLLM, llama.cpp |
| Anthropic Messages | `GET /models`, bounded pagination | `POST /messages`, SSE | Anthropic API |
| Ollama | `GET /api/tags`; selected model via `POST /api/show` | `POST /api/chat`, NDJSON | Local Ollama |

Presets contain connection URLs and protocols, not model IDs. The endpoint's
catalog supplies model IDs, display names and any advertised context/output/tool
capabilities. Missing metadata remains unknown; Kubiki does not infer capabilities
from model names. Explicitly retired models are excluded. Refresh to pick up newly
installed or newly available models. Discovery failure is visible, with no fallback
to an invented model list.

For a local llama.cpp server, select **OpenAI-compatible chat** and use
`http://127.0.0.1:<port>/v1` as the API root. The key stays empty unless the server
requires authentication (`--api-key` / `--api-key-file`). Test the connection,
save the provider, choose an advertised model and save the defaults. Existing
conversations keep their pinned provider/model; start a new conversation to use
a changed default. See the [llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

The home composer follows changes to the saved default provider/model. Removing
its selected connection selects the current valid default and resets the model
for that connection. Model discovery ignores removed provider IDs and responses
from an endpoint that changed while the request was running, including old 401
errors. This also applies when settings are reloaded without a full app restart.

HTTP errors identify the server origin and distinguish a missing key from a
rejected configured key. A 401 does not imply unsupported generation options.
Provider error bodies, URL paths/queries and key values remain excluded from the
error. Authentication failures do not trigger a retry without credentials.

Token limit and temperature are optional; leave them empty for provider defaults.
Anthropic requires `max_tokens`, for which Kubiki supplies 4096 when unset.
Ollama additionally supports an explicit runtime context window (`num_ctx`), since
the server's allocation can be smaller than a model's advertised maximum. Use a
tool-capable local model for investigation/actions. Turn off tool use for plain
chat models; a model explicitly advertising no tools is used without tools.

HTTPS is required for remote endpoints; loopback HTTP is allowed for local
servers. Redirects are rejected. Changing a saved endpoint/protocol clears its key
so credentials cannot silently move to another destination. Azure deployment/IAM
authentication, Bedrock, Vertex-native APIs, custom headers, LAN HTTP, attachments
and arbitrary server-specific generation options are not implemented by these
four protocols. A provider preset is not a certification of every model it serves.

## Tools and execution limits

The current tool set provides a resource catalog, namespace names, resource
get/list with field profiles/selectors/cursors, backend resource summaries, working
scope, historical evidence lookup, bounded workload verification, Pod/workload
diagnostics, Service/PVC/Node and configuration-reference diagnostics, Events and an event timeline, current/previous
bounded Pod logs, Pod metrics, clarification questions and YAML proposals.
Capability/policy-gated Helm, Argo CD and Flux inspection tools also exist.
Write tools create/update one manifest, scale, restart or delete a resource,
and are offered only when their operation has a policy grant, including in Ask.
GitOps mutations are not offered: the native write allowlist excludes these CRDs.
Multi-document
deployments execute one resource at a time and are not atomic.

Supported write kinds: Deployment, StatefulSet, DaemonSet, ReplicaSet, Service,
ConfigMap, PersistentVolumeClaim, Ingress, HorizontalPodAutoscaler and
PodDisruptionBudget. Generic grants do not enable Secret/RBAC/raw Pod/custom
resource writes, container exec, node debugging, draining, host processes or Helm
install/upgrade or GitOps refresh/sync/reconcile.
Known host/elevated fields, CSI/projected service-account tokens and service-account
selection are rejected. Workload manifests must explicitly disable automatic
service-account token mounting. Secret/ConfigMap references in workload manifests
require content access to the referenced object under the data policy.

The agent reuses `PreparedMutation`, optimistic concurrency and the existing
desktop `MutationGuard`. Ask uses the existing native consent dialog. Auto accept
uses backend policy authorization and never a renderer-supplied approval flag.
Only complete provider responses can produce executable calls; unknown tools,
incomplete streams, malformed/duplicate calls and output-limit truncation fail
closed. Native read tools have deadlines and cancellation. Writes are not retried
automatically after an ambiguous result. Failed, declined or uncertain mutations
stop the run and prevent queued companion operations from being dispatched.

Current bounds: 50 native conversations, two concurrent runs, one run per
conversation, 20 tool calls per run, 4 MiB per provider response and a nominal
64,000-byte resource-result bound. Generic get/list now accepts optional `fields`
(up to 32 paths): dot paths with `[*]`/`[index]`, or escaped JSON pointers for keys
containing dots/slashes. Identity is retained from the policy-filtered projection;
missing fields remain absent and explicit null stays null. Array entries retain
position and container relationships. Selection never restores denied fields.

Lists accept `labelSelector`, `fieldSelector` and `pageSize` (1–50, default 25),
within one explicit namespace. Profiles are `identity`, `health`, `images`,
`resources`, `scheduling`, or explicit `full`. Choose fields or a profile; lists
default to health, exact gets retain their full permitted-body default.
Metadata-only field selection uses metadata APIs.
For uniformly permitted content without potentially applicable identity rules, a
single full LIST replaces metadata LIST plus per-object GET. Mixed permissions
retain metadata discovery and individually authorized GETs with UID checks.
Selectors over excluded fields are rejected conservatively; label selectors are
unavailable when label paths are restricted, and non-metadata field selectors
require uniform collection content access.
Lists now return an opaque `cursor` with `hasMore`. Repeat identical arguments plus
that cursor to continue. Cursors expire after five minutes, are local to the native
session/revision, and retain byte-limited page tails before fetching the next API
page. The store is bounded to 16 entries/1 MiB per session. `list_namespaces` now has
matching cursor/pageSize support (1–200); explicit conversation namespaces do not
trigger global namespace discovery. Names pass field policy before egress. Unknown/expired cursors
and Kubernetes 410 require an explicit new scan; old/new snapshots are not silently
combined. A single oversized selected object requires narrower fields.

For example, request images and restart counts without full Pod bodies in the model:

```json
{
  "group": "",
  "version": "v1",
  "kind": "Pod",
  "namespace": "payments",
  "labelSelector": "app=checkout",
  "fields": [
    "spec.containers[*].name",
    "spec.containers[*].image",
    "status.containerStatuses[*].name",
    "status.containerStatuses[*].restartCount"
  ],
  "pageSize": 10
}
```

This is a `list_resources` argument. Arbitrary spec/status projection reduces model
context; the API still returns full objects unless only metadata was requested.

`summarize_resources` groups permitted objects by phase/node/image/health over
1–10 bounded pages (default five, at most 20 seconds), returning counts and up to
five example identities. Counts cover that invocation only. Follow its cursor to
continue the same snapshot; expired snapshots require a new scan. It does not send
all scanned objects to the model. Offline fixture evaluation at 10,000 Pods reduced
selected-field JSON from 21,400,000 to 1,940,000 bytes (90.9%); the aggregate itself
was 568 bytes. These figures measure fixture payloads, not API/LLM latency or accuracy.

Namespaces are capped at 200. Logs default to 150 lines over one hour; callers may
choose `tailLines` 1–500 and `sinceSeconds` 1–86400. The shared log reader bounds API
bytes and validates Pod UID/container; AI output is capped at 24,000 characters, and
logs exceeding 40 lines are condensed (`filter_logs_for_ai`) to the first 10 startup
lines, error/exception/stacktrace lines, and the last 25 tail lines. `get_events_timeline`
normalizes dynamic identifiers (Pod suffixes, IPs, UUIDs, ports) to deduplicate
repeated events (`deduplicate_events`). `diagnose_resource` extracts server-side
container `crashCauses` (including `waiting` reasons alongside `lastTermination`
exit codes/reasons on Pods and workload `childPods`), and policy scrubbing removes
boilerplate `kubectl.kubernetes.io/last-applied-configuration` and `deployment.kubernetes.io/revision`
annotations unless explicitly selected. For Anthropic Messages, the static system
prefix and tool catalog use ephemeral prompt caching (`cache_control`).
Pod metrics support an exact name, required under per-resource rules. Metrics
are policy-projected under `/status/metrics`; historical usage is unavailable.

Native reads have per-run transport caps: 128 HTTP GET attempts, 16 MiB fetched
body data, 4 MiB per response and a 180-second deadline. Frames are checked before
JSON decoding. One retry is allowed for read responses 429/503, within these caps,
with a short bounded Retry-After/backoff; 403 and mutations are not retried.
Discovery responses cache for 60 seconds within a run; simultaneous identical
small GETs coalesce. Sequential resource reads remain fresh. The cache holds at
most 32 responses of 128 KiB and clears on writes; logs/watch bypass it.
Helm content uses bounded subprocess execution and does not use these HTTP counters.

The connection pool issues a generation per client slot. Session creation pins
that generation; tool dispatch and every actual HTTP attempt validate it. A changed
configuration/invalidation revokes the session instead of retargeting it. Changing
the configured kubeconfig path also invalidates agent sessions explicitly.
Already dispatched operations may finish and retain their receipts.
After asynchronous connection validation, the transport rechecks phase, revision
and cancellation immediately before a write is sent.

Provider connect timeout is 10 seconds, stream idle timeout 120 seconds, and the
run's active generation deadline is five minutes; dispatched writes still await receipts.
Time spent awaiting human approval is excluded from read and generation deadlines;
request and byte caps remain unchanged.
The estimated context budget defaults to 16,384 tokens, capped by advertised model
metadata and any explicit runtime context. Model budget hints are not sent as local
runtime allocation. The UI displays the conversation's pinned budget. Backend context events provide
an input estimate even when provider token usage is unavailable; actual usage takes
precedence when supplied. `contextBudgetTokens` is a budget-only model hint; it
does not change provider allocation. Read results include cumulative HTTP/body/time readCost.
Budgeting includes system/tool schemas, full arguments/native items, Unicode and
an output reserve (4096 if unspecified). It is an estimate, not a model tokenizer.
Only a compact policy capability summary goes into the prompt; exact rules stay
in the backend. A budget that cannot fit instructions/tools/retained requests fails
explicitly before another provider call.

Compaction preserves complete assistant/tool exchanges, verbatim user requests,
operation receipt identities/statuses and recent evidence references. It does not
turn quoted evidence into instructions. `get_evidence` retrieves prior projected
results: at most 32 entries/512 KB per session, 64 KB each, TTL ten minutes. Evicted
or expired evidence requires a fresh query. Historical evidence never verifies a write.
Accepted mutation receipts include `operationId`, UID and generation. The connection
retains at most 256 accepted identities for one hour, across individual tool calls.
`verify_workload` accepts `operationId` and pins the recorded target, UID, generation
and desired state; without an ID it uses the latest accepted operation for the target.
An unknown/expired ID is rejected. Without a recorded operation, a previously observed
UID is required; current health alone does not verify a prior change.
Verification polls fresh workload state for 1–20 seconds, rejecting UID replacement.
For controller workloads (`Deployment`, `StatefulSet`, `DaemonSet`, `ReplicaSet`), it
checks `observedGeneration == expectedGeneration` and ready replica counts. For batch
workloads (`Job`), verification evaluates completion conditions (`Complete`, `Failed`,
or `suspended` state) without requiring generation matching or replica counts. Pending
or unknown results do not prove rollout completion or application health.

### Known diagnostic and scale limitations

- Ordinary namespaced get/list requires one explicit namespace; resource entry
  points already pin namespace/identity. The session now maintains a working namespace, optional label selector and root
  identity. `set_working_scope` records an investigation reason and checks allowed
  scope. Omitted namespaces inherit the working namespace; explicit null remains
  cluster-scoped. List selectors inherit only within that namespace and matching selectorKind
  (default Pod); a Pod selector does not silently filter Services/PVCs. An explicit
  selector (including empty string) overrides the default. Root UID is an optional
  investigation anchor, not proof of existence. Working defaults are
  query hints, not additional permissions; explicit dependency reads still pass
  allowed-scope checks. Working revision changes invalidate query cursors.
- Workload child discovery uses both matchLabels and matchExpressions and checks
  controller owner UID (Deployment → ReplicaSet → Pod). It remains bounded to 20
  matching ReplicaSets and 30 matching Pods. Reasons for page limits, omitted
  children, replacement and unavailable reads are reported; results stay partial.
- Workload health uses kind-specific replica fields, Job completion/failure,
  CronJob suspension, observed generation and StatefulSet revisions. Missing fields
  stay unknown/null rather than invented zero/default replicas. Historical metrics
  and complete child pagination remain pending. Exit 137 alone is not reported as
  confirmed OOM, and a normal Completed container is not flagged as a failure.
- Pod/workload diagnostics now require content access before fetching bodies and
  derive spec/status from the generic policy projection. Children are discovered
  through metadata and individually authorized before GET, projected, and checked
  for UID replacement. Events/GitOps share the same projection path. Helm values are parsed and
  projected under `/spec/values`, requiring exact virtual `helm.sh/Release` content
  access; inventory exposes virtual Release metadata from storage labels only.
  Partial diagnostics do not establish health when required fields are missing.
- GitOps inventories are bounded and conservatively partial. Use generic resource
  cursors for deeper enumeration. No default global namespace scans are performed.
- The system prompt now directs hypothesis-driven, scoped field queries and stops
  unnecessary collection; automatically permitted read batches execute with concurrency four; tools needing consent run sequentially. The desktop admits at most
  two AI reads across conversations, sharing ReadTasks with UI (four per context),
  leaving capacity for manual reads. Mixed/write/scope-change batches stay ordered.
  Transport caps independently bound HTTP attempts/bytes/time, and scoped discovery
  caching avoids repeated discovery reads for CRDs within the run.
- The desktop native ResourceStore is disabled. Raw informer reuse stays off until
  it has explicit generation/readiness/freshness and memory guarantees. Current
  reuse uses scoped discovery/coalescing and already-projected historical evidence;
  fresh live reads remain the fallback. No duplicate cluster-wide watch is started.

API acceptance, rollout completion and verified application health are distinct.
Read-back verification is available to the agent through read tools when permitted;
it is not a universal automatic health check or rollback mechanism.

## Storage, architecture and ownership

```text
src/domains/ai/                  Frontend domain: chat, settings, state, IPC adapter
crates/kubiki-ai/                Provider loop, model context and installed skills
crates/kubiki-tools/             Headless tools, policy, projections, receipts and verification
crates/kubiki-mcp/               Shared MCP dispatcher, embedded client, standalone CLI/bridge
src-tauri/src/agent_commands.rs  Window ownership, settings, credentials, lifecycle
src-tauri/src/agent_tools.rs     Native consent and installed-skill adapter
src-tauri/src/opencode.rs        Installed OpenCode launcher and attached MCP lifecycle
crates/kubiki-core/src/core/     ResourceAccess, shared reads, read budgets/cache
```

One repository contains the desktop application and independently installable
`kubiki-mcp`. Tools depend on `kubiki-core`, with no Tauri dependency. The integrated
agent reaches the same dispatcher over an in-memory MCP transport. OpenCode reaches
it through an authenticated local bridge and reuses the desktop connection pool.
Standalone MCP hosts the same tools/core without requiring the desktop application.
`kubiki-ai::ConversationState` owns provider turns, conversation memory and compaction.
The portable tools session owns execution controls, scope, evidence and accepted
operation identities. Provider protocols and generation options live in `kubiki-ai`.
MCP request cancellation is local to that request, including time spent waiting for
execution; global Stop or connection invalidation still revokes the whole session.
Dispatched writes finish receipt handling even after cancellation.
Desktop/core maintainers own tool and connection changes; frontend maintainers own
the chat/settings and terminal presentation.

Configuration is native app-config `ai.json`; credentials are in the OS keyring.
Desktop transcripts use app-data `ai/history.sqlite3` (SQLite + FTS5), schema v1.
Legacy `kubiki.ai_conversations.v1` data migrates through native sanitization before
removal from localStorage; corrupt migration preserves the old bytes and still
restores valid native history. Browser preview uses localStorage only.

History retains at most 200 conversations / 32 MiB, 2 MiB per transcript; default
retention is 30 days (configurable 1–365). Opt-out deletes stored transcripts and
index data. SQLite secure_delete and FTS5 secure-delete are both enabled. Explicit
conversation deletion awaits the native transaction; deletion tombstones prevent
stale windows from reintroducing it. Tool bodies, log/value data, YAML arguments,
PlanArtifact payloads and approvals are excluded by a native whitelist. User/assistant
text may still contain user-provided or copied sensitive text; this is not DLP.

Restored conversations are Plan + Ask, with no resumed session/run/approval.
Search supports text, cluster/namespace/date filters, historical message navigation
and archive/pin/rename. Branch/edit-and-retry creates a fresh Plan + Ask session with
an explicit bounded historical transcript in the editable draft. Provider/model
changes detach the previous native session; old tool evidence is not resent.
Transcript/plan export checks the separate local export preference.

Native plans are ephemeral versioned proposals (≤16 versions / 256 KiB; each ≤60 KB),
with a formal schema, checked evidence references and actual session scope/policy ID.
The UI renders plans as strictly validated typed cards (`PlanArtifact`), never by
guessing at Markdown or model thinking. Concurrently, streaming thought processes
(`<think>`/`<thought>`) are handled as distinct UI elements via `ThinkingBlock` to
visualize reasoning without contaminating plan state.
Selected concrete steps require an explicit native review and a single-use 5-minute
token. Current UID/resourceVersion/absence is checked again at dispatch, including
an independent mode/phase/cancellation guard after connection validation. Native
server-accepted UIDs bind create verification and are kept out of model history when
not permitted. Failed/uncertain/declined steps stop further writes. Unknown outcomes
may collect bounded read-only reconciliation evidence without retrying the write.
Verified dependencies and explicit acceptance-only dependencies remain distinct.
See [the plan contract](AI_PLAN_CONTRACT.md) for lifecycle, limitations and statuses.

Permission settings now provide diagnostic/metadata/workload/network/storage/limited
action presets and a native-only effective-access/rule preview. `allowedFields`
restricts egress after data permissions and denied paths; hidden fields cannot be
queried through selectors. Existing schema-v1 first-match rules retain their meaning.
Users can explicitly choose schema v2 `deny_overrides`: matching no-access/no-write
rules then override grants regardless of order. Preview precedes saving; settings
changes invalidate native sessions and their old context rather than silently
continuing under changed permissions.

Operation metadata is appended to app-data
`ai/operations.jsonl`, with intent persisted before commit and receipts afterwards.
It includes identity/operation/mode/status, not model prompts, object values or
credentials. It is a local operational journal, not tamper-proof compliance audit.
An interrupted process may leave a dispatching record with an unknown outcome;
there is no automatic replay. Journal failure blocks undispatched changes.

Provider/network failure affects AI conversations, not ordinary cluster views.
Disable a capability in permissions to revoke it from existing conversations;
removing connections makes new provider requests unavailable. Already applied
cluster changes require separately reviewed compensation. There is no general Undo.

## Implementation research

The following primary sources informed the design; code was not copied:

- [Headlamp AI Assistant](https://github.com/headlamp-k8s/plugins/tree/main/ai-assistant):
  closely matching chat, resource diagnosis/generation, provider and tool settings.
  Kubiki keeps policy and credentials in the native backend rather than relying
  on frontend tool switches.
- [kubectl-ai](https://github.com/GoogleCloudPlatform/kubectl-ai): provider selection,
  local-model support and configurable tools. Kubiki uses typed application tools
  instead of exposing general `bash`/`kubectl` execution.
- [Radar MCP](https://github.com/skyhook-io/radar/blob/main/docs/mcp.md): structured
  diagnostic context and separation of diagnosis/application/verification. Kubiki's
  tool layer is available through an embedded dispatcher and standalone MCP CLI.
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling),
  [Anthropic tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview),
  [Anthropic model discovery](https://platform.claude.com/docs/en/api/models/list),
  [Ollama API](https://docs.ollama.com/api/chat), and
  [Gemini compatibility](https://ai.google.dev/gemini-api/docs/openai): protocol contracts.

## Verification

```sh
pnpm typecheck
pnpm exec vitest run
pnpm test:e2e tests/e2e/ai_agent.spec.ts
cargo test --locked --manifest-path crates/kubiki-ai/Cargo.toml
cargo test --locked --manifest-path crates/kubiki-tools/Cargo.toml
cargo test --locked --manifest-path crates/kubiki-mcp/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo test --locked --manifest-path crates/kubiki-core/Cargo.toml --test revocable_mutation_tests
pnpm build
```

Tests use local HTTP fixtures and mocked IPC/Kubernetes services. No paid-provider
calls or live-cluster writes are part of the automated suite. Verify actual model
quality, credentials/OS keyring behavior and cluster admission on the intended
desktop platforms before relying on a new provider/model for automatic changes.

### Settings navigation

AI settings use the same sections in the workspace dialog and global Settings:
Connections & models, Confirmations, Data access, Scope & rules, Integrations,
Instructions, and History. Switching sections preserves unsaved permission edits.
Always ask takes precedence over the read-confirmation checkbox and Auto accept.

## Agent environment

**Test connection** requests the provider model catalog using the current form's
endpoint/protocol and temporary key. It neither saves the provider nor persists
the temporary credential. A stored key is reused only for its exact saved endpoint.

**Skills** follow the [skills.sh canonical layout](https://github.com/vercel-labs/skills/blob/main/src/installer.ts):
`~/.agents/skills/<skill>/SKILL.md`. Install globally with `npx skills add owner/repo -g`.
Kubiki reads the existing directories and symlinks; it does not install or copy them.
Type `$` in either composer, choose a skill with arrows/Enter/Tab, or dismiss with
Escape. Explicit `$name` references load instructions for that turn. `read_skill`
can load relative references inside the selected skill directory. Skills cannot
extend permissions. Discovery is bounded to 128 skills, depth three, 64 KiB per file;
a turn may explicitly select up to four skills. New conversations refresh the runtime
catalog; the settings list has a Refresh button.

## Agent selection and OpenCode

Choose **Kubiki / OpenCode** under **Settings → AI assistant → Agent**. Missing
runtime preferences default to Kubiki. The selection is application-wide, with
separate histories. Only settings that affect the selected runtime are displayed.
Kubiki provider/model/instructions/skills/confirmation settings are retained while
hidden and do not control OpenCode. Switching invalidates integrated sessions and
stops attached processes; it never transfers approvals or replays tools.

OpenCode uses the installed V2 executable, a real PTY, its user configuration and
credentials. Its pane uses the same terminal renderer and typography preferences
as local/Pod/Node shells (see [Terminal rendering](TERMINAL.md)). A dedicated Kubiki workspace adds only our local MCP connection;
existing project configuration is not overwritten. The desktop executable provides
a headless `--kubiki-mcp-attach` bridge entrypoint, so desktop bundles do not need a
separately installed CLI. Scope-specific workspace directories isolate windows and
connections. Custom workspace roots must be absolute; the default lives in app data.

OpenCode owns its permissions, Plan mode and confirmation prompts. No additional
Kubiki Ask/Auto/alwaysAsk confirmation is applied to host-owned calls. A separate
`mcpPolicy` controls what data and operations the application exposes: it is not
inherited from the hidden Kubiki policy. Defaults expose filtered reads and no
writes. Kubernetes RBAC, pinned connection generation, projection, bounds,
mutation preconditions and receipts remain enforced by the server.

Attached external clients have an explicit **MCP server phase** control in the
terminal toolbar and MCP settings. It defaults to Plan. This server phase is
independent of the external client's own Plan/Build mode: Kubiki does not infer
that mode from terminal output or model arguments. Phase changes apply live to
the MCP catalog and dispatcher without restarting the process. Policy and phase
updates are atomic; Plan blocks mutation calls and applies `planDisabledTools`,
while Action applies `actionDisabledTools`. Switching to Action still requires
explicit write grants. Standalone `kubiki-mcp serve` continues to use its explicit
host-owned profile in Action; the attached desktop control does not manage it.

Global context changes disconnect the panel until an explicit restart; they never
silently retarget a running connection. Stop also cancels pending startup, including
font loading and native version checks. Restart preserves an initial Analyze or
creation prompt only after a typed native failure proves that no process was
scheduled. Delivered tasks and ambiguous startup failures are never replayed.
Normal TUI commands and model/provider choices belong to OpenCode. Its shell runs
under its own permissions and is outside MCP filtering.

### MCP Architecture & Standalone Roadmap (`kubiki-mcp`)

The MCP layer is completely decoupled into `crates/kubiki-mcp` and `crates/kubiki-tools`. It has zero dependencies on Tauri, Webview, or frontend state, communicating purely via standard MCP primitives (`rmcp`) and generic Kubernetes session traits.

* **Current Architecture (Embedded & Attached Bridge)**:
  Desktop Kubiki manages Kubernetes cluster authentication and runs `kubiki-mcp` in attached socket/stdio bridge mode, exposing tools to external CLIs (OpenCode, Codex, Claude Code) and the internal AI assistant with synchronized live policy controls.
* **Roadmap / Future Concept (Standalone Daemon & Independent CLI)**:
  As an upcoming milestone, `kubiki-mcp` can be built and distributed as an independent standalone daemon without requiring the Kubiki desktop GUI to be installed or running:
  - Declarative configuration files (`kubiki-mcp.json`)
  - Standalone cluster discovery and connection pool
  - Live reload commands (`kubiki-mcp reload`) over local IPC/SIGHUP
  - Detailed design: see [ADR-009](decisions/009-standalone-mcp-server-and-unified-tool-permissions.md)

```sh
# Future standalone CLI interface (Roadmap):
kubiki-mcp init                                # Generate template configuration file
kubiki-mcp validate --config kubiki-mcp.json    # Validate config and cluster connectivity
kubiki-mcp serve --config kubiki-mcp.json       # Run standalone MCP server over stdio
kubiki-mcp reload                              # Reload policy live without disconnecting clients
```

#### Declarative Configuration (`kubiki-mcp.json`)

The server discovers configuration from `--config PATH`, `./kubiki-mcp.json`, or `~/.config/kubiki/mcp.json`:

```json
{
  "$schema": "https://kubiki.dev/schemas/mcp-v1.json",
  "version": 1,
  "cluster": {
    "context": "my-cluster",
    "kubeconfig": null,
    "namespaces": ["default", "production"],
    "allNamespaces": false
  },
  "policy": {
    "readOnly": false,
    "writes": ["create", "update", "scale", "restart", "delete"],
    "maxReplicas": 10,
    "data": {
      "resources": true,
      "events": true,
      "logs": true,
      "metrics": true,
      "clusterResources": true,
      "secrets": "none",
      "configMaps": "metadata",
      "customResources": "metadata"
    },
    "integrations": {
      "helm": "auto",
      "argocd": "auto",
      "flux": "auto"
    },
    "phases": {
      "plan": { "disabledTools": [] },
      "action": { "disabledTools": [] }
    },
    "disabledTools": [],
    "deniedPaths": []
  },
  "server": {
    "transport": "stdio"
  }
}
```

The MCP host launches `kubiki-mcp serve` over stdio. CLI flags `--context`, `--namespace`, `--all-namespaces`, and `--read-only` can override configuration values. Host-owned connections ignore `confirmReads`/`alwaysAsk`; host permissions decide whether each call may proceed. Logs go to stderr and mutation receipts to a process-specific journal; stdout is reserved for MCP JSON-RPC.

OpenCode V2 configuration example:

```json
{
  "mcp": {
    "servers": {
      "kubiki": {
        "type": "local",
        "command": ["/absolute/path/kubiki-mcp", "serve", "--config", "/absolute/path/kubiki-mcp.json"],
        "codemode": false
      }
    }
  }
}
```

Transport coverage is tested on Linux. The Windows named-pipe implementation needs
native Windows validation. Live provider/cluster evaluation and infrastructure
repositories remain separate work. Architecture and migration rationale:
[ADR-007](decisions/007-portable-cluster-tools-and-opencode.md) and
[ADR-009](decisions/009-standalone-mcp-server-and-unified-tool-permissions.md).
