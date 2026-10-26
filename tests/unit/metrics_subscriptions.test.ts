import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MetricsSubscriptions, type MetricsSnapshot } from '../../src/providers/metrics_subscriptions';
import type { OverviewMetrics } from '../../src/providers/overview_metrics';
class Visibility extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event('visibilitychange')); }
}
const sample = (namespace: string | null = null): OverviewMetrics => ({ context: 'test', namespace, pods: { items: [], error: null }, nodes: { items: [], error: null } });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('shares polling and manual refresh across consumers and stops after the last unsubscribe', async () => {
  const visibility = new Visibility();
  const read = vi.fn(async () => sample());
  const subscriptions = new MetricsSubscriptions(read, () => visibility);
  const first = subscriptions.subscribe('test', null, vi.fn());
  const second = subscriptions.subscribe('test', null, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15000);
  expect(read).toHaveBeenCalledTimes(2);
  first(); subscriptions.refresh('test', null); await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(3);
  second(); await vi.advanceTimersByTimeAsync(60000);
  expect(read).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
});
it('pauses while hidden and keeps independent namespace scopes', async () => {
  const visibility = new Visibility();
  const read = vi.fn(async (_context: string, namespace: string | null) => sample(namespace));
  const subscriptions = new MetricsSubscriptions(read, () => visibility);
  const closeA = subscriptions.subscribe('test', 'a', vi.fn());
  const closeB = subscriptions.subscribe('test', 'b', vi.fn());
  await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(2);
  visibility.setHidden(true); await vi.advanceTimersByTimeAsync(60000); expect(read).toHaveBeenCalledTimes(2);
  visibility.setHidden(false); await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(4);
  closeA(); closeB();
});
it('does not overlap refreshes or publish late data from a closed scope', async () => {
  const visibility = new Visibility();
  let finish!: (value: OverviewMetrics) => void;
  const read = vi.fn(() => new Promise<OverviewMetrics>(resolve => { finish = resolve; }));
  const subscriptions = new MetricsSubscriptions(read, () => visibility);
  const received: MetricsSnapshot[] = [];
  const close = subscriptions.subscribe('test', null, data => received.push(data));
  await vi.advanceTimersByTimeAsync(0);
  subscriptions.refresh('test', null); subscriptions.refresh('test', null);
  expect(read).toHaveBeenCalledTimes(1);
  close(); finish(sample()); await vi.advanceTimersByTimeAsync(60000);
  expect(received.some(snapshot => snapshot.data)).toBe(false); expect(read).toHaveBeenCalledTimes(1);
});
