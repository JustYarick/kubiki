# Changelog

All notable user-facing changes to Kubiki are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Maintenance rules

- Record new work under `## [Unreleased]` as tasks and fixes land; do not assign a release version prematurely.
- Only stable releases (`vX.Y.Z`) get their own versioned sections. Dev releases (`-dev.NUMBER`) and other prereleases are not listed separately and remain under `## [Unreleased]` until the next stable release.
- Group entries under the standard Keep a Changelog headings: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security` (omit empty sections).
- When cutting a stable release `vX.Y.Z`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty `## [Unreleased]` section at the top, and update the comparison links at the bottom of this file.

## [Unreleased]

### Added

- Native ARM64 desktop release builds for Linux (`aarch64-unknown-linux-gnu`: DEB, RPM, AppImage on `ubuntu-24.04-arm`) and Windows (`aarch64-pc-windows-msvc`: NSIS EXE on `windows-11-arm`) with full updater manifest and website download support.
- Automatic update checks across all desktop packages: macOS (ARM64/Intel), Windows (x64 NSIS/MSI, ARM64 NSIS), and Linux x64/ARM64 AppImage/DEB support verified in-app updates, while Linux RPM packages check the signed channel feed in notify-only mode with changelog notes and a direct link to the GitHub Release page.
- Automatic `## [Unreleased]` release summaries for `dev` preview releases (`vX.Y.Z-dev.N`) in both GitHub Releases and in-app updater manifests (`latest.json`), while keeping `docs/CHANGELOG.md` versioned strictly by stable `main` releases.
- Consolidated reusable adaptive UI/UX primitives under `src/components/ui` (`index.ts`, `DataTable`, `Badge`, `CountPill`, `Textarea`, `Field`, `FieldGroup`, `SectionCard`, `EmptyState`, `KeyValueList`, upgraded `Input`/`SearchInput`/`Button`/`Select`/`Checkbox`) and migrated ad-hoc search inputs, dialogs, and secondary tables across the workspace to use them.
- Actionable `accessHints` and `aiInstruction` guidance in MCP policy denials so AI clients tell the user which Kubiki setting blocked access (`Annotations`, `Custom resources`, `Helm release values`, `Secrets`, etc.) and where to enable it.
- Fast direct Kubernetes Secret/ConfigMap storage reads for Helm release inventory, revision history, and release documents (`Values`, `Manifest`, `Hooks`, `Notes`) over the warm `kube::Client` (with Kubernetes `(context, uid, resourceVersion)` MVCC caching, concurrent revision-read coalescing, and transparent fallback to the `helm` CLI).
- Target/pinned Node resolution for unscheduled Pending Pods (DaemonSet `nodeAffinity` `matchFields: metadata.name`, `kubernetes.io/hostname` affinity/`nodeSelector`, and preemption `nominatedNodeName`) in the Pods table, Pod details (including a clickable `Target node` link and rendered `Node Affinity` / `Pod Affinity` / `Pod Anti-Affinity`), Workload child pods, Node details (`Pending pods targeting this node`), resource search, topology/neighborhood graphs, and MCP (`diagnose_resource`, `cluster_info(problems)`, `list_resources(health)`, and `summarize_resources(groupBy: "nodeName")`).
- MCP Resources (`kubiki://session/info`, `kubiki://evidence/{id}`) and built-in debugging Prompts (`investigate-resource`, `triage-namespace`, `debug-node-pressure`, `debug-rollout-regression`) alongside accurate MCP `serverInfo` and `ToolAnnotations`.
- Dedicated `helmValues` policy toggle separating Helm release chart values (`helm action=values`) from custom resource defaults, while keeping metadata-only release listings (`helm action=list`) and multi-revision storage conflict diagnostics (`helm action=storage`) available without Secret access.
- Cross-namespace `namespace: "*"` support in `list_resources`, `summarize_resources` (including `groupBy: "reason"`), and `get_events` (`raw` and `timeline` modes), plus `cluster_info` (`session`, `namespaces`, `catalog`, `problems`) triage, `diagnose_resource` sections (`config`, `diff`, `metrics`, describe-equivalent Pod fields, Node events), `propose_manifests` optional `dryRun` validation, and `topPodsByCpuRequest` on Node metrics.
- Expanded `diagnostic` CRD field projections for Argo CD (`Application`, `ApplicationSet`, `Rollout`), `cert-manager.io`, Gateway API, and KEDA, with automatic Flux served API version resolution (`v2`/`v2beta2`/`v2beta1`, `v1`/`v1beta2`/`v1beta1`).
- MCP cluster selection per HTTP profile and named standalone connections with independent scope and policy.
- Incident diagnostics for nominated Pod nodes, Flux conditions, node grouping, cross-namespace Events, Helm storage checks and client-side chart previews.
- Historical Pod and Node CPU/memory reads from session observations or a configured Prometheus service.

