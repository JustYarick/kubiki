# Resource analysis

Select Codex, OpenCode or Claude Code under **Settings → AI assistant**. The CLI
must already be installed on the host's PATH and signed in. Kubiki uses the
agent's configured account and model; it does not manage model credentials.

**Analyze** in **What's wrong** opens an independent workspace terminal with a
bounded diagnostic snapshot: identity, reported issues, status, scheduling
constraints, container images/resource requests, and matching loaded Events.
Kubiki does not fetch additional logs or run cluster commands for this action.
Secret/ConfigMap contents, environment values and annotations are excluded.
The initial message can be inspected and copied. Snapshots are not persisted in
workspace settings. Browser/demo mode provides the message preview; launching
the process requires the desktop app.

The initial message explicitly prohibits commands, cluster changes, experiments
and attempts to fix or verify anything. It treats all snapshot content as data
and asks for an explanation, evidence, uncertainty and recommendations in Russian.

Native launch uses a fixed executable with separate arguments, never a shell
command assembled from resource data. Codex starts with `--sandbox read-only`
and `--ask-for-approval never`. OpenCode receives denied tool permissions through
`OPENCODE_PERMISSION`. Claude Code starts in plan mode with built-in tools and
configured MCP servers disabled. Local terminals and Analyze start directly
without a local-process confirmation. The existing PTY lifecycle applies.
Analyze uses its own `start_ai_analysis` IPC command; an older native backend
reports that a rebuild/restart is required instead of launching a shell.
These external CLI controls and the prompt are not a
replacement for Kubernetes RBAC.

References: [Codex CLI](https://learn.chatgpt.com/docs/cli/reference),
[OpenCode CLI](https://docs.opencode.ai/docs/cli/),
[OpenCode permissions](https://docs.opencode.ai/docs/permissions/).

Ordinary consoles still open in the bottom panel. **Open terminal in tab**
opens an additional session for the same target; the original session remains
in the panel. Closing split view leaves its workspace tab available.
