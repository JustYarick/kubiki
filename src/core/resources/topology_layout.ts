import type { ElkNode } from 'elkjs/lib/elk-api';
import type { ResourceGraph } from './relationships';
import type { ResourceItem } from '../../types/k8s';

export const namespaceGroupId = (name: string) => JSON.stringify(['namespace-group', name]);
export function layoutNodeId(graph: ResourceGraph, key: string, grouping: 'namespace' | 'flat' = 'namespace') {
  const item = graph.items.get(key);
  return grouping === 'namespace' && item?.kind === 'Namespace' ? namespaceGroupId(item.name) : key;
}

export function topologyLayout(graph: ResourceGraph, direction: 'RIGHT' | 'DOWN', grouping: 'namespace' | 'flat' = 'namespace') {
  const namespaces = new Map<string, { name: string; item?: ResourceItem; members: ElkNode[] }>();
  const cluster: ElkNode[] = [];
  const group = (name: string) => {
    if (!namespaces.has(name)) namespaces.set(name, { name, members: [] });
    return namespaces.get(name)!;
  };
  for (const [id, item] of graph.items) {
    if (grouping === 'namespace' && item.kind === 'Namespace') { group(item.name).item = item; continue; }
    const node: ElkNode = { id, width: 232, height: 76 };
    if (grouping === 'namespace' && item.namespace) group(item.namespace).members.push(node);
    else cluster.push(node);
  }
  const children = grouping === 'namespace'
    ? [
        ...[...namespaces.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, members }) => ({
          id: namespaceGroupId(name), children: members,
          ...(members.length ? {} : { width: 320, height: 144 }),
          layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.padding': '[top=48,left=24,bottom=24,right=24]', 'elk.spacing.nodeNode': '32', 'elk.layered.spacing.nodeNodeBetweenLayers': '90' },
        })),
        ...cluster,
      ]
    : cluster;

  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.hierarchyHandling': grouping === 'namespace' ? 'INCLUDE_CHILDREN' : 'SEPARATE_CHILDREN',
      'elk.spacing.nodeNode': '40', 'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    },
    children,
    edges: graph.relations.map((edge) => ({ id: edge.id, sources: [layoutNodeId(graph, edge.source, grouping)], targets: [layoutNodeId(graph, edge.target, grouping)] })),
  };
  return { root, namespaces };
}

/** Only membership and relationships affect layout. Status/resourceVersion changes retain positions. */
export function topologyStructureKey(graph: ResourceGraph, grouping: 'namespace' | 'flat' = 'namespace'): string {
  return JSON.stringify([
    grouping,
    [...graph.items].map(([id, item]) => [id, item.kind, item.namespace ?? '', item.name]).sort((a, b) => a[0].localeCompare(b[0])),
    graph.relations.map((edge) => [edge.id, edge.source, edge.target, edge.type, edge.label]).sort((a, b) => a[0].localeCompare(b[0])),
  ]);
}
