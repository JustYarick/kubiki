import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startResourceWatches, stopResourceWatches, refreshResourceWatches } from '../../src/state/resource_watch';
import { useClusterStore } from '../../src/state/cluster_store';
import { useResourceStore } from '../../src/state/resource_store';
import { isValidNamespaceName, namespaceIsOutsideScope, resourceType, type ResourceQuery } from '../../src/core/resources/resource_types';
import type { WatchBatch } from '../../src/providers/watch_types';
import { useWorkspaceStore } from '../../src/state/workspace_store';
import { useUiStore } from '../../src/state/ui_store';
import { retainResourceKinds, useResourceRequirements } from '../../src/state/resource_requirements';

const mock = vi.hoisted(() => ({ supportsResourceWatch: true, watchResources: vi.fn() }));
vi.mock('../../src/providers/k8s_provider', () => ({ k8s: mock }));
beforeEach(() => { vi.useFakeTimers(); useResourceStore.getState().reset(); useResourceRequirements.setState({ entries: new Map() }); useWorkspaceStore.setState({ tabs: [{ id: 'pods', type: 'resource-list', kind: 'Pod', title: 'Pods' }], activeTabId: 'pods', splitTabId: null }); useUiStore.setState({ inspectorCollapsed: true }); useClusterStore.setState({ currentContext: 'test', selectedNamespace: 'backend', availableNamespaces: [], availableResourceKinds: null }); mock.watchResources.mockReset(); });
afterEach(() => { stopResourceWatches(); vi.useRealTimers(); });

it('subscribes to selected namespace, preserves cluster watches and removes the namespace listener on stop', async () => {
  const queries: ResourceQuery[] = []; const signals: AbortSignal[] = [];
  mock.watchResources.mockImplementation(async (query: ResourceQuery, emit: (batch: WatchBatch) => void, signal: AbortSignal) => {
    queries.push(query); signals.push(signal);
    emit({ query, subscription_id: 'test', messages: [{ sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items: [] } } } }, { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } }] });
    return vi.fn();
  });
  const ready = startResourceWatches('test'); await vi.advanceTimersByTimeAsync(50); await ready;
  expect(queries.map(query => query.kind)).toEqual(['Namespace', 'CustomResourceDefinition', 'Pod']);
  for (const query of queries) expect(query.namespace).toBe(!resourceType(query.kind as any).namespaced ? null : 'backend');
  const cluster = queries.filter((query) => !resourceType(query.kind as any).namespaced);
  useClusterStore.getState().selectNamespace('other'); await vi.advanceTimersByTimeAsync(50);
  expect(queries.slice(3).map(query => [query.kind, query.namespace])).toEqual([['Pod', 'other']]);
  for (let i = 0; i < 3; i++) expect(signals[i].aborted).toBe(resourceType(queries[i].kind as any).namespaced);
  expect(queries.filter((query) => query.namespace === null)).toHaveLength(cluster.length);
  stopResourceWatches(); const count = queries.length;
  useClusterStore.getState().selectNamespace('backend'); await vi.advanceTimersByTimeAsync(50);
  expect(queries).toHaveLength(count); expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(await refreshResourceWatches()).toBe(false); expect(vi.getTimerCount()).toBe(0);
});

it('validates namespace names without allowing paths, whitespace or overlong labels', () => {
  for (const name of ['backend', 'x', '0', 'team-1', 'a'.repeat(63), 'all']) expect(isValidNamespaceName(name)).toBe(true);
  for (const name of ['', '-a', 'a-', 'BACKEND', 'a_b', 'a.b', '../pods', ' a', 'a\n', 'a'.repeat(64)]) expect(isValidNamespaceName(name)).toBe(false);
});

