import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareNodeDebug, stopNodeDebug, closeNodeDebugConnections, removeOtherDebugPod, nodeDebugStatus } from '../../src/providers/node_debug';
import { resourceQuery } from '../../src/core/resources/resource_types';
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
const resource = { ...resourceQuery('test', 'Node'), name: 'worker', uid: 'node-uid' };
const pod = { ...resourceQuery('test', 'Pod', 'debug'), name: 'kubiki-node-debug-node-uid', uid: 'pod-uid' };
const prepared = { session_id: 'node-uid', pod, reused: false };
beforeEach(() => { mock.invoke.mockReset().mockResolvedValue(prepared);vi.stubGlobal('window', { __TAURI_INTERNALS__: {} }); });
afterEach(() => { closeNodeDebugConnections();vi.unstubAllGlobals(); });
it('sends the Node identity and chosen debug scope and returns the derived lease', async () => {
  expect(await prepareNodeDebug({ resource, namespace: 'debug', image: 'ubuntu:24.04' }, new AbortController().signal)).toEqual(prepared);
  expect(mock.invoke).toHaveBeenCalledWith('mutate_resource', { request: { operation: 'node_debug', request: { resource, namespace: 'debug', image: 'ubuntu:24.04' } } });
  await stopNodeDebug('node-uid');expect(mock.invoke).toHaveBeenCalledWith('stop_node_debug', { sessionId: 'node-uid' });
});
it('cancels an aborted preparation through the Node reference only', async () => {
  let ready!: (result: typeof prepared) => void;mock.invoke.mockImplementation((cmd) => cmd === 'mutate_resource' ? new Promise((resolve) => { ready = resolve; }) : Promise.resolve());
  const abort = new AbortController();void prepareNodeDebug({ resource, namespace: 'debug', image: 'ubuntu' }, abort.signal);
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('mutate_resource', expect.anything()));
  abort.abort();await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('cancel_node_debug', { resource }));
  ready(prepared);await vi.waitFor(() => expect(mock.invoke.mock.calls.filter(([cmd]) => cmd === 'cancel_node_debug')).toHaveLength(1));
  expect(mock.invoke.mock.calls.filter(([cmd]) => cmd === 'stop_node_debug')).toHaveLength(0);
});
it('closes every pending preparation when the app window ends', async () => {
  let ready!: (result: typeof prepared) => void;mock.invoke.mockImplementation((cmd) => cmd === 'mutate_resource' ? new Promise((resolve) => { ready = resolve; }) : Promise.resolve());
  void prepareNodeDebug({ resource, namespace: 'default', image: 'ubuntu' }, new AbortController().signal);
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalled());
  closeNodeDebugConnections();await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('cancel_node_debug', { resource }));
  ready(prepared);
});
it('normalizes admission errors and keeps cleanup failures visible to explicit retry', async () => {
  mock.invoke.mockImplementation((cmd) => cmd === 'mutate_resource' ? Promise.reject({ code: 'forbidden', status: 403, message: 'privileged Pods denied' }) : Promise.resolve());
  await expect(prepareNodeDebug({ resource, namespace: 'debug', image: 'ubuntu' }, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
  mock.invoke.mockRejectedValue({ code: 'forbidden', status: 403, message: 'delete denied' });await expect(stopNodeDebug('node-uid')).rejects.toMatchObject({ status: 403 });
});
it('uses UID-bearing references for manual cleanup and supports status reads', async () => {
  await removeOtherDebugPod(pod);expect(mock.invoke).toHaveBeenCalledWith('delete_resource', { request: { operation: 'debug_pod', resource: pod } });
  mock.invoke.mockResolvedValue(null);await nodeDebugStatus('node-uid');expect(mock.invoke).toHaveBeenCalledWith('node_debug_status', { sessionId: 'node-uid' });
});
it('does not prepare an already aborted or browser-only session', async () => {
  const abort = new AbortController();abort.abort();await expect(prepareNodeDebug({ resource, namespace: 'debug', image: 'ubuntu' }, abort.signal)).rejects.toMatchObject({ code: 'conflict' });expect(mock.invoke).not.toHaveBeenCalled();
  vi.stubGlobal('window', {});await expect(prepareNodeDebug({ resource, namespace: 'debug', image: 'ubuntu' }, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' });expect(mock.invoke).not.toHaveBeenCalled();
});
