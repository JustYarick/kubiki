import { expect, it } from 'vitest';
import { PodMetricsHistory, podMetricPoint, podMetricUsage } from '../../src/providers/pod_metrics_history';
import type { PodMetric } from '../../src/providers/overview_metrics';

const metric = (timestamp = 150000): PodMetric => ({ name: 'web', namespace: 'apps', timestamp: new Date(timestamp).toISOString(), window: '15s', containers: [{ name: 'app', cpu: '300m', memory: '100Mi' }, { name: 'sidecar', cpu: '100m', memory: '28Mi' }] });
it('sums measured containers without treating missing or invalid data as zero', () => {
  expect(podMetricUsage(metric())).toEqual({ cpu: .4, memory: 128 * 1024 ** 2 });
  expect(podMetricUsage(undefined)).toEqual({ cpu: null, memory: null });
  const invalid = metric(); invalid.containers[1].cpu = 'invalid';
  expect(podMetricUsage(invalid).cpu).toBeNull();
  expect(podMetricUsage({ ...metric(), containers: [] })).toEqual({ cpu: null, memory: null });
});
it('rejects stale, future or previous-incarnation observations', () => {
  expect(podMetricPoint(metric(), 100000, 150000)).toMatchObject({ at: 150000, cpu: .4 });
  expect(podMetricPoint(metric(), 160000, 170000)).toBeUndefined();
  expect(podMetricPoint(metric(), 100000, 300001)).toBeUndefined();
  expect(podMetricPoint(metric(190001), 100000, 150000)).toBeUndefined();
});
it('retains independent Pod identities, rejects repeated and out-of-order timestamps, and preserves history on errors', () => {
  const cache = new PodMetricsHistory();
  const point = podMetricPoint(metric(), 0, 150000)!;
  const key = JSON.stringify(['production', 'apps', 'web', 'original-uid']);
  const first = cache.record(key, point, 0);
  expect(cache.record(key, point, 0)).toBe(first);
  expect(cache.record(key, { ...point, at: point.at - 1 }, 0)).toBe(first);
  expect(cache.record(key, undefined, 0)).toBe(first);
  expect(cache.get(JSON.stringify(['staging', 'apps', 'web', 'original-uid']))).toEqual([]);
  expect(cache.get(JSON.stringify(['production', 'other', 'web', 'original-uid']))).toEqual([]);
  expect(cache.get(JSON.stringify(['production', 'apps', 'web', 'new-uid']))).toEqual([]);
  const second = cache.record(key, { ...point, at: point.at + 15000, cpu: .8 }, 0);
  expect(second.map(sample => sample.cpu)).toEqual([.4, .8]);
  expect(cache.record(key, undefined, point.at + 1)).toHaveLength(1);
});
it('bounds histories to 32 viewed Pods and 120 observations per Pod', () => {
  const cache = new PodMetricsHistory();
  for (let i = 0; i < 33; i++) cache.record(`pod-${i}`, { at: 150000, cpu: 1, memory: 1 }, 0);
  expect(cache.get('pod-0')).toEqual([]);
  for (let i = 1; i <= 140; i++) cache.record('pod-32', { at: 150000 + i * 15000, cpu: i, memory: i }, 0);
  expect(cache.get('pod-32')).toHaveLength(120);
  expect(cache.get('pod-32').at(-1)?.cpu).toBe(140);
});
