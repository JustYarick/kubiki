import { describe, expect, it, vi } from 'vitest';
import { watchNamespaceSelection } from '../../src/providers/multi_namespace_watch';
import type { ResourceWatchProvider, WatchBatch, WatchMessage } from '../../src/providers/watch_types';
import type { ResourceQuery } from '../../src/core/resources/resource_types';

const query: ResourceQuery = { context: 'cluster', group: '', version: 'v1', kind: 'Pod', namespace: '["alpha","beta"]' };
const pod = (namespace: string, uid: string) => ({ kind: 'Pod', apiVersion: 'v1', metadata: { namespace, uid, name: uid } });
function harness() {
  const connections: { query: ResourceQuery; send: (...events: WatchMessage['event'][]) => void; signal: AbortSignal; close: ReturnType<typeof vi.fn> }[] = [];
  const provider: ResourceWatchProvider = { watchResources: async (query, receive, signal) => {
    let sequence = 0; const close = vi.fn();
    connections.push({ query, signal, close, send: (...events) => receive({ query, subscription_id: query.namespace!, messages: events.map(event => ({ sequence: ++sequence, event })) }) });
    return close;
  } };
  return { provider, connections };
}
const restart = (namespace: string, uid: string): WatchMessage['event'] => ({ type: 'Delta', payload: { type: 'Restarted', payload: { items: [pod(namespace, uid)] } } });
const live: WatchMessage['event'] = { type: 'Status', payload: { phase: 'live', error: null } };
describe('Multi-namespace watch', () => {
  it('starts the initial timeout after a queued namespace obtains its LIST permit', async () => {
    vi.useFakeTimers();
    const { provider, connections } = harness();
    const abort = new AbortController();
    let closeFirst: (() => void) | undefined;
    let closeSecond: (() => void) | undefined;
    const batches: WatchBatch[] = [];
    try {
      closeFirst = await watchNamespaceSelection(provider, { ...query, namespace: '["one","two","three","four"]' }, () => {}, abort.signal);
      const pending = watchNamespaceSelection(provider, { ...query, namespace: 'later' }, batch => batches.push(batch), abort.signal);
      await vi.advanceTimersByTimeAsync(29000);
      expect(connections).toHaveLength(4);
      connections[0].send(restart('one', 'one'), live);
      await vi.advanceTimersByTimeAsync(0);
      closeSecond = await pending;
      await vi.advanceTimersByTimeAsync(2000);
      expect(connections[4].signal.aborted).toBe(false);
      expect(batches).toEqual([]);
    } finally { abort.abort(); closeFirst?.(); closeSecond?.(); vi.useRealTimers(); }
  });
  it('shares four initial LIST slots across selections and releases them on snapshots while watches stay open', async () => {
    const { provider, connections } = harness();
    const abort = new AbortController();
    const namespaces = Array.from({ length: 12 }, (_, i) => `team-${i}`);
    const pending = [0, 6].map(start => watchNamespaceSelection(provider, { ...query, namespace: JSON.stringify(namespaces.slice(start, start + 6)) }, () => {}, abort.signal));
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    try {
      await flush();
      expect(connections).toHaveLength(4);
      for (const connection of connections.slice()) connection.send(restart(connection.query.namespace!, connection.query.namespace!));
      await flush();
      expect(connections).toHaveLength(8);
      expect(connections.every(connection => !connection.signal.aborted)).toBe(true);
      for (const connection of connections.slice(4)) connection.send(restart(connection.query.namespace!, connection.query.namespace!));
      await flush();
      expect(connections).toHaveLength(12);
      for (const connection of connections.slice(8)) connection.send(restart(connection.query.namespace!, connection.query.namespace!));
      const close = await Promise.all(pending);
      close.forEach(stop => stop());
      expect(connections.every(connection => connection.signal.aborted)).toBe(true);
    } finally { abort.abort(); await Promise.allSettled(pending); }
  });
  it('requests only selected namespaces, combines complete snapshots, merges updates and rejects late callbacks', async () => {
    const { provider, connections } = harness();
    const batches: WatchBatch[] = [];
    const abort = new AbortController();
    const close = await watchNamespaceSelection(provider, query, batch => batches.push(batch), abort.signal);
    expect(connections.map(connection => connection.query.namespace)).toEqual(['alpha', 'beta']);
    connections[0].send(restart('alpha', 'a'), live);
    expect(batches).toHaveLength(0);
    connections[1].send(restart('beta', 'b'), live);
    expect(batches[0].messages[0].event).toMatchObject({ type: 'Delta', payload: { type: 'Restarted', payload: { items: [pod('alpha', 'a'), pod('beta', 'b')] } } });
    connections[0].send({ type: 'Delta', payload: { type: 'Deleted', payload: { uid: 'a' } } });
    connections[1].send(restart('beta', 'new-b'), live);
    expect(batches.at(-1)!.messages[0].event).toMatchObject({ payload: { type: 'Restarted', payload: { items: [pod('beta', 'new-b')] } } });
    const messages = batches.flatMap(batch => batch.messages);
    expect(messages.map(message => message.sequence)).toEqual(messages.map((_, index) => index + 1));
    close();
    connections[0].send(restart('alpha', 'late'), live);
    expect(batches.flatMap(batch => batch.messages)).toHaveLength(messages.length);
    expect(connections.every(connection => connection.signal.aborted)).toBe(true);
    expect(connections.every(connection => connection.close.mock.calls.length === 1)).toBe(true);
  });
  it('marks the combined scope failed if one namespace is forbidden instead of reporting an incomplete graph as live', async () => {
    const { provider, connections } = harness();
    const batches: WatchBatch[] = [];
    await watchNamespaceSelection(provider, query, batch => batches.push(batch), new AbortController().signal);
    connections[0].send(restart('alpha', 'a'), live);
    connections[1].send({ type: 'Status', payload: { phase: 'failed', error: { code: 'forbidden', message: 'beta is forbidden', operation: 'watch', status: 403, retryable: false } } });
    expect(batches.at(-1)!.messages.at(-1)!.event).toMatchObject({ type: 'Status', payload: { phase: 'failed', error: { code: 'forbidden' } } });
    expect(connections.every(connection => connection.signal.aborted)).toBe(true);
  });
});
