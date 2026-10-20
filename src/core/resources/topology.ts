import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { resourceKey } from './identity';
import { buildResourceGraph, GraphLimitError, matchesSelector, type ResourceGraph } from './relationships';

export const MAX_TOPOLOGY_NODES = 250;
export const MAX_TOPOLOGY_EDGES = 1000;
export const EMPTY_GRAPH: ResourceGraph = { items: new Map(), relations: [] };
const NON_EXPANDING_NEIGHBORS = new Set(['Node', 'Namespace', 'ConfigMap', 'Secret', 'StorageClass', 'HelmRelease']);
const NO_EVENTS = new Map<string, ResourceItem>();

/** No implicit cluster graph; size checks run before label matching, rendering or layout. */
export function buildTopology(input: Record<ResourceKind, Map<string, ResourceItem>>, scope: string, focus?: ResourceItem, depth = 2): ResourceGraph {
  if (!scope || scope === 'overview') return EMPTY_GRAPH;
  if (scope === 'resource' && focus?.kind === 'Event') return EMPTY_GRAPH;
  // Events belong to the timeline island, never to the layout or its resource budget.
  const resources = { ...input, Event: NO_EVENTS };
  if (scope === 'resource' && focus) {
    const items = new Map([[resourceKey(focus), focus]]);
    const relations = new Map<string, ResourceGraph['relations'][number]>();
    let frontier = new Set(items.keys());
    for (let step = 0; step < depth && frontier.size; step++) {
      const adjacent = buildResourceGraph(resources, { adjacentTo: frontier, includeContains: false, includeMissing: false, maxNodes: MAX_TOPOLOGY_NODES, maxEdges: MAX_TOPOLOGY_EDGES });
      const next = new Set<string>();
      for (const [key, item] of adjacent.items) if (!items.has(key)) {
        items.set(key, item);
        if (!NON_EXPANDING_NEIGHBORS.has(item.kind) || item.kind === focus.kind) next.add(key);
      }
      for (const edge of adjacent.relations) if (!edge.missing) relations.set(edge.id, edge);
      checkLimits(items.size, relations.size);
      frontier = next;
    }
    return { items, relations: [...relations.values()] };
  }
  if (!scope.startsWith('namespace:')) return EMPTY_GRAPH;
  const namespace = scope.slice('namespace:'.length);

  const scoped = Object.fromEntries(Object.keys(resources).map((kind) => [kind, new Map<string, ResourceItem>()])) as typeof resources;
  let count = 0;
  for (const [kind, map] of Object.entries(resources) as [ResourceKind, Map<string, ResourceItem>][]) for (const [uid, item] of map) {
    if (item.namespace === namespace || item.kind === 'Namespace' && item.name === namespace) {
      scoped[kind].set(uid, item);
      count++;
      checkLimits(count, 0);
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
  for (const binding of scoped.RoleBinding.values()) if (binding.raw?.roleRef?.apiGroup === 'rbac.authorization.k8s.io' && binding.raw.roleRef.kind === 'ClusterRole') need('ClusterRole', binding.raw.roleRef.name);
  for (const binding of resources.ClusterRoleBinding.values()) if (binding.raw?.subjects?.some((subject: any) => subject.kind === 'ServiceAccount' && !subject.apiGroup && subject.namespace === namespace)) {
    scoped.ClusterRoleBinding.set(binding.uid, binding); count++; checkLimits(count, 0);
    if (binding.raw.roleRef?.apiGroup === 'rbac.authorization.k8s.io' && binding.raw.roleRef.kind === 'ClusterRole') need('ClusterRole', binding.raw.roleRef.name);
  }
  for (const [kind, map] of Object.entries(resources) as [ResourceKind, Map<string, ResourceItem>][]) for (const item of map.values()) if (!item.namespace && !scoped[kind].has(item.uid)) {
    const metadata = item.raw?.metadata ?? item.metadata ?? {};
    const annotations = metadata.annotations ?? {};
    if (metadata.labels?.['app.kubernetes.io/managed-by'] === 'Helm' && annotations['meta.helm.sh/release-namespace'] === namespace && [...scoped.HelmRelease.values()].some(release => release.name === annotations['meta.helm.sh/release-name'])) {
      scoped[kind].set(item.uid, item); count++; checkLimits(count, 0);
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
          need('ClusterRole', candidate.name); expanded = true; checkLimits(count + needed.get('ClusterRole')!.size, 0);
        }
      }
    }
  }
  for (const kind of ['Node', 'PersistentVolume', 'StorageClass', 'ClusterRole'] as const) for (const item of resources[kind].values()) if (needed.get(kind)?.has(item.name)) {
    if (!scoped[kind].has(item.uid)) { scoped[kind].set(item.uid, item); count++; }
    if (kind === 'PersistentVolume') need('StorageClass', item.spec?.storageClassName ?? item.storageClass);
    checkLimits(count, 0);
  }
  return buildResourceGraph(scoped, { maxNodes: MAX_TOPOLOGY_NODES, maxEdges: MAX_TOPOLOGY_EDGES, includeContains: false, includeMissing: false });
}

function checkLimits(nodes: number, edges: number) {
  if (nodes > MAX_TOPOLOGY_NODES) throw new GraphLimitError(`This scope exceeds ${MAX_TOPOLOGY_NODES} resources. Open a workload or Pod topology instead.`);
  if (edges > MAX_TOPOLOGY_EDGES) throw new GraphLimitError(`This scope exceeds ${MAX_TOPOLOGY_EDGES} relationships. Reduce the depth or choose a smaller resource.`);
}
