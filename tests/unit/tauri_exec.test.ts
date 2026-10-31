import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectPodExec, connectHostTerminal, getHostTerminalInfo, resetExecSessions, closeExecConnections, type ExecBatch } from '../../src/providers/tauri_exec';
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
  expect(mock.invoke.mock.calls[0][1].ackTimeoutSecs).toBe(0);
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

it('routes host shell IO/resize/ACK/exit to independent host commands with no Kubernetes context', async () => {
  const receive = vi.fn();const conn = await connectHostTerminal({ shell: '/bin/zsh', cols: 100, rows: 32 }, receive, new AbortController().signal);
  expect(mock.invoke.mock.calls[0][0]).toBe('start_host_terminal');expect(mock.invoke.mock.calls[0][1].request).toEqual({ shell: '/bin/zsh', cols: 100, rows: 32 });
  const id = mock.invoke.mock.calls[0][1].sessionId;conn.write('printf test\r');conn.resize(120, 40);
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('write_host_terminal', { sessionId: id, data: 'printf test\r' }));
  expect(mock.invoke).toHaveBeenCalledWith('resize_host_terminal', { sessionId: id, cols: 120, rows: 40 });
  mock.channels[0].onmessage({ session_id: id, messages: [{ sequence: 1, event: { type: 'Exited', payload: { code: 0 } } }] });
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('close_host_terminal', { sessionId: id }));
  expect(mock.invoke).toHaveBeenCalledWith('ack_host_terminal', { sessionId: id, sequence: 1 });expect(unregister).toHaveBeenCalledOnce();
});

it('loads real shell metadata and reset stops both Pod and host transports', async () => {
  mock.invoke.mockResolvedValue({ shells: ['/bin/zsh'], default_shell: '/bin/zsh', cwd: '/home/user' });
  expect(await getHostTerminalInfo()).toEqual({ shells: ['/bin/zsh'], default_shell: '/bin/zsh', cwd: '/home/user' });
  await resetExecSessions();expect(mock.invoke).toHaveBeenCalledWith('stop_host_terminals');expect(mock.invoke).toHaveBeenCalledWith('stop_pod_execs');
});
it('browser host shell reports desktop requirement without attempting native commands', async () => {
  vi.stubGlobal('window', {});await expect(getHostTerminalInfo()).rejects.toMatchObject({ code: 'unsupported' });
  await expect(connectHostTerminal({ shell: '/bin/sh', cols: 80, rows: 24 }, vi.fn(), new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported' });expect(mock.invoke).not.toHaveBeenCalled();
});
it('routes Node exec input and ACK using its managed debug session ID', async () => {
  const { connectNodeExec } = await import('../../src/providers/tauri_exec');const nodeRequest = { resource: { ...resourceQuery('test', 'Node'), name: 'worker', uid: 'node-uid' }, debug_session_id: 'debug-id', shell: '/bin/sh', cols: 80, rows: 24 };const conn = await connectNodeExec(nodeRequest, vi.fn(), new AbortController().signal);
  const id = mock.invoke.mock.calls[0][1].sessionId;conn.write('ls\r');await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('write_node_exec', { sessionId: id, debugSessionId: 'debug-id', data: 'ls\r' }));
  mock.channels[0].onmessage({ session_id: id, messages: [{ sequence: 1, event: { type: 'Exited', payload: { code: 0 } } }] });await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('ack_node_exec', { sessionId: id, debugSessionId: 'debug-id', sequence: 1 }));
});
it('forwards the configured output timeout to the backend start command', async () => {
  const { useUiStore } = await import('../../src/state/ui_store');
  useUiStore.setState({ terminalAckTimeoutSecs: 60 });
  await connectHostTerminal({ shell: '/bin/zsh', cols: 100, rows: 32 }, vi.fn(), new AbortController().signal);
  expect(mock.invoke.mock.calls[0][1].ackTimeoutSecs).toBe(60);
  useUiStore.setState({ terminalAckTimeoutSecs: 0 });
});
