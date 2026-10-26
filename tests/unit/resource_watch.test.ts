import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceWatchSession, WATCH_FLUSH_MS, FIRST_SYNC_TIMEOUT_MS } from '../../src/providers/resource_watch_session';
import type { ResourceQuery } from '../../src/core/resources/resource_types';
import type { ResourceWatchProvider, WatchBatch, WatchCommit, WatchMessage } from '../../src/providers/watch_types';
import { useResourceStore } from '../../src/state/resource_store';

const pod = (uid: string, phase = 'Running', namespace = 'backend') => ({ kind: 'Pod', apiVersion: 'v1', metadata: { uid, name: uid, namespace }, status: { phase } });
const delta = (items: Record<string, any>[]): WatchMessage['event'] => ({ type: 'Delta', payload: { type: 'Restarted', payload: { items } } });
const live: WatchMessage['event'] = { type: 'Status', payload: { phase: 'live', error: null } };
function harness(context = 'a', namespace = 'all') {
  const connections: Array<{ query: ResourceQuery; signal: AbortSignal; close: ReturnType<typeof vi.fn>; emit: (...events: WatchMessage['event'][]) => void; send: (batch: WatchBatch) => void }> = [];
  const commits: WatchCommit[] = [];
  const provider: ResourceWatchProvider = { watchResources: vi.fn(async (query, send, signal) => {
    let sequence = 0; const close = vi.fn();
    connections.push({ query, signal, close, send, emit: (...events) => send({ subscription_id: 'test', query, messages: events.map((event) => ({ sequence: ++sequence, event })) }) });
    return close;
  }) };
  const session = new ResourceWatchSession(context, provider, (kind, commit) => { commits.push(commit); useResourceStore.getState().applyWatchCommit(kind, commit); }, namespace);
  return { session, connections, commits };
}
const flush = () => vi.advanceTimersByTimeAsync(WATCH_FLUSH_MS);
beforeEach(() => { vi.useFakeTimers(); useResourceStore.getState().reset(); });
afterEach(() => { vi.useRealTimers(); });

