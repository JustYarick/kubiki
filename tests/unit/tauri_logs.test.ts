import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectPodLogs, closeLogConnections, type LogBatch } from '../../src/providers/tauri_logs';
import { resourceQuery } from '../../src/core/resources/resource_types';
const mock = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as Array<{ id: number; onmessage: (batch: LogBatch) => void }> }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke, Channel: class { id = mock.channels.length + 1; onmessage = (_batch: LogBatch) => {}; constructor() { mock.channels.push(this); } } }));
const request = { resource: { ...resourceQuery('test','Pod','backend'), name: 'web', uid: 'uid' }, container: 'app', follow: true, previous: false, tail_lines: 500, since_seconds: null };
let unregister: ReturnType<typeof vi.fn>;
beforeEach(() => { mock.invoke.mockReset().mockResolvedValue(undefined); mock.channels.length = 0; unregister = vi.fn(); vi.stubGlobal('window', { __TAURI_INTERNALS__: { unregisterCallback: unregister } }); });
afterEach(() => { closeLogConnections(); vi.unstubAllGlobals(); });
it('acknowledges only after bytes are processed and acknowledges Completed before cleanup', async () => {
  let consumed!: () => void; const receive = vi.fn(() => new Promise<void>((resolve) => { consumed = resolve; }));
  await connectPodLogs(request, receive, new AbortController().signal);const id = mock.invoke.mock.calls[0][1].sessionId;
  mock.channels[0].onmessage({ session_id: id, messages: [{ sequence: 1, event: { type: 'Output', payload: { data: [240,159] } } }] });
  await vi.waitFor(() => expect(receive).toHaveBeenCalled());expect(mock.invoke.mock.calls.some(([c]) => c === 'ack_pod_logs')).toBe(false);
  consumed();await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('ack_pod_logs', { sessionId: id, sequence: 1 }));
  receive.mockResolvedValue();mock.channels[0].onmessage({ session_id: id, messages: [{ sequence: 2, event: { type: 'Completed' } }] });
  await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
  const calls = mock.invoke.mock.calls;expect(calls.findIndex(([c,args]) => c === 'ack_pod_logs' && args.sequence === 2)).toBeLessThan(calls.findIndex(([c]) => c === 'close_pod_logs'));
});
it('rejects gaps, ignores foreign sessions and releases callback exactly once', async () => {
  const receive = vi.fn();const abort = new AbortController();const close = await connectPodLogs(request, receive, abort.signal);const id = mock.invoke.mock.calls[0][1].sessionId;
  mock.channels[0].onmessage({ session_id: 'other', messages: [{ sequence: 1, event: { type: 'Started' } }] });expect(receive).not.toHaveBeenCalled();
  mock.channels[0].onmessage({ session_id: id, messages: [{ sequence: 2, event: { type: 'Started' } }] });
  await vi.waitFor(() => expect(receive).toHaveBeenCalledWith(expect.objectContaining({ type: 'Failed' })));abort.abort();close();expect(unregister).toHaveBeenCalledOnce();
});
it('stops late registration after cancellation and ignores late output', async () => {
  let started!: () => void; mock.invoke.mockImplementation((command) => command === 'start_pod_logs' ? new Promise<void>((resolve) => { started = resolve; }) : Promise.resolve());
  const receive = vi.fn();const abort = new AbortController();const pending = connectPodLogs(request, receive, abort.signal);
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalled());abort.abort();started();await pending;
  mock.channels[0].onmessage({ session_id: mock.invoke.mock.calls[0][1].sessionId, messages: [{ sequence: 1, event: { type: 'Output', payload: { data: [65] } } }] });
  expect(receive).not.toHaveBeenCalled();expect(mock.invoke.mock.calls.filter(([c]) => c === 'close_pod_logs')).toHaveLength(2);
});
it('preserves structured start failures and releases rejected or already aborted registrations', async () => {
  mock.invoke.mockImplementation((command) => command === 'start_pod_logs' ? Promise.reject({ code: 'forbidden', status: 403, message: 'pods/log denied' }) : Promise.resolve());
  await expect(connectPodLogs(request, vi.fn(), new AbortController().signal)).rejects.toMatchObject({ status: 403 });expect(unregister).toHaveBeenCalledOnce();
  const abort = new AbortController();abort.abort();await connectPodLogs(request, vi.fn(), abort.signal);expect(unregister).toHaveBeenCalledTimes(2);
});
