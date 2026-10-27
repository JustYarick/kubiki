import { describe, expect, it } from 'vitest';
import { buildResourceGraph, relatedResourceScope } from '../../src/core/resources/relationships';
import { resourceKey } from '../../src/core/resources/identity';
import { buildTopology, EMPTY_GRAPH } from '../../src/core/resources/topology';
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
  it('builds all namespaces and cluster resources without charging Events to the budget', () => {
    const resources = emptyResources();
    for (const namespace of ['alpha', 'beta', 'other']) {
      const item = pod(0, namespace); resources.Pod.set(item.uid, item);
    }
    resources.Node.set('worker', { uid: 'worker', name: 'worker', kind: 'Node', apiVersion: 'v1' });
    resources.Node.set('idle', { uid: 'idle', name: 'idle', kind: 'Node', apiVersion: 'v1' });
    for (let index = 0; index < 1000; index++) resources.Event.set(`event-${index}`, { uid: `event-${index}`, name: 'event', kind: 'Event', apiVersion: 'v1' });
    const graph = buildTopology(resources, 'all');
    expect([...graph.items.values()].map(item => item.uid).sort()).toEqual(['idle', 'pod-alpha-0', 'pod-beta-0', 'pod-other-0', 'worker']);
    expect(graph.relations.filter(edge => edge.type === 'schedules')).toHaveLength(3);
  });
  it('keeps more than 250 objects in an all-namespace graph', () => {
    const resources = emptyResources();
    for (let index = 0; index < 600; index++) {
      const item = pod(index, `namespace-${index}`); resources.Pod.set(item.uid, item);
    }
    expect(buildTopology(resources, 'all').items.size).toBe(600);
  });
  it('combines selected namespaces and shares cluster dependencies while excluding every other namespace', () => {
    const resources = emptyResources();
    for (const namespace of ['alpha', 'beta', 'outside']) {
      const item = pod(0, namespace); resources.Pod.set(item.uid, item);
    }
    resources.Node.set('worker', { uid: 'worker', name: 'worker', kind: 'Node', apiVersion: 'v1' });
    const graph = buildTopology(resources, 'namespaces:["alpha","beta"]');
    expect([...graph.items.values()].map(item => item.uid).sort()).toEqual(['pod-alpha-0', 'pod-beta-0', 'worker']);
    expect(graph.relations.filter(edge => edge.type === 'schedules')).toHaveLength(2);
  });
  it('keeps more than 250 objects across selected namespaces', () => {
    const resources = emptyResources();
    for (const namespace of ['alpha', 'beta']) for (let index = 0; index < 200; index++) {
      const item = pod(index, namespace); resources.Pod.set(item.uid, item);
    }
    expect(buildTopology(resources, 'namespaces:["alpha","beta"]').items.size).toBe(400);
  });

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
  it('keeps every object in a large namespace graph', () => {
    const resources = emptyResources();
    for (let index = 0; index < 5000; index++) {
      const item = pod(index); resources.Pod.set(item.uid, item);
    }
    expect(buildTopology(resources, 'namespace:busy').items.size).toBe(5000);
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
  it('allows a Node focus with more than 250 related Pods', () => {
    const resources = emptyResources();
    for (let index = 0; index < 400; index++) { const item = pod(index); resources.Pod.set(item.uid, item); }
    const node: ResourceItem = { uid: 'node', name: 'worker', kind: 'Node', apiVersion: 'v1' };
    resources.Node.set(node.uid, node);
    expect(buildTopology(resources, 'resource', node).items.size).toBe(401);
  });
  it('treats every cluster-scoped dependency as a boundary and points links towards it', () => {
    const resources = emptyResources();
    const focus = pod(0); const other = pod(1);
    for (const item of [focus, other]) {
      item.raw!.spec.priorityClassName = 'shared';
      resources.Pod.set(item.uid, item);
    }
    const priority: ResourceItem = { uid: 'priority', name: 'shared', kind: 'PriorityClass', apiVersion: 'scheduling.k8s.io/v1' };
    const node: ResourceItem = { uid: 'node', name: 'worker', kind: 'Node', apiVersion: 'v1' };
    resources.PriorityClass.set(priority.uid, priority); resources.Node.set(node.uid, node);
    const graph = buildTopology(resources, 'resource', focus, 5);
    expect([...graph.items.values()].map(item => item.uid).sort()).toEqual([node.uid, focus.uid, priority.uid].sort());
    expect(graph.relations.every(edge => edge.source === resourceKey(focus))).toBe(true);
    expect(graph.relations.find(edge => edge.type === 'schedules')?.target).toBe(resourceKey(node));
    // Explicitly opening the shared resource still reveals its consumers.
    expect(buildTopology(resources, 'resource', priority, 1).items.has(resourceKey(other))).toBe(true);
  });
  it('slices Related before serialization while retaining kinds with cross-namespace references', () => {
    const resources = emptyResources(); const focus = pod(0, 'small'); const other = pod(1, 'other');
    resources.Pod.set(focus.uid, focus); resources.Pod.set(other.uid, other);
    const binding: ResourceItem = { uid: 'binding', name: 'binding', namespace: 'other', kind: 'RoleBinding', apiVersion: 'rbac.authorization.k8s.io/v1' };
    resources.RoleBinding.set(binding.uid, binding);
    const scoped = relatedResourceScope(resources, focus);
    expect([...scoped.Pod.values()]).toEqual([focus]);
    expect(scoped.RoleBinding).toBe(resources.RoleBinding);
    expect(relatedResourceScope(resources, focus).Pod).toBe(scoped.Pod);
    expect(resources.Pod.size).toBe(2);
    const updated = { ...resources, Pod: new Map(resources.Pod).set('new', { ...focus, uid: 'new', name: 'new' }) };
    expect(relatedResourceScope(updated, focus).Pod.size).toBe(2);
  });
  it('excludes unrelated namespaces before building a small namespace graph', () => {
    const resources = emptyResources();
    for (let index = 0; index < 5000; index++) { const item = pod(index); resources.Pod.set(item.uid, item); }
    const small = pod(0, 'small'); resources.Pod.set(small.uid, small);
    expect(buildTopology(resources, 'namespace:small').items.size).toBe(1);
  });
  it('supports dense selector relationships with no edge limit', () => {
    const resources = emptyResources();
    for (let index = 0; index < 100; index++) { const item = pod(index); item.labels = { app: 'shared' }; resources.Pod.set(item.uid, item); }
    for (let index = 0; index < 100; index++) resources.Service.set(`svc-${index}`, { uid: `svc-${index}`, name: `svc-${index}`, namespace: 'busy', kind: 'Service', apiVersion: 'v1', spec: { selector: { app: 'shared' } } });
    const graph = buildTopology(resources, 'namespace:busy');
    expect(graph.relations.length).toBeGreaterThan(1000);
  });
  it('supports Namespace membership in Related without building unrelated Service/Pod joins', () => {
    const resources = emptyResources(); const item = pod(0); resources.Pod.set(item.uid, item);
    const namespace: ResourceItem = { uid: 'ns', name: 'busy', kind: 'Namespace', apiVersion: 'v1' }; resources.Namespace.set(namespace.uid, namespace);
    const graph = buildResourceGraph(resources, { adjacentTo: new Set([resourceKey(namespace)]) });
    expect(graph.relations).toHaveLength(1); expect(graph.relations[0].type).toBe('contains');
  });
});
