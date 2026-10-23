# Kubiki

Kubiki is a desktop application for inspecting and managing Kubernetes clusters. It combines resource browsing, workload diagnostics, YAML editing, resource topology, Helm management, logs, terminals, and port forwarding in a single workspace.

## Contents

- [Purpose and capabilities](#purpose-and-capabilities)
- [Screenshots](#screenshots)
- [Installation](#installation)
- [Connecting to a cluster](#connecting-to-a-cluster)
- [Working with Kubiki](#working-with-kubiki)
  - [Resources and workload health](#resources-and-workload-health)
  - [YAML editing](#yaml-editing)
  - [Resource topology](#resource-topology)
  - [Helm releases](#helm-releases)
  - [Logs and terminals](#logs-and-terminals)
  - [Port forwarding](#port-forwarding)
  - [Reviewing changes](#reviewing-changes)
- [Architecture](#architecture)
  - [Components](#components)
  - [Data flow](#data-flow)
- [Building and verification](#building-and-verification)
  - [Build requirements](#build-requirements)
  - [Running from source](#running-from-source)
  - [Building desktop packages](#building-desktop-packages)
  - [Verification commands](#verification-commands)
- [Repository structure](#repository-structure)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [License](#license)

## Purpose and capabilities

Kubiki provides a local workspace for day-to-day Kubernetes administration and investigation. The interface runs in a native desktop window, while a Rust backend connects to the Kubernetes API using credentials from the user's kubeconfig. Helm operations use the locally installed Helm executable.

The application supports switching between kubeconfig contexts and selecting one or multiple namespaces. Resource views, detail panels, YAML documents, and diagnostic sessions can remain open in tabs and split panes.

| Area | Capabilities |
| --- | --- |
| Cluster navigation | Kubeconfig context selection, namespace scoping, API discovery, and custom resource browsing. |
| Resource inspection | Filterable resource tables, configurable columns, metadata, conditions, ownership, events, and references to related objects. |
| Workload diagnostics | Pod and container status, restarts, warning events, and CPU and memory metrics where the cluster exposes them. |
| YAML workspace | Live manifests, clean and full document views, formatting, change review, and drafts retained while navigating within the application session. |
| Topology | Interactive resource relationships, workload ownership, Service connections, Ingress routes, and event context. |
| Helm | Release inventory, revision history, values, manifests, notes, chart search, repository management, installation, upgrades, rollback, and uninstallation. |
| Diagnostic sessions | Streaming container logs, interactive container shells, node debug shells, and local host terminals. |
| Network access | TCP port forwarding to Pods and Services, with active sessions managed in the bottom panel. |
| Cluster changes | YAML updates, scaling, rollout restarts, deletions, and other supported resource actions with confirmation and concurrency checks. |

Kubiki also discovers resources from installed extensions, including Gateway API, Flux, and Argo CD. The available resource types depend on the APIs installed in the selected cluster and the permissions of the active Kubernetes identity.

## Screenshots

### Cluster overview

The overview brings together cluster health, capacity, workload metrics, recent events, and detected problems.

![Cluster overview with health indicators, resource metrics, and events](docs/media/overview.png)

### Resource inspection

Resource tables and detail panels expose workload state, container information, conditions, and related objects.

![Resource inventory and the details of a selected workload](docs/media/resources.png)

### YAML workspace

The manifest editor can be opened alongside resource views to inspect and modify the selected object.

![YAML editor displayed alongside the resource workspace](docs/media/yaml.png)

### Topology graph

The topology view displays relationships between workloads, networking resources, and their dependencies.

![Interactive topology of Kubernetes resources and their relationships](docs/media/topology.png)

### Helm workspace

The Helm workspace provides release inspection, revision history, values, and manifests.

![Helm release workspace with release details and revision information](docs/media/helm.png)

## Installation

Download the installer for your operating system from [GitHub Releases](https://github.com/JustYarick/kubiki/releases).

The desktop release workflow targets the following platforms and package formats:

| Operating system | Architecture | Packages |
| --- | --- | --- |
| Linux | x86_64 | Debian package (`.deb`) and AppImage (`.AppImage`). |
| macOS | Apple Silicon (aarch64) | Disk image (`.dmg`). |
| Windows | x86_64 | Windows Installer (`.msi`) and NSIS installer (`.exe`). |

On Linux, install the Debian package using the system package manager, or make the downloaded AppImage executable and launch it. On macOS, open the disk image and copy Kubiki to Applications. On Windows, run the installer.

Before connecting to a cluster, prepare:

- A kubeconfig containing the required cluster contexts and credentials.
- Network access to the Kubernetes API endpoint specified in that kubeconfig.
- Any authentication executables referenced by the kubeconfig, available on the application's `PATH`.
- The `helm` executable on `PATH` if you intend to use Helm features.

Desktop Kubernetes reads, watches, logs, exec sessions, and port forwarding use the Rust Kubernetes client. These operations do not require a local `kubectl` executable.

## Connecting to a cluster

1. Place your kubeconfig at `~/.kube/config`, or set `KUBECONFIG` in the environment from which Kubiki is launched. On Windows, the default location is `%USERPROFILE%\.kube\config`.
2. If `KUBECONFIG` lists several files, separate their paths with `:` on Linux and macOS or `;` on Windows. The backend merges their contexts when reading the configuration.
3. Launch Kubiki and select a context from the cluster selector.
4. Select the namespace or namespaces to inspect. Use the all-namespaces scope when appropriate for your access level.
5. Open a resource category in the explorer, then select an object to inspect its details. Open the overview or topology to investigate cluster health and resource relationships.

Authentication follows the selected kubeconfig context. Kubernetes RBAC and admission policies govern the requests made by the application. CPU and memory usage require the cluster metrics API and permission to read its resources.

## Working with Kubiki

### Resources and workload health

Use the explorer to navigate workloads, configuration, networking, storage, access control, nodes, namespaces, and events. Additional categories expose supported extension APIs and custom resources.

Filter and sort resource tables to narrow the current inventory. Select an object to inspect its metadata, status, conditions, events, and related resources. Follow resource references to move between owners, workloads, Services, and dependent objects.

The overview summarizes cluster state and highlights workload problems. Resource views receive live updates through native Kubernetes watches. Changing context or namespace scope updates the subscriptions used by the workspace.

### YAML editing

Open the YAML view for an existing resource to inspect or edit its manifest. The editor provides syntax highlighting, search and replace, formatting, copying, and downloading.

The default document view omits `status` and `metadata.managedFields` to make editable configuration easier to read. Switch to the full document view when those fields are needed. Unsaved drafts are associated with the context and resource identity and are retained when navigating within the current application session.

To apply a change:

1. Edit the manifest while preserving the resource identity.
2. Select Apply or press `Ctrl+S` on Linux and Windows, or `Cmd+S` on macOS.
3. Review the proposed change in the confirmation dialog.
4. Confirm the operation and inspect the resulting resource state.

The frontend parses YAML and checks the resource name and kind before submission. The backend checks the resource identity and version before committing the update; the Kubernetes API validates the submitted object.

### Resource topology

Open the cluster topology from the activity bar, or open a topology focused on a resource or Helm release. Use the graph to follow workload ownership, Service selectors, routing connections, and other supported relationships.

Select graph nodes to inspect the corresponding resources. The topology includes event context and visibility controls for focusing on relevant objects. Its relationships are derived from Kubernetes resource data; it is a dependency view rather than a network traffic capture.

### Helm releases

Open Helm in the explorer to browse releases in the selected context and namespace scope. Select a release to inspect its status, chart, revision history, values, generated manifests, and notes.

Use the release actions to install a chart, upgrade a release, roll back to a previous revision, or uninstall it. Repository management and chart search use the local Helm configuration. Operations affecting a cluster are pinned to the context selected in Kubiki.

Helm changes are prepared for review before execution. Existing releases are checked again after confirmation so that a change in release state can invalidate an outdated review.

### Logs and terminals

Open logs from a Pod and select the container to inspect. Log sessions stream into the bottom panel and remain separate from resource inspection tabs.

Container terminals connect to the selected Pod through the Kubernetes exec API. A local host terminal runs a shell on the machine where Kubiki is installed. Node shells prepare a debug Pod for the selected node and require the corresponding cluster permissions and admission policy support.

Sessions can be managed from the bottom panel. Closing the desktop window stops its tracked watches, log streams, terminals, and port-forward sessions.

### Port forwarding

Start port forwarding from a Pod or Service, select the remote TCP port, and specify a local port. Leave the local port empty or use `0` to allocate a free port automatically.

The listener binds to `127.0.0.1`. Open the forwarded address locally and stop the session from the bottom panel when it is no longer needed. A Service forward resolves a matching running Pod and maps the Service port to its target port.

### Reviewing changes

Resource changes pass through a backend preparation and confirmation flow. The dialog identifies the target and describes the proposed operation. Manual YAML edits include a complete review of the changes. Built-in actions show the operation, its parameters, every target, and relevant warnings. Secret and ConfigMap data edits list changed key names without exposing their values in the confirmation. Batch reviews retain every step; operations whose complete review exceeds the size limit are rejected rather than truncated.

For existing Kubernetes objects, mutation checks use the object identity, UID, and resource version to detect replacement or concurrent edits. If the target changes during review, refresh the resource and review the operation again. Grouped actions share a review and execute their steps sequentially; they are not Kubernetes transactions.

Interactive shell commands execute in their respective shell sessions. They are separate from the confirmation flow used for resource actions in the interface.

## Architecture

Kubiki separates the desktop interface, native command handling, and Kubernetes operations. Tauri hosts the frontend in a system WebView and exposes Rust commands and streaming channels to the interface.

```mermaid
flowchart TB
    subgraph Desktop["Kubiki desktop application"]
        subgraph Frontend["Frontend: React 19 and TypeScript"]
            Views["Resource views, YAML editor, topology and Helm"]
            State["Zustand workspace state and resource cache"]
            Providers["Provider interfaces and native transports"]
            Views <--> State
            Views --> Providers
            State <--> Providers
        end
        IPC["Tauri 2 commands, streaming channels and confirmations"]
        Core["kubiki-core: clients, informers and resource operations"]
        Providers <--> IPC
        IPC <--> Core
    end

    Config["Local kubeconfig and authentication plugins"]
    API["Kubernetes API server"]
    Helm["Local Helm executable"]
    Shell["Local shell and PTY"]

    Config --> Core
    Core <--> API
    Core --> Helm
    Helm <--> API
    Core <--> Shell
```

### Components

| Component | Responsibility | Location |
| --- | --- | --- |
| User interface | Resource tables, detail panels, overview, Monaco YAML editor, React Flow topology, and xterm.js terminals. | `src/views/`, `src/components/` |
| Workspace state | Context and namespace selection, resource cache, tabs, split panes, diagnostic sessions, and editor drafts. | `src/state/` |
| Provider layer | Resource access contracts, native command calls, watch subscriptions, and error normalization. | `src/providers/` |
| Desktop shell | Application lifecycle, IPC dispatch, stream ownership, and mutation confirmation dialogs. | `src-tauri/` |
| Kubernetes engine | Kubeconfig parsing, context-specific client pooling, API discovery, informers, metrics, resource mutations, logs, exec, and port forwarding. | `crates/kubiki-core/` |
| Helm integration | Context-specific Helm reads and reviewed lifecycle operations through the local Helm executable. | `crates/kubiki-core/src/helm/` |

The frontend uses React 19, TypeScript, Zustand, Tailwind CSS 4, Monaco Editor, React Flow, ELK, and xterm.js. The backend uses Rust, Tauri 2, Tokio, and the `kube` client library.

### Data flow

For reads, the frontend sends a request through the provider layer to a Tauri command. The backend resolves the selected context, obtains a Kubernetes client, and requests the resource from the API server. Results return to the interface through the same boundary.

For live resource updates, Rust informers maintain snapshots and produce watch batches. Tauri channels carry those batches to the frontend, where watch sessions update the resource cache and the subscribed views.

For writes, the backend prepares the operation against the current resource state, requests confirmation through the desktop interface, and commits the reviewed operation after the applicable identity and concurrency checks. Helm operations use a corresponding preparation flow and invoke the local Helm executable.

Logs, terminals, and port forwards have explicit session lifecycles managed by the native backend. Local host terminals use a pseudo-terminal; Pod sessions and forwarding communicate with the Kubernetes API.

See [Project structure and architecture](docs/STRUCTURE.md) for a module-level reference.

## Building and verification

### Build requirements

| Dependency | Requirement |
| --- | --- |
| Node.js | Version 22.12 or later; the project's workflows use Node.js 22. |
| pnpm | Version 10, matching the project's workflows. |
| Rust | Stable toolchain with support for Rust edition 2024. |
| Native build tools | The platform dependencies required by Tauri 2. |

The [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) describe the native toolchain for each operating system, including Xcode command-line tools on macOS and Microsoft C++ Build Tools and WebView2 on Windows.

For Debian or Ubuntu, the project's desktop build dependencies can be installed with:

```sh
sudo apt-get update
sudo apt-get install -y build-essential \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev
```

### Running from source

```sh
git clone https://github.com/JustYarick/kubiki.git
cd kubiki
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm tauri dev` starts the frontend development server, compiles the Rust backend, and opens the desktop application. The frontend server is started automatically by the Tauri configuration.

### Building desktop packages

```sh
pnpm tauri build
```

This command runs frontend type checking, builds the production frontend, compiles the native application, and creates the platform packages. For a native build without an explicit target override, packages are written under `src-tauri/target/release/bundle/`.

### Verification commands

Run these commands from the repository root:

| Command | Checks |
| --- | --- |
| `pnpm typecheck` | Frontend, development tooling, and test TypeScript projects. |
| `pnpm test` | Frontend unit and contract tests run by Vitest. |
| `pnpm build` | Type checking and the production frontend build. |
| `cargo test --manifest-path crates/kubiki-core/Cargo.toml` | Rust core unit and integration tests. |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Desktop Rust backend compilation. |
| `pnpm test:e2e` | Browser-driven interface tests run by Playwright. |

Run `pnpm test:e2e`; Playwright starts the frontend test server automatically, or reuses an existing local server. The default test URL is `http://127.0.0.1:1420`; the configuration also accepts `PLAYWRIGHT_BASE_URL`. A browser supported by the Playwright configuration must be available. These tests exercise the interface; native backend checks are listed separately above.

## Repository structure

```text
kubiki/
├── src/                        React interface and application logic
│   ├── components/             Workspace layout, resource details, dialogs, terminals
│   ├── core/                   Resource relationships, diagnostics, layout, utilities
│   ├── navigation/             Command palette
│   ├── providers/              Resource contracts and native transports
│   ├── state/                  Zustand stores and resource synchronization
│   └── views/                  Overview, resources, YAML, topology, Helm
├── src-tauri/                  Tauri desktop application and Rust IPC commands
├── crates/
│   └── kubiki-core/            Rust Kubernetes engine
├── shared/                     Resource type registry shared by frontend and tooling
├── server/                     Local bridges for frontend development and tests
├── tests/                      Frontend unit, contract, and Playwright tests
├── docs/                       Architecture reference and screenshots
├── public/licenses/            Licenses for bundled font assets
└── .github/workflows/          Verification and desktop release builds
```

## Keyboard shortcuts

Use `Ctrl` on Linux and Windows or `Cmd` on macOS for the modifier shown below.

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+K` | Open the command palette to search resources and actions. |
| `Ctrl/Cmd+B` | Toggle the explorer sidebar. |
| `Ctrl/Cmd+J` | Toggle the bottom panel. |
| `Ctrl/Cmd+W` | Close the active workspace tab. |
| `Ctrl/Cmd+,` | Open settings. |
| `Ctrl/Cmd+S` | Apply the manifest when the YAML editor is focused. |
| `Ctrl/Cmd+Plus` or `Ctrl/Cmd+Equals` | Increase the interface scale. |
| `Ctrl/Cmd+Minus` | Decrease the interface scale. |
| `Ctrl/Cmd+0` | Reset the interface scale to its default value. |

When a terminal is focused, `Ctrl+K`, `Ctrl+B`, `Ctrl+J`, and `Ctrl+W` are passed through to the terminal.

## License

Kubiki is distributed under the [Apache License 2.0](LICENSE).

Bundled fonts retain their respective licenses:

| Asset | License |
| --- | --- |
| Inter | [SIL Open Font License 1.1](public/licenses/Inter-OFL.txt) |
| JetBrains Mono | [SIL Open Font License 1.1](public/licenses/JetBrainsMono-OFL.txt) |
| Nerd Fonts Symbols Only Mono | [MIT License](public/licenses/NerdFontsSymbolsOnly-LICENSE.txt) |
