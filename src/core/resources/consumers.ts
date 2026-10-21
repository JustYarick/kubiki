import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { resourceKey } from './identity';
import { buildResourceGraph } from './relationships';

export interface ResourceConsumer {
  key: string;
  kind: ResourceKind | 'User' | 'Group';
  name: string;
  namespace?: string;
  resource?: ResourceItem;
}

/** Direct consumers, including RBAC subjects which are not Kubernetes objects. */
export function resourceConsumers(resources: Record<ResourceKind, Map<string, ResourceItem>>, item: ResourceItem): ResourceConsumer[] {
  if (item.kind === 'Namespace') return Object.values(resources).flatMap(map => [...map.values()])
    .filter(resource => resource.namespace === item.name && resource.kind !== 'Event')
    .map(resource => ({ key: resourceKey(resource), kind: resource.kind, name: resource.name, namespace: resource.namespace, resource }));
  const targetKey = resourceKey(item);
  const graph = buildResourceGraph(resources, { adjacentTo: new Set([targetKey]), includeContains: false, includeMissing: false });
  const consumers = new Map<string, ResourceConsumer>();
  for (const edge of graph.relations) {
    if (edge.target !== targetKey || !['uses', 'binds', 'routes', 'selects', 'manages'].includes(edge.type)) continue;
    const resource = graph.items.get(edge.source);
    if (resource) consumers.set(edge.source, { key: edge.source, kind: resource.kind, name: resource.name, namespace: resource.namespace, resource });
  }

  if (item.kind === 'RoleBinding' || item.kind === 'ClusterRoleBinding') {
    for (const subject of item.raw?.subjects ?? []) {
      if (!subject.name) continue;
      let namespace: string | undefined;
      let apiVersion: string;
      if (subject.kind === 'ServiceAccount' && !subject.apiGroup) {
        namespace = subject.namespace || (item.kind === 'RoleBinding' ? item.namespace : undefined);
        if (!namespace) continue;
        apiVersion = 'v1';
      } else if ((subject.kind === 'User' || subject.kind === 'Group') && (!subject.apiGroup || subject.apiGroup === 'rbac.authorization.k8s.io')) {
        apiVersion = 'rbac.authorization.k8s.io/v1';
      } else continue;
      const key = resourceKey({ kind: subject.kind, name: subject.name, namespace, apiVersion });
      if (!consumers.has(key)) consumers.set(key, { key, kind: subject.kind, name: subject.name, namespace });
    }
  }
  return [...consumers.values()];
}
