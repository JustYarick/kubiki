import { inNamespaceScope } from '../core/resources/namespace_scope';
import { useEffect, useMemo } from 'react';
import { useClusterStore } from '../state/cluster_store';
import { useResourceStore } from '../state/resource_store';
import { helmResource } from '../core/resources/helm';
import { useHelmInventory } from './use_helm_inventory';
export { subscribeHelmChanges, invalidateHelmGraphs } from './helm_inventory_subscriptions';

export function useHelmGraph(namespace: string | undefined, enabled: boolean) {
  const context = useClusterStore(state => state.currentContext);
  const active = enabled && !!context && !!namespace;
  const state = useHelmInventory(context ?? '', namespace === 'all' ? null : namespace ?? null, active);
  const items = useMemo(() => context && state.data ? state.data.map(release => helmResource(context, release)) : undefined, [context, state.data]);
  useEffect(() => {
    if (!active || !context || !namespace || !items || useClusterStore.getState().currentContext !== context) return;
    // Keep independently opened namespace diagrams in split panes available.
    const retained = [...useResourceStore.getState().resources.HelmRelease.values()].filter(item => item.raw?.context === context && !inNamespaceScope(namespace, item.namespace));
    useResourceStore.getState().setResourcesForKind('HelmRelease', [...retained, ...items]);
  }, [active, context, namespace, items]);
  return { loading: active && state.loading, error: active ? state.error?.message ?? '' : '' };
}
