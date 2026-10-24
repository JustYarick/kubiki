import { useEffect, useRef, useState } from 'react';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { resourceKey } from '../core/resources/identity';
import { EMPTY_GRAPH } from '../core/resources/topology';
import type { ResourceGraph } from '../core/resources/relationships';
import { graphResource, type TopologyGraphResponse, type TopologyGraphRequest } from './topology_graph';

/** One worker per view. At most one build and one latest pending snapshot are retained. */
export function useTopologyGraph(resources: Record<ResourceKind, Map<string, ResourceItem>>, scope: string, focus?: ResourceItem, depth = 2, enabled = true) {
  const [state, setState] = useState<{ graph: ResourceGraph; notice: string; loading: boolean }>({ graph: EMPTY_GRAPH, notice: '', loading: false });
  const worker = useRef<Worker | undefined>(undefined);
  const sequence = useRef(0);
  const generation = useRef(0);
  const completedGeneration = useRef(0);
  const focusKey = focus ? JSON.stringify([resourceKey(focus), focus.uid]) : undefined;
  const pending = useRef<{ request: TopologyGraphRequest; originals: Map<string, ResourceItem>; generation: number } | undefined>(undefined);
  const current = useRef<{ id: number; originals: Map<string, ResourceItem>; generation: number } | undefined>(undefined);
  const launch = useRef<() => void>(() => {});
  launch.current = () => {
    if (!worker.current || current.current || !pending.current) return;
    const build = pending.current; pending.current = undefined;
    const { request, originals } = build;
    current.current = { id: request.id, originals, generation: build.generation };
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
    return () => { worker.current = undefined; current.current = undefined; instance.terminate(); };
  }, []);
  // Live snapshots may finish behind the stream; only a change of diagram invalidates them.
  useEffect(() => { generation.current++; }, [scope, focusKey, depth, enabled]);
  useEffect(() => {
    const id = ++sequence.current;
    if (!enabled || !scope || scope === 'overview') { pending.current = undefined; setState({ graph: EMPTY_GRAPH, notice: '', loading: false }); return; }
    const originals = new Map<string, ResourceItem>();
    const input = Object.fromEntries(Object.entries(resources).map(([kind, map]) => [kind, new Map([...map].map(([uid, item]) => { originals.set(resourceKey(item), item); return [uid, graphResource(item)] as const; }))]));
    pending.current = { request: { id, resources: input as TopologyGraphRequest['resources'], scope, focus: focus ? graphResource(focus) : undefined, depth }, originals, generation: generation.current };
    // Keep background watch updates quiet after the first result for this diagram.
    setState(previous => ({ ...previous, loading: completedGeneration.current !== generation.current, notice: '' }));
    launch.current();
  }, [resources, scope, focus, depth, enabled]);
  return state;
}
