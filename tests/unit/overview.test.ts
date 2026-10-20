import { it, expect } from 'vitest';
import { buildOverview, type OverviewInput } from '../../src/core/resources/overview';
import { RESOURCE_TYPES, resourceQuery } from '../../src/core/resources/resource_types';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { useWorkspaceStore } from '../../src/state/workspace_store';
import type { ResourceKind } from '../../src/types/k8s';
function input(): OverviewInput {
  const data = { resources: Object.fromEntries(RESOURCE_TYPES.map(type => [type.kind, new Map()])), namespace: 'all', context: 'test', syncMode: 'snapshot', loading: false, connected: true, watchStates: {}, loadErrors: {} } as OverviewInput;
  const add = (kind: ResourceKind, name: string, namespace?: string, status = {}) => {
    const item = mapK8sResource({ kind, metadata: { uid: name, name, namespace }, status }, kind); data.resources[kind].set(item.uid, item); return item;
  };
  add('Pod', 'good', 'a', { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, state: { running: {} }, restartCount: 2 }], initContainerStatuses: [{ name: 'init', state: { terminated: { exitCode: 0 } }, restartCount: 1 }] });
  add('Pod', 'bad', 'b', { phase: 'Failed' });add('Deployment', 'web', 'a');add('ReplicaSet', 'web-replica', 'a');add('Service', 'web-service', 'a');
  add('Node', 'node', undefined, { conditions: [{ type: 'Ready', status: 'True' }] });add('Namespace', 'a');
  const event = add('Event', 'warning', 'b'); event.raw!.type = 'Warning';
  return data;
}
it('summarizes cluster phases, all container restarts, health and nonduplicated workloads', () => {
  const result = buildOverview(input());
  expect(result.row('Pod')?.count).toBe(2);expect(result.phases).toMatchObject({ Running: 1, Failed: 1 });expect(result.restarts).toBe(3);expect(result.readyNodes).toBe(1);expect(result.workloads).toBe(1);expect(result.warningEvents).toBe(1);expect(result.issues.some(entry => entry.item.name === 'bad')).toBe(true);expect(result.total).toBe(7);
});
it('namespace summary excludes foreign and cluster scoped objects and Events from the object total', () => {
  const data = input();data.namespace = 'a';const result = buildOverview(data);
  expect(result.row('Pod')?.count).toBe(1);expect(result.row('Node')).toBeUndefined();expect(result.row('Namespace')).toBeUndefined();expect(result.phases.Failed).toBe(0);expect(result.warningEvents).toBe(0);expect(result.total).toBe(4);
  data.namespace = 'empty';expect(buildOverview(data).total).toBe(0);
});
it('never treats unavailable data as an empty successful list, while retaining stale snapshots', () => {
  const data = input();data.loadErrors.Secret = { message: 'Forbidden' };data.loadErrors.Pod = { message: 'Disconnected' };const result = buildOverview(data);
  expect(result.row('Secret')).toMatchObject({ count: null, state: 'unavailable' });expect(result.row('Pod')).toMatchObject({ count: 2, state: 'stale' });
  data.loading = true;delete data.loadErrors.Secret;expect(buildOverview(data).row('Secret')?.state).toBe('loading');
});
it('watch snapshots must cover the context and selected namespace, including All Namespaces transitions', () => {
  const data = input();data.syncMode = 'watch';data.namespace = 'a';data.watchStates.Pod = { query: resourceQuery('test', 'Pod', 'b'), phase: 'live', hasSnapshot: true };
  expect(buildOverview(data).row('Pod')).toMatchObject({ count: null, state: 'loading' });
  data.watchStates.Pod!.query = resourceQuery('test', 'Pod');expect(buildOverview(data).row('Pod')).toMatchObject({ count: 1, state: 'ready' });
  data.namespace = 'all';data.watchStates.Pod!.query = resourceQuery('test', 'Pod', 'a');expect(buildOverview(data).row('Pod')?.count).toBeNull();
  data.watchStates.Pod!.query = resourceQuery('other', 'Pod');expect(buildOverview(data).row('Pod')?.count).toBeNull();
  data.watchStates.Pod!.query = resourceQuery('test', 'Pod');data.watchStates.Pod!.phase = 'reconnecting';expect(buildOverview(data).row('Pod')).toMatchObject({ count: 2, state: 'stale' });
});
it('opens a single persistent Overview tab without binding it to a cluster or object', () => {
  useWorkspaceStore.setState({ tabs: [], activeTabId: '', splitTabId: null });useWorkspaceStore.getState().openOverview();useWorkspaceStore.getState().openOverview();
  expect(useWorkspaceStore.getState().tabs).toEqual([{ id: 'tab-overview', title: 'Overview', type: 'overview' }]);
});
