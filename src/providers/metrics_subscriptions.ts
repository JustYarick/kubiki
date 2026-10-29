import type { OverviewMetrics } from './overview_metrics';
import { ReadSubscriptions, type ReadVisibility } from './read_subscriptions';
import { appendHistory, buildTelemetry, type HistoryPoint } from '../core/resources/telemetry';

export interface MetricsSnapshot { data?: OverviewMetrics; loading: boolean; error?: string; history: HistoryPoint[] }
type Reader = (context: string, namespace: string | null, signal: AbortSignal) => Promise<OverviewMetrics>;
interface CollectedMetrics { data: OverviewMetrics; history: HistoryPoint[] }

/** Share both polling and history so neither depends on a visible dashboard or its resource inventory. */
export class MetricsSubscriptions {
  private subscriptions: ReadSubscriptions<CollectedMetrics>;

  constructor(read: Reader, visibility: () => ReadVisibility, demo: () => boolean = () => false) {
    this.subscriptions = new ReadSubscriptions(async (key, signal, previous) => {
      const [context, namespace] = JSON.parse(key) as [string, string | null];
      const received = await read(context, namespace, signal);
      const data = { ...received,
        pods: { ...received.pods, items: received.pods.items ?? previous?.data.pods.items ?? null },
        nodes: { ...received.nodes, items: received.nodes.items ?? previous?.data.nodes.items ?? null },
      };
      // Aggregate the scoped Metrics API response. Other tabs may unload/narrow
      // the Pod/Node inventory without changing what this measurement covers.
      const sample = buildTelemetry(data, null, null, namespace).point;
      let history = previous?.history ?? [];
      if (demo() && !history.length && sample) history = Array.from({ length: 35 }, (_, index) => ({ at: sample.at - (35 - index) * 15000, cpu: sample.cpu === null ? null : sample.cpu * (0.8 + Math.sin(index * .37) * .14 + Math.cos(index * .71) * .06), memory: sample.memory === null ? null : sample.memory * (0.84 + index / 220 + Math.sin(index * .24) * .03) }));
      return { data, history: appendHistory(history, sample) };
    }, 15000, visibility);
  }

  subscribe(context: string, namespace: string | null, listener: (snapshot: MetricsSnapshot) => void): () => void {
    return this.subscriptions.subscribe(JSON.stringify([context, namespace]), snapshot => {
      listener({ data: snapshot.data?.data, history: snapshot.data?.history ?? [], loading: snapshot.loading, error: snapshot.error?.message });
    });
  }

  refresh(context: string, namespace: string | null): void {
    this.subscriptions.refresh(JSON.stringify([context, namespace]));
  }
}
