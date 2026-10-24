import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType, useNodesState, useEdgesState, type NodeProps, type Node, type ReactFlowInstance, type NodeMouseHandler } from '@xyflow/react';
import ELK from 'elkjs/lib/elk-api.js';
import { Loader2 } from 'lucide-react';
import { ResourceWarnings } from '../components/k8s/ResourceWarnings';
import { ResourceKindBadge } from '../components/k8s/ResourceKindBadge';
import { StatusBadge } from '../components/k8s/StatusBadge';
import { useResourceStore } from '../state/resource_store';
import { useUiStore } from '../state/ui_store';
import { useWorkspaceStore } from '../state/workspace_store';
import type { ResourceGraph } from '../core/resources/relationships';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { diagramEdgeTypes, type DiagramEdge } from './TopologyEdge';
import { layoutNodeId, namespaceGroupId, topologyLayout, topologyStructureKey } from '../core/resources/topology_layout';

type ResourceNode = Node<{ item: ResourceItem; direction: 'RIGHT' | 'DOWN' }, 'resource'>;
type NamespaceNode = Node<{ name: string; item?: ResourceItem; count: number; direction: 'RIGHT' | 'DOWN' }, 'namespace'>;
type GraphNode = ResourceNode | NamespaceNode;
const ResourceGraphNode = memo(function ResourceGraphNode({ data }: NodeProps<ResourceNode>) {
  return <div className="topology-node">
    <Handle type="target" position={data.direction === 'RIGHT' ? Position.Left : Position.Top} isConnectable={false} />
    <div className="topology-node-details flex items-center gap-1.5 text-[var(--text-secondary)] text-[length:calc(10px*var(--ui-factor))]"><ResourceKindBadge kind={data.item.kind} apiVersion={data.item.apiVersion} /><ResourceWarnings item={data.item} /><span className="ml-auto truncate">{data.item.namespace || 'cluster'}</span></div>
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
  useResourceStore.getState().selectItem(item, { origin: `topology:${useWorkspaceStore.getState().activeTabId}` });
  useUiStore.setState({ inspectorCollapsed: false, rightTab: 'overview' });
};
const focusNode: NodeMouseHandler<GraphNode> = (_, node) => {
  if (node.type === 'namespace') { useWorkspaceStore.getState().openTopology(undefined, node.data.name); return; }
  const target = node.data.item;
  if (!target) return;
  useWorkspaceStore.getState().openTopology(target.kind === 'Namespace' ? undefined : target, target.kind === 'Namespace' ? target.name : undefined);
};

/** All high-frequency node updates stay here, away from scope menus, diagnostics and events. */
export const TopologyCanvas = memo(function TopologyCanvas({ graph, direction, revision, routeRevision, hiddenKinds, focusKey }: {
  graph: ResourceGraph; direction: 'RIGHT' | 'DOWN'; revision: number; routeRevision: number; hiddenKinds: ReadonlySet<ResourceKind>; focusKey?: string;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DiagramEdge>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const visibleNodes = useMemo(() => nodes.map(node => node.type === 'namespace'
    ? { ...node, style: { ...node.style, opacity: hiddenKinds.has('Namespace') ? 0 : 1, pointerEvents: hiddenKinds.has('Namespace') ? 'none' as const : 'auto' as const } }
    : { ...node, hidden: hiddenKinds.has(node.data.item.kind) }), [nodes, hiddenKinds]);
  const visibleEdges = useMemo(() => {
    const hidden = new Set(visibleNodes.filter(node => node.type === 'namespace' ? hiddenKinds.has('Namespace') : node.hidden).map(node => node.id));
    return edges.map(edge => ({ ...edge, hidden: hidden.has(edge.source) || hidden.has(edge.target) }));
  }, [edges, visibleNodes, hiddenKinds]);
  const flow = useRef<ReactFlowInstance<GraphNode, DiagramEdge> | null>(null);
  const onInit = useCallback((instance: ReactFlowInstance<GraphNode, DiagramEdge>) => { flow.current = instance; }, []);
  const nodeColor = useCallback((node: Node) => node.type === 'namespace' && hiddenKinds.has('Namespace') ? 'transparent' : node.id === focusKey ? '#3574f0' : '#545d70', [focusKey, hiddenKinds]);

  const latestGraph = useRef(graph);
  latestGraph.current = graph;
  const structureKey = topologyStructureKey(graph);
  useEffect(() => {
    setNodes((nodes) => nodes.map((node) => {
      const item = node.type === 'resource' ? graph.items.get(node.id) : [...graph.items.values()].find((item) => item.kind === 'Namespace' && item.name === node.data.name);
      return item && item !== node.data.item ? { ...node, data: { ...node.data, item } } as GraphNode : node;
    }));
  }, [graph, setNodes]);

  useEffect(() => {
    const graph = latestGraph.current;
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
          positioned.push({ id: node.id, type: 'namespace', position, data: { name: namespace.name, item: [...latestGraph.current.items.values()].find((item) => item.kind === 'Namespace' && item.name === namespace.name), count: namespace.members.length, direction }, width: node.width, height: node.height, style: { width: node.width, height: node.height }, draggable: false, selectable: false, zIndex: -1 });
          for (const child of node.children ?? []) {
            const item = latestGraph.current.items.get(child.id);
            if (item) positioned.push({ id: child.id, type: 'resource', parentId: node.id, extent: 'parent', position: { x: child.x ?? 0, y: child.y ?? 0 }, data: { item, direction }, width: 232, height: 76 });
          }
        } else {
          const item = latestGraph.current.items.get(node.id);
          if (item) positioned.push({ id: node.id, type: 'resource', position, data: { item, direction }, width: 232, height: 76 });
        }
      }
      setNodes(positioned);
      const bundles = new Map<string, string[]>();
      for (const edge of graph.relations) { if (!bundles.has(edge.source)) bundles.set(edge.source, []); bundles.get(edge.source)!.push(edge.id); }
      for (const bundle of bundles.values()) bundle.sort();
      setEdges(graph.relations.map((edge) => ({ id: edge.id, source: layoutNodeId(graph, edge.source), target: layoutNodeId(graph, edge.target), label: edge.label,
        type: 'adjustable', data: { direction, lane: bundles.get(edge.source)!.indexOf(edge.id) - (bundles.get(edge.source)!.length - 1) / 2 }, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: edge.type === 'owns' ? '#7c9bda' : '#626b7c' },
        labelStyle: { fill: '#b5bac4', fontSize: 10 }, labelBgStyle: { fill: '#25272a' },
      })));
      setBusy(false);
      requestAnimationFrame(() => { void flow.current?.fitView({ padding: 0.2, duration: 0 }); });
    }).catch((error) => { clearTimeout(timeout); worker?.terminate(); if (!cancelled) { setError(String(error)); setBusy(false); } });
    worker.onerror = (event) => { clearTimeout(timeout); worker?.terminate(); if (!cancelled) { setError(`Automatic layout failed: ${event.message}`); setBusy(false); } };
    return () => { cancelled = true; clearTimeout(timeout); worker?.terminate(); };
  }, [structureKey, direction, revision, setNodes, setEdges]);

  useEffect(() => { setEdges(edges => edges.map(edge => ({ ...edge, data: { ...edge.data!, bend: undefined } }))); }, [routeRevision, setEdges]);

  return <div className="topology-canvas relative h-full w-full min-w-0 min-h-0 overflow-hidden">
    <ReactFlow<GraphNode, DiagramEdge> nodes={visibleNodes} edges={visibleEdges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} edgeTypes={diagramEdgeTypes} nodeTypes={nodeTypes} onInit={onInit}
      colorMode="dark" fitView onlyRenderVisibleElements minZoom={0.1} maxZoom={2} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      onNodeClick={inspectNode} onNodeDoubleClick={focusNode}>
      <Background gap={20} size={1} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={nodeColor} />
    </ReactFlow>
    {busy && <div role="status" className="absolute top-3 left-3 flex items-center gap-2 bg-[var(--bg-secondary)] rounded border border-[var(--border-default)] px-3 py-2"><Loader2 size="calc(13px * var(--ui-factor))" className="animate-spin" /> Arranging topology…</div>}
    {error && <div role="alert" className="absolute top-3 left-3 p-3 bg-[var(--bg-secondary)] text-[var(--status-danger)]">{error}</div>}
    {!busy && !graph.items.size && <div className="absolute inset-0 pointer-events-none flex items-center justify-center text-[var(--text-muted)]">No loaded resources in this scope.</div>}
    {!busy && graph.items.size > 0 && visibleNodes.length > 0 && visibleNodes.every(node => node.type === 'namespace' ? hiddenKinds.has('Namespace') : node.hidden) && <div role="status" className="absolute inset-0 pointer-events-none flex items-center justify-center p-5 text-center text-[var(--text-secondary)]">All resource types are hidden. Enable a type to display it.</div>}
  </div>;
});
