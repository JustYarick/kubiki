import type { ResourceItem } from '../../types/k8s';

/** Kubernetes names are unique only within a kind and namespace. */
export function resourceKey(item: Pick<ResourceItem, 'kind' | 'namespace' | 'name'>): string {
  return JSON.stringify([item.kind, item.namespace ?? '', item.name]);
}

export function resourceTabId(type: string, context: string | null, item: ResourceItem, container?: string): string {
  return JSON.stringify([type, context, item.kind, item.namespace ?? '', item.name, container ?? '']);
}
