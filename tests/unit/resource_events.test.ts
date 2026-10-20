import { describe, expect, it } from 'vitest';
import { resourceEvents } from '../../src/core/resources/resource_events';
import { buildResourceGraph } from '../../src/core/resources/relationships';
import { resourceKey } from '../../src/core/resources/identity';
import { useResourceStore } from '../../src/state/resource_store';
import type { ResourceItem } from '../../src/types/k8s';

const pod: ResourceItem = { uid: 'pod', kind: 'Pod', apiVersion: 'v1', name: 'web', namespace: 'backend' };
const ref = { uid: pod.uid, kind: pod.kind, apiVersion: pod.apiVersion, name: pod.name, namespace: pod.namespace };
const event = (uid: string, reference: object, raw = {}): ResourceItem => ({ uid, name: uid, kind: 'Event', apiVersion: 'v1', namespace: 'backend', raw: { involvedObject: reference, ...raw } });

describe('Object notifications', () => {
  it('excludes loaded Events, their ownership and missing Event targets from Related and graph budgets', () => {
    const namespace: ResourceItem = { uid: 'ns', kind: 'Namespace', apiVersion: 'v1', name: 'backend' };
    const notification = event('evt', ref, { metadata: { ownerReferences: [ref] } });
    const resources = { ...useResourceStore.getState().resources,
      Namespace: new Map([[namespace.uid, namespace]]),
      Pod: new Map([[pod.uid, { ...pod, raw: { metadata: { ownerReferences: [{ kind: 'Event', name: 'missing-event', apiVersion: 'v1' }] } } }]]),
      Event: new Map([[notification.uid, notification]]),
    };
    const graph = buildResourceGraph(resources, { maxNodes: 2 });
    expect([...graph.items.values()].map((item) => item.kind)).toEqual(['Pod', 'Namespace']);
    expect(graph.relations.filter(edge => !edge.missing)).toHaveLength(1);
    expect(graph.relations[0]).toMatchObject({ source: resourceKey(namespace), target: resourceKey(pod), type: 'contains' });
  });
  it('rejects previous UID, wrong kind, namespace, name and API group even if UID matches', () => {
    const events = [event('valid', ref), event('legacy', { ...ref, uid: undefined }),
      ...[{ uid: 'old' }, { kind: 'Service' }, { namespace: 'other' }, { name: 'other' }, { apiVersion: 'example.com/v1' }].map((change, index) => event(`wrong-${index}`, { ...ref, ...change }))];
    expect(resourceEvents(events, pod).map((entry) => entry.event.uid)).toEqual(['legacy', 'valid']);
  });
  it('uses namespace fallback for namespaced objects and supports cluster objects in namespaced Events', () => {
    expect(resourceEvents([event('fallback', { ...ref, namespace: undefined })], pod)).toHaveLength(1);
    const node: ResourceItem = { uid: 'node', kind: 'Node', apiVersion: 'v1', name: 'worker' };
    expect(resourceEvents([event('node-event', { kind: 'Node', name: 'worker', uid: 'node' })], node)).toHaveLength(1);
    const namespace: ResourceItem = { uid: 'ns', kind: 'Namespace', apiVersion: 'v1', name: 'backend' };
    expect(resourceEvents([event('child', ref), event('own', { kind: 'Namespace', name: 'backend', uid: 'ns' })], namespace).map((entry) => entry.event.uid)).toEqual(['own']);
  });
  it('normalizes core and events.k8s.io notifications, orders by last occurrence and handles invalid dates/counts', () => {
    const result = resourceEvents([
      event('old', ref, { lastTimestamp: '2026-10-20T07:00:00Z', count: 2 }),
      { ...event('new', ref), apiVersion: 'events.k8s.io/v1', raw: { regarding: ref, type: 'Warning', reason: 'BackOff', note: 'Restarting', series: { count: 8, lastObservedTime: '2026-10-20T08:00:00Z' }, reportingController: 'kubelet' } },
      event('unknown', ref, { lastTimestamp: 'invalid', count: Infinity }),
    ], pod);
    expect(result.map((entry) => entry.event.uid)).toEqual(['new', 'old', 'unknown']);
    expect(result[0]).toMatchObject({ warning: true, reason: 'BackOff', message: 'Restarting', count: 8, reporter: 'kubelet' });
    expect(result[2]).toMatchObject({ count: 1, time: 0 });
  });
});
