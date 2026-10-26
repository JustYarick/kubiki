import { useEffect, useRef, useState } from 'react';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { resourceKey } from '../core/resources/identity';
import { EMPTY_GRAPH, topologyNamespaces } from '../core/resources/topology';
import type { ResourceGraph } from '../core/resources/relationships';
import { graphResource, type TopologyGraphResponse, type TopologyGraphRequest } from './topology_graph';

/** One worker per view. At most one build and one latest pending snapshot are retained. */
export function useTopologyGraph(resources: Record<ResourceKind, Map<string, ResourceItem>>, scope: string, focus?: ResourceItem, depth = 2, enabled = true, updateIntervalMs = 1000) {
  const [state, setState] = useState<{ graph: ResourceGraph; notice: string; loading: boolean }>({ graph: EMPTY_GRAPH, notice: '', loading: false });
  const worker = useRef<Worker | undefined>(undefined);
  const sequence = useRef(0);
  const generation = useRef(0);
  const completedGeneration = useRef(0);
  const focusKey = focus ? JSON.stringify([resourceKey(focus), focus.uid]) : undefined;
  const pending = useRef<{ id: number; resources: typeof resources; scope: string; focus?: ResourceItem; depth: number; generation: number } | undefined>(undefined);
  const current = useRef<{ id: number; originals: Map<string, ResourceItem>; generation: number } | undefined>(undefined);
  const lastLaunch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const launch = useRef<() => void>(() => {});
  launch.current = () => {
    if (!worker.current || current.current || !pending.current) return;
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
    const input = Object.fromEntries(Object.entries(build.resources).map(([kind, map]) => {
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
    current.current = { id: request.id, originals, generation: build.generation };
    lastLaunch.current = performance.now();
    worker.current.postMessage(request);
  };
  useEffect(() => {
    const instance = new Worker(new URL('../views/topology_graph_worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    instance.onmessage = ({ data }: MessageEvent<TopologyGraphResponse>) => {
      const build = current.current;
      if (!build || build.id !== data.id) return;
      current.current = undefined;
      if (build.generation === generation.current) {
        completedGeneration.current = build.generation;
        if ('error' in data) setState({ graph: EMPTY_GRAPH, notice: data.error, loading: false });
        else setState({ graph: { items: new Map(data.keys.flatMap(key => { const item = build.originals.get(key); return item ? [[key, item] as const] : []; })), relations: data.relations }, notice: '', loading: false });
      }
      launch.current();
    };
    instance.onerror = event => {
      const build = current.current;
      current.current = undefined;
      if (build?.generation === generation.current) {
        completedGeneration.current = build.generation;
        setState({ graph: EMPTY_GRAPH, notice: `Topology build failed: ${event.message}`, loading: false });
      }
      launch.current();
    };
    launch.current();
    return () => { clearTimeout(timer.current); timer.current = undefined; worker.current = undefined; current.current = undefined; instance.terminate(); };
  }, []);
  // Live snapshots may finish behind the stream; only a change of diagram invalidates them.
  useEffect(() => { generation.current++; }, [scope, focusKey, depth, enabled]);
  useEffect(() => {
    const id = ++sequence.current;
    if (!enabled || !scope || scope === 'overview') { clearTimeout(timer.current); timer.current = undefined; pending.current = undefined; setState({ graph: EMPTY_GRAPH, notice: '', loading: false }); return; }
    pending.current = { id, resources, scope, focus, depth, generation: generation.current };
    // Keep background watch updates quiet after the first result for this diagram.
    setState(previous => ({ ...previous, loading: completedGeneration.current !== generation.current, notice: '' }));
    launch.current();
  }, [resources, scope, focus, depth, enabled, updateIntervalMs]);
  return state;
}
