import type { ResourceRef } from '../core/resources/resource_types';
import { normalizeK8sError, requestError, type K8sErrorPayload } from './errors';

export interface LogRequest { resource: ResourceRef; container: string; follow: boolean; previous: boolean; tail_lines: number; since_seconds: number | null }
export type LogEvent = { type: 'Started' | 'Completed' } | { type: 'Output'; payload: { data: number[] } } | { type: 'Failed'; payload: { error: K8sErrorPayload } };
export interface LogBatch { session_id: string; messages: Array<{ sequence: number; event: LogEvent }> }
const active = new Set<() => void>();
export function closeLogConnections(): void { for (const close of [...active]) close(); }
export async function resetLogSessions(): Promise<void> {
  closeLogConnections();
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) { const { invoke } = await import('@tauri-apps/api/core'); await invoke('stop_pod_logs'); }
}

/** One native batch in flight, acknowledged after the consumer processes its bytes. */
export async function connectPodLogs(request: LogRequest, receive: (event: LogEvent) => void | Promise<void>, signal: AbortSignal): Promise<() => void> {
  const info = { operation: 'logs', context: request.resource.context, resource: request.resource };
  if (!('__TAURI_INTERNALS__' in window)) throw requestError('unsupported', 'Live Pod logs require the desktop app.', info);
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  const id = crypto.randomUUID(); let closed = false; let sequence = 0; let processing = Promise.resolve();
  const channel = new Channel<LogBatch>();
  const stop = () => { void invoke('close_pod_logs', { sessionId: id }).catch(() => {}); };
  const close = () => {
    if (closed) return; closed = true; active.delete(close); signal.removeEventListener('abort', close); channel.onmessage = () => {};
    (window as any).__TAURI_INTERNALS__?.unregisterCallback?.(channel.id); stop();
  };
  if (signal.aborted) { close(); return close; }
  active.add(close); signal.addEventListener('abort', close, { once: true });
  channel.onmessage = (batch) => {
    if (closed || batch.session_id !== id) return;
    processing = processing.then(async () => {
      if (closed) return;
      let ended = false;
      for (const message of batch.messages) {
        if (message.sequence !== sequence + 1) throw requestError('internal', 'Log stream sequence gap. Reconnect the viewer.', info);
        sequence = message.sequence; await receive(message.event);
        ended ||= message.event.type === 'Completed' || message.event.type === 'Failed';
      }
      if (!closed) await invoke('ack_pod_logs', { sessionId: id, sequence });
      if (ended) close();
    }).catch((error) => { if (!closed) { void receive({ type: 'Failed', payload: { error: normalizeK8sError(error, info) } }); close(); } });
  };
  try { await invoke('start_pod_logs', { sessionId: id, request, onEvent: channel }); if (closed) stop(); return close; }
  catch (error) { close(); throw normalizeK8sError(error, info); }
}
