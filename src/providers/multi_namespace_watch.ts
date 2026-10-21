import type { ResourceQuery } from '../core/resources/resource_types';
import { namespaceNames } from '../core/resources/namespace_scope';
import { normalizeK8sError, type K8sErrorPayload } from './errors';
import { sameQuery, type ResourceWatchProvider, type WatchBatch, type WatchMessage, type WatchPhase } from './watch_types';

/** Merge independent namespace streams without ever requesting cluster-wide permissions. */
export async function watchNamespaceSelection(provider: ResourceWatchProvider, query: ResourceQuery, onBatch: (batch: WatchBatch) => void, signal: AbortSignal): Promise<() => void> {
  const names = namespaceNames(query.namespace ?? 'all');
  if (!names || names.length <= 1) return provider.watchResources(query, onBatch, signal);
  const controller = new AbortController();
  const streams = names.map(namespace => ({ query: { ...query, namespace }, items: new Map<string, Record<string, any>>(), ready: false, phase: 'connecting' as WatchPhase, sequence: 0, error: null as K8sErrorPayload | null }));
  const closers: (() => void)[] = [];
  let sequence = 0;
  let published = false;
  let stopped = false;
  const close = () => { if (stopped) return; stopped = true; controller.abort(); closers.forEach(close => close()); signal.removeEventListener('abort', close); };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  const emit = (events: WatchMessage['event'][]) => {
    if (!stopped && events.length) onBatch({ subscription_id: 'namespace-selection', query, messages: events.map(event => ({ sequence: ++sequence, event })) });
  };
  try {
    await Promise.all(streams.map(async stream => {
      const stop = await provider.watchResources(stream.query, batch => {
        if (stopped || !sameQuery(batch.query, stream.query)) return;
        try {
          const events: WatchMessage['event'][] = [];
          let restarted = false;
          for (const message of batch.messages) {
            if (message.sequence <= stream.sequence) continue;
            if (message.sequence !== stream.sequence + 1) throw new Error('Namespace watch sequence gap; refresh to resynchronize');
            stream.sequence = message.sequence;
            const event = message.event;
            if (event.type === 'Status') {
              stream.phase = event.payload.phase;
              stream.error = event.payload.error;
              if (['failed', 'stopped'].includes(stream.phase)) {
                emit([{ type: 'Status', payload: { phase: 'failed', error: event.payload.error ?? normalizeK8sError(new Error(`Watch stopped for namespace ${stream.query.namespace}`), { operation: 'watch', resource: stream.query }) } }]);
                close(); return;
              }
            } else {
              const delta = event.payload;
              if (delta.type === 'Restarted') {
                stream.items.clear();
                for (const raw of delta.payload.items) {
                  if (!raw?.metadata?.uid || raw.metadata.namespace !== stream.query.namespace) throw new Error('Invalid namespace snapshot');
                  stream.items.set(raw.metadata.uid, raw);
                }
                stream.ready = true; restarted = true;
              } else if (delta.type === 'Applied') {
                if (!stream.ready || delta.payload.data?.metadata?.namespace !== stream.query.namespace) throw new Error('Invalid namespace delta');
                stream.items.set(delta.payload.data.metadata.uid, delta.payload.data);
                if (published) events.push(event);
              } else {
                if (!stream.ready) throw new Error('Namespace delete before snapshot');
                stream.items.delete(delta.payload.uid);
                if (published) events.push(event);
              }
            }
          }
          if (streams.every(stream => stream.ready)) {
            if (!published || restarted) {
              events.length = 0;
              events.push({ type: 'Delta', payload: { type: 'Restarted', payload: { items: streams.flatMap(stream => [...stream.items.values()]) } } });
              published = true;
            }
            events.push({ type: 'Status', payload: { phase: streams.every(stream => stream.phase === 'live') ? 'live' : streams.some(stream => stream.phase === 'reconnecting') ? 'reconnecting' : 'syncing', error: streams.find(stream => stream.phase === 'reconnecting')?.error ?? null } });
            emit(events);
          }
        } catch (error) { emit([{ type: 'Status', payload: { phase: 'failed', error: normalizeK8sError(error, { operation: 'watch', resource: stream.query }) } }]); close(); }
      }, controller.signal);
      if (stopped) stop(); else closers.push(stop);
    }));
    return close;
  } catch (error) { close(); throw error; }
}
