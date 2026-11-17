# 012: Bounded log snapshot pages

## Status

Accepted, 2026-11-17. Extends [ADR-005](005-bounded-ai-resource-queries.md).
Implemented in the portable tools layer; real-cluster rotation behavior remains
outside fixture verification.

## Context

Diagnostic log output intentionally condenses evidence. Investigations also need
exact lines and a way to inspect a bounded result without losing lines between
pages as a container writes new logs. Existing core reads support an exact Pod
UID/container, tail limits, timestamps and bounded API bytes. Existing session
cursors already bind queries and permission revisions with bounded storage.

## Decision

Keep the default diagnostic contract. Add an opt-in `lines` mode to `get_logs`
which captures one core log slice, applies a literal substring filter and returns
byte- and count-bounded pages with original slice line numbers. Continuation uses
the existing session-local cursor store and reads no live data. Expose the core
RFC3339 `sinceTime` option, exclusive with relative `sinceSeconds`, in both modes.
Authorize logs and the exact target before reading or resuming. Returned capture
time and coverage identify the result as historical, partial evidence.

## Alternatives considered

- Timestamp-based repeated reads: lower retained memory, but concurrent writes,
  identical timestamps and rotation make stable page boundaries unreliable.
- External log backend: useful for durable history, but adds credentials,
  deployment requirements and identity mapping beyond local Pod diagnostics.
- Replace diagnostic output: breaks existing callers and increases model context.

## Consequences

Pages preserve exact text within the captured slice, including repeated timestamp
lines; filtering does not imply complete coverage of container history. A new
call without a cursor captures fresh data. Existing tail/time and API byte bounds
remain; rotation or restarts can omit data before capture. The core UID pre-read
cannot make the Kubernetes log subresource atomic against Pod replacement.

Cursor storage uses the existing five-minute TTL, 16-entry limit and 1 MiB budget.
Expired/evicted cursors require a new read; oversized lines or retained snapshots
fail explicitly rather than silently discarding evidence. Policy changes revoke
stored pages. A future durable log integration requires a separate identity,
retention and security design.

## References

- [Current tool contract](../AI_AGENT.md#tools-and-execution-limits)
- [Remaining MCP work](../plans/mcp-improvements-and-website.md)
