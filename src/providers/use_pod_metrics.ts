import { useEffect, useMemo, useState } from 'react';
import type { ResourceItem } from '../types/k8s';
import type { HistoryPoint } from '../core/resources/telemetry';
import { useOverviewMetrics } from './use_overview_metrics';
import { PodMetricsHistory, podMetricPoint, podMetricUsage } from './pod_metrics_history';

const histories = new PodMetricsHistory();
export function usePodMetrics(context: string | null, item: ResourceItem, paused: boolean) {
  const namespace = item.namespace ?? item.raw?.metadata?.namespace ?? '';
  const key = JSON.stringify([context, namespace, item.name, item.uid]);
  const createdAt = Date.parse(item.raw?.metadata?.creationTimestamp ?? '') || 0;
  const metrics = useOverviewMetrics(context, namespace || null, paused || !namespace);
  const source = metrics.data?.pods;
  const sample = namespace ? source?.items?.find(pod => pod.name === item.name && pod.namespace === namespace) : undefined;
  const usage = useMemo(() => podMetricUsage(sample), [sample]);
  const point = useMemo(() => metrics.error || source?.error ? undefined : podMetricPoint(sample, createdAt), [sample, createdAt, metrics.error, source?.error]);
  const [state, setState] = useState<{ key: string; points: HistoryPoint[] }>(() => ({ key, points: histories.get(key) }));
  useEffect(() => {
    const points = histories.record(key, point, createdAt);
    setState(previous => previous.key === key && previous.points === points ? previous : { key, points });
  }, [key, point, createdAt]);
  const timestamp = sample ? Date.parse(sample.timestamp) : null;
  const stale = timestamp !== null && (timestamp < createdAt || Date.now() - timestamp > 120000 || timestamp - Date.now() > 30000);
  return { ...metrics, sample, usage: timestamp !== null && timestamp >= createdAt ? usage : { cpu: null, memory: null }, stale, error: metrics.error ?? source?.error?.message,
    history: state.key === key ? state.points : [], namespace };
}
