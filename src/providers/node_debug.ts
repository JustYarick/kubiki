import { changeResource, deleteObject } from './mutations';
import type { ResourceRef } from '../core/resources/resource_types';
import { toast } from '../state/notifications_store';
import { normalizeK8sError, requestError, type K8sErrorPayload } from './errors';
export interface NodeDebugRequest { resource: ResourceRef; namespace: string; image: string }
export interface NodeDebugResult { session_id: string; pod: ResourceRef; reused: boolean }
export interface NodeDebugState { phase: string; name: string; namespace: string; detail: string; error?: K8sErrorPayload }
export interface DebugPod { resource: ResourceRef; node: string; phase: string }
let sdk: Promise<typeof import('@tauri-apps/api/core')> | undefined;
/** In-flight preparations; a close must fold a Pod-less lease away from the registry. */
const pending = new Map<string, () => Promise<void>>();
export function closeNodeDebugConnections(): void { for (const cancel of [...pending.values()]) void cancel().catch(() => {});pending.clear(); }
async function native<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!('__TAURI_INTERNALS__' in window)) throw requestError('unsupported', 'Node shell is available in the desktop app.', { operation: 'node_debug' });
  const { invoke } = await (sdk ??= import('@tauri-apps/api/core'));
  try { return await invoke<T>(command, args); } catch (error) { throw normalizeK8sError(error, { operation: 'node_debug' }); }
}
export async function prepareNodeDebug(request: NodeDebugRequest, signal: AbortSignal): Promise<NodeDebugResult> {
  if (signal.aborted) throw requestError('conflict', 'Node shell session was closed', { operation: 'node_debug' });
  // The helper Pod identifier is derived Node-side, so cancellation addresses
  // it by the Node reference. Cancelling only folds a Pod-less lease away;
  // Pods serving other terminals are left alone.
  const cancel = async () => { pending.delete(key);await native('cancel_node_debug', { resource: request.resource }).catch(() => {}); };
  const key = crypto.randomUUID();
  const abort = () => { signal.removeEventListener('abort', abort);void cancel(); };
  pending.set(key, cancel);signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await changeResource<NodeDebugResult>({ operation: 'node_debug', request });
    pending.delete(key);signal.removeEventListener('abort', abort);
    return result;
  } catch (error) { pending.delete(key);signal.removeEventListener('abort', abort);throw error; }
}
/** Explicitly end the managed session: stop all shells and delete the helper Pod. */
export async function stopNodeDebug(sessionId: string): Promise<void> {
  await native('stop_node_debug', { sessionId });
  toast.success('Node debug session stopped', 'Debug Pod cleanup was requested.');
}
export function nodeDebugStatus(sessionId: string): Promise<NodeDebugState | null> { return native('node_debug_status', { sessionId }); }
export function otherDebugPods(context: string, namespace: string): Promise<DebugPod[]> { return native('list_other_debug_pods', { context, namespace }); }
export function removeOtherDebugPod(resource: ResourceRef): Promise<void> { return deleteObject({ operation: 'debug_pod', resource }).then(() => {}); }
