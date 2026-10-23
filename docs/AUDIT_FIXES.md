# Audit follow-up

This follow-up addresses the audit of commit `71033a6`.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| Incomplete batch review covered more mutations than it displayed | Preserve every target and step. Reject batches over 1000 steps or a complete review over 2 MiB. Built-in actions have semantic summaries; manual manifests retain diffs. | `audit_regressions.rs`, browser audit regressions |
| An already cordoned Node could be replaced before a drain | Check Node UID and resource version before listing Pods, recheck after consent, and verify source identity before each batch step. | drain preparation and source-change tests |
| Node shell attachment raced the last terminal's cleanup | Reserve pending attachments under the same lock as the session phase; release failed or cancelled reservations with an RAII guard. | deterministic node attachment/cleanup race test |
| Native discovery and snapshots depended on kubectl | Use the pooled Kubernetes client for discovery, paginated snapshots and CRD instance reads. CRD reads pin the definition UID and select a served version. | paginated native read test; resource catalog browser tests |
| Snapshot namespace fallback could not execute | Share the RBAC fallback predicate with watch synchronization and ignore late responses from a previous namespace. | snapshot synchronization and restricted watch tests |
| Logs disappeared after pause, resume or tab visibility changes | Own the buffer by session/source identity; stop and resume polling independently. | native log polling browser regression |
| Node Pod counts remained stale after Pod updates | Include the Pod count map in memoized column dependencies. | live table regression |
| Split tables shared search and cleared it on mount | Store search controls by workspace tab and remove them on tab close. | independent split search regression |
| Custom kinds could select built-in detail renderers | Resolve renderers and explicit references using API group plus kind. Preserve dependency navigation in specialized Gateway and autoscaler details. | kind collision, reference isolation and catalog navigation tests |

## Structural changes

- Extract table columns, data derivation, column layout, cells, action handlers and resource creation from `ResourceView` (1960 to 1020 lines).
- Extract log and terminal session panes from `BottomDock` (1196 to 577 lines).
- Keep mutation construction in the backend with typed actions and structured review data. Model prepared operations as an enum, rather than combinations of optional flags.
- Separate native reads, drain orchestration, batch preparation, review models and action preparation. Share terminal IPC batching and acknowledgement handling.
- Inject read transports, cache parsed kubeconfig outside the async executor, and build topology relationships in a worker with bounded pending snapshots.
- Add a registry for bundled workspace panels, including context identity, retained tabs, visibility and unavailable-extension handling. See [Workspace extensions](EXTENSIONS.md).
- Start the development server automatically for browser tests and run those tests in CI.

The panel registry is the initial extension boundary. Redis and Kafka clients, third-party package installation, a versioned external SDK and isolation of untrusted plugins remain separate implementation work.
