import type { ResourceRef } from '../core/resources/resource_types';
import { normalizeK8sError, requestError, type K8sErrorPayload } from './errors';
export interface NodeDebugRequest { resource: ResourceRef; namespace: string; image: string }
export interface NodeDebugState { phase: string; name: string; namespace: string; detail: string; error?: K8sErrorPayload }
export interface DebugPod { resource: ResourceRef; node: string; phase: string }
let sdk: Promise<typeof import('@tauri-apps/api/core')> | undefined;
const active = new Map<string, () => Promise<void>>();
export function closeNodeDebugConnections(): void { for (const close of [...active.values()]) void close().catch(() => {}); }
async function native<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!('__TAURI_INTERNALS__' in window)) throw requestError('unsupported', 'Node shell is available in the desktop app.', { operation: 'node_debug' });
  const { invoke } = await (sdk ??= import('@tauri-apps/api/core'));
  try { return await invoke<T>(command, args); } catch (error) { throw normalizeK8sError(error, { operation: 'node_debug' }); }
}
export async function prepareNodeDebug(sessionId: string, request: NodeDebugRequest, signal: AbortSignal): Promise<ResourceRef> {
  let closed = false;
  const close = async () => { if (closed) return;closed = true;active.delete(sessionId);signal.removeEventListener('abort', abort);await native('stop_node_debug', { sessionId }); };
  const abort = () => { void close().catch(() => {}); };
  if (signal.aborted) throw requestError('conflict', 'Node shell preparation cancelled', { operation: 'node_debug' });
  active.set(sessionId, close);signal.addEventListener('abort', abort, { once: true });
  try {
    const resource = await native<ResourceRef>('prepare_node_debug', { sessionId, request });
    if (closed || signal.aborted) { await native('stop_node_debug', { sessionId });throw requestError('conflict', 'Node shell preparation cancelled', { operation: 'node_debug' }); }
    return resource;
  } catch (error) { await close().catch(() => {});throw error; }
}
export async function stopNodeDebug(sessionId: string): Promise<void> {
  const close = active.get(sessionId);if (close) await close();else await native('stop_node_debug', { sessionId });
}
export function nodeDebugStatus(sessionId: string): Promise<NodeDebugState | null> { return native('node_debug_status', { sessionId }); }
export function otherDebugPods(context: string, namespace: string): Promise<DebugPod[]> { return native('list_other_debug_pods', { context, namespace }); }
export function removeOtherDebugPod(resource: ResourceRef): Promise<void> { return native('remove_other_debug_pod', { resource }); }
