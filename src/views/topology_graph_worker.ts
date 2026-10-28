import { buildTopology } from '../core/resources/topology';
import { buildResourceGraph } from '../core/resources/relationships';
import { resourceKey } from '../core/resources/identity';
import type { TopologyGraphRequest, TopologyGraphResponse } from '../providers/topology_graph';
self.onmessage = (event: MessageEvent<TopologyGraphRequest>) => {
  const { id, resources, scope, focus, depth } = event.data;
  let response: TopologyGraphResponse;
  try {
    const graph = scope === 'related' && focus
      ? buildResourceGraph(resources, { adjacentTo: new Set([resourceKey(focus)]) })
      : buildTopology(resources, scope, focus, depth);
    response = { id, keys: [...graph.items.keys()], relations: graph.relations };
  } catch (error) { response = { id, error: error instanceof Error ? error.message : String(error) }; }
  self.postMessage(response);
};
