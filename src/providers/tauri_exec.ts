import type { ResourceRef } from '../core/resources/resource_types';
import { normalizeK8sError, requestError, type K8sErrorPayload } from './errors';

export interface ExecRequest { resource: ResourceRef; container: string; shell: string; cols: number; rows: number }
export type ExecEvent = { type: 'Started' } | { type: 'Output'; payload: { data: number[] } } | { type: 'Exited'; payload: { code: number } } | { type: 'Failed'; payload: { error: K8sErrorPayload } };
export interface ExecBatch { session_id: string; messages: Array<{ sequence: number; event: ExecEvent }> }
export interface ExecConnection { write(data: string): void; resize(cols: number, rows: number): void; close(): void }
const active = new Set<() => void>();
export function closeExecConnections(): void { for (const close of [...active]) close(); }
export async function resetExecSessions(): Promise<void> {
  closeExecConnections();
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) { const { invoke } = await import('@tauri-apps/api/core'); await invoke('stop_pod_execs'); }
}

/** No automatic reconnect: resending input to a new shell could repeat a destructive command. */
export async function connectPodExec(request: ExecRequest, receive: (event: ExecEvent) => void | Promise<void>, signal: AbortSignal): Promise<ExecConnection> {
  const info = { operation: 'exec', context: request.resource.context, resource: request.resource };
  if (!('__TAURI_INTERNALS__' in window)) throw requestError('unsupported', 'Interactive Pod shell is available in the desktop app. Start Kubiki with pnpm tauri dev.', info);
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  let closed = signal.aborted; const id = crypto.randomUUID(); let sequence = 0; let pendingInput = 0;
  let input = Promise.resolve(); let rendering = Promise.resolve();
  const channel = new Channel<ExecBatch>();
  const stop = () => { void invoke('close_pod_exec', { sessionId: id }).catch(() => {}); };
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
      input = input.then(async () => { if (!closed) await invoke('write_pod_exec', { sessionId: id, data }); }).catch(fail).finally(() => { pendingInput -= size; });
    },
    resize(cols, rows) { if (!closed && cols > 0 && rows > 0) void invoke('resize_pod_exec', { sessionId: id, cols, rows }).catch(fail); },
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
      if (!closed) await invoke('ack_pod_exec', { sessionId: id, sequence });
      if (terminal) close();
    }).catch(fail);
  };
  try {
    await invoke('start_pod_exec', { sessionId: id, request, onEvent: channel });
    if (closed) stop();
    return connection;
  } catch (error) { close(); throw normalizeK8sError(error, info); }
}