- Developer-mode Application Logs with filtered, virtualized frontend/native events, correlated Kubernetes API request metadata, structured console/stderr output, bounded private JSONL rotation and export. Capture excludes request/response contents and credentials, reports drops and sink failures, and stops when Developer mode is disabled.

- Cluster-wide Helm Overview with release metrics, status distribution, namespace health, chart versions, recent changes and explicit snapshot freshness, independent of the namespace filter. Counts open the shared typed release table with matching filters; the table supports column sorting, layouts and virtualization. Overview navigation uses the common dashboard icon.
- Flux Kustomization and HelmRelease reconciliation actions alongside the existing reset-and-retry action for exhausted HelmRelease attempts.
- MCP Pod/Node CPU and RAM usage with requests, limits, capacity, allocatable and explicit coverage for bounded Node reservations.
- Diagnostic-only CRD access for selected Flux and external-secrets fields without exposing chart values or provider credentials; existing saved access levels remain unchanged.
- MCP Event type, reason and time-window filters, and explicit explanations when requested resource fields are denied.
- Overview warnings for high per-Node memory usage and Secret reference states distinguishing observed metadata, missing resources and unavailable access.
- MCP Event reads can filter by involved resource UID and continue through bounded pages.
- MCP logs support exact-line snapshot pages, literal substring filtering and RFC3339 time windows alongside the existing diagnostic output.
- React project website with a pipeline that builds static assets, commits them to `gh-pages` and deploys them to GitHub Pages.
- Dark website with recorded WebM/MP4 workspace animations, interactive diagnostics/topology/YAML/MCP policy previews, responsive WebP posters and platform-aware direct downloads from the latest stable GitHub release.

### Changed

- Enabled HTTP `gzip` response compression across all `kube` clients, switched non-CRD resource watchers and unbounded reads to Kubernetes apiserver watch-cache lists (`resourceVersion=0`), streamed `Secret` and `ConfigMap` tables via server-side `Table` + `PartialObjectMetadata` watches with on-demand single-object hydration when inspecting or editing, prioritized active-tab watches over background CRD/inspector/sidebar-count probes, skipped ESO/VSO origin lookups for Helm/service-account Secrets, and filtered out superseded Helm revisions during fast release inventory reads.
- Consolidated the MCP tool catalog from 32 fragmented tools into 19 universal, orthogonal tools (15 read/inspection tools + 4 write tools: `cluster_info`, `diagnose_resource`, `get_events`, `helm`, `gitops`, etc.) and enabled concurrent read execution, shared discovery caching, and background Argo CD/Flux capability detection on external MCP sessions.
- Expanded `get_logs` tail ceiling to 5000 lines, added `ignoreCase` and `contextLines` in `lines` mode, and broadened diagnostic log error pattern matching (klog, logfmt, JSON severity, network/TLS/OOM failures).
- Refined Helm Overview layout and density to match the application's overview cards, with a compact header strip, uniform card surfaces, monospace summary metrics, evenly distributed inventory facts, aligned namespace and chart panels, and single-line release change rows.
- Updated the project website with bundled JetBrains Mono Variable display typography, concise Hero copy with `#download` anchor links, a unified FAQ and Get Kubiki constellation closing band with smooth section gradients, reordered MCP topology and resource workbench sections without redundant labels, keyboard and triage workflow bars, and a non-scrolling interactive Pod inspector card.

### Removed

- Removed the unused standalone `kubiki-cli` binary from `crates/kubiki-core` and desktop release builds.

### Fixed

- Fixed virtualized resource table scroll jumping when rows are added, removed, or reordered, recognized static Flux OCI `HelmRepository` objects as `Ready` instead of `Not reported`, disabled WebKit/macOS spelling autocorrection across all text input fields, restored the CronJob `Schedule` table column, and eliminated O(N²) scans in workload Pod matching, GitOps relationship resolution, Helm diagnostic descendant traversal, and Event/hook lookups on large clusters.
- Propagated shared `schemaVersion`, `ruleResolution`, and `allowedFields` into effective Kubiki Agent policies, cleared per-rule writes in MCP `Clear writes` and blank read-only profile creation, corrected the manual OpenCode JSON snippet to use `disabled: false`, fixed `summarize_resources` evidence persistence, and cleaned up HTTP MCP peer/subscription tracking and session pruning.
- Desktop Pod tables fetch their initial inventory in one collection request per scope. Sidebar counts skip duplicate probes while a covering watch initializes.

