# Architecture decisions

ADRs explain why a significant design was chosen, including alternatives, costs
and consequences. They preserve decision history. Current implementation belongs
in [Project structure](../STRUCTURE.md) and the topic guides; unimplemented work
belongs in [development plans](../plans/README.md).

Status tracks adoption of a decision, not completion of every original sketch.
Historical references to old APIs, UI or migration steps describe that decision's
context. Follow status clarifications and replacement ADRs for later changes.

| Decision | Status |
| --- | --- |
| [001: Signed desktop updates](001-desktop-updates.md) | Accepted; stable/dev implementation documented separately |
| [002: Integrated Kubernetes agent](002-integrated-ai-agent.md) | Accepted; refined by 003, 005, 007–010 |
| [003: Shared Kubernetes access and phases](003-shared-kubernetes-access-and-ai-phases.md) | Accepted; planning presentation superseded by 010 |
| [004: Workbench shell and panel slots](004-workbench-layout-shell-and-perspective-panels.md) | Accepted |
| [005: Bounded AI resource queries](005-bounded-ai-resource-queries.md) | Accepted |
| [006: Structured plans and transcript storage](006-reviewed-ai-plans-and-transcript-history.md) | Partially superseded by 010; transcript storage retained |
| [007: Portable tools and external agents](007-portable-cluster-tools-and-opencode.md) | Accepted; refined by 008–010 |
| [008: Evidence-first investigation](008-evidence-first-investigation.md) | Accepted |
| [009: MCP isolation and phase permissions](009-standalone-mcp-server-and-unified-tool-permissions.md) | Accepted boundaries; managed lifecycle remains proposed |
| [010: Conversational Markdown plans](010-conversational-markdown-plans.md) | Accepted; replaces structured model-facing plans |
| [011: Trusted Node extension runtime](011-trusted-node-extension-runtime.md) | Accepted; records the existing runtime choice |

Use the [ADR template](TEMPLATE.md) and [documentation conventions](../DOCUMENTATION.md).
