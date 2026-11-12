# Development plans

These are proposals and deferred capabilities, not supported interfaces or release
commitments. No delivery dates or priorities are assigned here. Before implementing
an item, confirm its scope and acceptance criteria; record significant decisions
in an ADR and update the operating documentation when the code ships.

| Area | Status | Current boundary | Proposed work / validation |
| --- | --- | --- | --- |
| [Traffic observability](traffic-observability.md) | Proposed | Topology represents declared relationships. | Select a telemetry source; validate identity mapping, credentials, coverage and bounded collection before adding a Traffic view. |
| [MCP lifecycle](mcp-lifecycle.md) | Proposed | Standalone stdio `serve`, pinned CLI scope and `AgentPolicy` profile exist. | Specify declarative configuration and managed reload; validate atomic policy revocation and connection lifecycle. |
| Extension SDK | Deferred | Settings, secrets, notifications and extension-owned backend RPC are public. | Kubernetes reads/writes, context events and port-forward leases need explicit capability and cleanup contracts. |
| Extension isolation | Deferred | Node backends run as trusted local code. | An OS sandbox or restricted runtime needs a threat model and compatibility/cost evaluation; see [ADR-011](../decisions/011-trusted-node-extension-runtime.md). |
| Desktop updates | Deferred | Signed static GitHub feeds, stable/dev channels, manual recovery. | Rollback, staged rollout and key rotation require separate failure and trust-chain designs; see [ADR-001](../decisions/001-desktop-updates.md). |
| AI data reuse | Deferred | Bounded reads and scoped caching; no raw informer reuse. | Require explicit generation, readiness, freshness and memory guarantees before reusing informer data; see [AI limits](../AI_AGENT.md#known-diagnostic-and-scale-limitations). |

Platform validation is ongoing verification, not a promised feature. Native
installer/updater, keyring, DPI and rendering checks must run on the target OS;
[testing](../TESTING.md) describes automated coverage and its limits.