- Pod requests remain visible without usage samples. Pending Pod summaries include scheduler placement details.
- Resource name filters disable spelling corrections. Ready watch snapshots appear immediately and idle status sorting skips an initial table scan.

- Limit Pod Environment tab Secret status notices to unresolved or restricted `env`/`envFrom` references while moving volume Secret availability indicators to Pod `Overview` and `Related`.
- Allow direct Helm upgrade, rollback and uninstall for Flux-managed releases while preserving backend confirmation.
- Resolve explicitly requested served CRD API versions even when a more stable version exists, and match Flux Helm storage namespaces correctly.

### Security

- Made `secrets: none` a hard policy ceiling that blocks all Secret reads and `list_resources` membership/label oracles before any Kubernetes API call, even when wildcard rules exist.
- Fixed `RuleResolution::DenyOverrides` to enforce minimum `DataAccess` and write-set intersection across all matching rules, added wildcard `*` support to `deniedPaths` scrubbing, scrubbed probe `httpHeaders[].value` when `workloadConfiguration` is disabled, and broadened sensitive key redaction without breaking Kubernetes volume Secret references.
- Hardened `apply_manifest` checks to cover `serviceAccount`, `runAsUser: 0`, `shareProcessNamespace`, `procMount`, `Unconfined` seccomp, `Ingress` TLS secrets, `imagePullSecrets`, ephemeral containers, and legacy volume Secret references.
- Hardened MCP transports with constant-time attached bridge token checks, `reject_remote_clients(true)` on Windows named pipes, HTTP/1 header read timeout, `503` backpressure, `WWW-Authenticate: Bearer` on `401`, private `0o700` standalone journal directories, and 1 MiB `--connections` size limits.

## [1.4.0] - 2026-11-17

### Added

- Loopback Streamable HTTP MCP server (`kubiki-mcp` and desktop lifecycle manager) with dynamic cluster/namespace scope rebinding, optional bearer-token authentication, and client config integration.
- System terminal launch mode for external AI agents (OpenCode, Codex, Claude Code) alongside the embedded terminal pane.
- Unified MCP access profiles (`mcpProfiles`), dedicated MCP Access settings, and a title-bar MCP quick-control popover with Plan/Action profile bindings.
- Metadata-only Kubernetes list reads, background detail prefetching, and Master Search inventory support for custom resources.
- Repository-wide `AGENTS.md` guide and refreshed README screenshots/GIFs including an AI agent demo.

### Changed

- Separated MCP tool and data-access configuration from AI provider/runtime settings in the Settings dialog.
- Consolidated the quick MCP control into the title-bar popover and removed the duplicate bottom status-bar indicator.
- Excluded Pod two-hop owners from direct Topology graph demand.

### Fixed

- Restore extension panel JavaScript under the desktop Content Security Policy without permitting arbitrary inline scripts in the main window.
- Load Secret contents when opening Pod Environment after metadata prefetch, and retain crash/image-pull statuses in Master Search before opening resource tables.
- Generate valid OpenCode V2 configurations during MCP client auto-configuration.
- Retain partial namespace data and surface partial-scope errors on forbidden (`403`) or failed namespace reads instead of discarding accessible namespaces, while propagating cancellations.
- Cancel in-flight MCP reads on scope rebind and invalidate evicted HTTP MCP sessions when exceeding the active session cap.
- Format container log local timestamps cleanly without redundant timezone offsets or nanoseconds.
- Preserve working directory across shell startup scripts in the host terminal and improve Unix `PATH` recovery.
- Use the CRD plural name in custom resource table filter placeholders, improve Helm/watch/terminal diagnostics, and resolve platform-specific build issues on macOS and Windows.

### Security

- Prevent prompts from being interpreted as shell commands by the Windows system-terminal fallback.
- Keep MCP client configuration files private on Unix when replacing credentials-bearing configurations.
- Remove inherited per-resource write grants from generated Read-only MCP profiles and repair unchanged legacy presets.

## [1.3.1] - 2026-11-12

### Added

- Pass initial prompts to external AI agents and enforce Plan mode by default.

### Changed

- Align AI chat UI and planning workflow with Markdown plans and graceful handling of unoffered plan tools.
- Make release VirusTotal antivirus reports advisory rather than publication-blocking.

### Fixed

- Security audit remediation, chat metrics cleanup, and terminal agent prefill fixes.
- Disable Spotlight indexing on macOS during DMG bundling to avoid `hdiutil` resource-busy failures.

## [1.3.0] - 2026-11-08

### Added

