import { resourceBucket } from './custom_resource_types';
import type { ResourceItem, ResourceKind } from '../../types/k8s';
import type { ResourceGraph } from './relationships';
import { matchesResourceRef, resourceKey } from './identity';
import { eventDetails, eventReference } from './resource_events';
import { topologyNamespaces } from './topology';

export const MAX_TOPOLOGY_EVENTS = 10;
export interface TopologyEvent {
  event: ResourceItem; target?: ResourceItem; objectLabel: string;
  warning: boolean; reason: string; message: string; count: number;
  timestamp?: string; time: number;
}

/** Keep only the newest small window; never sort or render the entire event snapshot. */
export function topologyEvents(events: Iterable<ResourceItem>, scope: string, graph: ResourceGraph, resources: Record<ResourceKind, Map<string, ResourceItem>>) {
  const entries: TopologyEvent[] = [];
  let total = 0;
  let warnings = 0;
  if (!scope || scope === 'overview') return { entries, total, warnings };
  const namespaces = new Set(topologyNamespaces(scope));
  const byUid = new Map([...graph.items.values()].map((item) => [item.uid, item]));
  const byName = new Map<string, Map<string, ResourceItem>>();
  const lookupByName = (kind: string, key: string) => {
    if (!byName.has(kind)) byName.set(kind, new Map([...(resources[kind as ResourceKind]?.values() ?? [])].map((item) => [resourceKey(item), item])));
    return byName.get(kind)?.get(key);
  };
  for (const event of events) {
    const reference = eventReference(event);
    const ref = reference;
    const namespace = reference.namespace;
    const key = resourceKey(reference);
    const candidate = scope === 'resource' ? ref.uid ? byUid.get(ref.uid) : graph.items.get(key)
      : ref.uid ? byUid.get(ref.uid) ?? resources[resourceBucket(ref) as ResourceKind]?.get(ref.uid)
        : lookupByName(ref.kind, key);
    const target = candidate && matchesResourceRef(candidate, reference) ? candidate : undefined;
    if (scope === 'resource' ? !target : scope !== 'all' && !namespaces.has(event.namespace ?? namespace ?? '')) continue;
    const details = eventDetails(event);
    total++;
    if (details.warning) warnings++;
    const entry: TopologyEvent = {
      ...details, target, objectLabel: ref.kind && ref.name ? `${ref.kind}/${ref.name}` : 'Unknown resource',
    };
    const index = entries.findIndex((existing) => entry.time > existing.time || entry.time === existing.time && entry.event.uid.localeCompare(existing.event.uid) < 0);
    if (index !== -1) entries.splice(index, 0, entry);
    else if (entries.length < MAX_TOPOLOGY_EVENTS) entries.push(entry);
    if (entries.length > MAX_TOPOLOGY_EVENTS) entries.pop();
  }
  return { entries, total, warnings };
}
