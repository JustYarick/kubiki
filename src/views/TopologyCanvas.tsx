import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType, useNodesState, type NodeProps, type Node, type Edge, type ReactFlowInstance, type NodeMouseHandler } from '@xyflow/react';
import ELK from 'elkjs/lib/elk-api.js';
import { Loader2 } from 'lucide-react';
import { ResourceWarnings } from '../components/k8s/ResourceWarnings';
import { ResourceKindBadge } from '../components/k8s/ResourceKindBadge';
import { StatusBadge } from '../components/k8s/StatusBadge';
import { useResourceStore } from '../state/resource_store';
import { useUiStore } from '../state/ui_store';
import { useWorkspaceStore } from '../state/workspace_store';
import type { ResourceGraph } from '../core/resources/relationships';
import type { ResourceItem } from '../types/k8s';
import { layoutNodeId, namespaceGroupId, topologyLayout } from '../core/resources/topology_layout';

type ResourceNode = Node<{ item: ResourceItem; direction: 'RIGHT' | 'DOWN' }, 'resource'>;
type NamespaceNode = Node<{ name: string; item?: ResourceItem; count: number; direction: 'RIGHT' | 'DOWN' }, 'namespace'>;
type GraphNode = ResourceNode | NamespaceNode;
const ResourceGraphNode = memo(function ResourceGraphNode({ data }: NodeProps<ResourceNode>) {
  return <div className="topology-node">
    <Handle type="target" position={data.direction === 'RIGHT' ? Position.Left : Position.Top} isConnectable={false} />
    <div className="topology-node-details flex items-center gap-1.5 text-[var(--text-secondary)] text-[length:calc(10px*var(--ui-factor))]"><ResourceKindBadge kind={data.item.kind} /><ResourceWarnings item={data.item} /><span className="ml-auto truncate">{data.item.namespace || 'cluster'}</span></div>
    <div className="font-mono text-xs truncate mt-1" title={data.item.name}>{data.item.name}</div>
    {data.item.status && <div className="topology-node-details mt-1"><StatusBadge status={data.item.status} size="sm" /></div>}
    <Handle type="source" position={data.direction === 'RIGHT' ? Position.Right : Position.Bottom} isConnectable={false} />
  </div>;
}, (previous, next) => previous.data === next.data);
const NamespaceGraphNode = memo(function NamespaceGraphNode({ data }: NodeProps<NamespaceNode>) {
  return <div className="topology-namespace" data-namespace-group={data.name}>
    <div className="flex items-center gap-2 px-3 py-2 h-10"><ResourceKindBadge kind="Namespace" /><span className="font-mono text-xs truncate">{data.name}</span><span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] ml-auto">{data.count} resources</span></div>
    <Handle type="target" position={data.direction === 'RIGHT' ? Position.Left : Position.Top} isConnectable={false} className="!opacity-0" />
    <Handle type="source" position={data.direction === 'RIGHT' ? Position.Right : Position.Bottom} isConnectable={false} className="!opacity-0" />
  </div>;
});
const nodeTypes = { resource: ResourceGraphNode, namespace: NamespaceGraphNode };
const inspectNode: NodeMouseHandler<GraphNode> = (_, node) => {
  const item = node.type === 'namespace' ? [...useResourceStore.getState().resources.Namespace.values()].find((item) => item.name === node.data.name) : node.data.item;
  if (!item) return;
  useResourceStore.getState().selectItem(item);
  useUiStore.setState({ inspectorCollapsed: false, rightTab: 'overview' });
};
const focusNode: NodeMouseHandler<GraphNode> = (_, node) => {
  if (node.type === 'namespace') { useWorkspaceStore.getState().openTopology(undefined, node.data.name); return; }
  const target = node.data.item;
  if (!target) return;
  useWorkspaceStore.getState().openTopology(target.kind === 'Namespace' ? undefined : target, target.kind === 'Namespace' ? target.name : undefined);
};

