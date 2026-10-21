import { describe, expect, it } from 'vitest';
import { topologyEvents, MAX_TOPOLOGY_EVENTS } from '../../src/core/resources/topology_events';
import { EMPTY_GRAPH } from '../../src/core/resources/topology';
import { resourceKey } from '../../src/core/resources/identity';
import { useResourceStore } from '../../src/state/resource_store';
import type { ResourceItem } from '../../src/types/k8s';

const pod: ResourceItem = { kind: 'Pod', apiVersion: 'v1', uid: 'current', name: 'web', namespace: 'backend' };
function resources() {
  return { ...useResourceStore.getState().resources, Pod: new Map([[pod.uid, pod]]) };
}
function event(uid: string, reference: object, raw: Record<string, unknown> = {}, namespace = 'backend'): ResourceItem {
  return { uid, name: uid, kind: 'Event', apiVersion: 'v1', namespace, raw: { involvedObject: reference, reason: 'Scheduled', message: 'Assigned to node', ...raw } };
}
const graph = { items: new Map([[resourceKey(pod), pod]]), relations: [] };
const ref = { kind: 'Pod', name: 'web', namespace: 'backend', uid: 'current' };

describe('Topology event island', () => {
  it('includes every namespace and cluster targets for the all namespace graph', () => {
    const result = topologyEvents([event('backend', ref), event('other', { ...ref, namespace: 'other' }, {}, 'other'), event('node', { kind: 'Node', name: 'worker' }, {}, 'default')], 'all', graph, resources());
    expect(result.total).toBe(3);
    expect(result.entries.map(entry => entry.event.uid).sort()).toEqual(['backend', 'node', 'other']);
    expect(result.entries.find(entry => entry.event.uid === 'backend')?.target).toBe(pod);
  });
  it('shows events from all selected namespaces while excluding unselected namespaces', () => {
    const result = topologyEvents([event('backend-event', ref), event('other-event', { ...ref, namespace: 'other' }, {}, 'other'), event('outside-event', { ...ref, namespace: 'outside' }, {}, 'outside')], 'namespaces:["backend","other"]', graph, resources());
    expect(result.total).toBe(2);
    expect(result.entries.map(entry => entry.event.uid).sort()).toEqual(['backend-event', 'other-event']);
  });

  it('keeps the newest bounded window in a namespace and counts warnings outside that window', () => {
    const events = Array.from({ length: 500 }, (_, index) => event(`event-${index}`, ref, { lastTimestamp: new Date(1700000000000 + index * 1000).toISOString(), type: index === 0 ? 'Warning' : 'Normal' }));
    events.push(event('other-namespace', { ...ref, namespace: 'other' }, {}, 'other'));
    const result = topologyEvents(events, 'namespace:backend', graph, resources());
    expect(result.total).toBe(500); expect(result.warnings).toBe(1);
    expect(result.entries).toHaveLength(MAX_TOPOLOGY_EVENTS);
    expect(result.entries[0].event.uid).toBe('event-499');
    expect(result.entries.at(-1)?.event.uid).toBe('event-490');
  });
  it('matches focused graph targets by UID and excludes recreated resources and unrelated Pods', () => {
    const result = topologyEvents([
      event('current', ref), event('old-uid', { ...ref, uid: 'deleted' }),
      event('wrong-kind', { ...ref, kind: 'Service' }), event('other-pod', { ...ref, name: 'other', uid: 'other' }),
      event('name-fallback', { kind: 'Pod', name: 'web', namespace: 'backend' }),
    ], 'resource', graph, resources());
    expect(result.total).toBe(2);
    expect(result.entries.every((entry) => entry.target === pod)).toBe(true);
  });
  it('supports events.k8s.io regarding, series count and cluster-scoped targets', () => {
    const node: ResourceItem = { uid: 'node', name: 'worker', kind: 'Node', apiVersion: 'v1' };
    const graph = { items: new Map([[resourceKey(node), node]]), relations: [] };
    const item: ResourceItem = { uid: 'evt', name: 'evt', kind: 'Event', apiVersion: 'events.k8s.io/v1', namespace: 'default', raw: {
      regarding: { uid: 'node', name: 'worker', kind: 'Node' }, type: 'Warning', note: 'Node is not ready', series: { count: 8, lastObservedTime: '2026-10-20T08:00:00Z' }, eventTime: '2026-10-20T07:00:00Z',
    } };
    const result = topologyEvents([item], 'resource', graph, resources());
    expect(result.entries[0]).toMatchObject({ target: node, warning: true, message: 'Node is not ready', count: 8, timestamp: '2026-10-20T08:00:00Z' });
  });
  it('keeps missing namespace targets as text without linking an Event to a recreated object', () => {
    const result = topologyEvents([event('old', { ...ref, uid: 'deleted' }, { lastTimestamp: 'invalid', eventTime: '2026-10-20T08:00:00Z' })], 'namespace:backend', graph, resources());
    expect(result.entries[0]).toMatchObject({ objectLabel: 'Pod/web', target: undefined, timestamp: '2026-10-20T08:00:00Z' });
  });
  it('does not read Events before choosing a diagram scope', () => {
    const events = { *[Symbol.iterator](): Generator<ResourceItem> { throw new Error('Must not read'); } };
    expect(topologyEvents(events, '', EMPTY_GRAPH, resources()).total).toBe(0);
    expect(topologyEvents(events, 'overview', EMPTY_GRAPH, resources()).total).toBe(0);
  });
});