it('issues Related watches only for the object namespace plus cluster resources with All Namespaces selected', async () => {
  const item = { uid: 'pod', name: 'pod', kind: 'Pod', apiVersion: 'v1', namespace: 'backend' };
  useClusterStore.setState({ selectedNamespace: 'all' });
  useResourceStore.getState().setResourcesForKind('Pod', [item]);
  const queries: ResourceQuery[] = [];
  mock.watchResources.mockImplementation(async (query: ResourceQuery, emit: (batch: WatchBatch) => void) => {
    queries.push(query);
    const items = query.kind === 'Pod' ? [{ metadata: item }] : [];
    emit({ query, subscription_id: 'test', messages: [{ sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items } } } }, { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } }] });
    return vi.fn();
  });
  const ready = startResourceWatches('test'); await vi.advanceTimersByTimeAsync(1000); await ready;
  useResourceStore.getState().selectItem(useResourceStore.getState().resources.Pod.get(item.uid)!);
  useUiStore.setState({ inspectorCollapsed: false, rightTab: 'related' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(queries.some(query => query.kind === 'Secret' && query.namespace === 'backend')).toBe(true);
  expect(queries.some(query => query.kind === 'StorageClass' && query.namespace === null)).toBe(true);
  for (const query of queries) {
    expect(query.namespace).toBe(query.kind === 'Pod' || !resourceType(query.kind).namespaced ? null : 'backend');
  }
  const before = queries.length;
  const refresh = refreshResourceWatches('Secret');
  await vi.advanceTimersByTimeAsync(50); await refresh;
  expect(queries.slice(before).map(query => [query.kind, query.namespace])).toEqual([['Secret', 'backend']]);
});

it('retains independent Related scopes across global selection changes and unions split namespaces without all-namespace reads', async () => {
  useClusterStore.setState({ selectedNamespace: 'all' });
  useWorkspaceStore.setState({ tabs: [{ id: 'configs', type: 'resource-list', title: 'ConfigMaps', kind: 'ConfigMap' }], activeTabId: 'configs' });
  const release = retainResourceKinds('test', ['Pod', 'Service', 'Node'], 'backend');
  const queries: ResourceQuery[] = [];
  mock.watchResources.mockImplementation(async (query: ResourceQuery, emit: (batch: WatchBatch) => void) => {
    queries.push(query);
    emit({ query, subscription_id: 'test', messages: [{ sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items: [] } } } }, { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } }] });
    return vi.fn();
  });
  const ready = startResourceWatches('test'); await vi.advanceTimersByTimeAsync(1000); await ready;
  expect(queries.find(query => query.kind === 'Pod')?.namespace).toBe('backend');
  expect(queries.find(query => query.kind === 'Service')?.namespace).toBe('backend');
  useClusterStore.getState().selectNamespace('other'); await vi.advanceTimersByTimeAsync(1000);
  expect(queries.filter(query => query.kind === 'Service')).toHaveLength(1);
  expect(queries.filter(query => query.kind === 'ConfigMap').at(-1)?.namespace).toBe('other');
  const releaseOther = retainResourceKinds('test', ['Service', 'Node'], 'outside');
  await vi.advanceTimersByTimeAsync(1000);
  expect(queries.filter(query => query.kind === 'Service').at(-1)?.namespace).toBe('["backend","outside"]');
  releaseOther(); await vi.advanceTimersByTimeAsync(1000);
  expect(queries.filter(query => query.kind === 'Service').at(-1)?.namespace).toBe('backend');
  expect(queries.filter(query => query.kind === 'Service').every(query => query.namespace !== null)).toBe(true);
  expect(queries.filter(query => query.kind === 'Node')).toHaveLength(1);
  release(); await vi.advanceTimersByTimeAsync(1000);
});

it('distinguishes an unloaded namespace from absence, without restricting browser/demo or cluster resources', () => {
  expect(namespaceIsOutsideScope('other', 'backend', 'watch')).toBe(true);
  for (const [namespace, scope, mode] of [['backend','backend','watch'], ['other','all','watch'], [undefined,'backend','watch'], ['other','backend','demo'], ['other','backend','snapshot']] as const) {
    expect(namespaceIsOutsideScope(namespace, scope, mode)).toBe(false);
  }
});