/** All high-frequency node updates stay here, away from scope menus, diagnostics and events. */
export const TopologyCanvas = memo(function TopologyCanvas({ graph, direction, revision, focusKey }: {
  graph: ResourceGraph; direction: 'RIGHT' | 'DOWN'; revision: number; focusKey?: string;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<GraphNode> | null>(null);
  const onInit = useCallback((instance: ReactFlowInstance<GraphNode>) => { flow.current = instance; }, []);
  const nodeColor = useCallback((node: Node) => node.id === focusKey ? '#3574f0' : '#545d70', [focusKey]);

  useEffect(() => {
    setError('');
    setNodes([]);
    setEdges([]);
    if (!graph.items.size) { setBusy(false); return; }
    let cancelled = false;
    let worker: Worker | undefined;
    let elk: InstanceType<typeof ELK>;
    try {
      worker = new Worker(new URL('./layout_worker.ts', import.meta.url), { type: 'module' });
      elk = new ELK({ workerFactory: () => worker!, algorithms: ['layered'] });
    } catch (error) { worker?.terminate(); setError(String(error)); setBusy(false); return; }
    setBusy(true);
    const timeout = setTimeout(() => {
      cancelled = true; worker?.terminate(); setBusy(false);
      setError('Layout took longer than 10 seconds and was cancelled. Reduce the scope or relationship depth.');
    }, 10000);
    const layout = topologyLayout(graph, direction);
    void elk.layout(layout.root).then((result) => {
      clearTimeout(timeout); worker?.terminate();
      if (cancelled) return;
      const positioned: GraphNode[] = [];
      for (const node of result.children ?? []) {
        const position = { x: node.x ?? 0, y: node.y ?? 0 };
        const namespace = [...layout.namespaces.values()].find((group) => node.id === namespaceGroupId(group.name));
        if (namespace) {
          positioned.push({ id: node.id, type: 'namespace', position, data: { name: namespace.name, item: namespace.item, count: namespace.members.length, direction }, width: node.width, height: node.height, style: { width: node.width, height: node.height }, draggable: false, selectable: false, zIndex: -1 });
          for (const child of node.children ?? []) {
            const item = graph.items.get(child.id);
            if (item) positioned.push({ id: child.id, type: 'resource', parentId: node.id, extent: 'parent', position: { x: child.x ?? 0, y: child.y ?? 0 }, data: { item, direction }, width: 232, height: 76 });
          }
        } else {
          const item = graph.items.get(node.id);
          if (item) positioned.push({ id: node.id, type: 'resource', position, data: { item, direction }, width: 232, height: 76 });
        }
      }
      setNodes(positioned);
      setEdges(graph.relations.map((edge) => ({ id: edge.id, source: layoutNodeId(graph, edge.source), target: layoutNodeId(graph, edge.target), label: edge.label,
        type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: edge.type === 'owns' ? '#7c9bda' : '#626b7c' },
        labelStyle: { fill: '#b5bac4', fontSize: 10 }, labelBgStyle: { fill: '#25272a' },
      })));
      setBusy(false);
      requestAnimationFrame(() => { void flow.current?.fitView({ padding: 0.2, duration: 0 }); });
    }).catch((error) => { clearTimeout(timeout); worker?.terminate(); if (!cancelled) { setError(String(error)); setBusy(false); } });
    worker.onerror = (event) => { clearTimeout(timeout); worker?.terminate(); if (!cancelled) { setError(`Automatic layout failed: ${event.message}`); setBusy(false); } };
    return () => { cancelled = true; clearTimeout(timeout); worker?.terminate(); };
  }, [graph, direction, revision, setNodes]);

  useEffect(() => {
    if (!containerRef.current) return;
    let timer: ReturnType<typeof setTimeout>;
    const fit = () => { clearTimeout(timer); timer = setTimeout(() => { void flow.current?.fitView({ padding: 0.15, duration: 0 }); }, 100); };
    const observer = new ResizeObserver(fit);
    observer.observe(containerRef.current);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, []);

  return <div ref={containerRef} className="topology-canvas h-full w-full min-h-0">
    <ReactFlow<GraphNode> nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={nodeTypes} onInit={onInit}
      colorMode="dark" fitView minZoom={0.1} maxZoom={2} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      onNodeClick={inspectNode} onNodeDoubleClick={focusNode}>
      <Background gap={20} size={1} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={nodeColor} />
    </ReactFlow>
    {busy && <div role="status" className="absolute top-3 left-3 flex items-center gap-2 bg-[var(--bg-secondary)] rounded border border-[var(--border-default)] px-3 py-2"><Loader2 size="calc(13px * var(--ui-factor))" className="animate-spin" /> Arranging topology…</div>}
    {error && <div role="alert" className="absolute top-3 left-3 p-3 bg-[var(--bg-secondary)] text-[var(--status-danger)]">{error}</div>}
    {!busy && !graph.items.size && <div className="absolute inset-0 pointer-events-none flex items-center justify-center text-[var(--text-muted)]">No loaded resources in this scope.</div>}
  </div>;
});
