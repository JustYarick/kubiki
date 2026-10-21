import type { ResourceItem } from '../../types/k8s';
import type { OverviewMetrics } from '../../providers/overview_metrics';
import { quantity } from './quantities';
import { inNamespaceScope } from './namespace_scope';
export type Dimension = 'cpu' | 'memory';
export interface Budget { request: number | null; limit: number | null }
export interface UsageRow { name: string; namespace?: string; item?: ResourceItem; cpu: number; memory: number; timestamp: number; window: string; containers: { name: string; cpu: number; memory: number }[] }
export interface HistoryPoint { at: number; cpu: number | null; memory: number | null }
const dimensions: Dimension[] = ['cpu', 'memory'];
const active = (pod: ResourceItem) => !['Succeeded', 'Completed', 'Complete', 'Failed'].includes(pod.raw?.status?.phase ?? pod.status ?? '');
const add = (a: number | null, b: number | null) => a === null || b === null ? null : a + b;
/** Configured effective Pod budget, including ordered restartable init containers and overhead. */
export function podBudget(pod: ResourceItem, dimension: Dimension): Budget {
  const spec = pod.raw?.spec ?? pod.spec ?? {};
  const budget = (type: 'requests' | 'limits') => {
    let invalid = false;let unbounded = false;
    const read = (container: any): number => {
      const raw = container.resources?.[type]?.[dimension] ?? (type === 'requests' ? container.resources?.limits?.[dimension] : undefined);
      if (raw === undefined) { if (type === 'limits') unbounded = true;return 0; }
      const value = quantity(raw);if (value === null) invalid = true;
      if (type === 'limits' && value === 0) unbounded = true;
      return value ?? 0;
    };
    let main = (spec.containers ?? []).reduce((total: number, container: any) => total + read(container), 0);
    let sidecars = 0;let peak = 0;
    for (const container of spec.initContainers ?? []) {
      const amount = read(container);
      if (container.restartPolicy === 'Always') { sidecars += amount;main += amount;peak = Math.max(peak, sidecars); }
      else peak = Math.max(peak, sidecars + amount);
    }
    let total = Math.max(main, peak);
    const podLevel = spec.resources?.[type]?.[dimension];
    if (podLevel !== undefined) { const value = quantity(podLevel);invalid = value === null;unbounded = type === 'limits' && value === 0;total = value ?? 0; }
    const overhead = spec.overhead?.[dimension] === undefined ? 0 : quantity(spec.overhead[dimension]);
    if (invalid || overhead === null || type === 'limits' && unbounded) return null;
    return total + (type === 'requests' || total > 0 ? overhead : 0);
  };
  return { request: budget('requests'), limit: budget('limits') };
}
export function buildTelemetry(data: OverviewMetrics | undefined, pods: ResourceItem[] | null, nodes: ResourceItem[] | null, namespace: string | null, now = Date.now()) {
  const activePods = pods?.filter(active) ?? null;
  const podMap = new Map(activePods?.map(pod => [`${pod.namespace}/${pod.name}`, pod]));
  const nodeMap = new Map(nodes?.map(node => [node.name, node]));
  const podRows: UsageRow[] = (data?.pods.items ?? []).flatMap(metric => {
    const item = podMap.get(`${metric.namespace}/${metric.name}`);
    if (namespace && !inNamespaceScope(namespace, metric.namespace) || activePods && !item || item?.creationTimestamp && Date.parse(item.creationTimestamp) > Date.parse(metric.timestamp)) return [];
    const containers = metric.containers.map(container => ({ name: container.name, cpu: quantity(container.cpu)!, memory: quantity(container.memory)! }));
    return [{ name: metric.name, namespace: metric.namespace, item, timestamp: Date.parse(metric.timestamp), window: metric.window, containers, cpu: containers.reduce((sum, container) => sum + container.cpu, 0), memory: containers.reduce((sum, container) => sum + container.memory, 0) }];
  });
  const nodeRows: UsageRow[] = (data?.nodes.items ?? []).flatMap(metric => {
    const item = nodeMap.get(metric.name);if (nodes && !item) return [];
    return [{ ...metric, item, cpu: quantity(metric.cpu)!, memory: quantity(metric.memory)!, timestamp: Date.parse(metric.timestamp), containers: [] }];
  });
  const rows = namespace ? podRows : nodeRows;
  const source = namespace ? data?.pods : data?.nodes;
  const expected = namespace ? activePods?.length ?? null : nodes?.length ?? null;
  const oldest = rows.length ? rows.reduce((value, row) => Math.min(value, row.timestamp), Infinity) : null;
  const newest = rows.length ? rows.reduce((value, row) => Math.max(value, row.timestamp), -Infinity) : null;
  const stale = !!source?.error || oldest !== null && now - oldest > 120000 || newest !== null && newest > now + 30000;
  const measured = !!source?.items && (rows.length > 0 || expected === 0);
  const sum = (dimension: Dimension) => measured ? rows.reduce((total, row) => total + row[dimension], 0) : null;
  const complete = expected !== null && rows.length === expected && measured;
  const budgets = Object.fromEntries(dimensions.map(dimension => {
    const entries = activePods?.map(pod => podBudget(pod, dimension));
    const capacities = nodes?.map(node => quantity(node.raw?.status?.capacity?.[dimension]));
    const allocatable = nodes?.map(node => quantity(node.raw?.status?.allocatable?.[dimension]));
    return [dimension, {
      request: entries?.reduce((total: number | null, entry) => add(total, entry.request), 0) ?? null,
      limit: entries?.reduce((total: number | null, entry) => add(total, entry.limit), 0) ?? null,
      unbounded: entries?.filter(entry => entry.limit === null).length ?? null,
      capacity: capacities?.length ? capacities.reduce(add, 0) : null,
      allocatable: allocatable?.length ? allocatable.reduce(add, 0) : null,
    }];
  })) as Record<Dimension, { request: number | null; limit: number | null; unbounded: number | null; capacity: number | null; allocatable: number | null }>;
  return { podRows, nodeRows, budgets, cpu: sum('cpu'), memory: sum('memory'), oldest, newest, stale, complete, expected, measured: rows.length,
    coverage: expected === null ? `${rows.length} measured` : `${rows.length}/${expected} ${namespace ? 'active Pods' : 'nodes'} measured`,
    point: newest !== null && !stale && measured ? { at: newest, cpu: sum('cpu'), memory: sum('memory') } : undefined,
  };
}
/** Retain actual observation times, bounded history, no duplicate or out-of-order samples. */
export function appendHistory(history: HistoryPoint[], point?: HistoryPoint): HistoryPoint[] {
  if (!point || history.length && point.at <= history[history.length - 1].at) return history;
  return [...history.filter(previous => point.at - previous.at <= 30 * 60000), point].slice(-120);
}
