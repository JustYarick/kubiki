import type { OverviewMetrics } from './overview_metrics';
import { ReadSubscriptions, type ReadVisibility } from './read_subscriptions';

export interface MetricsSnapshot { data?: OverviewMetrics; loading: boolean; error?: string }
type Reader = (context: string, namespace: string | null, signal: AbortSignal) => Promise<OverviewMetrics>;

/** Share the read lifecycle; metrics alone retain the last successful source samples. */
export class MetricsSubscriptions {
  private subscriptions: ReadSubscriptions<OverviewMetrics>;

  constructor(read: Reader, visibility: () => ReadVisibility) {
    this.subscriptions = new ReadSubscriptions(async (key, signal, previous) => {
      const [context, namespace] = JSON.parse(key) as [string, string | null];
      const received = await read(context, namespace, signal);
      return { ...received,
        pods: { ...received.pods, items: received.pods.items ?? previous?.pods.items ?? null },
        nodes: { ...received.nodes, items: received.nodes.items ?? previous?.nodes.items ?? null },
      };
    }, 15000, visibility);
  }

  subscribe(context: string, namespace: string | null, listener: (snapshot: MetricsSnapshot) => void): () => void {
    return this.subscriptions.subscribe(JSON.stringify([context, namespace]), snapshot => {
      listener({ data: snapshot.data, loading: snapshot.loading, error: snapshot.error?.message });
    });
  }

  refresh(context: string, namespace: string | null): void {
    this.subscriptions.refresh(JSON.stringify([context, namespace]));
  }
}
