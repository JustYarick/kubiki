# Managed MCP configuration and lifecycle

Status: **Proposed**. Extends [ADR-009](../decisions/009-standalone-mcp-server-and-unified-tool-permissions.md).
No delivery date is assigned.

## Current implementation

`kubiki-mcp serve` runs independently over stdio. It accepts explicit context,
namespace scope, kubeconfig and an optional `AgentPolicy` profile. Desktop-attached
clients use a separate bridge and desktop-owned connections. See the
[current CLI contract](../AI_AGENT.md#standalone-mcp-server).

## Proposed scope

- Define a versioned declarative configuration format and precedence over CLI flags.
- Define validation and initialization commands for that format.
- Specify managed reload and any daemon/control transport only if required by a host.
- Preserve protocol output on stdout and diagnostic logging on stderr.

`kubiki-mcp.json`, `init`, `validate`, `reload`, SIGHUP and control IPC are proposed;
they are not accepted commands or configuration contracts in the current executable.

## Acceptance criteria

Configuration validation must fail before exposing tools on invalid scope or policy.
Reload must atomically revoke old permissions and prepared operations, handle
connection generation changes, and retain receipts for already dispatched writes.
Untrusted callers must not gain a control channel. Test stdio and native bridge
lifecycle on supported platforms without requiring desktop startup for standalone
operation. Document migration and failure recovery before adopting a stable format.
