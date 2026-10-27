import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { resourceKey } from './identity';
import { buildResourceGraph, matchesSelector, type ResourceGraph } from './relationships';
import { namespaceNames } from './namespace_scope';
import { resourceBucket } from './custom_resource_types';

export function topologyNamespaces(scope: string): string[] {
  return scope.startsWith('namespace:') ? [scope.slice(10)] : scope.startsWith('namespaces:') ? namespaceNames(scope.slice(11)) ?? [] : [];
}

export const MAX_TOPOLOGY_EDGES = Infinity;
export const EMPTY_GRAPH: ResourceGraph = { items: new Map(), relations: [] };
const NON_EXPANDING_NEIGHBORS = new Set(['Node', 'Namespace', 'ConfigMap', 'Secret', 'StorageClass', 'HelmRelease']);
const NO_EVENTS = new Map<string, ResourceItem>();

/** In diagrams, point namespace-to-cluster edges towards the shared dependency. */
function dependencyDirections(graph: ResourceGraph): ResourceGraph {
  return { ...graph, relations: graph.relations.map(edge => {
    const source = graph.items.get(edge.source); const target = graph.items.get(edge.target);
    if (!source || source.namespace || !target?.namespace) return edge;
    const label = edge.type === 'schedules' ? 'scheduled on' : edge.type === 'owns' ? 'owned by' : edge.type === 'manages' ? 'managed by' : edge.label;
    return { ...edge, source: edge.target, target: edge.source, id: JSON.stringify([edge.target, edge.source, edge.type]), label };
  }) };
}

