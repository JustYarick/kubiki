import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResourceWatches, stopResourceWatches, discardStaleResourceKind } from '../../src/state/resource_watch';
import { useClusterStore } from '../../src/state/cluster_store';
import { useResourceStore } from '../../src/state/resource_store';
import { useWorkspaceStore } from '../../src/state/workspace_store';
import { useUiStore } from '../../src/state/ui_store';
import { useDetailCache } from '../../src/state/detail_cache';
import { useNotifications } from '../../src/state/notifications_store';
import { notifyStaleRefreshFailure, resetStaleRefreshToasts } from '../../src/state/stale_error_toast';
import { clearAllResourceCaches } from '../../src/state/cache_control';
import { ReadSubscriptions, type ReadSnapshot, type ReadVisibility } from '../../src/providers/read_subscriptions';
import { prefetchDetailDependencies } from '../../src/providers/detail_prefetch';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import type { ResourceQuery } from '../../src/core/resources/resource_types';
import type { WatchBatch } from '../../src/providers/watch_types';
import { requestError } from '../../src/providers/errors';

const mock = vi.hoisted(() => ({
  supportsResourceWatch: true,
  watchResources: vi.fn(),
  getResourceCounts: vi.fn(async () => ({})),
  getResource: vi.fn(),
  getResources: vi.fn(async () => []),
  demo: false,
}));
vi.mock('../../src/providers/k8s_provider', () => ({ k8s: mock }));

const podRaw = (uid: string, name = uid, namespace = 'backend') => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { uid, name, namespace },
  status: { phase: 'Running' },
});

class Visibility implements ReadVisibility {
  hidden = false;
  listeners = new Set<() => void>();
  addEventListener(_type: string, fn: () => void) { this.listeners.add(fn); }
  removeEventListener(_type: string, fn: () => void) { this.listeners.delete(fn); }
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  useResourceStore.getState().reset();
  useDetailCache.getState().clear();
  useNotifications.setState({ toasts: [] });
  resetStaleRefreshToasts();
  useUiStore.setState({ inspectorCollapsed: true, resourceCacheMode: 'stale-while-revalidate' });
  useWorkspaceStore.setState({
    tabs: [{ id: 'pods', type: 'resource-list', kind: 'Pod', title: 'Pods' }],
    activeTabId: 'pods',
    splitTabId: null,
  });
  useClusterStore.setState({
    currentContext: 'test',
    selectedNamespace: 'backend',
    availableNamespaces: [],
    availableResourceKinds: null,
  });
  mock.watchResources.mockReset();
  mock.getResource.mockReset();
  mock.getResources.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  stopResourceWatches();
  useUiStore.setState({ resourceCacheMode: 'stale-while-revalidate' });
  vi.useRealTimers();
});

