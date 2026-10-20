import type { ResourceKind } from '../../types/k8s';
import type { ResourceGraph } from './relationships';

/** Namespace frames exist even when Namespace objects are absent from a focused graph. */
export function topologyTypeCounts(graph: ResourceGraph): Array<[ResourceKind, number]> {
  const counts = new Map<ResourceKind, number>();
  const namespaces = new Set<string>();
  for (const item of graph.items.values()) {
    if (item.namespace) namespaces.add(item.namespace);
    if (item.kind === 'Namespace') namespaces.add(item.name);
    else counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  if (namespaces.size) counts.set('Namespace', namespaces.size);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}
