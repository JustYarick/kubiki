import type { ResourceQuery } from '../core/resources/resource_types';
import { normalizeK8sError } from './errors';
import type { WatchBatch, WatchMessage } from './watch_types';

/** Use snapshots when discovery reports that a collection does not support watch. */
export async function pollResourceSnapshots(query: ResourceQuery, read: () => Promise<{ items: Record<string, any>[] }>, onBatch: (batch: WatchBatch) => void, signal: AbortSignal): Promise<() => void> {
  let sequence = 0;
  let closed = signal.aborted;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { closed = true; clearTimeout(timer); signal.removeEventListener('abort', close); };
  signal.addEventListener('abort', close, { once: true });
  const emit = (events: WatchMessage['event'][]) => {
    if (!closed) onBatch({ subscription_id: 'snapshot-poll', query, messages: events.map(event => ({ sequence: ++sequence, event })) });
  };
  const poll = async () => {
    if (closed) return;
    try {
      const result = await read();
      if (!Array.isArray(result?.items)) throw new Error('Invalid Kubernetes list response');
      emit([{ type: 'Delta', payload: { type: 'Restarted', payload: { items: result.items } } }, { type: 'Status', payload: { phase: 'live', error: null } }]);
    } catch (error) {
      emit([{ type: 'Status', payload: { phase: 'reconnecting', error: normalizeK8sError(error, { operation: 'resources', context: query.context, resource: query }) } }]);
    }
    if (!closed) timer = setTimeout(() => void poll(), 30000);
  };
  await poll();
  return close;
}