describe('resource tab cache policy and stale refresh handling', () => {
  it('marks reopened cached rows with fromCache and updatedAt, supports discarding stale rows on failure, and clears on always-fresh', async () => {
    let holdPodSync = false;
    let releasePodSync: (() => void) | null = null;
    let failPodSync: (() => void) | null = null;

    mock.watchResources.mockImplementation(async (query: ResourceQuery, emit: (batch: WatchBatch) => void) => {
      const sendLive = (items: Record<string, any>[]) => emit({
        query,
        subscription_id: 'test',
        messages: [
          { sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items } } } },
          { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } },
        ],
      });
      if (query.kind === 'Pod' && holdPodSync) {
        releasePodSync = () => sendLive([podRaw('pod-2', 'web-2')]);
        failPodSync = () => emit({
          query,
          subscription_id: 'test',
          messages: [{ sequence: 1, event: { type: 'Status', payload: { phase: 'failed', error: { code: 'unavailable', operation: 'watch', message: 'API server unreachable', status: 503, retryable: true } } } }],
        });
        return vi.fn();
      }
      sendLive(query.kind === 'Pod' ? [podRaw('pod-1', 'web-1')] : []);
      return vi.fn();
    });

    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    const ready = startResourceWatches('test');
    await vi.advanceTimersByTimeAsync(50);
    await ready;

    const firstUpdatedAt = useResourceStore.getState().watchStates.Pod?.updatedAt;
    expect(firstUpdatedAt).toBe(Date.parse('2026-01-01T10:00:00Z'));
    expect(useResourceStore.getState().watchStates.Pod?.fromCache).toBe(false);
    expect([...useResourceStore.getState().resources.Pod.keys()]).toEqual(['pod-1']);

    // Close Pods tab (switch to ConfigMaps) -> Pod watch stops, snapshot remains cached in store.
    useWorkspaceStore.setState({ tabs: [{ id: 'configmaps', type: 'resource-list', kind: 'ConfigMap', title: 'ConfigMaps' }], activeTabId: 'configmaps' });
    await vi.advanceTimersByTimeAsync(50);
    expect(useResourceStore.getState().watchStates.Pod?.phase).toBe('stopped');
    expect(useResourceStore.getState().watchStates.Pod?.updatedAt).toBe(firstUpdatedAt);

    // Reopen Pods tab while fresh sync is held -> stale-while-revalidate shows cached rows with fromCache: true.
    vi.setSystemTime(new Date('2026-01-01T10:05:00Z'));
    holdPodSync = true;
    useWorkspaceStore.setState({ tabs: [{ id: 'pods', type: 'resource-list', kind: 'Pod', title: 'Pods' }], activeTabId: 'pods' });
    await vi.advanceTimersByTimeAsync(50);
    expect([...useResourceStore.getState().resources.Pod.keys()]).toEqual(['pod-1']);
    expect(useResourceStore.getState().watchStates.Pod).toMatchObject({
      phase: 'connecting',
      hasSnapshot: true,
      fromCache: true,
      updatedAt: firstUpdatedAt,
    });

    // Background refresh fails -> cached rows remain with error and original updatedAt.
    failPodSync!();
    await vi.advanceTimersByTimeAsync(60);
    expect(useResourceStore.getState().watchStates.Pod).toMatchObject({
      phase: 'failed',
      hasSnapshot: true,
      fromCache: true,
      updatedAt: firstUpdatedAt,
    });
    expect(useResourceStore.getState().loadErrors.Pod?.message).toBe('API server unreachable');
    expect([...useResourceStore.getState().resources.Pod.keys()]).toEqual(['pod-1']);

    // User clicks "Clear stale data" -> rows cleared, error retained for Retry.
    discardStaleResourceKind('Pod');
    expect(useResourceStore.getState().resources.Pod.size).toBe(0);
    expect(useResourceStore.getState().watchStates.Pod).toMatchObject({
      phase: 'failed',
      hasSnapshot: false,
      fromCache: false,
      updatedAt: undefined,
    });
    expect(useResourceStore.getState().loadErrors.Pod?.message).toBe('API server unreachable');

    // Close and reopen once live again, then verify always-fresh clears cache on reopen.
    holdPodSync = false;
    useWorkspaceStore.setState({ tabs: [{ id: 'configmaps', type: 'resource-list', kind: 'ConfigMap', title: 'ConfigMaps' }], activeTabId: 'configmaps' });
    await vi.advanceTimersByTimeAsync(50);
    useWorkspaceStore.setState({ tabs: [{ id: 'pods', type: 'resource-list', kind: 'Pod', title: 'Pods' }], activeTabId: 'pods' });
    await vi.advanceTimersByTimeAsync(50);
    expect([...useResourceStore.getState().resources.Pod.keys()]).toEqual(['pod-1']);
    expect(useResourceStore.getState().watchStates.Pod?.fromCache).toBe(false);

    // Switch to always-fresh, close tab, reopen with held sync -> old rows must NOT appear.
    useUiStore.getState().setResourceCacheMode('always-fresh');
    useWorkspaceStore.setState({ tabs: [{ id: 'configmaps', type: 'resource-list', kind: 'ConfigMap', title: 'ConfigMaps' }], activeTabId: 'configmaps' });
    await vi.advanceTimersByTimeAsync(50);
    holdPodSync = true;
    useWorkspaceStore.setState({ tabs: [{ id: 'pods', type: 'resource-list', kind: 'Pod', title: 'Pods' }], activeTabId: 'pods' });
    await vi.advanceTimersByTimeAsync(50);
    expect(useResourceStore.getState().resources.Pod.size).toBe(0);
    expect(useResourceStore.getState().watchStates.Pod).toMatchObject({
      phase: 'connecting',
      hasSnapshot: false,
      fromCache: false,
    });

    // Fresh snapshot lands -> live rows appear.
    releasePodSync!();
    await vi.advanceTimersByTimeAsync(50);
    expect([...useResourceStore.getState().resources.Pod.keys()]).toEqual(['pod-2']);
    expect(useResourceStore.getState().watchStates.Pod).toMatchObject({
      phase: 'live',
      hasSnapshot: true,
      fromCache: false,
    });
  });

  it('ReadSubscriptions tracks fromCache on reopen, supports discardStale, and bypasses cache in always-fresh mode', async () => {
    const visibility = new Visibility();
    let resolveNext: ((value: string) => void) | null = null;
    const read = vi.fn(() => new Promise<string>((resolve) => { resolveNext = resolve; }));
    const subs = new ReadSubscriptions(read, 15000, () => visibility);

    const first: ReadSnapshot<string>[] = [];
    const off1 = subs.subscribe('scope-a', (snap) => first.push(snap));
    await flushMicrotasks();
    expect(first.at(-1)?.data).toBeUndefined();
    expect(first.at(-1)).toMatchObject({ loading: true, fromCache: false });
    resolveNext!('v1');
    await flushMicrotasks();
    expect(first.at(-1)).toMatchObject({ data: 'v1', loading: false, fromCache: false });
    off1();

    // Reopen in default stale-while-revalidate mode -> seeds cached v1 with fromCache: true.
    const second: ReadSnapshot<string>[] = [];
    const off2 = subs.subscribe('scope-a', (snap) => second.push(snap));
    expect(second[0]).toMatchObject({ data: 'v1', loading: true, fromCache: true });
    await flushMicrotasks();
    resolveNext!('v2');
    await flushMicrotasks();
    expect(second.at(-1)).toMatchObject({ data: 'v2', loading: false, fromCache: false });

    // Simulate failure retaining data, then discardStale preserves error while removing stale data.
    read.mockRejectedValueOnce(new Error('503 Unavailable'));
    subs.refresh('scope-a');
    await flushMicrotasks();
    expect(second.at(-1)).toMatchObject({ data: 'v2', loading: false, error: { message: '503 Unavailable' } });
    subs.discardStale('scope-a');
    expect(second.at(-1)?.data).toBeUndefined();
    expect(second.at(-1)).toMatchObject({ loading: false, fromCache: false, error: { message: '503 Unavailable' } });
    off2();

    // In always-fresh mode -> never serves cached snapshot on reopen.
    useUiStore.getState().setResourceCacheMode('always-fresh');
    read.mockImplementation(() => new Promise<string>((resolve) => { resolveNext = resolve; }));
    const off3 = subs.subscribe('scope-b', () => {});
    await flushMicrotasks();
    resolveNext!('fresh-1');
    await flushMicrotasks();
    off3();

    const fourth: ReadSnapshot<string>[] = [];
    const off4 = subs.subscribe('scope-b', (snap) => fourth.push(snap));
    expect(fourth[0]?.data).toBeUndefined();
    expect(fourth[0]).toMatchObject({ loading: true, fromCache: false });
    off4();
  });

  it('prefetchDetailDependencies bypasses detail_cache when always-fresh is enabled', async () => {
    const pod = mapK8sResource({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { uid: 'pod-1', name: 'web', namespace: 'prod' },
      spec: { containers: [{ name: 'web', envFrom: [{ configMapRef: { name: 'app-cfg' } }] }] },
    }, 'Pod');
    mock.getResource.mockImplementation(async (_ctx: string, kind: any, name: string, namespace?: string) => mapK8sResource({
      apiVersion: 'v1',
      kind,
      metadata: { uid: `${kind}-${name}`, name, namespace },
      ...(kind === 'ConfigMap' ? { data: { key: 'val' } } : {}),
    }, kind));

    useUiStore.getState().setResourceCacheMode('stale-while-revalidate');
    await prefetchDetailDependencies('test', pod, new AbortController().signal);
    const firstPassCalls = mock.getResource.mock.calls.length;
    expect(firstPassCalls).toBeGreaterThan(0);
    await prefetchDetailDependencies('test', pod, new AbortController().signal);
    expect(mock.getResource).toHaveBeenCalledTimes(firstPassCalls);

    // Switching to always-fresh forces fresh dependency fetch instead of reusing detail_cache.
    useUiStore.getState().setResourceCacheMode('always-fresh');
    await prefetchDetailDependencies('test', pod, new AbortController().signal);
    expect(mock.getResource).toHaveBeenCalledTimes(firstPassCalls * 2);
  });

  it('deduplicates stale-refresh warning toasts per scope until error changes or recovers', () => {
    const err503 = requestError('unavailable', 'API server unavailable', { operation: 'watch' }, 503);
    const err403 = requestError('forbidden', 'Forbidden', { operation: 'watch' }, 403);

    expect(notifyStaleRefreshFailure({ scopeId: 'pods', label: 'pods', error: err503, retainedData: true, fromCache: true })).toBe(true);
    expect(useNotifications.getState().toasts).toHaveLength(1);
    expect(useNotifications.getState().toasts[0]).toMatchObject({
      type: 'warn',
      title: 'Showing cached pods',
      description: 'Refresh failed: API server unavailable',
    });

    // Repeated identical failure does not spam toasts.
    expect(notifyStaleRefreshFailure({ scopeId: 'pods', label: 'pods', error: err503, retainedData: true, fromCache: true })).toBe(false);
    expect(useNotifications.getState().toasts).toHaveLength(1);

    // Different error emits a new toast.
    expect(notifyStaleRefreshFailure({ scopeId: 'pods', label: 'pods', error: err403, retainedData: true, fromCache: false })).toBe(true);
    expect(useNotifications.getState().toasts).toHaveLength(2);
    expect(useNotifications.getState().toasts[1].title).toBe('Showing stale pods');

    // Recovery clears dedup state so a future failure alerts again.
    expect(notifyStaleRefreshFailure({ scopeId: 'pods', label: 'pods', error: null, retainedData: true })).toBe(false);
    expect(notifyStaleRefreshFailure({ scopeId: 'pods', label: 'pods', error: err403, retainedData: true })).toBe(true);
    expect(useNotifications.getState().toasts).toHaveLength(3);
  });

  it('clearAllResourceCaches clears detail_cache and stopped buckets while preserving active watches', async () => {
    mock.watchResources.mockImplementation(async (query: ResourceQuery, emit: (batch: WatchBatch) => void) => {
      emit({
        query,
        subscription_id: 'test',
        messages: [
          { sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items: query.kind === 'Pod' ? [podRaw('pod-active')] : [] } } } },
          { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } },
        ],
      });
      return vi.fn();
    });
    const ready = startResourceWatches('test');
    await vi.advanceTimersByTimeAsync(50);
    await ready;

    // Seed a stopped ConfigMap snapshot and a detail_cache entry.
    useResourceStore.setState((state) => ({
      resources: {
        ...state.resources,
        ConfigMap: new Map([['cm-old', mapK8sResource({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { uid: 'cm-old', name: 'old', namespace: 'backend' } }, 'ConfigMap')]]),
      },
      watchStates: {
        ...state.watchStates,
        ConfigMap: { query: { context: 'test', group: '', version: 'v1', kind: 'ConfigMap', namespace: 'backend' }, phase: 'stopped', hasSnapshot: true },
      },
    }));
    useDetailCache.getState().upsert('test', mapK8sResource({ apiVersion: 'v1', kind: 'Node', metadata: { uid: 'node-1', name: 'worker-1' } }, 'Node'));
    expect(useResourceStore.getState().resources.ConfigMap.size).toBe(1);
    expect(useDetailCache.getState().items.size).toBe(1);

    await clearAllResourceCaches({ refreshActive: false });
    expect(useDetailCache.getState().items.size).toBe(0);
    expect(useResourceStore.getState().resources.ConfigMap.size).toBe(0);
    expect(useResourceStore.getState().watchStates.ConfigMap).toBeUndefined();
    // Active Pod watch remains intact.
    expect(useResourceStore.getState().resources.Pod.has('pod-active')).toBe(true);
  });
});
