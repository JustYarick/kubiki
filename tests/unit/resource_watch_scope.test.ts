import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startResourceWatches, stopResourceWatches, refreshResourceWatches } from '../../src/state/resource_watch';
import { useClusterStore } from '../../src/state/cluster_store';
import { useResourceStore } from '../../src/state/resource_store';
import { isValidNamespaceName, namespaceIsOutsideScope, resourceType, type ResourceQuery } from '../../src/core/resources/resource_types';
import type { WatchBatch } from '../../src/providers/watch_types';
import { useWorkspaceStore } from '../../src/state/workspace_store';
import { useUiStore } from '../../src/state/ui_store';

const mock = vi.hoisted(() => ({ supportsResourceWatch: true, watchResources: vi.fn() }));
vi.mock('../../src/providers/k8s_provider', () => ({ k8s: mock }));
beforeEach(() => { vi.useFakeTimers(); useResourceStore.getState().reset(); useWorkspaceStore.setState({ tabs: [{ id: 'pods', type: 'resource-list', kind: 'Pod', title: 'Pods' }], activeTabId: 'pods', splitTabId: null }); useUiStore.setState({ inspectorCollapsed: true }); useClusterStore.setState({ currentContext: 'test', selectedNamespace: 'backend', availableNamespaces: [], availableResourceKinds: null }); mock.watchResources.mockReset(); });
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

it('distinguishes an unloaded namespace from absence, without restricting browser/demo or cluster resources', () => {
  expect(namespaceIsOutsideScope('other', 'backend', 'watch')).toBe(true);
  for (const [namespace, scope, mode] of [['backend','backend','watch'], ['other','all','watch'], [undefined,'backend','watch'], ['other','backend','demo'], ['other','backend','snapshot']] as const) {
    expect(namespaceIsOutsideScope(namespace, scope, mode)).toBe(false);
  }
});
