import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareNodeDebug, stopNodeDebug, closeNodeDebugConnections, removeOtherDebugPod, nodeDebugStatus } from '../../src/providers/node_debug';
import { resourceQuery } from '../../src/core/resources/resource_types';
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
const resource = { ...resourceQuery('test', 'Node'), name: 'worker', uid: 'node-uid' };
const pod = { ...resourceQuery('test', 'Pod', 'debug'), name: 'kubiki-node-debug-id', uid: 'pod-uid' };
beforeEach(() => { mock.invoke.mockReset().mockResolvedValue(pod);vi.stubGlobal('window', { __TAURI_INTERNALS__: {} }); });
afterEach(() => { closeNodeDebugConnections();vi.unstubAllGlobals(); });
it('sends the Node identity and chosen debug scope and retains its lease until stop', async () => {
  const abort = new AbortController();expect(await prepareNodeDebug('id', { resource, namespace: 'debug', image: 'ubuntu:24.04' }, abort.signal)).toEqual(pod);
  expect(mock.invoke).toHaveBeenCalledWith('mutate_resource', { request: { operation: 'node_debug', session_id: 'id', request: { resource, namespace: 'debug', image: 'ubuntu:24.04' } } });
  await stopNodeDebug('id');expect(mock.invoke).toHaveBeenCalledWith('stop_node_debug', { sessionId: 'id' });
});
it('cancels pending preparation, rejects late readiness and requests cleanup again after a late response', async () => {
  let ready!: (resource: typeof pod) => void;mock.invoke.mockImplementation((cmd) => cmd === 'mutate_resource' ? new Promise((resolve) => { ready = resolve; }) : Promise.resolve());
  const abort = new AbortController();const pending = prepareNodeDebug('late', { resource, namespace: 'debug', image: 'ubuntu' }, abort.signal);const rejection = expect(pending).rejects.toMatchObject({ code: 'conflict' });
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalled());abort.abort();ready(pod);await rejection;expect(mock.invoke.mock.calls.filter(([cmd]) => cmd === 'stop_node_debug')).toHaveLength(2);
});
it('normalizes admission errors and keeps cleanup failures visible to explicit retry', async () => {
  mock.invoke.mockImplementation((cmd) => cmd === 'mutate_resource' ? Promise.reject({ code: 'forbidden', status: 403, message: 'privileged Pods denied' }) : Promise.resolve());
  await expect(prepareNodeDebug('denied', { resource, namespace: 'debug', image: 'ubuntu' }, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
  mock.invoke.mockRejectedValue({ code: 'forbidden', status: 403, message: 'delete denied' });await expect(stopNodeDebug('denied')).rejects.toMatchObject({ status: 403 });
});
it('uses UID-bearing references for manual cleanup and supports status reads', async () => {
  await removeOtherDebugPod(pod);expect(mock.invoke).toHaveBeenCalledWith('delete_resource', { request: { operation: 'debug_pod', resource: pod } });await nodeDebugStatus('id');expect(mock.invoke).toHaveBeenCalledWith('node_debug_status', { sessionId: 'id' });
});
it('does not prepare an already aborted or browser-only session', async () => {
  const abort = new AbortController();abort.abort();await expect(prepareNodeDebug('aborted', { resource, namespace: 'debug', image: 'ubuntu' }, abort.signal)).rejects.toMatchObject({ code: 'conflict' });expect(mock.invoke).not.toHaveBeenCalled();
  vi.stubGlobal('window', {});await expect(prepareNodeDebug('browser', { resource, namespace: 'debug', image: 'ubuntu' }, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' });expect(mock.invoke).not.toHaveBeenCalled();
});
