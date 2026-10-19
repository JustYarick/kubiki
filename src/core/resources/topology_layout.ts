import type { ElkNode } from 'elkjs/lib/elk-api';
import type { ResourceGraph } from './relationships';
import type { ResourceItem } from '../../types/k8s';

export const namespaceGroupId = (name: string) => JSON.stringify(['namespace-group', name]);
export function layoutNodeId(graph: ResourceGraph, key: string) {
  const item = graph.items.get(key);
  return item?.kind === 'Namespace' ? namespaceGroupId(item.name) : key;
}

export function topologyLayout(graph: ResourceGraph, direction: 'RIGHT' | 'DOWN') {
  const namespaces = new Map<string, { name: string; item?: ResourceItem; members: ElkNode[] }>();
  const cluster: ElkNode[] = [];
  const group = (name: string) => {
    if (!namespaces.has(name)) namespaces.set(name, { name, members: [] });
    return namespaces.get(name)!;
  };
  for (const [id, item] of graph.items) {
    if (item.kind === 'Namespace') { group(item.name).item = item; continue; }
    const node: ElkNode = { id, width: 232, height: 76 };
    if (item.namespace) group(item.namespace).members.push(node);
    else cluster.push(node);
  }
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '40', 'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    },
    children: [
      ...[...namespaces.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, members }) => ({
        id: namespaceGroupId(name), children: members,
        ...(members.length ? {} : { width: 320, height: 144 }),
        layoutOptions: { 'elk.padding': '[top=48,left=24,bottom=24,right=24]', 'elk.spacing.nodeNode': '32', 'elk.layered.spacing.nodeNodeBetweenLayers': '90' },
      })),
      ...cluster,
    ],
    edges: graph.relations.map((edge) => ({ id: edge.id, sources: [layoutNodeId(graph, edge.source)], targets: [layoutNodeId(graph, edge.target)] })),
  };
  return { root, namespaces };
}
