# Project structure and architecture

Kubiki is a desktop Kubernetes workspace built with React 19, TypeScript, Tauri 2, and Rust. This document maps the source modules to their runtime responsibilities. See the [README architecture section](../README.md#architecture) for the component diagram and application-level data flow.

## Contents

- [Repository layout](#repository-layout)
- [Frontend](#frontend)
- [Desktop shell](#desktop-shell)
- [Kubernetes engine](#kubernetes-engine)
- [Resource synchronization](#resource-synchronization)
- [Resource mutations](#resource-mutations)
- [Diagnostic sessions](#diagnostic-sessions)
- [Development tooling and tests](#development-tooling-and-tests)
- [Documentation and assets](#documentation-and-assets)

## Repository layout

```text
kubiki/
├── src/                        React interface, providers, state, resource logic
├── src-tauri/                  Tauri desktop shell and Rust IPC handlers
├── crates/
│   └── kubiki-core/            Rust Kubernetes engine
├── shared/                     Shared resource type registry
├── server/                     Local frontend development and test bridges
├── tests/                      Frontend unit, contract, and interface tests
├── docs/                       Documentation and screenshots
├── public/licenses/            Bundled font licenses
└── .github/workflows/          Verification and release packaging
```

## Frontend

The frontend is a React 19 and TypeScript application. Tailwind CSS and application styles define the interface. Monaco provides the YAML editor, React Flow and ELK provide topology rendering and layout, and xterm.js renders terminal sessions.

### Views and navigation

| Module | Responsibility |
| --- | --- |
| `src/views/OverviewView.tsx` | Cluster overview, workload health, metrics, and problems. |
| `src/views/ResourceView.tsx` | Resource inventory, filtering, sorting, selection, and actions. |
| `src/views/YamlEditor.tsx` | Manifest editing, formatting, full and clean document views, and apply actions. |
| `src/views/TopologyView.tsx` | Topology data preparation and workspace integration. |
| `src/views/TopologyCanvas.tsx` | Interactive graph presentation. |
| `src/views/HelmView.tsx` | Release and repository navigation, release inspection, and action entry points. |
| `src/navigation/CommandPalette.tsx` | Search and navigation across commands and resource types. |

`src/components/layout/` contains the explorer, workspace, tabs, inspector, and bottom panel. `src/components/k8s/details/` contains resource-specific detail views and reusable field blocks. Dialogs and diagnostic panes live under `src/components/dialogs/` and `src/components/k8s/`.

### Application state

Zustand stores separate workspace state from cached Kubernetes data and session state.

| Module | Responsibility |
| --- | --- |
| `src/state/cluster_store.ts` | Available contexts, active context, namespace scope, and discovered resource availability. |
| `src/state/resource_store.ts` | Resource cache and synchronization state consumed by views. |
| `src/state/resource_watch.ts` | Starting, stopping, refreshing, and rescoping resource watch sessions. |
| `src/state/workspace_store.ts` | Workspace tabs, split panes, and resource navigation. |
| `src/state/dock_store.ts` | Bottom-panel sessions and selection. |
| `src/state/ui_store.ts` | Appearance, layout preferences, and interface settings. |
| `src/state/yaml_draft_store.ts` | In-memory editor drafts keyed by context and resource identity. |
| `src/state/mutation_confirm_store.ts` | Pending native mutation confirmation requests. |
| `src/state/pf_store.ts` | Port-forward session state. |

### Providers and resource logic

`src/providers/contract.ts` defines the common resource access interface. `k8s_provider.ts` selects the transport, and the desktop application calls native commands through Tauri. Dedicated transports handle watches, logs, exec sessions, and forwarding.

`resource_watch_session.ts` manages frontend subscription state. `tauri_watch.ts` creates Tauri channels, checks subscription identity, and requests native cleanup when a watch closes. `errors.ts` normalizes backend failures for the interface.

`src/core/resources/` contains resource identity, namespace scoping, relationship inference, diagnostics, quantity parsing, topology preparation, and presentation logic. `shared/resource-types.json` supplies the resource registry used by frontend code and local tooling. API discovery supplements the registry with information from the selected cluster.

## Desktop shell

`src-tauri/tauri.conf.json` defines the application identity, window, frontend build commands, and native package configuration. `src-tauri/src/main.rs` starts the application; `src-tauri/src/lib.rs` initializes backend managers, registers commands, and arranges session cleanup when a window is destroyed.

| Command module in `src-tauri/src/` | Responsibility |
| --- | --- |
| `k8s_commands.rs` | Contexts, namespaces, resource reads, discovery, and overview metrics. |
| `watch_commands.rs` | Native resource watch subscriptions and Tauri channel delivery. |
| `mutation_commands.rs` | Preparation and execution of supported resource and Helm changes. |
| `mutation_guard.rs` | Pending confirmation requests, desktop review events, and approval resolution. |
| `helm_commands.rs` | Helm release, history, content, repository, and chart search reads. |
| `log_commands.rs` | Container log session lifecycle and stream delivery. |
| `terminal_commands.rs` | Interactive Pod exec sessions, input, resizing, and cleanup. |
| `host_terminal_commands.rs` | Local shell sessions backed by a pseudo-terminal. |
| `node_commands.rs` | Node debug preparation and exec sessions. |
| `port_forward_commands.rs` | Starting, listing, and stopping TCP forwards. |
| `graphics.rs` | Linux graphics runtime initialization and diagnostics. |

The desktop shell owns transport and application lifecycle concerns. Kubernetes request logic and reusable session managers reside in `kubiki-core`.

## Kubernetes engine

`crates/kubiki-core/` is the Rust library used by the desktop backend. It uses Tokio for asynchronous work and the `kube` library for Kubernetes API access.

| Source directory | Responsibility |
| --- | --- |
| `src/cluster/` | Kubeconfig reading, multi-file configuration, contexts, namespace access, and client pooling. |
| `src/informer/` | Resource snapshots, watch streams, deltas, and reconciliation. |
| `src/core/` | Shared API errors, resource operations, mutation preparation, events, and Secret data handling. |
| `src/crd/` | API and custom resource discovery and dynamic resource access. |
| `src/metrics/` | Metrics API requests and overview aggregation. |
| `src/pod_ops/` | Logs, Pod exec, node debug sessions, host terminals, and port forwarding. |
| `src/helm/` | Helm models, bounded reads, and reviewed lifecycle operations. |

`src/cluster/kubeconfig.rs` reads the default kubeconfig or the files listed in `KUBECONFIG`. `src/cluster/client.rs` provides context-specific clients so requests can remain tied to the selected context.

`src/informer/watcher.rs` implements the informer manager, while `store.rs`, `delta.rs`, and `reconcile.rs` implement snapshot storage and update handling. Helm subprocess handling lives in `src/helm/reader.rs`; operation preparation and execution live in `src/helm/mutations.rs`.

The crate also contains `src/bin/kubiki-cli.rs`, an inspection utility that reuses the library. The desktop application does not depend on that executable.

## Resource synchronization

The frontend starts resource subscriptions for the active context and namespace scope. Each subscription identifies its query and receives batches through a Tauri channel.

The Rust informer layer maintains resource snapshots and processes Kubernetes watch changes. The frontend watch session applies the resulting batches to the resource store. Components subscribe to that store to render the current resource state.

Changing the context stops the old frontend session before starting another. Namespace selection updates subscription scope. The transport checks subscription and query identity before delivering a batch, preventing a closed subscription from updating an unrelated view.

Custom resources use the discovery and dynamic access modules. Resource types and available operations depend on the APIs advertised by the cluster and on the active identity's permissions.

## Resource mutations

Resource actions enter the native backend through the mutation command module. Supported operations are represented as structured requests rather than arbitrary shell commands.

The core mutation implementation prepares the requested change against live resource state. For existing objects, it records identity and concurrency information and produces a review. The desktop guard emits a confirmation request to the frontend and waits for the user's decision.

After approval, the backend commits the prepared operation with the applicable identity and resource-version checks. Kubernetes remains responsible for authorization, admission, and API validation. Grouped actions are prepared for a shared review and committed sequentially; a group is not an atomic cluster transaction.

Helm operations have a separate preparation implementation. They invoke the local Helm executable with the selected context, and changes to an existing release are checked against the state used during preparation.

## Diagnostic sessions

Logs and terminals use dedicated managers and streaming command interfaces. Input, resize events, stream acknowledgements, and close operations have explicit commands rather than sharing the resource watch channel.

Pod terminals and logs communicate through the Kubernetes API. Node shells prepare debug Pods and then attach an exec session. Host terminals allocate local pseudo-terminals through `portable-pty`.

Port forwarding opens a loopback TCP listener and connects it to the selected Pod through the Kubernetes API. Service forwarding resolves a matching running Pod and translates the selected Service port to its target port.

Managers track session ownership by desktop window. The window destruction handler stops its watches, terminals, logs, debug sessions, and forwards.

## Development tooling and tests

The installed application loads the built frontend and uses Tauri commands. `server/k8s_bridge.ts` and `server/helm_bridge.ts` provide read-only local access for frontend development and browser-driven checks. They are connected to the Vite development server and invoke local `kubectl` and `helm` executables. In-memory fixtures live in `src/providers/mock/`.

Frontend checks and tests are configured through `package.json`, the TypeScript project files, Vitest, and `playwright.config.ts`. Rust tests live within the library modules and under `crates/kubiki-core/tests/`.

The CI workflow checks TypeScript, frontend tests and builds, Rust core tests, and desktop backend compilation. The release workflow packages the desktop application for Linux, macOS, and Windows. See the [README build instructions](../README.md#building-and-verification) for local commands.

## Documentation and assets

`docs/media/` contains the screenshots used by the README: overview, resources, YAML, topology, and Helm. Native application icons are stored in `src-tauri/icons/`.

Font license notices are stored in `public/licenses/`. The project's own license is defined in the root `LICENSE` file.
