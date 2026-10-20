import { k8s } from '../providers/k8s_provider';
import { ResourceWatchSession } from '../providers/resource_watch_session';
import type { ResourceKind } from '../types/k8s';
import { useResourceStore } from './resource_store';
import { useClusterStore } from './cluster_store';

let session: ResourceWatchSession | undefined;
export function stopResourceWatches(): void { session?.stop(); session = undefined; }
export async function startResourceWatches(context: string): Promise<PromiseSettledResult<void>[]> {
  stopResourceWatches();
  const next = new ResourceWatchSession(context, k8s, (kind, update) => {
    if (session !== next || useClusterStore.getState().currentContext !== context) return;
    useResourceStore.getState().applyWatchCommit(kind, update);
    if (kind === 'Namespace' && update.state.hasSnapshot) {
      useClusterStore.getState().setAvailableNamespaces([...useResourceStore.getState().resources.Namespace.values()].map((item) => item.name).sort());
    }
  });
  session = next;
  useResourceStore.getState().setSyncMode('watch');
  return next.start(Object.keys(useResourceStore.getState().resources) as ResourceKind[]);
}
export async function refreshResourceWatches(kind?: ResourceKind): Promise<boolean> {
  if (!session) return false;
  if (kind) await session.refresh(kind);
  else {
    const results = await session.refreshAll();
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  return true;
}
