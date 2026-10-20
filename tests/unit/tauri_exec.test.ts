import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectPodExec, closeExecConnections, type ExecBatch } from '../../src/providers/tauri_exec';
import { resourceQuery } from '../../src/core/resources/resource_types';
const mock = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as Array<{ id: number; onmessage: (batch: ExecBatch) => void }> }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke, Channel: class { id = mock.channels.length + 1; onmessage = (_batch: ExecBatch) => {}; constructor() { mock.channels.push(this); } } }));
const request = { resource: { ...resourceQuery('test','Pod','backend'), name: 'web', uid: 'uid' }, container: 'app', shell: '/bin/sh', cols: 80, rows: 24 };
let unregister: ReturnType<typeof vi.fn>;
beforeEach(() => { mock.invoke.mockReset().mockResolvedValue(undefined); mock.channels.length = 0; unregister = vi.fn(); vi.stubGlobal('window', { __TAURI_INTERNALS__: { unregisterCallback: unregister } }); });
afterEach(() => { closeExecConnections(); vi.unstubAllGlobals(); });
it('acknowledges output only after the renderer consumes bytes and serializes input writes', async () => {
  let consumed!: () => void; const receiver = vi.fn(() => new Promise<void>((resolve) => { consumed = resolve; }));
  const conn = await connectPodExec(request, receiver, new AbortController().signal);
  const id = mock.invoke.mock.calls[0][1].sessionId;
  mock.channels[0].onmessage({ session_id: id, messages: [{ sequence: 1, event: { type: 'Output', payload: { data: [240,159] } } }] });
  await vi.waitFor(() => expect(receiver).toHaveBeenCalled()); expect(mock.invoke.mock.calls.some(([c]) => c === 'ack_pod_exec')).toBe(false);
  consumed(); await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('ack_pod_exec', { sessionId: id, sequence: 1 }));
  let sent!: () => void; mock.invoke.mockImplementation((command) => command === 'write_pod_exec' ? new Promise<void>((resolve) => { sent = resolve; }) : Promise.resolve());
  conn.write('one'); conn.write('\u0003'); await Promise.resolve();
  expect(mock.invoke.mock.calls.filter(([c]) => c === 'write_pod_exec')).toHaveLength(1);
  sent(); await vi.waitFor(() => expect(mock.invoke.mock.calls.filter(([c]) => c === 'write_pod_exec')).toHaveLength(2));
});
it('rejects sequence gaps, ignores foreign sessions, stops explicitly and unregisters callbacks', async () => {
  const receive = vi.fn(); const abort = new AbortController(); const conn = await connectPodExec(request, receive, abort.signal);
  const id = mock.invoke.mock.calls[0][1].sessionId;
  mock.channels[0].onmessage({ session_id: 'other', messages: [{ sequence: 1, event: { type: 'Started' } }] });
  expect(receive).not.toHaveBeenCalled();
  mock.channels[0].onmessage({ session_id: id, messages: [{ sequence: 2, event: { type: 'Started' } }] });
  await vi.waitFor(() => expect(receive).toHaveBeenCalledWith(expect.objectContaining({ type: 'Failed' })));
  abort.abort(); conn.close(); expect(unregister).toHaveBeenCalledOnce(); expect(mock.invoke).toHaveBeenCalledWith('close_pod_exec', { sessionId: id });
});
it('stops a late native registration after cancellation, and cleans up a rejected start', async () => {
  let acknowledge!: () => void; mock.invoke.mockImplementation((command) => command === 'start_pod_exec' ? new Promise<void>((resolve) => { acknowledge = resolve; }) : Promise.resolve());
  const abort = new AbortController(); const pending = connectPodExec(request, vi.fn(), abort.signal);
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalled()); abort.abort(); acknowledge(); await pending;
  expect(mock.invoke.mock.calls.filter(([c]) => c === 'close_pod_exec')).toHaveLength(2);
  mock.invoke.mockImplementation((command) => command === 'start_pod_exec' ? Promise.reject({ code: 'forbidden', status: 403, message: 'pods/exec denied' }) : Promise.resolve());
  await expect(connectPodExec(request, vi.fn(), new AbortController().signal)).rejects.toMatchObject({ status: 403 });
  expect(unregister).toHaveBeenCalledTimes(2);
});
it('finishes only after acknowledging final output; large input fails instead of silently dropping bytes', async () => {
  const receive = vi.fn(); const conn = await connectPodExec(request, receive, new AbortController().signal); const id = mock.invoke.mock.calls[0][1].sessionId;
  mock.channels[0].onmessage({ session_id: id, messages: [{ sequence: 1, event: { type: 'Exited', payload: { code: 7 } } }] });
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('close_pod_exec', { sessionId: id }));
  const ackIndex = mock.invoke.mock.calls.findIndex(([c]) => c === 'ack_pod_exec'); const closeIndex = mock.invoke.mock.calls.findIndex(([c]) => c === 'close_pod_exec'); expect(ackIndex).toBeLessThan(closeIndex);
  const other = await connectPodExec(request, receive, new AbortController().signal); other.write('x'.repeat(65537)); expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'Failed' })); conn.close();
});
