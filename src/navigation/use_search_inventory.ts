import { useCallback, useEffect, useState } from 'react';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { k8s } from '../providers/k8s_provider';
import { loadSearchInventory, type SearchInventory } from '../providers/search_inventory';
import { inNamespaceScope, namespaceScopeCovers } from '../core/resources/namespace_scope';
import { resourceKey } from '../core/resources/identity';
import { RESOURCE_TYPES, resourceType } from '../core/resources/resource_types';

const CACHE_TTL_MS = 180_000;
const PARTIAL_TTL_MS = 120_000;
const cache = new Map<string, SearchInventory & { at: number }>();
const partialCache = new Map<string, SearchInventory & { at: number }>();
const empty: SearchInventory = { items: [], completed: 0, total: 0, errors: [], loading: false };

function pruneMap(map: Map<string, SearchInventory & { at: number }>, limit = 6) {
  while (map.size > limit) map.delete(map.keys().next().value!);
}

export function useSearchInventory(open: boolean, context: string | null, scope: string) {
  const available = useClusterStore(state => state.availableResourceKinds);
  const key = JSON.stringify([context, scope, available]);
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<SearchInventory & { key: string }>({ ...empty, key: '' });
  useEffect(() => {
    if (!open || !context) return;
    const controller = new AbortController();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) { setState({ ...cached, key }); return; }

    const partial = partialCache.get(key);
    const resumePartial = partial && Date.now() - partial.at < PARTIAL_TTL_MS ? partial : undefined;
    const storeState = useResourceStore.getState();
    const liveKinds = new Set<string>();
    for (const [kind, ws] of Object.entries(storeState.watchStates)) {
      if (!ws?.hasSnapshot || ws.phase !== 'live' || ws.query.context !== context) continue;
      if (kind.startsWith('custom:')) continue;
      if (!resourceType(kind).namespaced || namespaceScopeCovers(ws.query.namespace ?? 'all', scope)) {
        liveKinds.add(kind);
      }
    }

    const seedMap = new Map<string, ResourceItem>();
    if (resumePartial) {
      for (const item of resumePartial.items) {
        if (inNamespaceScope(scope, item.namespace)) seedMap.set(resourceKey(item), item);
      }
    }
    for (const map of Object.values(storeState.resources)) {
      for (const item of map.values()) {
        if (inNamespaceScope(scope, item.namespace)) seedMap.set(resourceKey(item), item);
      }
    }

    let latest: SearchInventory | undefined = resumePartial;
    const reader = k8s.supportsCustomSearchInventory
      ? k8s
      : {
          getResources: k8s.getResources.bind(k8s),
          getCustomResources: k8s.getCustomResources.bind(k8s),
          getHelmInventory: k8s.getHelmInventory.bind(k8s),
        };

    void (async () => {
      const selectedScope = useClusterStore.getState().selectedNamespace;
      const zeroKinds = new Set<string>();
      const storedCounts = storeState.resourceCounts;
      for (const type of RESOURCE_TYPES) {
        const kind = type.kind as ResourceKind;
        if (available && !available.includes(kind)) continue;
        if (liveKinds.has(kind)) continue;
        if ((!type.namespaced || scope === selectedScope) && storedCounts[kind] === 0) {
          zeroKinds.add(kind);
        }
      }

      const snapshot = await loadSearchInventory(
        reader,
        context,
        scope,
        [...seedMap.values()],
        available,
        controller.signal,
        partialSnapshot => {
          latest = partialSnapshot;
          if (!controller.signal.aborted) setState({ ...partialSnapshot, key });
        },
        { liveKinds, zeroKinds, completedBuckets: new Set(resumePartial?.completedBuckets ?? []) },
      );
      if (controller.signal.aborted) return;
      partialCache.delete(key);
      cache.delete(key);
      cache.set(key, { ...snapshot, at: Date.now() });
      pruneMap(cache);
      setState({ ...snapshot, key });
    })();

    return () => {
      controller.abort();
      if (latest && latest.completed > 0 && latest.completed < latest.total && latest.items.length > 0) {
        partialCache.delete(key);
        partialCache.set(key, { ...latest, loading: false, at: Date.now() });
        pruneMap(partialCache);
      }
    };
  }, [open, context, scope, key, epoch, available]);
  const refresh = useCallback(() => { cache.delete(key); partialCache.delete(key); setEpoch(value => value + 1); }, [key]);
  return { ...(open && state.key === key ? state : empty), refresh };
}
