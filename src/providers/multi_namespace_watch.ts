import type { ResourceQuery } from '../core/resources/resource_types';
import { namespaceNames } from '../core/resources/namespace_scope';
import { normalizeK8sError, type K8sErrorPayload } from './errors';
import { sameQuery, type ResourceWatchProvider, type WatchBatch, type WatchMessage, type WatchPhase } from './watch_types';
import { InitialSyncQueue } from './initial_sync_queue';

// This queue counts namespace streams, rather than their parent resource kinds.
// A watch keeps running after its initial LIST releases the permit.
const initialStreams = new InitialSyncQueue(4);
function watchInitialStream(provider: ResourceWatchProvider, query: ResourceQuery, onBatch: (batch: WatchBatch) => void, signal: AbortSignal): Promise<() => void> {
  let registered!: (close: () => void) => void;
  let failed!: (error: unknown) => void;
  const registration = new Promise<() => void>((resolve, reject) => { registered = resolve; failed = reject; });
  let finish!: () => void;
  const snapshot = new Promise<void>(resolve => { finish = resolve; });
  const controller = new AbortController();
  let started = false;
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeNative: (() => void) | undefined;
  let closed = false;
  const close = () => { if (closed) return; closed = true; controller.abort(); closeNative?.(); finish(); clearTimeout(timer); signal.removeEventListener('abort', abort); };
  const abort = () => { close(); if (!started) registered(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  void initialStreams.run(async () => {
    started = true;
    timer = setTimeout(() => {
      onBatch({ query, subscription_id: 'initial-timeout', messages: [{ sequence: sequence + 1, event: { type: 'Status', payload: { phase: 'failed', error: normalizeK8sError({ code: 'timeout', message: 'Initial namespace snapshot timed out', retryable: true }, { operation: 'watch', resource: query }) } } }] });
      close();
      failed(new Error('Initial namespace snapshot timed out'));
    }, 30000);
    try {
      void provider.watchResources(query, batch => {
        if (controller.signal.aborted || !sameQuery(batch.query, query)) return;
        sequence = batch.messages[batch.messages.length - 1]?.sequence ?? sequence;
        onBatch(batch);
        if (batch.messages.some(message => message.event.type === 'Delta' && message.event.payload.type === 'Restarted' || message.event.type === 'Status' && ['failed', 'stopped'].includes(message.event.payload.phase))) {
          clearTimeout(timer); finish();
        }
      }, controller.signal).then(stop => {
        closeNative = stop;
        if (controller.signal.aborted) stop();
        registered(close);
      }, error => { close(); failed(error); });
    } catch (error) { close(); failed(error); }
    await snapshot;
  }, signal).catch(failed);
  return registration;
}

/** Merge independent namespace streams without ever requesting cluster-wide permissions. */
export async function watchNamespaceSelection(provider: ResourceWatchProvider, query: ResourceQuery, onBatch: (batch: WatchBatch) => void, signal: AbortSignal): Promise<() => void> {
  const names = namespaceNames(query.namespace ?? 'all');
  if (names?.length === 0) {
    if (!signal.aborted) onBatch({ query, subscription_id: 'empty-selection', messages: [
      { sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items: [] } } } },
      { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } },
    ] });
    return () => {};
  }
  if (!names || names.length <= 1) return watchInitialStream(provider, query, onBatch, signal);
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
      const stop = await watchInitialStream(provider, stream.query, batch => {
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
