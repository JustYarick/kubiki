import { useCallback, useEffect, useState } from 'react';
import { k8s } from './k8s_provider';
import type { OverviewMetrics } from './overview_metrics';
import { normalizeK8sError } from './errors';
import { appendHistory, type HistoryPoint } from '../core/resources/telemetry';
interface State { key: string; data?: OverviewMetrics; loading: boolean; error?: string; history: HistoryPoint[] }
const cache = new Map<string, State>();
export function useOverviewMetrics(context: string | null, namespace: string | null, point: (data: OverviewMetrics) => HistoryPoint | undefined, paused = false) {
  const key = JSON.stringify([context, namespace]);
  const [state, setState] = useState<State>({ key, loading: true, history: [] });
  const [attempt, setAttempt] = useState(0);
  // Capture the current snapshot projection without restarting the transport for every watch update.
  const [project] = useState(() => ({ current: point }));project.current = point;
  useEffect(() => {
    let cancelled = false;let timer: ReturnType<typeof setTimeout>;let controller: AbortController | undefined;let busy = false;
    let current: State = { ...(cache.get(key) ?? { key, history: [] }), loading: true, error: undefined };
    if (paused) { setState({ ...current, loading: false }); return; }
    setState(current);
    const publish = () => { if (cancelled) return;setState(current);cache.delete(key);cache.set(key, current);while (cache.size > 4) cache.delete(cache.keys().next().value!); };
    const poll = async () => {
      if (cancelled || !context || document.hidden || busy) return;
      busy = true;controller = new AbortController();current = { ...current, loading: true };publish();
      try {
        const received = await k8s.getOverviewMetrics(context, namespace, controller.signal);
        if (cancelled || controller.signal.aborted) return;
        const data = { ...received, pods: { ...received.pods, items: received.pods.items ?? current.data?.pods.items ?? null }, nodes: { ...received.nodes, items: received.nodes.items ?? current.data?.nodes.items ?? null } };
        const sample = project.current(data);
        const history = k8s.demo && !current.history.length && sample ? Array.from({ length: 36 }, (_, index) => ({ at: sample.at - (35 - index) * 15000, cpu: sample.cpu === null ? null : sample.cpu * (0.8 + Math.sin(index * .37) * .14 + Math.cos(index * .71) * .06), memory: sample.memory === null ? null : sample.memory * (0.84 + index / 220 + Math.sin(index * .24) * .03) })) : current.history;
        current = { ...current, data, error: undefined, history: appendHistory(history, sample) };
      } catch (error) { if (!cancelled && !controller.signal.aborted) current = { ...current, error: normalizeK8sError(error, { operation: 'metrics', context }).message }; }
      finally { busy = false;if (!cancelled) { current = { ...current, loading: false };publish();if (!document.hidden) timer = setTimeout(poll, controller?.signal.aborted ? 0 : 15000); } }
    };
    const visibility = () => { clearTimeout(timer);if (document.hidden) controller?.abort();else void poll(); };
    document.addEventListener('visibilitychange', visibility);void poll();
    return () => { cancelled = true;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange', visibility); };
  }, [key, attempt, project, paused]);
  const refresh = useCallback(() => setAttempt(value => value + 1), []);
  return { ...(state.key === key ? state : { key, loading: true, history: [] }), refresh };
}
