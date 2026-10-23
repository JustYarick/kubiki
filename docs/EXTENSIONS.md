# Workspace extensions

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

After both modules establish their actual shared needs, define a versioned plugin
manifest, typed host API, capability model, native extension boundary, package
installation/update mechanism and compatibility policy. A registry alone is not a
sandbox for third-party JavaScript or native code.
