import { afterEach, expect, it, vi } from 'vitest';
import { MetricsSubscriptions, type MetricsSnapshot } from '../../src/providers/metrics_subscriptions';
import type { OverviewMetrics } from '../../src/providers/overview_metrics';

afterEach(() => vi.useRealTimers());

it('keeps successful metric sources when a later sample is incomplete, without borrowing another scope', async () => {
  vi.useFakeTimers();
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  const pod = { name: 'web', namespace: 'a', timestamp: '', window: '', containers: [] };
  const first: OverviewMetrics = { context: 'test', namespace: 'a', pods: { items: [pod], error: null }, nodes: { items: [], error: null } };
  const incomplete: OverviewMetrics = { ...first, pods: { items: null, error: { code: 'forbidden', message: 'Forbidden', operation: 'metrics', retryable: false } } };
  const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(incomplete);
  const subscriptions = new MetricsSubscriptions(read, () => visibility);
  const received: MetricsSnapshot[] = [];
  const closeA = subscriptions.subscribe('test', 'a', snapshot => received.push(snapshot));
  await vi.advanceTimersByTimeAsync(0);
  subscriptions.refresh('test', 'a');
  await vi.advanceTimersByTimeAsync(0);
  expect(received.at(-1)?.data?.pods).toEqual({ items: [pod], error: incomplete.pods.error });
  const other: MetricsSnapshot[] = [];
  const closeB = subscriptions.subscribe('test', 'b', snapshot => other.push(snapshot));
  await vi.advanceTimersByTimeAsync(0);
  expect(other.at(-1)?.data?.pods.items).toBeNull();
  closeA(); closeB();
});
