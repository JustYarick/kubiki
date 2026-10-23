import type { ResourceRef } from '../core/resources/resource_types';
import { normalizeK8sError, requestError, type K8sErrorPayload } from './errors';

export interface NodeExecRequest { resource: ResourceRef; debug_session_id: string; shell: string; cols: number; rows: number }
export interface HostTerminalInfo { shells: string[]; default_shell: string; cwd: string }
export interface HostTerminalRequest { shell: string; cols: number; rows: number }
export interface ExecRequest { resource: ResourceRef; container: string; shell: string; cols: number; rows: number }
export type ExecEvent = { type: 'Started' } | { type: 'Output'; payload: { data: number[] } } | { type: 'Exited'; payload: { code: number } } | { type: 'Failed'; payload: { error: K8sErrorPayload } };
export interface ExecBatch { session_id: string; messages: Array<{ sequence: number; event: ExecEvent }> }
export interface ExecConnection { write(data: string): void; resize(cols: number, rows: number): void; close(): void }
const active = new Set<() => void>();
export function closeExecConnections(): void { for (const close of [...active]) close(); }
export async function resetExecSessions(): Promise<void> {
  closeExecConnections();
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) { const { invoke } = await import('@tauri-apps/api/core'); await Promise.all([invoke('stop_pod_execs'), invoke('stop_host_terminals'), invoke('stop_node_debugs')]); }
}

/** No automatic reconnect: resending input to a new shell could repeat a destructive command. */
export async function connectPodExec(request: ExecRequest, receive: (event: ExecEvent) => void | Promise<void>, signal: AbortSignal): Promise<ExecConnection> {
  return connectTerminal(request, receive, signal, 'pod_exec');
}
export async function connectHostTerminal(request: HostTerminalRequest, receive: (event: ExecEvent) => void | Promise<void>, signal: AbortSignal): Promise<ExecConnection> {
  return connectTerminal(request, receive, signal, 'host_terminal');
}
export async function connectNodeExec(request: NodeExecRequest, receive: (event: ExecEvent) => void | Promise<void>, signal: AbortSignal): Promise<ExecConnection> {
  return connectTerminal(request, receive, signal, 'node_exec');
}
export async function getHostTerminalInfo(): Promise<HostTerminalInfo> {
  if (!('__TAURI_INTERNALS__' in window)) throw requestError('unsupported', 'Local shell is available in the desktop app. Start Kubiki with pnpm tauri dev.', { operation: 'host_terminal' });
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<HostTerminalInfo>('get_host_terminal_info');
}
async function connectTerminal(request: ExecRequest | HostTerminalRequest | NodeExecRequest, receive: (event: ExecEvent) => void | Promise<void>, signal: AbortSignal, target: 'pod_exec' | 'host_terminal' | 'node_exec'): Promise<ExecConnection> {
  const node = target === 'node_exec';
  const info = 'resource' in request ? (node ? { operation: 'node_debug', context: request.resource.context } : { operation: 'exec', context: request.resource.context, resource: request.resource }) : { operation: 'host_terminal' };
  const routing = 'debug_session_id' in request ? { debugSessionId: request.debug_session_id } : {};
  if (!('__TAURI_INTERNALS__' in window)) throw requestError('unsupported', 'Interactive shell is available in the desktop app. Start Kubiki with pnpm tauri dev.', info);
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  let closed = signal.aborted; const id = crypto.randomUUID(); let sequence = 0; let pendingInput = 0;
  let input = Promise.resolve(); let rendering = Promise.resolve();
  const channel = new Channel<ExecBatch>();
  const stop = () => { void invoke(`close_${target}`, { sessionId: id, ...routing }).catch(() => {}); };
  const close = () => {
    if (closed) return; closed = true; active.delete(close); signal.removeEventListener('abort', close); channel.onmessage = () => {};
    (window as unknown as { __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void } }).__TAURI_INTERNALS__?.unregisterCallback?.(channel.id);
    stop();
  };
  const fail = (error: unknown) => { if (!closed) { void receive({ type: 'Failed', payload: { error: normalizeK8sError(error, info) } }); close(); } };
  const connection: ExecConnection = {
    close,
    write(data) {
      if (closed || !data) return;
      const size = new TextEncoder().encode(data).length;
      if (size > 65536 || pendingInput + size > 131072) { fail(requestError('rate_limited', 'Terminal input is too large or busy. Reconnect before sending more input.', info, 429)); return; }
      pendingInput += size;
      input = input.then(async () => { if (!closed) await invoke(`write_${target}`, { sessionId: id, data, ...routing }); }).catch(fail).finally(() => { pendingInput -= size; });
    },
    resize(cols, rows) { if (!closed && cols > 0 && rows > 0) void invoke(`resize_${target}`, { sessionId: id, cols, rows, ...routing }).catch(fail); },
  };
  if (closed) { (window as any).__TAURI_INTERNALS__?.unregisterCallback?.(channel.id); return connection; }
  active.add(close); signal.addEventListener('abort', close, { once: true });
  channel.onmessage = (batch) => {
    if (closed || batch.session_id !== id) return;
    // Native allows one batch in flight; acknowledgement is sent after xterm's write callback.
    rendering = rendering.then(async () => {
      if (closed) return;
      let terminal = false;
      for (const message of batch.messages) {
        if (message.sequence !== sequence + 1) throw requestError('internal', 'Terminal output sequence gap. Reconnect the session.', info);
        sequence = message.sequence;
        await receive(message.event);
        terminal ||= message.event.type === 'Exited' || message.event.type === 'Failed';
      }
      if (!closed) await invoke(`ack_${target}`, { sessionId: id, sequence, ...routing });
      if (terminal) close();
    }).catch(fail);
  };
  try {
    await invoke(`start_${target}`, { sessionId: id, request, onEvent: channel });
    if (closed) stop();
    return connection;
  } catch (error) { close(); throw normalizeK8sError(error, info); }
}
