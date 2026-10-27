import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invalidateHelmGraphs, subscribeHelmInventory } from '../../src/providers/helm_inventory_subscriptions';
const read = vi.hoisted(() => vi.fn());
vi.mock('../../src/providers/k8s_provider', () => ({ k8s: { getHelmInventory: read } }));
const inventory = Array.from({ length: 401 }, (_, index) => ({ name: `web-${index}`, namespace: 'backend', revision: '1', status: 'deployed', chart: 'web-1', app_version: '1', updated: '' }));
const stops: (() => void)[] = [];
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  read.mockReset().mockResolvedValue(inventory);
});
afterEach(() => { stops.splice(0).forEach(stop => stop());vi.useRealTimers();vi.unstubAllGlobals(); });

it('shares one complete snapshot between table and graph, including each refresh', async () => {
  const table = vi.fn();const graph = vi.fn();
  const offTable = subscribeHelmInventory('prod', null, table);stops.push(offTable);
  stops.push(subscribeHelmInventory('prod', 'all', graph));
  await flush();
  expect(read).toHaveBeenCalledOnce();
  expect(table.mock.calls.at(-1)?.[0].data).toHaveLength(401);
  expect(graph.mock.calls.at(-1)?.[0].data).toBe(table.mock.calls.at(-1)?.[0].data);
  invalidateHelmGraphs();await flush();expect(read).toHaveBeenCalledTimes(2);
  offTable();await vi.advanceTimersByTimeAsync(30000);expect(read).toHaveBeenCalledTimes(3);
});

it('cancels pre-mutation work and releases its replacement only after the last consumer leaves', async () => {
  read.mockImplementation((_context, _namespace, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  const offTable = subscribeHelmInventory('prod', 'backend', () => {});stops.push(offTable);
  const offGraph = subscribeHelmInventory('prod', 'backend', () => {});stops.push(offGraph);
  await flush();expect(read).toHaveBeenCalledOnce();
  const previous = read.mock.calls[0][2] as AbortSignal;
  invalidateHelmGraphs();await flush();await vi.advanceTimersByTimeAsync(0);
  expect(previous.aborted).toBe(true);expect(read).toHaveBeenCalledTimes(2);
  const signal = read.mock.calls[1][2] as AbortSignal;
  offTable();expect(signal.aborted).toBe(false);
  offGraph();expect(signal.aborted).toBe(true);
  await flush();await vi.advanceTimersByTimeAsync(60000);expect(read).toHaveBeenCalledTimes(2);
});
