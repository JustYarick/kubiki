import type { ResourceKind } from '../types/k8s';
import { resourceType, scopeForKind, namespaceFallback } from '../core/resources/resource_types';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { k8s } from './k8s_provider';
import { normalizeK8sError } from './errors';

const requests = new Map<ResourceKind, AbortController>();
export function cancelResourceSnapshots() {
  for (const controller of requests.values()) controller.abort();
  requests.clear();
}

/** Only the newest read for a collection may replace its snapshot, including A → B → A scope changes. */
export async function syncResourceSnapshot(context: string, kind: ResourceKind, scope: string): Promise<boolean> {
  requests.get(kind)?.abort();
  const controller = new AbortController(); requests.set(kind, controller);
  const namespaced = resourceType(kind).namespaced;
  // Scope-independent kinds always read the whole cluster, so the selection does not change their numbers.
  const effectiveScope = scopeForKind(kind, scope);
  let scopedFallback = false;
  const current = () => !controller.signal.aborted && requests.get(kind) === controller && useClusterStore.getState().currentContext === context && (!namespaced || effectiveScope === 'all' && !scopedFallback || useClusterStore.getState().selectedNamespace === scope);
  useResourceStore.getState().setKindLoading(kind, true);
  try {
    let items: Awaited<ReturnType<typeof k8s.getResources>>;
    try {
      items = await k8s.getResources(context, kind, effectiveScope, controller.signal);
    } catch (error) {
      // Cluster-wide access can be denied by RBAC: keep the namespace-scoped read.
      if (scope === 'all' || !namespaceFallback(kind, effectiveScope, scope, normalizeK8sError(error).code)) throw error;
      scopedFallback = true;
      items = await k8s.getResources(context, kind, scope, controller.signal);
    }
    if (!current()) return false;
    useResourceStore.getState().setResourcesForKind(kind, items);
    return true;
  } catch (error) {
    if (!current()) return false;
    useResourceStore.getState().setLoadError(kind, error);
    throw error;
  } finally {
    if (current()) useResourceStore.getState().setKindLoading(kind, false);
    if (requests.get(kind) === controller) requests.delete(kind);
  }
}
