import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceWatchSession, WATCH_FLUSH_MS, FIRST_SYNC_TIMEOUT_MS } from '../../src/providers/resource_watch_session';
import type { ResourceQuery } from '../../src/core/resources/resource_types';
import type { ResourceWatchProvider, WatchBatch, WatchCommit, WatchMessage } from '../../src/providers/watch_types';
import { useResourceStore } from '../../src/state/resource_store';

const pod = (uid: string, phase = 'Running', namespace = 'backend') => ({ kind: 'Pod', apiVersion: 'v1', metadata: { uid, name: uid, namespace }, status: { phase } });
const delta = (items: ReturnType<typeof pod>[]): WatchMessage['event'] => ({ type: 'Delta', payload: { type: 'Restarted', payload: { items } } });
const live: WatchMessage['event'] = { type: 'Status', payload: { phase: 'live', error: null } };
function harness(context = 'a') {
  const connections: Array<{ query: ResourceQuery; signal: AbortSignal; close: ReturnType<typeof vi.fn>; emit: (...events: WatchMessage['event'][]) => void; send: (batch: WatchBatch) => void }> = [];
  const commits: WatchCommit[] = [];
  const provider: ResourceWatchProvider = { watchResources: vi.fn(async (query, send, signal) => {
    let sequence = 0; const close = vi.fn();
    connections.push({ query, signal, close, send, emit: (...events) => send({ subscription_id: 'test', query, messages: events.map((event) => ({ sequence: ++sequence, event })) }) });
    return close;
  }) };
  const session = new ResourceWatchSession(context, provider, (kind, commit) => { commits.push(commit); useResourceStore.getState().applyWatchCommit(kind, commit); });
  return { session, connections, commits };
}
const flush = () => vi.advanceTimersByTimeAsync(WATCH_FLUSH_MS);
beforeEach(() => { vi.useFakeTimers(); useResourceStore.getState().reset(); });
afterEach(() => { vi.useRealTimers(); });

describe('Resource watch session', () => {
  it('publishes one complete snapshot, coalesces a burst by UID and updates selection', async () => {
    const { session, connections, commits } = harness();
    const ready = session.refresh('Pod'); await Promise.resolve();
    connections[0].emit(delta([pod('web')]), live); await flush(); await ready;
    useResourceStore.getState().selectItem(useResourceStore.getState().resources.Pod.get('web')!);
    commits.length = 0;
    for (let i = 0; i < 1000; i++) connections[0].emit({ type: 'Delta', payload: { type: 'Applied', payload: { data: pod('web', `phase-${i}`) } } });
    expect(commits).toHaveLength(0); await flush();
    expect(commits).toHaveLength(1); expect(commits[0].changes).toHaveLength(1);
    expect(useResourceStore.getState().selectedItem?.status).toBe('phase-999');
    connections[0].emit({ type: 'Delta', payload: { type: 'Deleted', payload: { uid: 'web' } } }); await flush();
    expect(useResourceStore.getState().selectedItem).toBeNull(); session.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('retains the last complete snapshot on reconnect and atomically replaces it with an empty relist', async () => {
    const { session, connections } = harness(); const ready = session.refresh('Pod'); await Promise.resolve();
    connections[0].emit(delta([pod('old')]), live); await flush(); await ready;
    const resources = useResourceStore.getState().resources;
    connections[0].emit({ type: 'Status', payload: { phase: 'reconnecting', error: { code: 'unavailable', operation: 'watch', message: 'Connection lost', status: 503, retryable: true } } }); await flush();
    expect(useResourceStore.getState().resources).toBe(resources);
    expect(useResourceStore.getState().watchStates.Pod).toMatchObject({ phase: 'reconnecting', hasSnapshot: true });
    expect(useResourceStore.getState().loadErrors.Pod?.status).toBe(503);
    connections[0].emit(delta([]), live); await flush();
    expect(useResourceStore.getState().resources.Pod.size).toBe(0);
    expect(useResourceStore.getState().loadErrors.Pod).toBeUndefined(); session.stop();
  });
  it('rejects sequence gaps without publishing buffered updates; ignores duplicate and foreign query messages', async () => {
    const { session, connections } = harness(); const ready = session.refresh('Pod'); await Promise.resolve();
    const connection = connections[0];
    connection.send({ subscription_id: 'test', query: { ...connection.query, context: 'other' }, messages: [{ sequence: 1, event: delta([pod('foreign')]) }] });
    connection.emit(delta([pod('ok')]), live); await flush(); await ready;
    connection.send({ subscription_id: 'test', query: connection.query, messages: [{ sequence: 2, event: delta([]) }] }); await flush();
    expect(useResourceStore.getState().resources.Pod.has('ok')).toBe(true);
    connection.emit({ type: 'Delta', payload: { type: 'Applied', payload: { data: pod('buffered') } } });
    connection.send({ subscription_id: 'test', query: connection.query, messages: [{ sequence: 5, event: live }] }); await flush();
    expect(useResourceStore.getState().resources.Pod.has('buffered')).toBe(false);
    expect(useResourceStore.getState().watchStates.Pod?.phase).toBe('failed'); expect(connection.signal.aborted).toBe(true); session.stop();
  });
  it('rejects a malformed snapshot as a whole and a live state before first sync', async () => {
    for (const event of [delta([pod('good'), pod('bad', 'Running', '')]), live]) {
      const { session, connections } = harness(); const ready = session.refresh('Pod'); const rejected = expect(ready).rejects.toThrow(); await Promise.resolve();
      connections[0].emit(event); await flush(); await rejected;
      expect(useResourceStore.getState().resources.Pod.size).toBe(0); session.stop();
    }
  });
  it('times out first sync and closes all timers and the underlying subscription', async () => {
    const { session, connections } = harness(); const ready = session.refresh('Pod'); const rejected = expect(ready).rejects.toMatchObject({ code: 'timeout' });
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(FIRST_SYNC_TIMEOUT_MS); await rejected;
    expect(connections[0].signal.aborted).toBe(true); expect(connections[0].close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); session.stop();
  });
  it('ignores late callbacks from a previous refresh and closes a late registration acknowledgement', async () => {
    const { session, connections } = harness(); const first = session.refresh('Pod'); await Promise.resolve();
    const second = session.refresh('Pod'); await Promise.resolve(); await first;
    connections[0].emit(delta([pod('stale')]), live);
    connections[1].emit(delta([pod('current')]), live); await flush(); await second;
    expect([...useResourceStore.getState().resources.Pod.keys()]).toEqual(['current']);
    expect(connections[0].close).toHaveBeenCalledOnce(); session.stop();
    connections[1].emit(delta([pod('after-stop')]), live); await flush();
    expect([...useResourceStore.getState().resources.Pod.keys()]).toEqual(['current']);
  });
  it('closes a provider registration that resolves after the session stops', async () => {
    let acknowledge!: (close: () => void) => void; const close = vi.fn();
    const session = new ResourceWatchSession('a', { watchResources: () => new Promise((resolve) => { acknowledge = resolve; }) }, vi.fn());
    const ready = session.refresh('Pod'); await Promise.resolve(); session.stop(); await ready;
    acknowledge(close); await Promise.resolve(); await Promise.resolve(); expect(close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
