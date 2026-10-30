# Integrated AI agent

This page describes the current implementation. The next stages, including a
shared Kubernetes access service, separate Plan/Action phases, deeper diagnostics
and chat history, are tracked in the [development roadmap](AI_ROADMAP.md).
Plan/Action phases are planned and are not implemented by the current mode selector.

Kubiki's integrated agent has its own workspace tab and a shared runtime for
ordinary chat, resource investigation and resource generation. It calls model
APIs directly. It does not run Codex, Claude Code, `kubectl`, a shell or an
extension backend. The existing external CLI snapshot analysis is a separate
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
   cluster/namespace scope. Every new conversation starts in **Read only**.

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
get/list, Events, bounded Pod logs, Pod metrics and YAML proposals. Write tools
create/update one manifest, scale, restart or delete a resource. Multi-document
deployments execute one resource at a time and are not atomic.

Supported write kinds: Deployment, StatefulSet, DaemonSet, ReplicaSet, Service,
ConfigMap, PersistentVolumeClaim, Ingress, HorizontalPodAutoscaler and
PodDisruptionBudget. Generic grants do not enable Secret/RBAC/raw Pod/custom
resource writes, container exec, node debugging, draining, host processes or Helm.
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
automatically after an ambiguous result.

Current bounds: 50 native conversations, two concurrent runs, one run per
conversation, 20 tool calls per run, 160 KB of conversation context, 4 MiB per
provider response and 64 KB per resource response. Resource lists cover a bounded
first page, with partial coverage reported explicitly. Logs cover at most 150
lines within an hour, capped at 24,000 characters. A 60-second provider stream
idle timeout and a 180-second HTTP deadline bound generation. Long contexts stop
with a visible error rather than silently discarding evidence. Automatic
compaction and resumable conversation history are future work.

API acceptance, rollout completion and verified application health are distinct.
Read-back verification is available to the agent through read tools when permitted;
it is not a universal automatic health check or rollback mechanism.

## Storage, architecture and ownership

```text
src/domains/ai/                  Frontend domain: chat, settings, state, IPC adapter
crates/kubiki-ai/                Headless domain: policy, sessions, loop, provider protocols
src-tauri/src/agent_commands.rs  Window ownership, settings, credentials, lifecycle
src-tauri/src/agent_tools.rs     Kubernetes adapters, native consent, operation receipts
```

One repository and the existing desktop runtime remain the deployment unit.
The AI crate has no Kubernetes credentials, shell, filesystem tools or dependency
on Tauri; capabilities enter through a host-owned `ToolExecutor`. Desktop/core
maintainers own authorization and tool changes; frontend maintainers own the chat
and event adapter. CI runs AI-domain tests on the desktop target OS alongside
existing core and desktop tests.

Configuration is native app-config `ai.json`; credentials are in the OS keyring.
Conversation messages, tool results and elevated modes stay in memory and are not
restored after restart. Operation metadata is appended to app-data
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
