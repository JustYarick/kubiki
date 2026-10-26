import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { scanClusterInventory, cancelResourceSnapshots } from '../../src/providers/snapshot_sync';
import { k8s } from '../../src/providers/k8s_provider';
import { useClusterStore } from '../../src/state/cluster_store';
import { useResourceStore } from '../../src/state/resource_store';
import { RESOURCE_TYPES } from '../../src/core/resources/resource_types';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import type { ResourceKind } from '../../src/types/k8s';

beforeEach(() => { useResourceStore.getState().reset(); useClusterStore.setState({ currentContext: 'test', selectedNamespace: 'all' }); });
afterEach(() => { cancelResourceSnapshots(); vi.restoreAllMocks(); });

it('collects every catalog kind once, caches health data and limits initial LIST concurrency', async () => {
  let running = 0; let maximum = 0;
  const seen: string[] = [];
  vi.spyOn(k8s, 'getResources').mockImplementation(async (_context, kind, scope) => {
    expect(scope).toBe('all'); seen.push(kind); running++; maximum = Math.max(maximum, running);
    await new Promise(resolve => setTimeout(resolve, 0)); running--;
    return kind === 'Pod' ? [mapK8sResource({ apiVersion: 'v1', kind, metadata: { name: 'failed', uid: 'pod', namespace: 'team' }, status: { phase: 'Failed' } }, kind)] : [];
  });
  const results = await scanClusterInventory('test', RESOURCE_TYPES.map(type => type.kind as ResourceKind), 'all');
  expect(results.every(result => result.status === 'fulfilled')).toBe(true);
  expect(new Set(seen).size).toBe(RESOURCE_TYPES.length); expect(seen).toHaveLength(RESOURCE_TYPES.length); expect(maximum).toBe(4);
  expect(useResourceStore.getState().resources.Pod.get('pod')?.status).toBe('Failed');
  expect(Object.values(useResourceStore.getState().watchStates).every(state => state?.phase === 'stopped' && state.hasSnapshot)).toBe(true);
});
it('stops queued collections and ignores late responses after context cancellation', async () => {
  const finish: (() => void)[] = [];
  const read = vi.spyOn(k8s, 'getResources').mockImplementation(() => new Promise(resolve => finish.push(() => resolve([]))));
  const inventory = scanClusterInventory('test', RESOURCE_TYPES.map(type => type.kind as ResourceKind), 'all');
  expect(read).toHaveBeenCalledTimes(4);
  cancelResourceSnapshots(); useClusterStore.setState({ currentContext: 'other' });
  finish.forEach(resolve => resolve()); await inventory;
  expect(read).toHaveBeenCalledTimes(4); expect(useResourceStore.getState().watchStates).toEqual({});
});
it('keeps forbidden collections incomplete and falls back only to an allowed namespace', async () => {
  const read = vi.spyOn(k8s, 'getResources').mockImplementation(async (_context, kind, scope) => {
    if (kind === 'Secret' || scope === 'all') throw { code: 'forbidden', message: 'Forbidden', retryable: false };
    return [];
  });
  const results = await scanClusterInventory('test', ['Pod', 'Secret'], 'team');
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(read.mock.calls.filter(call => call[1] === 'Pod').map(call => call[2])).toEqual(['all', 'team']);
  expect(useResourceStore.getState().watchStates.Pod).toMatchObject({ query: { namespace: 'team' }, hasSnapshot: true });
  expect(useResourceStore.getState().watchStates.Secret).toMatchObject({ phase: 'failed', hasSnapshot: false });
});
