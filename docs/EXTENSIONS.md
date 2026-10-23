# Workspace extensions

## Public extension platform

Open **Extensions** in the activity bar or command palette. The desktop app ships
SDK Diagnostics as its first built-in package. Run its checks, then try disabling
and re-enabling it to exercise the lifecycle. The Redis extension is maintained in
a separate repository and installed as an ordinary external package.

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

The current extension point is a registry of trusted, bundled feature panels. It
provides navigation, independent workspace tabs, split views and lazy rendering.
It does not install external packages or dynamically extend native Tauri commands.

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

A useful first version is two bundled modules using this registry:

- Redis: connection setup, database/key browsing, bounded key/value reads, TTL and
  explicitly confirmed writes. Use incremental scans rather than collecting the
  entire keyspace before rendering it.
- Kafka: connection setup, topic/partition metadata, consumer group inspection and
  bounded message reads. Message sampling should have explicit offsets, limits,
  pause and cancellation rather than an unbounded stream.

Native client managers should own authentication, TLS, cancellation and connection
lifecycles. Feature views should depend on typed feature providers, with separate
native and demo adapters. They can reuse the port-forward service for endpoints
inside Kubernetes, without making Kubernetes discovery a prerequisite for direct
connections.

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
