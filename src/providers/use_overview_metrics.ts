import { useCallback, useEffect, useState } from 'react';
import { k8s } from './k8s_provider';
import type { OverviewMetrics } from './overview_metrics';
import { appendHistory, type HistoryPoint } from '../core/resources/telemetry';
import { MetricsSubscriptions } from './metrics_subscriptions';

interface State { key: string; data?: OverviewMetrics; loading: boolean; error?: string; history: HistoryPoint[] }
const histories = new Map<string, HistoryPoint[]>();
const subscriptions = new MetricsSubscriptions((context, namespace, signal) => k8s.getOverviewMetrics(context, namespace, signal), () => document);

export function useOverviewMetrics(context: string | null, namespace: string | null, point: (data: OverviewMetrics) => HistoryPoint | undefined, paused = false) {
  const key = JSON.stringify([context, namespace]);
  const [state, setState] = useState<State>({ key, loading: true, history: [] });
  const [project] = useState(() => ({ current: point })); project.current = point;
  useEffect(() => {
    if (!context || paused) { setState(previous => ({ ...(previous.key === key ? previous : { key, history: [] }), loading: false })); return; }
    let history = histories.get(key) ?? [];
    let lastData: OverviewMetrics | undefined;
    return subscriptions.subscribe(context, namespace, snapshot => {
      if (snapshot.data && snapshot.data !== lastData) {
        lastData = snapshot.data;
        const sample = project.current(snapshot.data);
        if (k8s.demo && !history.length && sample) history = Array.from({ length: 36 }, (_, index) => ({ at: sample.at - (35 - index) * 15000, cpu: sample.cpu === null ? null : sample.cpu * (0.8 + Math.sin(index * .37) * .14 + Math.cos(index * .71) * .06), memory: sample.memory === null ? null : sample.memory * (0.84 + index / 220 + Math.sin(index * .24) * .03) }));
        history = appendHistory(history, sample);
        if (sample) {
          histories.delete(key); histories.set(key, history);
          while (histories.size > 4) histories.delete(histories.keys().next().value!);
        }
      }
      setState({ key, ...snapshot, history });
    });
  }, [key, context, namespace, project, paused]);
  const refresh = useCallback(() => { if (context && !paused) subscriptions.refresh(context, namespace); }, [context, namespace, paused]);
  return { ...(state.key === key ? state : { key, loading: true, history: [] }), refresh };
}
