import { afterEach, expect, it, vi } from 'vitest';
import { HttpReadTransport, TauriReadTransport } from '../../src/providers/read_transport';
import { K8sProvider } from '../../src/providers/k8s_provider';
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => native);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); native.invoke.mockReset(); });

it('aborts native reads immediately and sends the matching owner-bound request ID for backend cancellation', async () => {
  let finish!: (value: unknown) => void;
  native.invoke.mockImplementation(command => command === 'get_resources' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
  const abort = new AbortController();
  const pending = new TauriReadTransport().request('get_resources', 'resources', { context: 'prod' }, { operation: 'resources' }, undefined, abort.signal);
  await Promise.resolve();
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('get_resources', expect.objectContaining({ requestId: expect.any(String) })));
  const requestId = native.invoke.mock.calls[0][1].requestId;
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(native.invoke).toHaveBeenCalledWith('cancel_read_task', { requestId });
  finish({ items: ['late'] });
});

it('distinguishes explicit HTTP cancellation from the longer Helm deadline', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  })));
  const transport = new HttpReadTransport();
  const abort = new AbortController();
  const cancelled = transport.request('get_resources', 'resources', {}, { operation: 'resources' }, undefined, abort.signal);
  abort.abort(); await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
  let settled = false;
  const slow = transport.request('get_helm_inventory', 'helm/inventory', {}, { operation: 'helm' });
  const result = expect(slow).rejects.toMatchObject({ code: 'timeout' }).then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(20001); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(40000); await result;
});

it('bounds actual resource, custom-resource and metrics reads together across namespace selections', async () => {
  const finish: (() => void)[] = [];
  let running = 0; let maximum = 0; let count = 0;
  const provider = new K8sProvider({ native: false, request: async <T>(command: string, _path: string, args: Record<string, unknown>) => {
    running++; maximum = Math.max(maximum, running); count++;
    await new Promise<void>(resolve => finish.push(resolve)); running--;
    return (command === 'get_overview_metrics' ? { context: 'prod', namespace: args.namespace, pods: { items: [], error: null }, nodes: { items: null, error: null } } : { items: [] }) as T;
  } });
  const namespaces = JSON.stringify(['one', 'two', 'three', 'four', 'five', 'six']);
  const pending = Promise.all([provider.getResources('prod', 'Pod', namespaces), provider.getCustomResources('prod', 'widgets.example.com', 'definition', namespaces), provider.getOverviewMetrics('prod', namespaces)]);
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  await flush(); expect(count).toBe(4);
  for (let round = 0; round < 30 && (count < 18 || finish.length); round++) {
    finish.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 0));
    await flush();
  }
  expect(count).toBe(18);
  await pending;
  expect(maximum).toBe(4); expect(count).toBe(18);
});

it('does not sum successful namespace counts when another namespace count is unknown', async () => {
  const provider = new K8sProvider({ native: false, request: async <T>(_command: string, _path: string, args: Record<string, unknown>) => (args.namespace === 'one' ? { Pod: 10, Node: 3 } : { Node: 3 }) as T });
  expect(await provider.getResourceCounts('prod', ['Pod', 'Node'], '["one","two"]')).toEqual({ Node: 3 });
});

it('computes resource counts from locally cached snapshots when scope covers request', async () => {
  const { useResourceStore } = await import('../../src/state/resource_store');
  useResourceStore.setState({
    resources: {
      ...useResourceStore.getState().resources,
      Pod: new Map([
        ['pod-1', { uid: 'pod-1', name: 'pod-1', namespace: 'default', kind: 'Pod', apiVersion: 'v1' }],
        ['pod-2', { uid: 'pod-2', name: 'pod-2', namespace: 'kube-system', kind: 'Pod', apiVersion: 'v1' }],
      ]),
    },
    watchStates: {
      Pod: {
        hasSnapshot: true,
        phase: 'live',
        query: { context: 'prod', group: '', version: 'v1', kind: 'Pod', namespace: null },
      },
    },
  });

  let networkCalled = false;
  const provider = new K8sProvider({
    native: false,
    request: async <T>() => {
      networkCalled = true;
      return {} as T;
    },
  });

  const allCounts = await provider.getResourceCounts('prod', ['Pod'], 'all');
  expect(allCounts).toEqual({ Pod: 2 });
  expect(networkCalled).toBe(false);

  const nsCounts = await provider.getResourceCounts('prod', ['Pod'], 'default');
  expect(nsCounts).toEqual({ Pod: 1 });
  expect(networkCalled).toBe(false);

  useResourceStore.getState().reset();
});

it('cancels context discovery reads when activating a different context', async () => {
  const provider = new K8sProvider({ native: false, request: <T>(_command: string, _path: string, _args: Record<string, unknown>, _info: unknown, _body?: unknown, signal?: AbortSignal) => new Promise<T>((_, reject) => {
    signal!.addEventListener('abort', () => reject({ code: 'cancelled', message: 'Read was cancelled', retryable: false }), { once: true });
  }) });
  provider.activateContext('old');
  const pending = provider.getNamespaces('old');
  provider.activateContext('new');
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
});
