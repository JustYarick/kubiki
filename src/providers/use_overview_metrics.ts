import { useCallback, useEffect, useState } from 'react';
import { k8s } from './k8s_provider';
import type { OverviewMetrics } from './overview_metrics';
import type { HistoryPoint } from '../core/resources/telemetry';
import { MetricsSubscriptions } from './metrics_subscriptions';

interface State { key: string; data?: OverviewMetrics; loading: boolean; error?: string; history: HistoryPoint[] }
const subscriptions = new MetricsSubscriptions((context, namespace, signal) => k8s.getOverviewMetrics(context, namespace, signal), () => document, () => k8s.demo);

/** Keep collecting for an open Overview tab while another workspace tab is selected. */
export function useRetainedOverviewMetrics(context: string | null, namespace: string | null, enabled: boolean) {
  useEffect(() => enabled && context ? subscriptions.subscribe(context, namespace, () => {}) : undefined, [context, namespace, enabled]);
}

export function useOverviewMetrics(context: string | null, namespace: string | null, paused = false) {
  const key = JSON.stringify([context, namespace]);
  const [state, setState] = useState<State>({ key, loading: true, history: [] });
  useEffect(() => {
    if (!context || paused) { setState(previous => ({ ...(previous.key === key ? previous : { key, history: [] }), loading: false })); return; }
    return subscriptions.subscribe(context, namespace, snapshot => {
      setState({ key, ...snapshot });
    });
  }, [key, context, namespace, paused]);
  const refresh = useCallback(() => { if (context && !paused) subscriptions.refresh(context, namespace); }, [context, namespace, paused]);
  return { ...(state.key === key ? state : { key, loading: true, history: [] }), refresh };
}
