import { namespaceScopeCovers } from './namespace_scope';
import { resourceType } from './resource_types';
import type { ResourceKind } from '../../types/k8s';
import type { WatchState } from '../../providers/watch_types';

/** An empty collection is known only after a snapshot for this context/scope. */
export function topologyReadiness(input: {
  context: string | null; namespace: string; kinds: readonly ResourceKind[];
  availableKinds: readonly string[] | null; mode: string; connected: boolean;
  clusterLoading: boolean; allowStopped?: boolean; watches: Partial<Record<ResourceKind, WatchState>>;
  loading: Partial<Record<ResourceKind, boolean>>; errors: Partial<Record<ResourceKind, unknown>>;
}) {
  const pending: ResourceKind[] = []; const unavailable: ResourceKind[] = [];
  for (const kind of input.kinds) {
    if (kind === 'Event' || input.availableKinds && !input.availableKinds.includes(kind)) continue;
    const watch = input.watches[kind];
    if (input.mode === 'demo') {
      if (input.errors[kind]) unavailable.push(kind);
      else if (input.clusterLoading || input.loading[kind] !== false) pending.push(kind);
      continue;
    }
    const matching = watch?.query.context === input.context && (!resourceType(kind).namespaced || namespaceScopeCovers(watch.query.namespace ?? 'all', input.namespace));
    if (matching && watch?.phase === 'failed') unavailable.push(kind);
    else if (!matching || !watch?.hasSnapshot || !['live', 'reconnecting', ...(input.allowStopped ? ['stopped'] : [])].includes(watch.phase)) pending.push(kind);
  }
  return { ready: input.connected && !!input.context && pending.length === 0, pending, unavailable };
}
