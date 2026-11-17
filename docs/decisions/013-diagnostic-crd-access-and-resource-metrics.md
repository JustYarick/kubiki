# 013: Diagnostic CRD access and resource metrics

## Status

Accepted, 2026-11-17. Implemented in the portable tools and core layers; validation
uses HTTP/browser fixtures, not a live-cluster incident. Extends
[ADR-005](005-bounded-ai-resource-queries.md).

## Context

Metadata-only custom resource access removes the conditions needed to diagnose
Flux and external-secrets. Granting all CRD contents would also expose Helm values
and arbitrary provider configuration. Separately, Pod usage does not describe a
Node's host usage or the workloads' configured reservation and limit budgets.

## Decision

Add `diagnostic` as a read level. Recognized Flux and external-secrets kinds use an
explicit field allowlist in the common policy projection. Unrecognized kinds fall
back to metadata. Secret/ConfigMap payloads are not part of this level. Resource
rules, category/scope gates, excluded paths and allowed fields remain authoritative.
New policies and the Diagnostic preset use this level for custom resources;
explicitly saved metadata/no-access policies are not migrated to broader access.
Generic reads report high-confidence field denials separately from absent fields.
Collection explanations defer to exact reads when per-resource rules can differ.
Diagnostic field selectors must not infer excluded data through membership.

Extend the existing `get_metrics` tool with Pod/Node selection rather than adding
parallel tools. Core reads exact Node Metrics API samples. Tools join independently
authorized projected resource reads for effective configured budgets and bounded
Node Pod allocations. Computed output is projected under the target's
`/status/metrics`. Host usage is never inferred from Pod sums. Namespace, page,
policy, sample-age and unknown/unbounded limits remain explicit.

## Alternatives considered

- Open complete Flux/external-secrets objects: unnecessary disclosure of values and
  unrelated configuration.
- Bypass generic policy in specialized GitOps tools: inconsistent authorization and
  loss of field restrictions across generic/diagnostic reads.
- Add independent usage/request/limit tools: duplicates target and permission
  contracts and increases catalog ambiguity.
- Report bounded Node allocations as complete totals: incorrect under namespace
  restrictions, denied reads or page caps.

## Consequences

Diagnostic investigations can read conditions and revision evidence without
general CRD body access. Allowlist maintenance follows supported API fields;
condition messages and artifact strings remain untrusted and may be sensitive.
Independent metrics/spec/Pod reads cannot promise an atomic cluster snapshot or
historical rightsizing. Unknown budget fields stay unknown, and partial Node sums
must not be used as full-node reservation totals. A durable historical source or
broader default access would require another decision.

## References

- [Current policy and tool contracts](../AI_AGENT.md#tools-and-execution-limits)
- [Remaining MCP work and catalog overlap audit](../plans/mcp-improvements-and-website.md)