describe('Resource watch session', () => {
  it('releases unused watches, rejects late updates and reopens them with a fresh snapshot', async () => {
    const { session, connections } = harness();
    const initial = session.setKinds(['Pod', 'Service'], new Set()); await Promise.resolve();
    connections[0].emit(delta([pod('old')]), live); connections[1].emit(delta([]), live); await flush(); await initial;
    await session.setKinds(['Service']);
    expect(connections[0].signal.aborted).toBe(true); expect(connections[1].signal.aborted).toBe(false);
    connections[0].emit(delta([pod('late')])); await flush(); expect(useResourceStore.getState().resources.Pod.has('late')).toBe(false);
    const reopened = session.setKinds(['Pod', 'Service']); await Promise.resolve();
    expect(connections).toHaveLength(3); connections[2].emit(delta([pod('new')]), live); await flush(); await reopened;
    expect([...useResourceStore.getState().resources.Pod.keys()]).toEqual(['new']); session.stop();
  });
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

describe('Namespace-scoped watch sessions', () => {
  it('replaces only namespaced subscriptions and clears old snapshots, selection and pending changes', async () => {
    const { session, connections } = harness();
    const initial = session.start(['Pod', 'Service', 'Node']); await Promise.resolve();
    connections[0].emit(delta([pod('web'), pod('other', 'Running', 'other')]), live);
    connections[1].emit(delta([]), live);
    connections[2].emit(delta([{ kind: 'Node', apiVersion: 'v1', metadata: { uid: 'node', name: 'worker' } }]), live);
    await flush(); await initial;
    const nodeMap = useResourceStore.getState().resources.Node;
    const selected = useResourceStore.getState().resources.Pod.get('web')!;
    useResourceStore.getState().selectItem(selected);
    useResourceStore.setState({ selectionHistory: [selected] });
    connections[0].emit({ type: 'Delta', payload: { type: 'Applied', payload: { data: pod('buffered') } } });
    const scoped = session.setNamespace('backend');
    // Scope-independent kinds keep their cluster-wide snapshot and selection.
    expect(useResourceStore.getState().resources.Pod.size).toBe(2);
    expect(useResourceStore.getState().selectedItem).not.toBeNull();
    expect(useResourceStore.getState().selectionHistory).toEqual([selected]);
    await Promise.resolve();
    expect(connections.slice(3).map((c) => [c.query.kind, c.query.namespace])).toEqual([['Service', 'backend']]);
    expect(connections[0].signal.aborted).toBe(false); expect(connections[2].signal.aborted).toBe(false);
    connections[0].emit({ type: 'Delta', payload: { type: 'Applied', payload: { data: pod('late') } } });
    connections[3].emit(delta([]), live);
    await flush(); await scoped;
    expect([...useResourceStore.getState().resources.Pod.keys()]).toEqual(['web', 'other', 'buffered', 'late']);
    expect(useResourceStore.getState().resources.Node).toBe(nodeMap);
    const count = connections.length; await session.setNamespace('backend'); expect(connections.length).toBe(count);
    session.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('starts at the requested namespace, validates object scope, and keeps scoped data on Retry', async () => {
    const { session, connections } = harness('a', 'backend'); const initial = session.refresh('Service'); await Promise.resolve();
    expect(connections[0].query.namespace).toBe('backend');
    connections[0].emit(delta([{ kind: 'Service', apiVersion: 'v1', metadata: { uid: 'current', name: 'svc', namespace: 'backend' } }]), live); await flush(); await initial;
    const retry = session.refresh('Service'); const rejected = expect(retry).rejects.toThrow('scope'); await Promise.resolve();
    expect(useResourceStore.getState().resources.Service.has('current')).toBe(true);
    expect(useResourceStore.getState().watchStates.Service?.hasSnapshot).toBe(true);
    connections[1].emit(delta([{ kind: 'Service', apiVersion: 'v1', metadata: { uid: 'foreign', name: 'svc', namespace: 'other' } }])); await flush();
    await rejected;
    expect([...useResourceStore.getState().resources.Service.keys()]).toEqual(['current']);
    session.stop();
  });
  it('isolates rapid namespace A → B → A and returning to all namespaces', async () => {
    const { session, connections } = harness('context', 'backend'); const first = session.refresh('Service'); await Promise.resolve();
    const second = session.setNamespace('other'); await Promise.resolve();
    const third = session.setNamespace('backend'); await Promise.resolve();
    connections[0].emit(delta([{ kind: 'Service', apiVersion: 'v1', metadata: { uid: 'stale-a', name: 'a', namespace: 'backend' } }]), live);
    connections[1].emit(delta([{ kind: 'Service', apiVersion: 'v1', metadata: { uid: 'stale-b', name: 'b', namespace: 'other' } }]), live);
    connections[2].emit(delta([{ kind: 'Service', apiVersion: 'v1', metadata: { uid: 'current', name: 'c', namespace: 'backend' } }]), live); await flush(); await Promise.all([first, second, third]);
    expect([...useResourceStore.getState().resources.Service.keys()]).toEqual(['current']);
    const all = session.setNamespace('all'); await Promise.resolve(); expect(connections[3].query.namespace).toBeNull();
    connections[3].emit(delta([{ kind: 'Service', apiVersion: 'v1', metadata: { uid: 'a', name: 'a', namespace: 'backend' } }, { kind: 'Service', apiVersion: 'v1', metadata: { uid: 'b', name: 'b', namespace: 'other' } }]), live); await flush(); await all;
    expect(useResourceStore.getState().resources.Service.size).toBe(2); session.stop();
  });
  it('keeps scope-independent kinds cluster-wide so global metrics do not change with the selection', async () => {
    const { session, connections } = harness('context', 'backend');
    const initial = session.refresh('Pod'); await Promise.resolve();
    expect(connections[0].query.namespace).toBeNull();
    connections[0].emit(delta([pod('web'), pod('other', 'Running', 'other')]), live); await flush(); await initial;
    const scoped = session.setNamespace('other'); await Promise.resolve(); await scoped;
    // The Pod subscription is untouched by the namespace change.
    expect(connections).toHaveLength(1);
    expect(connections[0].signal.aborted).toBe(false);
    expect(useResourceStore.getState().resources.Pod.size).toBe(2);
    session.stop();
  });
});
