import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invalidateHelmGraphs, loadHelmGraph } from '../../src/providers/use_helm_graph';
const list = vi.hoisted(() => vi.fn());
vi.mock('../../src/providers/k8s_provider', () => ({ k8s: { getHelmReleases: list } }));
const page = (namespace: string, offset = 0, count = 1, more = false) => ({ items: Array.from({ length: count }, (_, index) => ({ name: `web-${offset + index}`, namespace, revision: '1', status: 'deployed', chart: 'web-1', app_version: '1', updated: '' })), has_more: more });
beforeEach(() => { invalidateHelmGraphs(); list.mockReset(); });
afterEach(() => vi.useRealTimers());
it('deduplicates concurrent namespace requests, caches for 30 seconds and isolates context/namespace keys', async () => {
  vi.useFakeTimers(); list.mockImplementation(async (_context, namespace) => page(namespace));
  const [first, second] = await Promise.all([loadHelmGraph('prod', 'a'), loadHelmGraph('prod', 'a')]);
  expect(first).toBe(second); expect(list).toHaveBeenCalledTimes(1);
  expect(await loadHelmGraph('prod', 'a')).toBe(first);
  await loadHelmGraph('prod', 'b'); await loadHelmGraph('other', 'a'); expect(list).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(30001); await loadHelmGraph('prod', 'a'); expect(list).toHaveBeenCalledTimes(4);
});
it('stops namespace expansion at 250 releases and never keeps a partial cached graph', async () => {
  list.mockImplementation(async (_context, namespace, offset) => page(namespace, offset, 100, true));
  await expect(loadHelmGraph('prod', 'big')).rejects.toThrow('250'); expect(list).toHaveBeenCalledTimes(3);
  list.mockResolvedValue(page('big')); expect(await loadHelmGraph('prod', 'big')).toHaveLength(1); expect(list).toHaveBeenCalledTimes(4);
});
it('does not cache a late snapshot after a mutation invalidates the graph', async () => {
  let resolve!: (value: ReturnType<typeof page>) => void;
  list.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const old = loadHelmGraph('prod', 'a'); invalidateHelmGraphs();
  list.mockResolvedValue(page('a', 0, 2)); const fresh = await loadHelmGraph('prod', 'a');
  resolve(page('a')); await old;
  expect(await loadHelmGraph('prod', 'a')).toBe(fresh); expect(fresh).toHaveLength(2); expect(list).toHaveBeenCalledTimes(2);
});
it('bounds retained namespace snapshots to eight and retries a failed read explicitly', async () => {
  list.mockRejectedValueOnce(new Error('Helm unavailable'));
  await expect(loadHelmGraph('prod', 'a')).rejects.toThrow('unavailable');
  list.mockImplementation(async (_context, namespace) => page(namespace));
  await loadHelmGraph('prod', 'a');
  for (let index = 0; index < 8; index++) await loadHelmGraph('prod', `ns-${index}`);
  const calls = list.mock.calls.length; await loadHelmGraph('prod', 'a'); expect(list).toHaveBeenCalledTimes(calls + 1);
});
