import type { ResourceKind } from '../types/k8s';
import { resourceType } from '../core/resources/resource_types';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { k8s } from './k8s_provider';

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
  const current = () => !controller.signal.aborted && requests.get(kind) === controller && useClusterStore.getState().currentContext === context && (!namespaced || useClusterStore.getState().selectedNamespace === scope);
  useResourceStore.getState().setKindLoading(kind, true);
  try {
    const items = await k8s.getResources(context, kind, scope, controller.signal);
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
