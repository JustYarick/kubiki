import type { ResourceKind } from '../types/k8s';
import { resourceType, resourceQuery, scopeForKind, namespaceFallback } from '../core/resources/resource_types';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { k8s } from './k8s_provider';
import { normalizeK8sError } from './errors';
import { InitialSyncQueue } from './initial_sync_queue';

const requests = new Map<ResourceKind, AbortController>();
let inventory: AbortController | undefined;
export function cancelResourceSnapshots() {
  inventory?.abort(); inventory = undefined;
  for (const controller of requests.values()) controller.abort();
  requests.clear();
}

/** One full inventory on connection; ongoing watches are selected separately. */
export async function scanClusterInventory(context: string, kinds: readonly ResourceKind[], selectedScope: string): Promise<PromiseSettledResult<void>[]> {
  inventory?.abort();
  const controller = new AbortController(); inventory = controller;
  const queue = new InitialSyncQueue(4);
  const current = () => !controller.signal.aborted && inventory === controller && useClusterStore.getState().currentContext === context;
  const results = await Promise.allSettled(kinds.map(kind => queue.run(async () => {
    if (!current()) return;
    let scope = 'all';
    useResourceStore.getState().setKindLoading(kind, true);
    try {
      let items;
      try { items = await k8s.getResources(context, kind, scope, controller.signal); }
      catch (error) {
        if (!current() || selectedScope === 'all' || !resourceType(kind).namespaced || normalizeK8sError(error).code !== 'forbidden') throw error;
        scope = selectedScope;
        items = await k8s.getResources(context, kind, scope, controller.signal);
      }
      if (!current()) return;
      useResourceStore.getState().applyWatchCommit(kind, { snapshot: items, changes: [], state: {
        query: resourceQuery(context, kind, scope), phase: 'stopped', hasSnapshot: true, updatedAt: Date.now(),
      } });
    } catch (error) {
      if (current()) useResourceStore.getState().applyWatchCommit(kind, { changes: [], error: normalizeK8sError(error), state: {
        query: resourceQuery(context, kind, scope), phase: 'failed', hasSnapshot: false,
      } });
      throw error;
    } finally { if (current()) useResourceStore.getState().setKindLoading(kind, false); }
  }, controller.signal)));
  return results;
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
