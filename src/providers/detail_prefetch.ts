import { useEffect } from 'react';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { RESOURCE_TYPES } from '../core/resources/resource_types';
import { namespaceScopeCovers } from '../core/resources/namespace_scope';
import { buildResourceGraph } from '../core/resources/relationships';
import { useResourceStore } from '../state/resource_store';
import { useDetailCache } from '../state/detail_cache';
import { k8s } from './k8s_provider';

export interface PrefetchTarget {
  kind: ResourceKind;
  name: string;
  namespace?: string;
  metadataOnly?: boolean;
}

const KNOWN_KINDS = new Set<string>(RESOURCE_TYPES.map(t => t.kind));
const MAX_TARGETS = 16;

function emptyCatalog(): Record<ResourceKind, Map<string, ResourceItem>> {
  const map = {} as Record<ResourceKind, Map<string, ResourceItem>>;
  for (const type of RESOURCE_TYPES) map[type.kind as ResourceKind] = new Map();
  return map;
}

/** Extract direct forward dependencies of a single inspected resource using canonical graph rules. */
export function extractForwardRefs(item: ResourceItem, includeSecretPayloads = false): PrefetchTarget[] {
  const catalog = emptyCatalog();
  if (!catalog[item.kind]) catalog[item.kind] = new Map();
  catalog[item.kind].set(item.uid || item.name, item);

  const graph = buildResourceGraph(catalog, {
    adjacentTo: undefined,
    includeContains: false,
    includeMissing: true,
    maxNodes: 256,
    maxEdges: 256,
  });

  const targets = new Map<string, PrefetchTarget>();
  const addTarget = (kind: string, name: string | undefined, namespace: string | undefined) => {
    if (!name || !KNOWN_KINDS.has(kind)) return;
    const type = RESOURCE_TYPES.find(t => t.kind === kind);
    const ns = type?.namespaced ? (namespace || item.namespace) : undefined;
    if (type?.namespaced && !ns) return;
    const k = `${kind}/${ns ?? ''}/${name}`;
    if (targets.has(k)) return;
    targets.set(k, {
      kind: kind as ResourceKind,
      name,
      namespace: ns,
      metadataOnly: !includeSecretPayloads && kind === 'Secret',
    });
  };

  for (const edge of graph.relations) {
    if (!edge.missing) continue;
    addTarget(edge.missing.kind, edge.missing.name, edge.missing.namespace);
  }

  // Fallback for storageClassName / runtimeClassName / priorityClassName when not emitted as graph edges
  const spec = item.raw?.spec ?? item.spec ?? {};
  if (typeof spec.storageClassName === 'string') addTarget('StorageClass', spec.storageClassName, undefined);
  if (typeof spec.ingressClassName === 'string') addTarget('IngressClass', spec.ingressClassName, undefined);

  return [...targets.values()].slice(0, MAX_TARGETS);
}

function isKindCovered(kind: ResourceKind, context: string, namespace?: string): boolean {
  const state = useResourceStore.getState();
  const ws = state.watchStates[kind];
  if (!ws?.hasSnapshot || ws.query.context !== context) return false;
  const type = RESOURCE_TYPES.find(t => t.kind === kind);
  return !type?.namespaced || namespaceScopeCovers(ws.query.namespace ?? 'all', namespace ?? 'all');
}

/** Prefetch exact forward references and object-scoped events into detail_cache without starting full collection watches. */
export async function prefetchDetailDependencies(
  context: string,
  item: ResourceItem,
  signal: AbortSignal,
  options: { includeSecretPayloads?: boolean } = {},
): Promise<void> {
  if (!k8s.getResource || k8s.demo || signal.aborted) return;

  const store = useResourceStore.getState();
  const cache = useDetailCache.getState();
  const alreadyCached = (target: PrefetchTarget) => {
    const live = [...(store.resources[target.kind]?.values() ?? [])].some(
      r => r.name === target.name && (!target.namespace || r.namespace === target.namespace),
    );
    if (live) return true;
    if (cache.context !== context) return false;
    return [...(cache.byKind[target.kind]?.values() ?? [])].some(
      r => r.name === target.name && (!target.namespace || r.namespace === target.namespace)
        && (options.includeSecretPayloads ? !r.readProjection : true),
    );
  };

  const fetchTarget = async (target: PrefetchTarget): Promise<ResourceItem | null> => {
    if (signal.aborted || isKindCovered(target.kind, context, target.namespace) || alreadyCached(target)) return null;
    try {
      const fetched = await k8s.getResource!(
        context,
        target.kind,
        target.name,
        target.namespace,
        { metadataOnly: target.metadataOnly, priority: 'low' },
        signal,
      );
      if (!signal.aborted) {
        useDetailCache.getState().upsert(context, fetched);
      }
      return fetched;
    } catch {
      return null;
    }
  };

  const firstHop = extractForwardRefs(item, options.includeSecretPayloads);
  // Bounded concurrency (3) at low priority so interactive actions always preempt.
  let cursor = 0;
  const fetchedFirstHop: ResourceItem[] = [];
  await Promise.all(Array.from({ length: Math.min(3, Math.max(1, firstHop.length)) }, async () => {
    while (!signal.aborted && cursor < firstHop.length) {
      const next = firstHop[cursor++];
      const res = await fetchTarget(next);
      if (res) fetchedFirstHop.push(res);
    }
  }));

  // Resolve 2-hop controller ancestors (e.g. Pod -> ReplicaSet -> Deployment or Job -> CronJob).
  if (!signal.aborted && fetchedFirstHop.length) {
    const ownerHops: PrefetchTarget[] = [];
    for (const parent of fetchedFirstHop) {
      for (const ref of parent.raw?.metadata?.ownerReferences ?? []) {
        if (ref.kind && ref.name && KNOWN_KINDS.has(ref.kind)) {
          ownerHops.push({ kind: ref.kind as ResourceKind, name: ref.name, namespace: parent.namespace });
        }
      }
    }
    await Promise.all(ownerHops.slice(0, 4).map(fetchTarget));
  }

  // Targeted per-UID Events lookup when Event watch is not already live for this scope.
  if (!signal.aborted && !isKindCovered('Event', context, item.namespace ?? 'all')) {
    try {
      const events = await k8s.getResources(
        context,
        'Event',
        item.namespace ?? 'all',
        signal,
        { fieldSelector: `involvedObject.uid=${item.uid}`, priority: 'low' },
      );
      if (!signal.aborted) {
        const matched = events.filter(ev => {
          const refUid = ev.raw?.involvedObject?.uid ?? ev.raw?.regarding?.uid;
          return !refUid || refUid === item.uid;
        });
        useDetailCache.getState().setEvents(context, item.uid, matched);
      }
    } catch { /* Event RBAC denial or unsupported fieldSelector is non-fatal. */ }
  }
}

export function useDetailPrefetch(
  context: string | null,
  item: ResourceItem | null | undefined,
  enabled: boolean,
  options: { includeSecretPayloads?: boolean } = {},
) {
  useEffect(() => {
    if (!enabled || !context || !item || k8s.demo) return;
    const controller = new AbortController();
    void prefetchDetailDependencies(context, item, controller.signal, options);
    return () => controller.abort();
  }, [enabled, context, item?.uid, item?.name, item?.namespace, options.includeSecretPayloads]);
}
