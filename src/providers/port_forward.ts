import type { ResourceRef } from '../core/resources/resource_types';
import { normalizeK8sError, requestError, type K8sErrorPayload } from './errors';
export interface ForwardRequest { resource: ResourceRef; remote_port: number; local_port: number }
export interface ForwardSession {
  id: string; resource: ResourceRef; target_kind: 'Pod' | 'Service'; namespace: string; name: string;
  local_port: number; remote_port: number; pod_name: string; pod_uid: string; pod_port: number;
  status: 'Starting' | 'Active' | 'Stopped' | { Failed: string }; last_error?: K8sErrorPayload | null;
  started_at: number; bytes_sent: number; bytes_received: number;
}
const pending = new Set<() => void>();
const native = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!native()) throw requestError('unsupported', 'Live port forwarding is available in the desktop app.', { operation: 'port_forward' });
  const { invoke } = await import('@tauri-apps/api/core');
  try { return await invoke<T>(command, args); } catch (error) { throw normalizeK8sError(error, { operation: 'port_forward' }); }
}
export async function startPortForward(request: ForwardRequest, signal: AbortSignal): Promise<ForwardSession> {
  const id = crypto.randomUUID();
  let cancelled = signal.aborted;
  const stop = () => { cancelled = true; void stopPortForward(id).catch(() => {}); };
  if (signal.aborted) throw requestError('conflict', 'Port-forward start cancelled', { operation: 'port_forward' });
  pending.add(stop); signal.addEventListener('abort', stop, { once: true });
  try {
    const session = await invoke<ForwardSession>('start_port_forward', { sessionId: id, request });
    if (cancelled || signal.aborted) { await stopPortForward(id); throw requestError('conflict', 'Port-forward start cancelled', { operation: 'port_forward' }); }
    return session;
  } catch (error) { await stopPortForward(id).catch(() => {}); throw error; } finally { pending.delete(stop); signal.removeEventListener('abort', stop); }
}
export const stopPortForward = (id: string) => invoke<void>('stop_port_forward', { sessionId: id });
export const listPortForwards = () => invoke<ForwardSession[]>('list_port_forwards');
export function closePortForwards(): void {
  for (const stop of pending) stop();
  if (native()) void invoke('stop_port_forwards').catch(() => {});
}
export async function resetPortForwards(): Promise<void> {
  for (const stop of pending) stop();
  if (native()) await invoke('stop_port_forwards');
}
export async function openForwardUrl(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const url = `http://127.0.0.1:${port}`;
  if (native()) { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(url); }
  else window.open(url, '_blank', 'noopener,noreferrer');
}
