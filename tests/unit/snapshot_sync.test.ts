import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { syncResourceSnapshot } from '../../src/providers/snapshot_sync';
import { k8s } from '../../src/providers/k8s_provider';
import { useResourceStore } from '../../src/state/resource_store';
import { useClusterStore } from '../../src/state/cluster_store';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import type { ResourceItem } from '../../src/types/k8s';
const pod = (name: string, namespace = 'a') => mapK8sResource({ apiVersion: 'v1', kind: 'Pod', metadata: { uid: name, name, namespace } }, 'Pod');
beforeEach(() => { useResourceStore.getState().reset(); useClusterStore.getState().selectContext('prod'); useClusterStore.getState().selectNamespace('a'); });
afterEach(() => vi.restoreAllMocks());
it('cancels superseded reads and ignores late A → B → A responses without clearing the latest loading state', async () => {
  const reads: { finish: (items: ResourceItem[]) => void; signal?: AbortSignal }[] = [];
  vi.spyOn(k8s, 'getResources').mockImplementation((_context, _kind, _scope, signal) => new Promise(resolve => reads.push({ finish: resolve, signal })));
  const first = syncResourceSnapshot('prod', 'Pod', 'a');
  useClusterStore.getState().selectNamespace('b'); const second = syncResourceSnapshot('prod', 'Pod', 'b');
  useClusterStore.getState().selectNamespace('a'); const latest = syncResourceSnapshot('prod', 'Pod', 'a');
  expect(reads[0].signal?.aborted).toBe(true); expect(reads[1].signal?.aborted).toBe(true);
  reads[0].finish([pod('outdated-a')]); reads[1].finish([pod('outdated-b', 'b')]);
  expect(await first).toBe(false); expect(await second).toBe(false);
  expect(useResourceStore.getState().resources.Pod.size).toBe(0); expect(useResourceStore.getState().loadingKinds.Pod).toBe(true);
  reads[2].finish([pod('latest-a')]); expect(await latest).toBe(true);
  expect([...useResourceStore.getState().resources.Pod.keys()]).toEqual(['latest-a']); expect(useResourceStore.getState().loadingKinds.Pod).toBe(false);
});
it('keeps the last snapshot and clears busy state when the current read fails', async () => {
  useResourceStore.getState().setResourcesForKind('Pod', [pod('retained')]);
  vi.spyOn(k8s, 'getResources').mockRejectedValue(new Error('API temporarily unavailable'));
  await expect(syncResourceSnapshot('prod', 'Pod', 'a')).rejects.toThrow('API temporarily unavailable');
  expect(useResourceStore.getState().resources.Pod.has('retained')).toBe(true);
  expect(useResourceStore.getState().loadingKinds.Pod).toBe(false);
  expect(useResourceStore.getState().loadErrors.Pod?.message).toContain('API temporarily unavailable');
});
it('does not publish a late response into another cluster', async () => {
  let finish!: (items: ResourceItem[]) => void;
  vi.spyOn(k8s, 'getResources').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = syncResourceSnapshot('prod', 'Pod', 'a');
  useClusterStore.getState().selectContext('other'); useResourceStore.getState().reset(); finish([pod('old')]);
  expect(await pending).toBe(false); expect(useResourceStore.getState().resources.Pod.size).toBe(0);
});

it('falls back to the selected namespace when cluster-wide Pod reads are forbidden', async () => {
  const get = vi.spyOn(k8s, 'getResources').mockImplementation(async (_context, _kind, scope) => {
    if (scope === 'all') throw { code: 'forbidden', message: 'Cluster-wide read denied', retryable: false };
    return [pod('allowed')];
  });
  expect(await syncResourceSnapshot('prod', 'Pod', 'a')).toBe(true);
  expect(get.mock.calls.map(call => call[2])).toEqual(['all', 'a']);
  expect(useResourceStore.getState().resources.Pod.has('allowed')).toBe(true);
});
it('does not publish namespace fallback data after the namespace changes', async () => {
  let finish!: (items: ResourceItem[]) => void;
  vi.spyOn(k8s, 'getResources').mockImplementation(async (_context, _kind, scope) => {
    if (scope === 'all') throw { code: 'forbidden', message: 'Denied', retryable: false };
    return new Promise(resolve => { finish = resolve; });
  });
  const request = syncResourceSnapshot('prod', 'Pod', 'a');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  useClusterStore.getState().selectNamespace('b'); finish([pod('outdated')]);
  expect(await request).toBe(false);
  expect(useResourceStore.getState().resources.Pod.size).toBe(0);
});

it('does not repeat a forbidden all-namespaces request without a selected namespace', async () => {
  useClusterStore.getState().selectNamespace('all');
  const get = vi.spyOn(k8s, 'getResources').mockRejectedValue({ code: 'forbidden', message: 'Denied', retryable: false });
  await expect(syncResourceSnapshot('prod', 'Pod', 'all')).rejects.toMatchObject({ code: 'forbidden' });
  expect(get).toHaveBeenCalledTimes(1);
});
