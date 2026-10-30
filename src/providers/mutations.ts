import type { ResourceAction } from './resource_actions';
import type { ResourceRef } from '../core/resources/resource_types';
import type { HelmMutation } from './helm_types';
import type { NodeDebugRequest } from './node_debug';
import type { SecretDataRequest } from './secret_data';
import { normalizeK8sError, requestError } from './errors';
import { notifyMutationCompleted } from './mutation_feedback';

export interface ManifestTarget { resource: ResourceRef; resource_version: string }
export type BatchStep =
  | { operation: 'action'; resource: ResourceRef; resource_version: string; action: ResourceAction; critical?: boolean }
  | { operation: 'manifest'; context: string; manifest: string; target?: ManifestTarget; critical?: boolean }
  | { operation: 'scale'; resource: ResourceRef; resource_version: string; replicas: number; critical?: boolean }
  | { operation: 'evict'; resource: ResourceRef; resource_version: string; critical?: boolean }
  | { operation: 'delete'; resource: ResourceRef; resource_version: string; critical?: boolean }
  | { operation: 'drain'; resource: ResourceRef; resource_version: string; critical?: boolean }
  | { operation: 'secret'; request: SecretDataRequest; critical?: boolean };
export interface BatchStepResult {
  action: string;
  kind: string;
  name: string;
  namespace: string | null;
  ok: boolean;
  code?: string;
  message?: string;
}
export interface BatchResult {
  steps: BatchStepResult[];
  succeeded: number;
  failed: number;
  stopped: boolean;
}
export type ChangeRequest =
  | { operation: 'action'; resource: ResourceRef; resource_version: string; action: ResourceAction; critical?: boolean }
  | { operation: 'manifest'; context: string; manifest: string; target?: ManifestTarget }
  | { operation: 'scale'; resource: ResourceRef; resource_version: string; replicas: number }
  | { operation: 'evict'; resource: ResourceRef; resource_version: string }
  | { operation: 'remove_finalizer'; resource: ResourceRef; finalizer: string }
  | { operation: 'secret'; request: SecretDataRequest }
  | { operation: 'batch'; primary: ResourceRef; steps: BatchStep[] }
  | { operation: 'helm'; request: HelmMutation }
  | { operation: 'node_debug'; request: NodeDebugRequest };
export type DeleteRequest =
  | { operation: 'resource'; resource: ResourceRef; resource_version: string }
  | { operation: 'debug_pod'; resource: ResourceRef };

/** Intent only: there is deliberately no renderer approval flag or commit/retry API. */
async function gateway<T>(command: 'mutate_resource' | 'delete_resource', request: ChangeRequest | DeleteRequest): Promise<T> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw requestError('forbidden', 'Changes require the desktop application and backend system confirmation. Browser access is read-only.', { operation: 'mutation' }, 403);
  }
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const result = await invoke<T>(command, { request });
    notifyMutationCompleted(command, request, result);
    return result;
  }
  catch (error) { throw normalizeK8sError(error, { operation: 'mutation' }); }
}
export function changeResource<T = Record<string, any>>(request: ChangeRequest): Promise<T> { return gateway('mutate_resource', request); }
export function applyBatch(primary: ResourceRef, steps: BatchStep[]): Promise<BatchResult> {
  return changeResource<BatchResult>({ operation: 'batch', primary, steps });
}
/** Returns the updated object; callers detect a controller re-adding the finalizer. */
export function removeFinalizer(resource: ResourceRef, finalizer: string): Promise<{ metadata?: { finalizers?: string[] } } | undefined> {
  return changeResource({ operation: 'remove_finalizer', resource, finalizer });
}
export function deleteObject(request: DeleteRequest): Promise<unknown> { return gateway('delete_resource', request); }
