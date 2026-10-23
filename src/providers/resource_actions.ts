import type { ResourceItem } from '../types/k8s';
import { resourceRef } from '../core/resources/identity';
import { changeResource } from './mutations';
import type { ResourceRef } from '../core/resources/resource_types';
export type ResourceAction =
  | { type: 'restart' }
  | { type: 'cordon'; unschedulable: boolean }
  | { type: 'suspend'; suspend: boolean }
  | { type: 'argo_sync' }
  | { type: 'argo_refresh'; hard: boolean }
  | { type: 'run_cron_job'; name: string }
  | { type: 'rollback'; revision: ResourceRef; resource_version: string }
  | { type: 'config_map_data'; data: Record<string, string> };

/** UI describes intent. The backend reads the exact object and constructs the change. */
export function resourceActionStep(context: string, item: ResourceItem, action: ResourceAction) {
  return { operation: 'action' as const, resource: resourceRef(context, item), resource_version: item.raw?.metadata?.resourceVersion ?? '', action };
}
export function performResourceAction(context: string, item: ResourceItem, action: ResourceAction): Promise<unknown> {
  return changeResource(resourceActionStep(context, item, action));
}
/** The same demo restart shape is shared by every launch surface. */
export function restartManifest(item: ResourceItem, timestamp = new Date().toISOString()): Record<string, any> {
  const raw = structuredClone(item.raw ?? {});
  raw.spec ??= {}; raw.spec.template ??= {}; raw.spec.template.metadata ??= {}; raw.spec.template.metadata.annotations ??= {};
  raw.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = timestamp;
  return raw;
}
