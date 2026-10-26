import { normalizeK8sError, type K8sRequestError } from './errors';

export interface ReadSnapshot<T> { data?: T; loading: boolean; updated?: number; error?: K8sRequestError }
export interface ReadVisibility {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}
interface Entry<T> { snapshot: ReadSnapshot<T>; listeners: Set<(snapshot: ReadSnapshot<T>) => void>; refresh: () => void; stop: () => void }

/** Shares reads across panes, bounds retained scopes, and cancels hidden/unmounted work. */
export class ReadSubscriptions<T> {
  private active = new Map<string, Entry<T>>();
  private cache = new Map<string, ReadSnapshot<T>>();
  constructor(private read: (key: string, signal: AbortSignal, previous?: T) => Promise<T>, private interval = 15000, private visibility: () => ReadVisibility = () => document) {}

  subscribe(key: string, listener: (snapshot: ReadSnapshot<T>) => void): () => void {
    let entry = this.active.get(key);
    if (!entry) {
      const visibility = this.visibility();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let controller: AbortController | undefined;
      let busy = false;
      let queued = false;
      const current: Entry<T> = { snapshot: { ...this.cache.get(key), loading: !visibility.hidden }, listeners: new Set(), refresh: () => {}, stop: () => {} };
      entry = current;
      const publish = (snapshot: ReadSnapshot<T>) => {
        if (this.active.get(key) !== current) return;
        current.snapshot = snapshot;
        this.cache.delete(key); this.cache.set(key, snapshot);
        while (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
        for (const receive of current.listeners) receive(snapshot);
      };
      const poll = async () => {
        if (this.active.get(key) !== current || visibility.hidden) return;
        if (busy) { queued = true;return; }
        clearTimeout(timer); busy = true; queued = false;
        const request = new AbortController(); controller = request;
        publish({ ...current.snapshot, loading: true });
        try {
          const data = await this.read(key, request.signal, current.snapshot.data);
          if (!request.signal.aborted) publish({ data, loading: false, updated: Date.now() });
        } catch (error) {
          if (!request.signal.aborted) publish({ ...current.snapshot, loading: false, error: normalizeK8sError(error) });
        } finally {
          busy = false;
          if (this.active.get(key) === current) {
            if (request.signal.aborted) publish({ ...current.snapshot, loading: false });
            if (!visibility.hidden) timer = setTimeout(() => void poll(), queued || request.signal.aborted ? 0 : this.interval);
          }
        }
      };
      const visible = () => { clearTimeout(timer); if (visibility.hidden) controller?.abort(); else void poll(); };
      current.refresh = () => { void poll(); };
      current.stop = () => { clearTimeout(timer); controller?.abort(); visibility.removeEventListener('visibilitychange', visible); };
      this.active.set(key, current);
      visibility.addEventListener('visibilitychange', visible);
      queueMicrotask(() => void poll());
    }
    const current = entry;
    current.listeners.add(listener); listener(current.snapshot);
    return () => {
      current.listeners.delete(listener);
      if (!current.listeners.size && this.active.get(key) === current) { this.active.delete(key);current.stop(); }
    };
  }
  refresh(key: string) { this.active.get(key)?.refresh(); }
}
