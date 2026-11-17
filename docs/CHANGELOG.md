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

- Refined Helm Overview layout and density to match the application's overview cards, with a compact header strip, uniform card surfaces, monospace summary metrics, evenly distributed inventory facts, aligned namespace and chart panels, and single-line release change rows.
- Updated the project website with bundled JetBrains Mono Variable display typography, concise Hero copy with `#download` anchor links, a unified FAQ and Get Kubiki constellation closing band with smooth section gradients, reordered MCP topology and resource workbench sections without redundant labels, keyboard and triage workflow bars, and a non-scrolling interactive Pod inspector card.

### Fixed

- Allow direct Helm upgrade, rollback and uninstall for Flux-managed releases while preserving backend confirmation.
- Resolve explicitly requested served CRD API versions even when a more stable version exists, and match Flux Helm storage namespaces correctly.

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
