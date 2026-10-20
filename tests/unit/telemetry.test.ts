import { it, expect } from 'vitest';
import { quantity, cpuText, memoryText } from '../../src/core/resources/quantities';
import { podBudget, buildTelemetry, appendHistory } from '../../src/core/resources/telemetry';
import { validateMetrics, type OverviewMetrics } from '../../src/providers/overview_metrics';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
const now = Date.parse('2026-10-20T12:00:00Z');
const pod = (spec: any = {}) => mapK8sResource({ metadata: { name: 'web', namespace: 'a', uid: 'pod', creationTimestamp: new Date(now - 60000).toISOString() }, spec: { containers: [{ name: 'app' }], ...spec }, status: { phase: 'Running' } }, 'Pod');
const metrics = (): OverviewMetrics => ({ context: 'test', namespace: 'a', pods: { items: [{ name: 'web', namespace: 'a', timestamp: new Date(now).toISOString(), window: '15s', containers: [{ name: 'app', cpu: '125000000n', memory: '64Mi' }] }], error: null }, nodes: { items: null, error: null } });
it('parses base, nano/micro/milli, decimal/binary and exponent quantities; never converts missing or malformed to zero', () => {
  expect(quantity('125000000n')).toBe(.125);expect(quantity('500u')).toBe(.0005);expect(quantity('250m')).toBe(.25);expect(quantity('1.5Gi')).toBe(1.5 * 1024 ** 3);expect(quantity('2G')).toBe(2e9);expect(quantity('1e3')).toBe(1000);expect(quantity('0')).toBe(0);expect(quantity('400m')).toBe(.4);
  for (const value of [undefined, null, '', '-1', '2GiB', '1e999', Infinity]) expect(quantity(value)).toBeNull();expect(cpuText(.125)).toBe('125m');expect(memoryText(1024 ** 3)).toBe('1 GiB');
});
it('effective Pod budgets include ordered sidecars, init peaks, overhead, Pod-level overrides and absent limits', () => {
  const resources = (cpu: string, limit = '2') => ({ requests: { cpu }, limits: { cpu: limit } });
  const item = pod({ containers: [{ name: 'app', resources: resources('300m') }], initContainers: [{ name: 'sidecar', restartPolicy: 'Always', resources: resources('200m', '1') }, { name: 'init', resources: resources('1500m', '3') }], overhead: { cpu: '50m' } });
  expect(podBudget(item, 'cpu')).toEqual({ request: 1.75, limit: 4.05 });
  item.raw!.spec.resources = { requests: { cpu: '4' }, limits: { cpu: '6' } };expect(podBudget(item, 'cpu')).toEqual({ request: 4.05, limit: 6.05 });
  expect(podBudget(pod(), 'cpu')).toEqual({ request: 0, limit: null });
  expect(podBudget(pod({ containers: [{ name: 'app', resources: { limits: { cpu: '2' } } }] }), 'cpu').request).toBe(2);
});
it('aggregates usage without inventing unmeasured Pods, honors namespace, recreation and sample freshness', () => {
  const data = metrics();const item = pod();const state = buildTelemetry(data, [item], null, 'a', now);
  expect(state.cpu).toBe(.125);expect(state.memory).toBe(64 * 1024 ** 2);expect(state.complete).toBe(true);expect(state.point?.at).toBe(now);
  expect(buildTelemetry(data, [item, { ...item, name: 'pending', uid: 'pending' }], null, 'a', now)).toMatchObject({ measured: 1, complete: false });
  expect(buildTelemetry(data, [item], null, 'b', now).cpu).toBeNull();
  item.creationTimestamp = new Date(now + 1000).toISOString();expect(buildTelemetry(data, [item], null, 'a', now).cpu).toBeNull();
  expect(buildTelemetry(data, null, null, 'a', now + 121000)).toMatchObject({ stale: true, point: undefined });
  data.pods.items = [];expect(buildTelemetry(data, [], null, 'a', now).cpu).toBe(0);expect(buildTelemetry(data, [pod()], null, 'a', now).cpu).toBeNull();
});
it('uses Node usage for cluster cards and keeps physical capacity separate from allocatable and Pod requests', () => {
  const data = { ...metrics(), namespace: null, nodes: { items: [{ name: 'worker', cpu: '2', memory: '3Gi', timestamp: new Date(now).toISOString(), window: '15s' }], error: null } };
  const node = mapK8sResource({ metadata: { name: 'worker', uid: 'node' }, status: { capacity: { cpu: '8', memory: '16Gi' }, allocatable: { cpu: '7', memory: '14Gi' } } }, 'Node');
  const result = buildTelemetry(data, [pod()], [node], null, now);expect(result.cpu).toBe(2);expect(result.budgets.cpu).toMatchObject({ capacity: 8, allocatable: 7, request: 0 });expect(result.memory).toBe(3 * 1024 ** 3);
});
it('history only accepts newer source samples and stays bounded in memory and time', () => {
  let history: import('../../src/core/resources/telemetry').HistoryPoint[] = [];
  for (let index = 0; index < 200; index++) history = appendHistory(history, { at: now + index * 15000, cpu: index, memory: index });
  expect(history).toHaveLength(120);expect(appendHistory(history, history[history.length - 1])).toBe(history);expect(appendHistory(history, { at: now, cpu: 0, memory: 0 })).toBe(history);expect(appendHistory(history, { at: now + 99999999, cpu: 1, memory: 1 })).toHaveLength(1);
});
it('validates metrics response scope, missing samples, duplicate containers and units', () => {
  expect(validateMetrics(metrics(), 'test', 'a')).toBeTruthy();expect(() => validateMetrics(metrics(), 'wrong', 'a')).toThrow();
  const invalid = metrics();invalid.pods.items![0].containers[0].cpu = 'bad';expect(validateMetrics(invalid, 'test', 'a').pods.error?.code).toBe('internal');
  const duplicate = metrics();duplicate.pods.items![0].containers.push(duplicate.pods.items![0].containers[0]);expect(validateMetrics(duplicate, 'test', 'a').pods.error?.code).toBe('internal');
});
