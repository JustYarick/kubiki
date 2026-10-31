# Integrated AI agent

Implementation snapshot: **2026-11-01**, checked against the repository, not a
live-cluster performance benchmark. Backend Plan/Action phases, Pod/workload
diagnostics, structured compaction and frontend conversation persistence already exist.
Generic UI/agent reads now share core ResourceAccess, with field selection,
pagination and working-scope defaults. Specialized readers use the same core transport and pinned connection generation.
Live-cluster/model evaluation and optional informer reuse remain separate work. See the [development roadmap](AI_ROADMAP.md) and
[query and diagnostic requirements](AI_QUERY_DESIGN.md) for remaining work.

Kubiki's integrated agent has its own workspace tab and a shared runtime for
ordinary chat, resource investigation and resource generation. It calls model
APIs directly. Generic resource tools use typed Kubernetes APIs, with no model-facing
shell or arbitrary command tool. Helm diagnostics currently delegate to the existing
`HelmReader` for explicitly permitted release content. Inventory uses Kubernetes
metadata-only reads of Helm storage labels; it never loads Secret bodies.
The existing external CLI snapshot analysis is a separate
feature described in [AI analysis](AI_ANALYSIS.md).

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
   cluster/namespace scope. The default is **Read only + Plan**; the creation UI
   also permits an explicit mode/phase selection.

The browser preview does not connect to model providers, persist credentials or
execute agent tools. Real connections require a rebuilt desktop backend with the
new AI commands.

## Entry points

- **AI Agent**: independent conversations for questions, investigation and creation.
- **Investigate with AI** in a resource's **What's wrong** block: opens a
  conversation pinned to that resource's context and namespace. Only identity
  is attached; live object fields must pass through native read policy.
- **Create with AI** in resource lists: opens a creation conversation. For
  example, request a Nexus deployment, discuss image/version/storage/exposure,
  and receive a YAML proposal. A multi-namespace selection is not silently
  reduced to its first namespace.

Text streams into the chat, with Markdown, code copying and structured tool
results. Generated YAML is a **proposal**, not evidence of a deployment. In
Ask/Accept a proposal can be passed back to the agent for application through
the same guarded mutation tools. The application never executes a Markdown code
block directly. Remote images and raw HTML in model output are not loaded.

## Modes and permissions

| Mode | Permitted reads | Permitted changes |
| --- | --- | --- |
| Read only | Automatic | Blocked; proposals are allowed |
| Ask | Automatic | Each prepared operation needs an explicit native review |
| Accept | Automatic | Automatic after policy and resource identity/version checks |

The changes column applies only in **Action**. In **Plan**, all modes prohibit
writes. Backend sessions start in Read only + Plan; users can explicitly select
another mode/phase. The UI now consistently displays **Action**. The wire enum
still serializes `tooling`, accepts `action` as an alias, and exposes a Rust
`AgentPhase::Action` alias for compatibility with existing data.
Read only forces Plan. Tool availability and dispatch both enforce the phase.

Changing to Accept does not enable disabled operations or expand data access.
Kubernetes RBAC and admission still apply. The model cannot change mode, edit
policy, approve a native confirmation, open a terminal or choose another endpoint.

The backend owns mode and scope. A cluster client is pinned to each cluster
conversation; changing the global cluster selector does not retarget it. Choose
scope/provider/model before the first message. Start a new conversation to change
them afterwards. General chat exposes only proposal generation, or no tools when
tool use is disabled.

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
Changing data policy, instructions, provider endpoints or credentials invalidates
existing native conversations. Start a new conversation rather than resending
previously collected sensitive context under a tighter policy. Changing only
default model/options does not retarget existing conversations.

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
diagnostics, Events and an event timeline, current/previous
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
desktop `MutationGuard`. Ask uses the existing native consent dialog. Accept
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
bytes and validates Pod UID/container; AI output is capped at 24,000 characters.
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
`verify_workload` polls fresh controller state for 1–20 seconds, rejecting UID
replacement and checking observed generation/expected replicas. Pending or unknown
results do not prove rollout completion or application health.

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
  unnecessary collection; read-only model batches execute with concurrency four. The desktop admits at most
  two AI reads across conversations, sharing ReadTasks with UI (four per context),
  leaving capacity for manual reads. Mixed/write/scope-change batches stay ordered.
  Transport caps independently bound HTTP attempts/bytes/time, and scoped discovery
  caching avoids repeated discovery reads for CRDs within the run.
- The desktop native ResourceStore is disabled. Raw informer reuse stays off until
  it has explicit generation/readiness/freshness and memory guarantees. Current
  reuse uses scoped discovery/coalescing and already-projected historical evidence;
  fresh live reads remain the fallback. No duplicate cluster-wide watch is started.

Remaining gaps and regression gates are tracked in
[AI_QUERY_DESIGN.md](AI_QUERY_DESIGN.md).

API acceptance, rollout completion and verified application health are distinct.
Read-back verification is available to the agent through read tools when permitted;
it is not a universal automatic health check or rollback mechanism.

## Storage, architecture and ownership

```text
src/domains/ai/                  Frontend domain: chat, settings, state, IPC adapter
crates/kubiki-ai/                Headless domain: policy, sessions, loop, provider protocols
src-tauri/src/agent_commands.rs  Window ownership, settings, credentials, lifecycle
src-tauri/src/agent_tools.rs     Policy/projection adapters, consent, receipts
crates/kubiki-core/src/core/     ResourceAccess, shared reads, read budgets/cache
```

One repository and the existing desktop runtime remain the deployment unit.
The AI crate has no Kubernetes credentials, shell, filesystem tools or dependency
on Tauri; capabilities enter through a host-owned `ToolExecutor`. Desktop/core
maintainers own authorization and tool changes; frontend maintainers own the chat
and event adapter. CI runs AI-domain tests on the desktop target OS alongside
existing core and desktop tests.

Configuration is native app-config `ai.json`; credentials are in the OS keyring.
Frontend text conversations and usage metadata persist in localStorage under
`kubiki.ai_conversations.v1` (Zustand schema version 1). Tool bodies, log/value data,
YAML arguments and generated tool manifests are omitted; only call identities and
operation ID/status receipts are retained. Legacy version-0 history is migrated with
the same filtering. User/assistant text can still contain sensitive text: this is
not general DLP or the planned native history/retention UI. Restored mode/phase reset
to Read only + Plan; native runs/approvals are not restored. Native runtime memory,
cursors and evidence are ephemeral; the visible transcript is not runtime replay.
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
  initial runtime calls APIs directly and does not require MCP or an external CLI.
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
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo test --locked --manifest-path crates/kubiki-core/Cargo.toml --test revocable_mutation_tests
pnpm build
```

Tests use local HTTP fixtures and mocked IPC/Kubernetes services. No paid-provider
calls or live-cluster writes are part of the automated suite. Verify actual model
quality, credentials/OS keyring behavior and cluster admission on the intended
desktop platforms before relying on a new provider/model for automatic changes.
