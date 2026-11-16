import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ResourceItem } from '../types/k8s';
import type { HistoryPoint } from '../core/resources/telemetry';
import { k8s } from './k8s_provider';
import { normalizeK8sError } from './errors';
import type { PodMetric } from './overview_metrics';
import { useOverviewMetrics } from './use_overview_metrics';
import { PodMetricsHistory, podMetricPoint, podMetricUsage } from './pod_metrics_history';

const histories = new PodMetricsHistory();
const SINGLE_POD_POLL_MS = 10_000;

function useSinglePodMetric(context: string | null, namespace: string, name: string, paused: boolean) {
  const [state, setState] = useState<{ key: string; sample?: PodMetric; loading: boolean; error?: string }>({ key: '', loading: false });
  const [tick, setTick] = useState(0);
  const key = JSON.stringify([context, namespace, name]);

  useEffect(() => {
    if (!context || !namespace || paused || !k8s.supportsSinglePodMetric) return;
    const controller = new AbortController();
    setState(prev => ({ key, sample: prev.key === key ? prev.sample : undefined, loading: true, error: undefined }));
    void k8s.getPodMetric(context, namespace, name, controller.signal)
      .then((sample) => { if (!controller.signal.aborted) setState({ key, sample, loading: false, error: undefined }); })
      .catch((error) => { if (!controller.signal.aborted) setState(prev => ({ key, sample: prev.key === key ? prev.sample : undefined, loading: false, error: normalizeK8sError(error).message })); });
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setTick(t => t + 1);
    }, SINGLE_POD_POLL_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [context, namespace, name, paused, key, tick]);

  const refresh = useCallback(() => setTick(t => t + 1), []);
  const current = state.key === key;
  return {
    sample: current ? state.sample : undefined,
    loading: current ? state.loading : false,
    error: current ? state.error : undefined,
    refresh,
  };
}

export function usePodMetrics(context: string | null, item: ResourceItem, paused: boolean) {
  const namespace = item.namespace ?? item.raw?.metadata?.namespace ?? '';
  const key = JSON.stringify([context, namespace, item.name, item.uid]);
  const createdAt = Date.parse(item.raw?.metadata?.creationTimestamp ?? '') || 0;
  const singleMode = k8s.supportsSinglePodMetric;
  const overview = useOverviewMetrics(context, namespace || null, singleMode || paused || !namespace);
  const single = useSinglePodMetric(context, namespace, item.name, !singleMode || paused || !namespace);
  const sample = singleMode
    ? single.sample
    : (namespace ? overview.data?.pods?.items?.find(pod => pod.name === item.name && pod.namespace === namespace) : undefined);
  const activeError = singleMode ? single.error : (overview.error ?? overview.data?.pods?.error?.message);
  const loading = singleMode ? single.loading : overview.loading;
  const refresh = singleMode ? single.refresh : overview.refresh;
  const usage = useMemo(() => podMetricUsage(sample), [sample]);
  const point = useMemo(() => activeError ? undefined : podMetricPoint(sample, createdAt), [sample, createdAt, activeError]);
  const [state, setState] = useState<{ key: string; points: HistoryPoint[] }>(() => ({ key, points: histories.get(key) }));
  useEffect(() => {
    const points = histories.record(key, point, createdAt);
    setState(previous => previous.key === key && previous.points === points ? previous : { key, points });
  }, [key, point, createdAt]);
  const timestamp = sample ? Date.parse(sample.timestamp) : null;
  const stale = timestamp !== null && (timestamp < createdAt || Date.now() - timestamp > 120000 || timestamp - Date.now() > 30000);
  return { loading, refresh, sample, usage: timestamp !== null && timestamp >= createdAt ? usage : { cpu: null, memory: null }, stale, error: activeError,
    history: state.key === key ? state.points : [], namespace };
}
