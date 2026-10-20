import type { ResourceItem, ResourceKind } from '../../types/k8s';
import type { ResourceGraph } from './relationships';
import { matchesResourceRef, resourceKey } from './identity';
import { RESOURCE_TYPES, apiVersionFor } from './resource_types';

export const MAX_TOPOLOGY_EVENTS = 10;
const CLUSTER_KINDS = new Set(['Node', 'Namespace', 'PersistentVolume', 'StorageClass', 'CustomResourceDefinition']);
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
  const byUid = new Map([...graph.items.values()].map((item) => [item.uid, item]));
  const byName = new Map<string, Map<string, ResourceItem>>();
  const lookupByName = (kind: string, key: string) => {
    if (!byName.has(kind)) byName.set(kind, new Map([...(resources[kind as ResourceKind]?.values() ?? [])].map((item) => [resourceKey(item), item])));
    return byName.get(kind)?.get(key);
  };
  for (const event of events) {
    const raw = event.raw ?? {};
    const ref = raw.involvedObject ?? raw.regarding ?? {};
    const namespace = ref.namespace ?? (CLUSTER_KINDS.has(ref.kind) ? undefined : event.namespace);
    const builtin = RESOURCE_TYPES.find((type) => type.kind === ref.kind);
    const reference = { ...ref, namespace, apiVersion: ref.apiVersion ?? (builtin ? apiVersionFor(builtin) : '') };
    const key = resourceKey(reference);
    const candidate = scope === 'resource' ? ref.uid ? byUid.get(ref.uid) : graph.items.get(key)
      : ref.uid ? resources[ref.kind as ResourceKind]?.get(ref.uid)
        : lookupByName(ref.kind, key);
    const target = candidate && matchesResourceRef(candidate, reference) ? candidate : undefined;
    if (scope === 'resource' ? !target : !scope.startsWith('namespace:') || (event.namespace ?? namespace) !== scope.slice('namespace:'.length)) continue;
    const warning = raw.type === 'Warning';
    total++;
    if (warning) warnings++;
    const timestamp = [raw.series?.lastObservedTime, raw.lastTimestamp, raw.deprecatedLastTimestamp, raw.eventTime, raw.firstTimestamp, event.creationTimestamp]
      .find((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
    const entry: TopologyEvent = {
      event, target, objectLabel: ref.kind && ref.name ? `${ref.kind}/${ref.name}` : 'Unknown resource',
      warning, reason: raw.reason || 'Event', message: raw.message ?? raw.note ?? '',
      count: Math.max(1, Number(raw.series?.count ?? raw.count) || 1), timestamp, time: timestamp ? Date.parse(timestamp) : 0,
    };
    const index = entries.findIndex((existing) => entry.time > existing.time || entry.time === existing.time && entry.event.uid.localeCompare(existing.event.uid) < 0);
    if (index !== -1) entries.splice(index, 0, entry);
    else if (entries.length < MAX_TOPOLOGY_EVENTS) entries.push(entry);
    if (entries.length > MAX_TOPOLOGY_EVENTS) entries.pop();
  }
  return { entries, total, warnings };
}
