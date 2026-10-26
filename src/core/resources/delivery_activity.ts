import { eventDetails, eventReference } from './resource_events';
import { matchesResourceRef, resourceKey } from './identity';
import type { ResourceItem } from '../../types/k8s';

export function deliveryActivity(events: ResourceItem[], items: ResourceItem[]) {
  const byUid = new Map(items.map(item => [item.uid, item]));
  const byKey = new Map(items.map(item => [resourceKey(item), item]));
  return events.flatMap(event => {
    const reference = eventReference(event);
    const item = reference.uid ? byUid.get(reference.uid) : reference.apiVersion && reference.kind && reference.name
      ? byKey.get(resourceKey({ kind: reference.kind, apiVersion: reference.apiVersion, namespace: reference.namespace, name: reference.name })) : undefined;
    if (!item || !matchesResourceRef(item, reference)) return [];
    return [{ ...eventDetails(event), item }];
  }).sort((a, b) => b.time - a.time || a.event.uid.localeCompare(b.event.uid));
}
