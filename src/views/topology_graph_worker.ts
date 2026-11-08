import { buildTopology } from '../core/resources/topology';
import { buildRelatedGraph } from '../core/resources/relationships';
import type { TopologyGraphRequest, TopologyGraphResponse } from '../providers/topology_graph';
self.onmessage = (event: MessageEvent<TopologyGraphRequest>) => {
  const { id, resources, scope, focus, depth } = event.data;
  let response: TopologyGraphResponse;
  try {
    const graph = scope === 'related' && focus
      ? buildRelatedGraph(resources, focus, depth)
      : buildTopology(resources, scope, focus, depth);
    response = { id, keys: [...graph.items.keys()], relations: graph.relations };
  } catch (error) { response = { id, error: error instanceof Error ? error.message : String(error) }; }
  self.postMessage(response);
};
