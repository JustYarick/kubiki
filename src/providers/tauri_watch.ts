import type { ResourceQuery } from '../core/resources/resource_types';
import { normalizeK8sError } from './errors';
import { sameQuery, type WatchBatch } from './watch_types';

export async function watchTauriResources(query: ResourceQuery, onBatch: (batch: WatchBatch) => void, signal: AbortSignal): Promise<() => void> {
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  if (signal.aborted) return () => {};
  const id = crypto.randomUUID();
  const channel = new Channel<WatchBatch>();
  let closed = false;
  channel.onmessage = (batch) => { if (!closed && batch.subscription_id === id && sameQuery(batch.query, query)) onBatch(batch); };
  const unwatch = () => { void invoke('stop_resource_watch', { subscriptionId: id }).catch(() => {}); };
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    channel.onmessage = () => {};
    // Channel exposes no public close; release the callback also if invoke failed before Rust decoded it.
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void } }).__TAURI_INTERNALS__;
    internals?.unregisterCallback?.(channel.id);
    unwatch();
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    await invoke('watch_resources', { query, subscriptionId: id, onEvent: channel });
    // Cancellation can beat native registration: an idempotent second stop closes that race.
    if (closed) unwatch();
    return close;
  } catch (error) {
    close();
    throw normalizeK8sError(error, { operation: 'watch', context: query.context, resource: query });
  }
}
