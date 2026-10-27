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
  it('coalesces invalidations and discards a pre-mutation read before publishing its replacement', async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    let finish!: (value: number) => void;
    let signal!: AbortSignal;
    const read = vi.fn((_key: string, abort: AbortSignal) => {
      signal = abort;
      return new Promise<number>(resolve => { finish = resolve; });
    });
    const subscriptions = new ReadSubscriptions(read, 15000, () => visibility);
    const states: ReadSnapshot<number>[] = [];
    const stop = subscriptions.subscribe('prod', state => states.push(state));
    await vi.advanceTimersByTimeAsync(0);
    subscriptions.refresh('prod', true);
    subscriptions.refresh('prod', true);
    expect(signal.aborted).toBe(true);
    read.mockResolvedValueOnce(2);
    finish(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(states.filter(state => state.data !== undefined).map(state => state.data)).toEqual([2]);
    stop();
  });
});
describe('complete Helm inventory', () => {
  it('collects an entire large scope with one snapshot read', async () => {
    const reader = vi.fn(async () => Array.from({ length: 1001 }, (_, i) => release(`app-${i}`)));
    const items = await loadHelmInventory(reader, 'prod', null, new AbortController().signal);
    expect(items).toHaveLength(1001);expect(items.some(item => item.name === 'app-1000')).toBe(true);
    expect(reader).toHaveBeenCalledOnce();
  });
  it('reads only selected namespaces and bounds concurrent snapshots', async () => {
    let running = 0;let maximum = 0;
    const reader = vi.fn(async (_context: string, namespace: string | null) => {
      running++;maximum = Math.max(maximum, running);
      await new Promise(resolve => setTimeout(resolve, 0));running--;
      return [release('web', namespace!)];
    });
    const namespaces = Array.from({ length: 20 }, (_, i) => `team-${i}`);
    const items = await loadHelmInventory(reader, 'prod', JSON.stringify(namespaces), new AbortController().signal);
    expect(items).toHaveLength(20);expect(maximum).toBe(3);
    expect(reader.mock.calls.map(call => call[1]).sort()).toEqual(namespaces.sort());
  });
  it('rejects incomplete/duplicate snapshots and stops queued work on cancellation', async () => {
    const abort = new AbortController();
    const reader = vi.fn(async () => { throw new Error('snapshot denied'); });
    await expect(loadHelmInventory(reader, 'prod', null, abort.signal)).rejects.toThrow('snapshot denied');
    const duplicate = vi.fn(async () => [release('app'), release('app')]);
    await expect(loadHelmInventory(duplicate, 'prod', null, abort.signal)).rejects.toMatchObject({ code: 'conflict' });
    abort.abort();reader.mockClear();
    await expect(loadHelmInventory(reader, 'prod', null, abort.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(reader).not.toHaveBeenCalled();
  });
});
