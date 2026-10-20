import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startPortForward, closePortForwards, type ForwardSession } from '../../src/providers/port_forward';
import { usePfStore } from '../../src/state/pf_store';
import { resourceQuery } from '../../src/core/resources/resource_types';
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
const request = { resource: { ...resourceQuery('test','Pod','backend'), name: 'web', uid: 'uid' }, remote_port: 8080, local_port: 0 };
const native = (id = 'tunnel'): ForwardSession => ({ id, resource: request.resource, target_kind: 'Pod', name: 'web', namespace: 'backend', remote_port: 8080, local_port: 34567, pod_name: 'web', pod_uid: 'uid', pod_port: 8080, status: 'Active', started_at: 1000, bytes_sent: 123, bytes_received: 456 });
beforeEach(() => { vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: mock.invoke } }); mock.invoke.mockReset().mockResolvedValue(undefined); usePfStore.getState().clear(); });
afterEach(() => { closePortForwards(); vi.unstubAllGlobals(); });
it('cleans up late starts after cancel and after global context cleanup', async () => {
  for (const global of [false, true]) {
    mock.invoke.mockClear(); let release!: (value: ForwardSession) => void;
    mock.invoke.mockImplementation(command => command === 'start_port_forward' ? new Promise<ForwardSession>(resolve => { release = resolve; }) : Promise.resolve());
    const controller = new AbortController(); const pending = startPortForward(request, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'conflict' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (global) closePortForwards(); else controller.abort();
    release(native()); await rejected;
    expect(mock.invoke.mock.calls.filter(([command]) => command === 'stop_port_forward').length).toBeGreaterThanOrEqual(2);
  }
});
it('surfaces RBAC errors with their code and releases a failed registration', async () => {
  mock.invoke.mockImplementation(command => command === 'start_port_forward' ? Promise.reject({ code: 'forbidden', message: 'pods/portforward denied', status: 403 }) : Promise.resolve());
  await expect(startPortForward(request, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  expect(mock.invoke.mock.calls.some(([command]) => command === 'stop_port_forward')).toBe(true);
});
it('merges poll snapshots without resurrecting stopped tunnels or dropping new ones', () => {
  const store = usePfStore.getState(); store.upsertLive(native('old'));
  const requested = ['old']; store.upsertLive(native('new')); store.remove('old');
  store.syncLive([native('old')], 'test', requested);
  expect(usePfStore.getState().sessions.map(session => session.id)).toEqual(['new']);
  store.syncLive([{ ...native('new'), bytes_received: 999 }], 'test', ['new']);
  expect(usePfStore.getState().sessions[0]).toMatchObject({ bytesIn: 999, bytesOut: 123, podName: 'web' });
  store.tick(); expect(usePfStore.getState().sessions[0].bytesIn).toBe(999);
  store.syncLive([], 'test', ['new']); expect(usePfStore.getState().sessions).toEqual([]);
});
it('browser mode gives a desktop requirement instead of a simulated live tunnel', async () => {
  vi.stubGlobal('window', {});
  await expect(startPortForward(request, new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported' });
});
