import { useCallback, useEffect, useState } from 'react';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { k8s } from '../providers/k8s_provider';
import { loadSearchInventory, type SearchInventory } from '../providers/search_inventory';
import { inNamespaceScope } from '../core/resources/namespace_scope';

const cache = new Map<string, SearchInventory & { at: number }>();
const empty: SearchInventory = { items: [], completed: 0, total: 0, errors: [], loading: false };
export function useSearchInventory(open: boolean, context: string | null, scope: string) {
  const available = useClusterStore(state => state.availableResourceKinds);
  const key = JSON.stringify([context, scope, available]);
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<SearchInventory & { key: string }>({ ...empty, key: '' });
  useEffect(() => {
    if (!open || !context) return;
    const controller = new AbortController();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 30000) { setState({ ...cached, key }); return; }
    const seeds = Object.values(useResourceStore.getState().resources).flatMap(map => [...map.values()]).filter(item => inNamespaceScope(scope, item.namespace));
    void loadSearchInventory(k8s, context, scope, seeds, available, controller.signal, snapshot => {
      if (!controller.signal.aborted) setState({ ...snapshot, key });
    }).then(snapshot => {
      if (controller.signal.aborted) return;
      cache.delete(key); cache.set(key, { ...snapshot, at: Date.now() });
      while (cache.size > 6) cache.delete(cache.keys().next().value!);
      setState({ ...snapshot, key });
    });
    return () => controller.abort();
  }, [open, context, scope, key, epoch, available]);
  const refresh = useCallback(() => { cache.delete(key); setEpoch(value => value + 1); }, [key]);
  return { ...(open && state.key === key ? state : empty), refresh };
}
