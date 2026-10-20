import type { ResourceItem } from '../../types/k8s';
import { matchesResourceRef } from './identity';
import { RESOURCE_TYPES, apiVersionFor } from './resource_types';

export function eventReference(event: ResourceItem) {
  const ref = event.raw?.involvedObject ?? event.raw?.regarding ?? {};
  const builtin = RESOURCE_TYPES.find((type) => type.kind === ref.kind);
  return {
    ...ref,
    namespace: ref.namespace ?? (builtin?.namespaced === false ? undefined : event.namespace),
    apiVersion: ref.apiVersion ?? (builtin ? apiVersionFor(builtin) : ''),
  };
}

export function eventDetails(event: ResourceItem) {
  const raw = event.raw ?? {};
  const timestamp = [raw.series?.lastObservedTime, raw.lastTimestamp, raw.deprecatedLastTimestamp, raw.eventTime, raw.firstTimestamp, event.creationTimestamp]
    .find((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  const count = Number(raw.series?.count ?? raw.count ?? raw.deprecatedCount);
  return {
    event, warning: raw.type === 'Warning', reason: raw.reason || 'Event', message: raw.message ?? raw.note ?? '',
    count: Number.isFinite(count) ? Math.max(1, count) : 1,
    timestamp, time: timestamp ? Date.parse(timestamp) : 0,
    reporter: raw.reportingController ?? raw.reportingComponent ?? raw.source?.component,
  };
}

/** Match the object itself; never include descendants or a previous object's UID. */
export function resourceEvents(events: Iterable<ResourceItem>, item: ResourceItem) {
  return [...events].filter((event) => matchesResourceRef(item, eventReference(event))).map(eventDetails)
    .sort((a, b) => b.time - a.time || a.event.uid.localeCompare(b.event.uid));
}
