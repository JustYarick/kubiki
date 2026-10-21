import type { ResourceRef } from '../core/resources/resource_types';
import type { HelmMutation } from './helm_types';
import type { NodeDebugRequest } from './node_debug';
import type { SecretDataRequest } from './secret_data';
import { normalizeK8sError, requestError } from './errors';

export interface ManifestTarget { resource: ResourceRef; resource_version: string }
export type ChangeRequest =
  | { operation: 'manifest'; context: string; manifest: string; target?: ManifestTarget }
  | { operation: 'scale'; resource: ResourceRef; resource_version: string; replicas: number }
  | { operation: 'secret'; request: SecretDataRequest }
  | { operation: 'helm'; request: HelmMutation }
  | { operation: 'node_debug'; session_id: string; request: NodeDebugRequest };
export type DeleteRequest =
  | { operation: 'resource'; resource: ResourceRef; resource_version: string }
  | { operation: 'debug_pod'; resource: ResourceRef };

/** Intent only: there is deliberately no renderer approval flag or commit/retry API. */
async function gateway<T>(command: 'mutate_resource' | 'delete_resource', request: ChangeRequest | DeleteRequest): Promise<T> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw requestError('forbidden', 'Changes require the desktop application and backend system confirmation. Browser access is read-only.', { operation: 'mutation' }, 403);
  }
  const { invoke } = await import('@tauri-apps/api/core');
  try { return await invoke<T>(command, { request }); }
  catch (error) { throw normalizeK8sError(error, { operation: 'mutation' }); }
}
export function changeResource<T = Record<string, any>>(request: ChangeRequest): Promise<T> { return gateway('mutate_resource', request); }
export function deleteObject(request: DeleteRequest): Promise<unknown> { return gateway('delete_resource', request); }
