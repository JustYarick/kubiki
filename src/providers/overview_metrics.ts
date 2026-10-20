import type { K8sErrorPayload } from './errors.ts';
import { quantity } from '../core/resources/quantities.ts';
export interface ContainerMetric { name: string; cpu: string; memory: string }
export interface PodMetric { name: string; namespace: string; timestamp: string; window: string; containers: ContainerMetric[] }
export interface NodeMetric { name: string; timestamp: string; window: string; cpu: string; memory: string }
export interface MetricSource<T> { items: T[] | null; error: K8sErrorPayload | null }
export interface OverviewMetrics { context: string; namespace: string | null; pods: MetricSource<PodMetric>; nodes: MetricSource<NodeMetric> }
const fail = () => { throw new Error('Metrics API returned an invalid response'); };
export function normalizeMetricList(raw: any, kind: 'pods' | 'nodes'): PodMetric[] | NodeMetric[] {
  if (!Array.isArray(raw?.items)) return fail();
  return raw.items.map((item: any) => kind === 'nodes' ? { name: item.metadata?.name, timestamp: item.timestamp, window: item.window, cpu: item.usage?.cpu, memory: item.usage?.memory }
    : { name: item.metadata?.name, namespace: item.metadata?.namespace, timestamp: item.timestamp, window: item.window, containers: item.containers?.map((container: any) => ({ name: container.name, cpu: container.usage?.cpu, memory: container.usage?.memory })) });
}
export function validateMetrics(data: OverviewMetrics, context: string, namespace: string | null): OverviewMetrics {
  if (!data || data.context !== context || data.namespace !== namespace || !data.pods || !data.nodes) return fail();
  const validate = (source: MetricSource<any>, kind: 'pods' | 'nodes') => {
    if (source.items === null) { if (!source.error && !(kind === 'nodes' && namespace !== null)) return fail();return; }
    if (!Array.isArray(source.items) || source.error) return fail();
    const names = new Set<string>();
    for (const item of source.items) {
      if (typeof item.name !== 'string' || !item.name || typeof item.timestamp !== 'string' || !Number.isFinite(Date.parse(item.timestamp)) || typeof item.window !== 'string' || !/^(?:\d+(?:\.\d+)?(?:h|m|s|ms|us|µs|ns))+$/.test(item.window)) return fail();
      const key = `${item.namespace ?? ''}/${item.name}`;if (names.has(key)) return fail();names.add(key);
      const values = kind === 'pods' ? item.containers : [item];
      if (kind === 'pods' && (typeof item.namespace !== 'string' || !item.namespace || namespace && item.namespace !== namespace || !Array.isArray(values) || !values.length)) return fail();
      const containerNames = new Set<string>();
      for (const value of values) {
        if (typeof value.name !== 'string' || !value.name || containerNames.has(value.name) || quantity(value.cpu) === null || quantity(value.memory) === null) return fail();
        containerNames.add(value.name);
      }
    }
  };
  const checked = <T>(source: MetricSource<T>, kind: 'pods' | 'nodes'): MetricSource<T> => {
    try { validate(source, kind);return source; }
    catch { return { items: null, error: { code: 'internal', message: `Metrics API returned an invalid ${kind} response`, operation: 'metrics', context, retryable: false, status: 502 } }; }
  };
  return { ...data, pods: checked(data.pods, 'pods'), nodes: namespace ? { items: null, error: null } : checked(data.nodes, 'nodes') };
}
