# Workspace extensions

## Public extension platform

Open **Extensions** in the activity bar or command palette. Install a published
package from GitHub or a local archive. Redis and Kafka are maintained as separate
extension projects and use the same external package installation path.

SDK Diagnostics is bundled for extension development and hidden by default.
Enable **Settings → Developer → Developer mode** to show it in the manager,
workspace navigation and command palette. Run its checks, then try disabling and
re-enabling it to exercise the lifecycle. Turning developer mode off hides its
contributions and closes its workspace tabs.

The current Catalog/Installed sections list packages known to this installation;
there is no remotely refreshed marketplace. The Updates section lists GitHub-origin
packages that can be checked manually, rather than an automatically fetched list
of newer versions.

Install a local `.kubiki-extension` file or check a public GitHub repository/release
URL. Review the resolved version, source and integrations before Install & Enable.
GitHub releases need one prepared package and its SHA-256 sidecar (or GitHub asset
digest). Repository source is never built on the end user's machine. The checksum
checks bytes, not publisher identity. External Node backends are trusted local code.

Installed packages run offline, activate lazily and can be disabled, restarted,
rolled back or uninstalled. Built-in packages can be disabled. Updates are manual;
the previous version remains available. Package rollback does not undo external
database writes or extension data migrations. Uninstallation retains saved settings.

The SDK, host and packaging tools live in separate pnpm workspace packages. See
[SDK API](../packages/extension-sdk/README.md) and
[author tools/template](../packages/extension-tools/README.md).

```sh
pnpm install
pnpm extensions:build
pnpm test:extensions
node scripts/check-external-extension.mjs
pnpm desktop:prepare
pnpm tauri dev
```

Desktop preparation downloads a pinned Node 24 runtime and verifies the official
archive checksum. Desktop release resources include that runtime, the controller
and bundled packages. Browser mode explains the desktop requirement.

Passwords use the operating system credential store. If unavailable, an extension
must offer session-only credentials. Never store credentials in workspace tabs or
extension settings. Kubernetes operations and port-forward APIs are not part of
the initial public SDK; the existing application services remain internal.

## Internal bundled panel registry

The internal registry supports trusted application components and host-owned
adapters for installed extension panels. It provides navigation, independent
workspace tabs, split views and lazy rendering. Package installation belongs to
the extension host; third-party panels do not dynamically extend native Tauri
commands or load their React code into the main application renderer.

Register a feature with `registerWorkspacePanel` from
`src/core/workspace_panels.tsx`:

```tsx
const unregister = registerWorkspacePanel({
  id: 'redis',
  title: 'Redis',
  icon: Database,
  context: 'global',
  component: RedisPanel,
});
```

The component receives `{ tab, visible, item? }`. IDs are unique and stable.
A global panel owns its connection selection; a cluster panel is pinned to the
Kubernetes context active when it opens. Closing split view leaves the tab
available. Removing a registration removes its navigation button, and existing
tabs display an unavailable-extension message. The returned function unregisters
that exact registration.

Keep credentials and live sessions outside persisted workspace tab objects.
Pause background queries when `visible` is false, preserve the session's buffered
results, and close owned connections when the tab unmounts or context changes.
Features should report loading, partial results and errors explicitly.

## Redis and Kafka

Redis and Kafka are independent SDK consumers, not built-in Rust database clients.
Install their prepared `.kubiki-extension` packages through the manager. Their Node
backends own protocol libraries, authentication, TLS and connection lifecycles;
their panels use the public SDK bridge and host theme tokens. The application
provides dedicated Redis/Kafka navigation icons and shared internal tab metrics.

The public SDK currently exposes settings, secrets, notifications and calls to
the extension's own backend. Kubernetes discovery, reviewed cluster mutations
and port-forward leasing are not public SDK capabilities. Connections to cluster
services need an endpoint reachable by the extension backend, such as a separately
managed port forward. Use each extension's documentation for its supported
operations and external database write confirmations.

The external platform wraps this registry with host-owned iframe adapters. The
registry itself continues to accept trusted application components; third-party
code is not imported into the main React tree. See the
[architecture rationale](EXTENSION_PLATFORM.md) for the runtime tradeoffs.

## Runtime cost

A Linux development sample with bundled Node 24.22.1 measured approximately
65 MiB RSS for the controller, 63 MiB for an active SDK Diagnostics backend and
70 MiB for an idle Redis backend with no network connection. These are individual
process snapshots, not a desktop memory benchmark. The Linux runtime binary is
about 122 MiB uncompressed. Processes are started lazily for enabled extension
views/commands; per-extension processes trade additional memory for failure isolation.
