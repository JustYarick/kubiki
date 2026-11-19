# 015. Historical metrics for incident investigation

## Status

Accepted 2026-11-19. Extends [ADR-013](013-diagnostic-crd-access-and-resource-metrics.md).

## Context

The Kubernetes Metrics API supplies recent samples. Investigations into a past
memory spike need timestamped measurements that may predate the MCP session.

## Decision

Retain bounded observations by resource UID and session revision. Let operators
associate a context with an existing Prometheus service. The host chooses the
service and the Kubernetes client accesses it through the API service proxy.
The tool accepts resource identity and time bounds. Core constructs fixed queries
and bounds the response. Tools check scope, policy and current resource identity.

## Alternatives considered

Continuously scraping every Pod from the desktop would require background
collection and a retention policy. It would also leave gaps while Kubiki was
closed. Supporting arbitrary PromQL and server URLs would expand access beyond
the requested resource.

## Consequences

Historical reads can use data retained before the session started. Coverage
depends on the operator's scrape labels, retention, service proxy access and
availability. Restricting the range to the current object's lifetime excludes
previous incarnations with the same name. Without a configured service, coverage
depends on prior session reads.

## References

[Metric sources and configuration](../AI_AGENT.md#scheduling-and-incident-diagnostics)
