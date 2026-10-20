import { describe, expect, it } from 'vitest';
import { buildResourceGraph, GraphLimitError } from '../../src/core/resources/relationships';
import { resourceKey } from '../../src/core/resources/identity';
import { buildTopology, EMPTY_GRAPH, MAX_TOPOLOGY_EDGES } from '../../src/core/resources/topology';
import { useResourceStore } from '../../src/state/resource_store';
import type { ResourceItem } from '../../src/types/k8s';

type Resources = ReturnType<typeof useResourceStore.getState>['resources'];
function emptyResources(): Resources {
  return Object.fromEntries(Object.keys(useResourceStore.getState().resources).map((kind) => [kind, new Map()])) as Resources;
}
function pod(index: number, namespace = 'busy'): ResourceItem {
  return { uid: `pod-${namespace}-${index}`, name: `pod-${index}`, namespace, kind: 'Pod', apiVersion: 'v1', labels: { app: `app-${index}` }, node: 'worker', raw: { metadata: { name: `pod-${index}`, namespace }, spec: { nodeName: 'worker' } } };
}

describe('Bounded topology construction', () => {
  it('excludes thousands of Events before applying graph budgets, including an explicit Event focus', () => {
    const resources = emptyResources(); const item = pod(0); resources.Pod.set(item.uid, item);
    for (let index = 0; index < 5000; index++) resources.Event.set(`event-${index}`, { uid: `event-${index}`, name: `event-${index}`, namespace: 'busy', kind: 'Event', apiVersion: 'v1' });
    const graph = buildTopology(resources, 'namespace:busy');
    expect([...graph.items.values()]).toEqual([item]);
    expect(graph.relations).toHaveLength(0);
    expect(buildTopology(resources, 'resource', resources.Event.get('event-0'))).toBe(EMPTY_GRAPH);
  });
  it('does no relationship work for an unselected scope or counts-only overview', () => {
    const resources = emptyResources();
    const item = pod(0); Object.defineProperty(item, 'labels', { get: () => { throw new Error('Labels must not be inspected'); } });
    resources.Pod.set(item.uid, item);
    expect(buildTopology(resources, '')).toBe(EMPTY_GRAPH);
    expect(buildTopology(resources, 'overview')).toBe(EMPTY_GRAPH);
  });
  it('checks a large namespace before selector matching or layout', () => {
    const resources = emptyResources();
    for (let index = 0; index < 5000; index++) {
      const item = pod(index); Object.defineProperty(item, 'labels', { get: () => { throw new Error('Selector work should never run'); } });
      resources.Pod.set(item.uid, item);
    }
    expect(() => buildTopology(resources, 'namespace:busy')).toThrow(GraphLimitError);
  });
  it('builds a small focus in a large cluster without following a common Node to all its other Pods', () => {
    const resources = emptyResources();
    for (let index = 0; index < 5000; index++) { const item = pod(index); resources.Pod.set(item.uid, item); }
    const focus = resources.Pod.get('pod-busy-0')!;
    focus.raw!.metadata.ownerReferences = [{ kind: 'ReplicaSet', name: 'web-rs', uid: 'rs' }];
    const replicaSet: ResourceItem = { uid: 'rs', name: 'web-rs', namespace: 'busy', kind: 'ReplicaSet', apiVersion: 'apps/v1', metadata: { ownerReferences: [{ kind: 'Deployment', name: 'web', uid: 'dep' }] } };
    resources.ReplicaSet.set(replicaSet.uid, replicaSet);
    resources.Deployment.set('dep', { uid: 'dep', name: 'web', namespace: 'busy', kind: 'Deployment', apiVersion: 'apps/v1' });
    resources.Node.set('node', { uid: 'node', name: 'worker', kind: 'Node', apiVersion: 'v1' });
    const graph = buildTopology(resources, 'resource', focus, 2);
    expect([...graph.items.values()].map((item) => item.kind).sort()).toEqual(['Deployment', 'Node', 'Pod', 'ReplicaSet']);
    expect(graph.relations).toHaveLength(3);
  });
  it('bounds a Node focus with thousands of Pods, rather than silently truncating it', () => {
    const resources = emptyResources();
    for (let index = 0; index < 5000; index++) { const item = pod(index); resources.Pod.set(item.uid, item); }
    const node: ResourceItem = { uid: 'node', name: 'worker', kind: 'Node', apiVersion: 'v1' };
    resources.Node.set(node.uid, node);
    expect(() => buildTopology(resources, 'resource', node)).toThrow(GraphLimitError);
  });
  it('excludes unrelated namespaces before building a small namespace graph', () => {
    const resources = emptyResources();
    for (let index = 0; index < 5000; index++) { const item = pod(index); resources.Pod.set(item.uid, item); }
    const small = pod(0, 'small'); resources.Pod.set(small.uid, small);
    expect(buildTopology(resources, 'namespace:small').items.size).toBe(1);
  });
  it('bounds dense selector relationships separately from node count', () => {
    const resources = emptyResources();
    for (let index = 0; index < 100; index++) { const item = pod(index); item.labels = { app: 'shared' }; resources.Pod.set(item.uid, item); }
    for (let index = 0; index < 100; index++) resources.Service.set(`svc-${index}`, { uid: `svc-${index}`, name: `svc-${index}`, namespace: 'busy', kind: 'Service', apiVersion: 'v1', spec: { selector: { app: 'shared' } } });
    expect(() => buildTopology(resources, 'namespace:busy')).toThrow(`${MAX_TOPOLOGY_EDGES} relationships`);
  });
  it('supports Namespace membership in Related without building unrelated Service/Pod joins', () => {
    const resources = emptyResources(); const item = pod(0); resources.Pod.set(item.uid, item);
    const namespace: ResourceItem = { uid: 'ns', name: 'busy', kind: 'Namespace', apiVersion: 'v1' }; resources.Namespace.set(namespace.uid, namespace);
    const graph = buildResourceGraph(resources, { adjacentTo: new Set([resourceKey(namespace)]) });
    expect(graph.relations).toHaveLength(1); expect(graph.relations[0].type).toBe('contains');
  });
});
