import { afterEach, expect, it, vi } from 'vitest';
import { MetricsSubscriptions, type MetricsSnapshot } from '../../src/providers/metrics_subscriptions';
import type { OverviewMetrics } from '../../src/providers/overview_metrics';

afterEach(() => vi.useRealTimers());

it('keeps successful metric sources when a later sample is incomplete, without borrowing another scope', async () => {
  vi.useFakeTimers();
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  const pod = { name: 'web', namespace: 'a', timestamp: new Date().toISOString(), window: '15s', containers: [{ name: 'app', cpu: '100m', memory: '64Mi' }] };
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

function measured(context: string, namespace: string | null, cpu = '250m'): OverviewMetrics {
  const timestamp = new Date().toISOString();
  return { context, namespace,
    pods: { items: [{ name: 'web', namespace: namespace ?? 'a', timestamp, window: '15s', containers: [{ name: 'app', cpu, memory: '64Mi' }] }], error: null },
    nodes: { items: namespace ? null : [{ name: 'worker', timestamp, window: '15s', cpu, memory: '128Mi' }], error: null },
  };
}

it('continues shared history while the dashboard is unmounted and never duplicates a source sample on return', async () => {
  vi.useFakeTimers();
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  const read = vi.fn(async (context: string, namespace: string | null) => measured(context, namespace));
  const subscriptions = new MetricsSubscriptions(read, () => visibility);
  const retained = subscriptions.subscribe('test', null, () => {});
  const initial: MetricsSnapshot[] = [];
  const closeView = subscriptions.subscribe('test', null, snapshot => initial.push(snapshot));
  await vi.advanceTimersByTimeAsync(0);
  expect(initial.at(-1)?.history).toEqual([{ at: Date.now(), cpu: .25, memory: 128 * 1024 ** 2 }]);
  expect(read).toHaveBeenCalledTimes(1);
  closeView();
  await vi.advanceTimersByTimeAsync(45000);
  const resumed: MetricsSnapshot[] = [];
  const closeResumed = subscriptions.subscribe('test', null, snapshot => resumed.push(snapshot));
  expect(resumed.at(-1)?.history).toHaveLength(4);
  expect(read).toHaveBeenCalledTimes(4);
  subscriptions.refresh('test', null);
  await vi.advanceTimersByTimeAsync(0);
  expect(resumed.at(-1)?.history).toHaveLength(4);
  const times = resumed.at(-1)!.history.map(point => point.at);
  expect(times.slice(1).every((at, index) => at - times[index] === 15000)).toBe(true);
  closeResumed(); retained();
  await vi.advanceTimersByTimeAsync(60000);
  expect(read).toHaveBeenCalledTimes(5);
});

it('isolates context and namespace histories and aggregates each Metrics API scope without a view inventory', async () => {
  vi.useFakeTimers();
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  const read = vi.fn(async (context: string, namespace: string | null) => measured(context, namespace, context === 'other' ? '4' : namespace === 'b' ? '2' : '1'));
  const subscriptions = new MetricsSubscriptions(read, () => visibility);
  const scopes: MetricsSnapshot[][] = [[], [], []];
  const stops = [['test', 'a'], ['test', 'b'], ['other', 'a']].map(([context, namespace], index) => subscriptions.subscribe(context, namespace, snapshot => scopes[index].push(snapshot)));
  await vi.advanceTimersByTimeAsync(15000);
  expect(scopes.map(scope => scope.at(-1)?.history.map(point => point.cpu))).toEqual([[1, 1], [2, 2], [4, 4]]);
  stops.forEach(stop => stop());
});

it('keeps history across failed, partial and stale reads without recording cached data as a new observation', async () => {
  vi.useFakeTimers();
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  const first = measured('test', 'a');
  const read = vi.fn().mockResolvedValue(first);
  const subscriptions = new MetricsSubscriptions(read, () => visibility);
  const received: MetricsSnapshot[] = [];
  const stop = subscriptions.subscribe('test', 'a', snapshot => received.push(snapshot));
  await vi.advanceTimersByTimeAsync(0);
  read.mockResolvedValue({ ...first, pods: { items: null, error: { code: 'forbidden', message: 'Forbidden', operation: 'metrics', retryable: false } } });
  await vi.advanceTimersByTimeAsync(15000);
  expect(received.at(-1)?.history).toHaveLength(1);
  expect(received.at(-1)?.data?.pods.items).toEqual(first.pods.items);
  read.mockRejectedValue(new Error('offline'));
  await vi.advanceTimersByTimeAsync(15000);
  expect(received.at(-1)).toMatchObject({ error: 'offline', history: [{ cpu: .25 }] });
  read.mockResolvedValue(first);
  await vi.advanceTimersByTimeAsync(120000);
  expect(received.at(-1)?.history).toHaveLength(1);
  read.mockImplementation(async () => measured('test', 'a', '500m'));
  await vi.advanceTimersByTimeAsync(15000);
  expect(received.at(-1)?.history.map(point => point.cpu)).toEqual([.25, .5]);
  stop();
});

it('suspends retained polling while the document is hidden and resumes with the existing history', async () => {
  vi.useFakeTimers();
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  const read = vi.fn(async (context: string, namespace: string | null) => measured(context, namespace));
  const subscriptions = new MetricsSubscriptions(read, () => visibility);
  const received: MetricsSnapshot[] = [];
  const stop = subscriptions.subscribe('test', null, snapshot => received.push(snapshot));
  await vi.advanceTimersByTimeAsync(0);
  visibility.hidden = true;
  visibility.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60000);
  expect(read).toHaveBeenCalledTimes(1);
  visibility.hidden = false;
  visibility.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(received.at(-1)?.history).toHaveLength(2);
  stop();
});

it('retains independent node histories, shares reads, and never records cached or duplicate node samples', async () => {
  vi.useFakeTimers();
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  const make = (): OverviewMetrics => ({ ...measured('test', null), nodes: { items: [
    { name: 'worker-a', timestamp: new Date().toISOString(), window: '15s', cpu: '1', memory: '1Gi' },
    { name: 'worker-b', timestamp: new Date().toISOString(), window: '15s', cpu: '2', memory: '2Gi' },
  ], error: null } });
  const read = vi.fn(async () => make());
  const subscriptions = new MetricsSubscriptions(read, () => visibility);
  const states: MetricsSnapshot[] = [];
  const closeA = subscriptions.subscribe('test', null, snapshot => states.push(snapshot));
  const closeB = subscriptions.subscribe('test', null, () => {});
  await vi.advanceTimersByTimeAsync(15000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(states.at(-1)?.nodeHistory['worker-a'].map(point => point.cpu)).toEqual([1, 1]);
  expect(states.at(-1)?.nodeHistory['worker-b'].map(point => point.cpu)).toEqual([2, 2]);
  subscriptions.refresh('test', null);
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)?.nodeHistory['worker-a']).toHaveLength(2);
  read.mockResolvedValue({ ...make(), nodes: { items: null, error: { code: 'forbidden', message: 'Denied', operation: 'metrics', retryable: false } } });
  await vi.advanceTimersByTimeAsync(15000);
  expect(states.at(-1)?.nodeHistory['worker-a']).toHaveLength(2);
  expect(states.at(-1)?.data?.nodes.error?.code).toBe('forbidden');
  closeA(); closeB();
});
