import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadSubscriptions, type ReadSnapshot, type ReadVisibility } from '../../src/providers/read_subscriptions';
import { loadHelmInventory } from '../../src/providers/helm_inventory';
import type { HelmRelease } from '../../src/providers/helm_types';

const release = (name: string, namespace = 'backend'): HelmRelease => ({ name, namespace, revision: '1', chart: 'web-1', app_version: '1', updated: '', status: 'deployed' });
class Visibility implements ReadVisibility {
  hidden = false;
  listeners = new Set<() => void>();
  addEventListener(_type: string, fn: () => void) { this.listeners.add(fn); }
  removeEventListener(_type: string, fn: () => void) { this.listeners.delete(fn); }
  hide(hidden: boolean) { this.hidden = hidden;this.listeners.forEach(fn => fn()); }
}
const flush = async () => { await Promise.resolve();await Promise.resolve();await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
describe('shared dashboard reads', () => {
  it('shares polling, pauses in a hidden window, and releases the last subscriber', async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();const read = vi.fn(async () => 42);
    const subscriptions = new ReadSubscriptions(read, 15000, () => visibility);
    const states: ReadSnapshot<number>[] = [];
    const offA = subscriptions.subscribe('prod', state => states.push(state));
    const offB = subscriptions.subscribe('prod', () => {});
    await flush();expect(read).toHaveBeenCalledTimes(1);expect(states.at(-1)?.data).toBe(42);
    await vi.advanceTimersByTimeAsync(15000);expect(read).toHaveBeenCalledTimes(2);
    visibility.hide(true);await vi.advanceTimersByTimeAsync(45000);expect(read).toHaveBeenCalledTimes(2);
    visibility.hide(false);await flush();expect(read).toHaveBeenCalledTimes(3);
    offA();await vi.advanceTimersByTimeAsync(15000);expect(read).toHaveBeenCalledTimes(4);
    offB();await vi.advanceTimersByTimeAsync(30000);expect(read).toHaveBeenCalledTimes(4);expect(visibility.listeners.size).toBe(0);
  });
  it('retains the last data on failure and never publishes an aborted response into a new scope', async () => {
    const visibility = new Visibility();let resolve!: (value: number) => void;
    const read = vi.fn((_key: string, _signal: AbortSignal): Promise<number> => Promise.resolve(1));
    const subscriptions = new ReadSubscriptions(read, 15000, () => visibility);
    const states: ReadSnapshot<number>[] = [];
    const off = subscriptions.subscribe('prod', state => states.push(state));await flush();
    read.mockRejectedValueOnce(new Error('Forbidden'));subscriptions.refresh('prod');await flush();
    expect(states.at(-1)).toMatchObject({ data: 1, loading: false, error: { message: 'Forbidden' } });
    read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));subscriptions.refresh('prod');await flush();off();
    const stage: ReadSnapshot<number>[] = [];const stop = subscriptions.subscribe('stage', state => stage.push(state));await flush();
    const count = states.length;resolve(99);await flush();expect(states).toHaveLength(count);expect(stage.at(-1)?.data).toBe(1);stop();
  });
});
describe('complete Helm inventory', () => {
  it('collects all server pages before allowing global search and totals', async () => {
    const reader = vi.fn(async (_context: string, namespace: string | null, offset: number) => ({ context: 'prod', namespace, offset, limit: 100, has_more: offset === 0, items: offset ? [release('last')] : Array.from({ length: 100 }, (_, i) => release(`app-${i}`)) }));
    const items = await loadHelmInventory(reader, 'prod', null, new AbortController().signal);
    expect(items).toHaveLength(101);expect(items.some(item => item.name === 'last')).toBe(true);expect(reader.mock.calls.map(call => call[2])).toEqual([0, 100]);
  });
  it('expands selected namespaces into independent page sequences', async () => {
    const reader = vi.fn(async (_context: string, namespace: string | null, offset: number) => ({ context: 'prod', namespace, offset, limit: 100, has_more: offset === 0, items: [release(`app-${offset}`, namespace!)] }));
    const items = await loadHelmInventory(reader, 'prod', '["frontend","backend"]', new AbortController().signal);
    expect(items).toHaveLength(4);
    expect(reader.mock.calls.map(call => [call[1], call[2]])).toEqual(expect.arrayContaining([['backend', 0], ['backend', 100], ['frontend', 0], ['frontend', 100]]));
  });
  it('rejects incomplete or moving inventories instead of reporting partial totals', async () => {
    const abort = new AbortController();
    const reader = vi.fn(async (_context: string, namespace: string | null, offset: number) => { if (offset) throw new Error('second page denied');return { context: 'prod', namespace, offset, limit: 100, has_more: true, items: [release('app')] }; });
    await expect(loadHelmInventory(reader, 'prod', null, abort.signal)).rejects.toThrow('second page denied');
    reader.mockImplementation(async (_context, namespace, offset) => ({ context: 'prod', namespace, offset, limit: 100, has_more: offset === 0, items: [release('app')] }));
    await expect(loadHelmInventory(reader, 'prod', null, abort.signal)).rejects.toMatchObject({ code: 'conflict' });
    abort.abort();await expect(loadHelmInventory(reader, 'prod', null, abort.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });
});
