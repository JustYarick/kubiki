import { useEffect, useRef, useState } from 'react';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { resourceKey } from '../core/resources/identity';
import { EMPTY_GRAPH, topologyNamespaces } from '../core/resources/topology';
import { relatedResourceScope, type ResourceGraph } from '../core/resources/relationships';
import { graphResource, type TopologyGraphResponse, type TopologyGraphRequest } from './topology_graph';

/** One worker per view. At most one build and one latest pending snapshot are retained. */
export function useTopologyGraph(resources: Record<ResourceKind, Map<string, ResourceItem>>, scope: string, focus?: ResourceItem, depth = 2, enabled = true, updateIntervalMs = 1000, preparation?: { context: string | null; ready: (graph: ResourceGraph) => boolean; requirements?: (graph: ResourceGraph) => string }) {
  const [state, setState] = useState<{ key: string; requirements: string; graph: ResourceGraph; notice: string; loading: boolean }>({ key: '', requirements: '', graph: EMPTY_GRAPH, notice: '', loading: false });
  const worker = useRef<Worker | undefined>(undefined);
  const sequence = useRef(0);
  const generation = useRef(0);
  const completedGeneration = useRef(0);
  const focusKey = focus ? JSON.stringify([resourceKey(focus), focus.uid]) : undefined;
  const key = JSON.stringify([preparation?.context, scope, focusKey, depth]);
  const graph = state.key === key ? state.graph : EMPTY_GRAPH;
  const prepared = preparation?.ready(graph) ?? true;
  const requirements = preparation?.requirements?.(graph) ?? '';
  const active = useRef({key, prepared}); active.current = {key, prepared};
  const pending = useRef<{ id: number; key: string; requirements: string; resources: typeof resources; scope: string; focus?: ResourceItem; depth: number; generation: number } | undefined>(undefined);
  const current = useRef<{ id: number; key: string; requirements: string; originals: Map<string, ResourceItem>; generation: number } | undefined>(undefined);
  const lastLaunch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const publishError = (build: {key: string; requirements: string}, notice: string) => setState(previous => ({
    key: build.key, requirements: build.requirements,
    // Keep dependency discovery after a failed later pass; clearing it would
    // shrink requirements and immediately retry the same failed build.
    graph: previous.key === build.key ? previous.graph : EMPTY_GRAPH,
    notice, loading: false,
  }));
  const launch = useRef<() => void>(() => {});
  launch.current = () => {
    if (!worker.current || current.current || !pending.current || !active.current.prepared) return;
    const delay = pending.current.generation === completedGeneration.current
      ? Math.max(0, lastLaunch.current + updateIntervalMs - performance.now()) : 0;
    clearTimeout(timer.current);
    timer.current = undefined;
    if (delay > 0) {
      timer.current = setTimeout(() => { timer.current = undefined; launch.current(); }, delay);
      return;
    }
    const build = pending.current; pending.current = undefined;
    // Copy only when a worker can actually start. Intermediate live snapshots
    // are replaced by the latest snapshot without walking/serializing them.
    // Pre-filter by namespace scope so opening a single namespace in a 9,000-pod
    // cluster does not structured-clone thousands of pods from other namespaces.
    const scopedNamespaces = build.scope.startsWith('namespace:') || build.scope.startsWith('namespaces:')
      ? new Set(topologyNamespaces(build.scope))
      : undefined;
    const originals = new Map<string, ResourceItem>();
    const source = build.scope === 'related' && build.focus ? relatedResourceScope(build.resources, build.focus) : build.resources;
    const input = Object.fromEntries(Object.entries(source).map(([kind, map]) => {
      if (kind === 'Event') return [kind, new Map()];
      const filtered = new Map<string, ResourceItem>();
      for (const [uid, item] of map) {
        if (scopedNamespaces && item.namespace && !scopedNamespaces.has(item.namespace)) continue;
        if (scopedNamespaces && item.kind === 'Namespace' && !scopedNamespaces.has(item.name)) continue;
        originals.set(resourceKey(item), item);
        filtered.set(uid, graphResource(item));
      }
      return [kind, filtered];
    }));
    const request: TopologyGraphRequest = { id: build.id, resources: input as TopologyGraphRequest['resources'], scope: build.scope, focus: build.focus ? graphResource(build.focus) : undefined, depth: build.depth };
    current.current = { id: request.id, key: build.key, requirements: build.requirements, originals, generation: build.generation };
    lastLaunch.current = performance.now();
    worker.current.postMessage(request);
  };
  useEffect(() => {
    if (!enabled) return;
    const instance = new Worker(new URL('../views/topology_graph_worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    instance.onmessage = ({ data }: MessageEvent<TopologyGraphResponse>) => {
      const build = current.current;
      if (!build || build.id !== data.id) return;
      current.current = undefined;
      if (build.generation === generation.current && build.key === active.current.key && active.current.prepared) {
        completedGeneration.current = build.generation;
        if ('error' in data) publishError(build, data.error);
        else setState({ key: build.key, requirements: build.requirements, graph: { items: new Map(data.keys.flatMap(key => { const item = build.originals.get(key); return item ? [[key, item] as const] : []; })), relations: data.relations }, notice: '', loading: false });
      }
      launch.current();
    };
    instance.onerror = event => {
      const build = current.current;
      current.current = undefined;
      if (build?.generation === generation.current && build.key === active.current.key && active.current.prepared) {
        completedGeneration.current = build.generation;
        publishError(build, `Topology build failed: ${event.message}`);
      }
      launch.current();
    };
    launch.current();
    return () => { clearTimeout(timer.current); timer.current = undefined; worker.current = undefined; current.current = undefined; instance.terminate(); };
  }, [enabled]);
  // Live snapshots may finish behind the stream; only a change of diagram invalidates them.
  useEffect(() => { generation.current++; }, [scope, focusKey, depth, enabled, preparation?.context]);
  useEffect(() => {
    const id = ++sequence.current;
    if (!enabled || !scope || scope === 'overview') { clearTimeout(timer.current); timer.current = undefined; pending.current = undefined; setState({ key, requirements, graph: EMPTY_GRAPH, notice: '', loading: false }); return; }
    if (!prepared) { clearTimeout(timer.current); timer.current = undefined; pending.current = undefined; setState(previous => ({...previous, loading: true})); return; }
    pending.current = { id, key, requirements, resources, scope, focus, depth, generation: generation.current };
    // Keep background watch updates quiet after the first result for this diagram.
    setState(previous => ({ ...previous, loading: completedGeneration.current !== generation.current, notice: '' }));
    launch.current();
  }, [resources, scope, focus, depth, enabled, updateIntervalMs, key, prepared, requirements]);
  return { graph, key, notice: state.key === key ? state.notice : '', loading: enabled && (!prepared || state.key !== key || state.requirements !== requirements || state.loading), prepared };
}