- Integrated AI Agent (`kubiki-ai`) with provider/model settings, streaming Markdown chat, `<ThinkingBlock />` extraction, Plan/Action phases, interactive `ask_user` question cards, conversation SQLite persistence, and full-text history search.
- Portable Kubernetes diagnostic and investigation tools (`kubiki-tools`) covering Pod/workload/event-timeline diagnostics, GitOps (Helm, ArgoCD, Flux) cluster auto-detection, scoped queries, and mandatory post-mutation verification.
- Embedded and standalone `kubiki-mcp` server along with OpenCode/external-agent terminal host integration, skills, and live MCP permissions synchronization.
- Master Search with field filters and isolated regex, continuous Pod and Node performance history charts, container attach with mutation guard, terminal search addon, and terminal background settings.
- Workbench perspective panels with bottom dock integration for Explorer, Topology, and AI Agent.

### Changed

- Replaced legacy terminal analysis with the integrated AI Agent and unified **Investigate with AI** entry points.
- Grouped AI permissions, read confirmation settings, and simplified execution controls across chat and settings.
- Improved relation hierarchies, grouped kind collapsing, namespace selection, and table search persistence across tab switches.

### Fixed

- Unified terminal rendering and capabilities across host PTY, Pod exec, and Node shells, and resolved full-screen external agent fitting.
- Waited for complete inputs before initial Topology layout and removed inventory counts from the namespace chooser.
- Stabilized column reordering/resizing, Pod environment variable resolution, provider error reporting, and hidden telemetry chart states when metrics are unavailable.

### Security

- Rechecked revocable authorization right before executing mutations and enforced tool consent, bounded evidence, and access policies in the agent runtime.

## [1.2.0] - 2026-10-28

### Added

- Pod **Environment** inspector tab with secret masking, drift detection, and adaptive container switching for sidecars.
- Persistent table column layouts, exclusion filters, and status sorting scoped to visible rows.
- Virtualized log viewer with local timestamps, persistent display preferences, and configurable poll/watch modes.
- Lightweight `limit=1` metadata resource counts, in-memory radar counts, and a 9,000-pod mock scale cluster profile.

### Changed

- Filtered Overview events to warnings/errors while keeping full event streams for targeted inspection.
- Excluded superseded Helm revisions from inventory and reduced eager cluster-wide demand in Helm and Topology views.
- Stripped `metadata.managedFields` on reads and watches while preserving server fields on mutations.

### Fixed

- Scoped Related resources to inspected namespaces, fixed Flux tenant RBAC, and stopped unbounded shared dependency expansion.
- Prevented column drag-and-drop from blocking resize handles, preserved nested JSON log payloads, and kept live sessions intact across namespace inventory updates.

## [1.1.0] - 2026-10-26

### Added

- Manifest creation through reviewed manifests and live GitOps dashboards with Helm diagnostics.
- Rich Developer-mode demo fixtures when kubeconfig is unavailable.
- Global rendering/performance settings for Topology (including flat layouts), plus persistent log, editor, and port-forward preferences (including automatic browser launch).
- Advisory VirusTotal release scanning in the release workflow.

### Changed

- Simplified Overview resource summaries and usage charts, and collected startup inventory on demand.
- Configured display of `managedFields` in clean YAML views.

### Fixed

- Restored the last selected cluster on startup and recovered login-shell `PATH` on macOS.
- Kept the bottom dock clear of the inspector and improved node metrics and resource table layout.
- Updated DOMPurify, TLS verification, and vendored GLib dependencies.

## [1.0.1] - 2026-10-25

### Added

- Custom kubeconfig path configuration in Settings and Kubiki branding assets.

### Changed

- Removed the 1,000-edge limit in Topology view and unified CI/release builds with isolated dev update feeds.

### Fixed

- Preserved server fields when applying changes from clean YAML views.
- Fixed Windows release runner dynamic imports (`pathToFileURL`).

## [1.0.0] - 2026-10-25

### Added

- Headless Rust Kubernetes engine (`kubiki-core`) with informers, Pod exec, Node debug shells, local host PTY terminals, container log streaming, live port forwards, Helm browsing/operations, CRD discovery, and live CPU/RAM telemetry.
- Desktop Tauri v2 shell and JetBrains-style React/TypeScript workbench with multi-tab dock, DataGrip-inspired resource tables, floating resource details, Overview dashboard, and Topology graph.
- Guarded Kubernetes mutations with native backend confirmation and single-confirmation batch mutations.
- Local extension platform (`@kubiki/extension-sdk`) with sandboxed extension panels, settings, and Node host runtime.
- Desktop auto-updater with signed update feeds and Apache-2.0 licensing.

[unreleased]: https://github.com/JustYarick/kubiki/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/JustYarick/kubiki/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/JustYarick/kubiki/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/JustYarick/kubiki/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/JustYarick/kubiki/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/JustYarick/kubiki/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/JustYarick/kubiki/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/JustYarick/kubiki/releases/tag/v1.0.0