/** Explicit scopes include every resource without artificial relationship count limits. */
export function buildTopology(input: Record<ResourceKind, Map<string, ResourceItem>>, scope: string, focus?: ResourceItem, depth = 2): ResourceGraph {
  if (!scope || scope === 'overview') return EMPTY_GRAPH;
  if (scope === 'resource' && focus?.kind === 'Event') return EMPTY_GRAPH;
  // Events belong to the timeline island, never to the layout or its resource budget.
  const resources: Record<ResourceKind, Map<string, ResourceItem>> = { ...input, Event: NO_EVENTS };
  if (scope === 'all') {
    return dependencyDirections(buildResourceGraph(resources, { includeContains: false, includeMissing: false }));
  }
  if (scope === 'resource' && focus) {
    const items = new Map([[resourceKey(focus), focus]]);
    const relations = new Map<string, ResourceGraph['relations'][number]>();
    let frontier = new Set(items.keys());
    for (let step = 0; step < depth && frontier.size; step++) {
      const adjacent = buildResourceGraph(resources, { adjacentTo: frontier, includeContains: false, includeMissing: false });
      const next = new Set<string>();
      for (const [key, item] of adjacent.items) if (!items.has(key)) {
        items.set(key, item);
        // A shared cluster object is a boundary, regardless of its kind. Reaching
        // it from a namespace must never fan out to its other consumers.
        if (item.namespace && (!NON_EXPANDING_NEIGHBORS.has(item.kind) || item.kind === focus.kind)) next.add(key);
      }
      for (const edge of adjacent.relations) if (!edge.missing) relations.set(edge.id, edge);
      frontier = next;
    }
    return dependencyDirections({ items, relations: [...relations.values()] });
  }
  const namespaces = new Set(topologyNamespaces(scope));
  if (!namespaces.size) return EMPTY_GRAPH;

  const scoped = Object.fromEntries(Object.keys(resources).map((kind) => [kind, new Map<string, ResourceItem>()])) as typeof resources;
  for (const [kind, map] of Object.entries(resources) as [ResourceKind, Map<string, ResourceItem>][]) for (const [uid, item] of map) {
    if (item.namespace && namespaces.has(item.namespace) || item.kind === 'Namespace' && namespaces.has(item.name)) {
      scoped[kind].set(uid, item);
    }
  }
  // Include only cluster-scoped dependencies referenced by the selected namespace.
  const needed = new Map<ResourceKind, Set<string>>();
  const need = (kind: ResourceKind, name: unknown) => {
    if (typeof name !== 'string' || !name || name === '-') return;
    if (!needed.has(kind)) needed.set(kind, new Set());
    needed.get(kind)!.add(name);
  };
  for (const pod of scoped.Pod.values()) need('Node', pod.raw?.spec?.nodeName ?? pod.node);
  for (const map of Object.values(scoped)) for (const item of map.values()) {
    const spec = item.raw?.spec ?? item.spec ?? {};
    const podSpec = item.kind === 'Pod' ? spec : item.kind === 'CronJob' ? spec.jobTemplate?.spec?.template?.spec : ['Deployment', 'ReplicaSet', 'ReplicationController', 'DaemonSet', 'StatefulSet', 'Job'].includes(item.kind) ? spec.template?.spec : undefined;
    need('PriorityClass', podSpec?.priorityClassName);
    need('RuntimeClass', podSpec?.runtimeClassName);
    if (item.kind === 'Ingress') need('IngressClass', spec.ingressClassName);
    if (item.kind === 'ResourceClaim' || item.kind === 'ResourceClaimTemplate') {
      const claimSpec = item.kind === 'ResourceClaimTemplate' ? spec.spec : spec;
      for (const request of claimSpec?.devices?.requests ?? []) for (const allocation of [request, request.exactly, ...(request.firstAvailable ?? [])]) need('DeviceClass', allocation?.deviceClassName);
    }
    if (resourceBucket(item) === 'custom:gateway.networking.k8s.io/Gateway') need('custom:gateway.networking.k8s.io/GatewayClass', spec.gatewayClassName);
  }
  for (const binding of scoped.RoleBinding.values()) if (binding.raw?.roleRef?.apiGroup === 'rbac.authorization.k8s.io' && binding.raw.roleRef.kind === 'ClusterRole') need('ClusterRole', binding.raw.roleRef.name);
  for (const binding of resources.ClusterRoleBinding.values()) if (binding.raw?.subjects?.some((subject: any) => subject.kind === 'ServiceAccount' && !subject.apiGroup && namespaces.has(subject.namespace))) {
    scoped.ClusterRoleBinding.set(binding.uid, binding);
    if (binding.raw.roleRef?.apiGroup === 'rbac.authorization.k8s.io' && binding.raw.roleRef.kind === 'ClusterRole') need('ClusterRole', binding.raw.roleRef.name);
  }
  for (const [kind, map] of Object.entries(resources) as [ResourceKind, Map<string, ResourceItem>][]) for (const item of map.values()) if (!item.namespace && !scoped[kind].has(item.uid)) {
    const metadata = item.raw?.metadata ?? item.metadata ?? {};
    const annotations = metadata.annotations ?? {};
    if (metadata.labels?.['app.kubernetes.io/managed-by'] === 'Helm' && namespaces.has(annotations['meta.helm.sh/release-namespace']) && [...scoped.HelmRelease.values()].some(release => release.name === annotations['meta.helm.sh/release-name'] && release.namespace === annotations['meta.helm.sh/release-namespace'])) {
      scoped[kind].set(item.uid, item);
    }
  }
  for (const claim of scoped.PersistentVolumeClaim.values()) {
    need('PersistentVolume', claim.spec?.volumeName ?? claim.volume);
    need('StorageClass', claim.spec?.storageClassName ?? claim.storageClass);
  }
  // Aggregated ClusterRoles reference other ClusterRoles by label selectors.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const role of resources.ClusterRole.values()) if (needed.get('ClusterRole')?.has(role.name)) {
      for (const selector of role.raw?.aggregationRule?.clusterRoleSelectors ?? []) for (const candidate of resources.ClusterRole.values()) {
        if (!needed.get('ClusterRole')?.has(candidate.name) && (Object.keys(selector).length === 0 || matchesSelector(candidate.labels ?? {}, selector))) {
          need('ClusterRole', candidate.name); expanded = true;
        }
      }
    }
  }
  for (const kind of ['Node', 'PersistentVolume', 'StorageClass', 'ClusterRole', 'PriorityClass', 'RuntimeClass', 'IngressClass', 'DeviceClass', 'custom:gateway.networking.k8s.io/GatewayClass'] as const) for (const item of resources[kind]?.values() ?? []) if (needed.get(kind)?.has(item.name)) {
    if (!scoped[kind].has(item.uid)) { scoped[kind].set(item.uid, item); }
    if (kind === 'PersistentVolume') need('StorageClass', item.spec?.storageClassName ?? item.storageClass);
  }
  return dependencyDirections(buildResourceGraph(scoped, { includeContains: false, includeMissing: false }));
}
