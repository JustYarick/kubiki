import type { OverviewMetrics } from './overview_metrics';
import { normalizeK8sError } from './errors';

export interface MetricsSnapshot { data?: OverviewMetrics; loading: boolean; error?: string }
interface Visibility {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}
type Reader = (context: string, namespace: string | null, signal: AbortSignal) => Promise<OverviewMetrics>;
interface Subscription {
  snapshot: MetricsSnapshot;
  listeners: Set<(snapshot: MetricsSnapshot) => void>;
  refresh: () => void;
  stop: () => void;
}

/** One poller per context/namespace, shared by overview, inspector and split panes. */
export class MetricsSubscriptions {
  private active = new Map<string, Subscription>();
  private cache = new Map<string, MetricsSnapshot>();
  constructor(private read: Reader, private visibility: () => Visibility) {}

  subscribe(context: string, namespace: string | null, listener: (snapshot: MetricsSnapshot) => void): () => void {
    const key = JSON.stringify([context, namespace]);
    let entry = this.active.get(key);
    if (!entry) {
      const document = this.visibility();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let controller: AbortController | undefined;
      let busy = false;
      const current: Subscription = { snapshot: { ...this.cache.get(key), loading: true }, listeners: new Set(), refresh: () => { void poll(); }, stop: () => {} };
      entry = current;
      const publish = (snapshot: MetricsSnapshot) => {
        if (this.active.get(key) !== current) return;
        current.snapshot = snapshot;
        this.cache.delete(key);
        this.cache.set(key, snapshot);
        while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
        for (const notify of current.listeners) notify(snapshot);
      };
      const poll = async () => {
        if (this.active.get(key) !== current || document.hidden || busy) return;
        clearTimeout(timer);
        busy = true;
        const request = new AbortController(); controller = request;
        publish({ ...current.snapshot, loading: true });
        try {
          const received = await this.read(context, namespace, request.signal);
          if (request.signal.aborted) return;
          const previous = current.snapshot.data;
          publish({ loading: false, data: { ...received,
            pods: { ...received.pods, items: received.pods.items ?? previous?.pods.items ?? null },
            nodes: { ...received.nodes, items: received.nodes.items ?? previous?.nodes.items ?? null },
          } });
        } catch (error) {
          if (!request.signal.aborted) publish({ ...current.snapshot, loading: false, error: normalizeK8sError(error, { operation: 'metrics', context }).message });
        } finally {
          busy = false;
          if (this.active.get(key) === current) {
            if (request.signal.aborted) publish({ ...current.snapshot, loading: false });
            if (!document.hidden) timer = setTimeout(() => void poll(), request.signal.aborted ? 0 : 15000);
          }
        }
      };
      const visible = () => { clearTimeout(timer); if (document.hidden) controller?.abort(); else void poll(); };
      current.stop = () => { clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible); };
      this.active.set(key, current);
      document.addEventListener('visibilitychange', visible);
      queueMicrotask(() => void poll());
    }
    const current = entry;
    current.listeners.add(listener);
    listener(current.snapshot);
    return () => {
      current.listeners.delete(listener);
      if (!current.listeners.size && this.active.get(key) === current) {
        this.active.delete(key);
        current.stop();
      }
    };
  }

  refresh(context: string, namespace: string | null) {
    this.active.get(JSON.stringify([context, namespace]))?.refresh();
  }
}
