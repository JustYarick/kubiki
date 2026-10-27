import { RESOURCE_TYPES } from '../core/resources/resource_types';
import { k8s } from '../providers/k8s_provider';
import { ResourceWatchSession } from '../providers/resource_watch_session';
import type { ResourceKind } from '../types/k8s';
import { useResourceStore } from './resource_store';
import { useClusterStore } from './cluster_store';
import { useWorkspaceStore } from './workspace_store';
import { useUiStore } from './ui_store';
import { resourceDemand } from '../core/resources/resource_demand';
import type { ResourceWatchProvider } from '../providers/watch_types';
import { useDockStore } from './dock_store';
import { inNamespaceScope } from '../core/resources/namespace_scope';
import { useResourceRequirements } from './resource_requirements';

let session: ResourceWatchSession | undefined;
let unsubscribers: (() => void)[] = [];
let countsController: AbortController | undefined;

export function syncResourceCounts(context: string, namespace: string): Promise<void> {
  countsController?.abort();
  if (!k8s.getResourceCounts) return Promise.resolve();
  const controller = new AbortController();
  countsController = controller;
  const available = useClusterStore.getState().availableResourceKinds;
  const kinds = RESOURCE_TYPES
    .map(type => type.kind as ResourceKind)
    .filter(kind => !available || available.includes(kind));
  return k8s.getResourceCounts(context, kinds, namespace, controller.signal).then((counts) => {
    if (controller.signal.aborted || useClusterStore.getState().currentContext !== context || useClusterStore.getState().selectedNamespace !== namespace) return;
    if (Object.keys(counts).length > 0) {
      useResourceStore.getState().setResourceCounts(counts);
    }
  }).catch(() => {});
}

export function stopResourceWatches(): void { countsController?.abort(); countsController = undefined; unsubscribers.forEach(close => close()); unsubscribers = []; session?.stop(); session = undefined; }
export async function startResourceWatches(context: string): Promise<PromiseSettledResult<void>[]> {
  stopResourceWatches();
  const provider: ResourceWatchProvider = k8s.supportsResourceWatch ? k8s : {
    // Browser reads are also demand-driven. They refresh explicitly without
    // introducing background polling or contacting unopened collections.
    async watchResources(query, emit, signal) {
      const items = await k8s.getResources(query.context, query.kind as ResourceKind, query.namespace ?? 'all', signal);
      if (!signal.aborted) emit({ query, subscription_id: 'snapshot', messages: [
        { sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items: items.map(item => item.raw!) } } } },
        { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } },
      ] });
      return () => {};
    },
  };
  const next = new ResourceWatchSession(context, provider, (kind, update) => {
    if (session !== next || useClusterStore.getState().currentContext !== context) return;
    useResourceStore.getState().applyWatchCommit(kind, update);
    if (kind === 'Namespace' && update.state.hasSnapshot) {
      const watched = [...useResourceStore.getState().resources.Namespace.values()].map((item) => item.name);
      if (watched.length > 0 || useClusterStore.getState().availableNamespaces.length === 0) {
        useClusterStore.getState().setAvailableNamespaces(watched.sort());
      }
    }
  }, useClusterStore.getState().selectedNamespace, new Set(), query => {
    const state = useResourceStore.getState();
    const snapshot = state.watchStates[query.kind as ResourceKind];
    if (!snapshot?.hasSnapshot || snapshot.query.context !== query.context || snapshot.query.namespace !== null && snapshot.query.namespace !== query.namespace) return;
    return [...state.resources[query.kind as ResourceKind].values()].filter(item => inNamespaceScope(query.namespace ?? 'all', item.namespace));
  });
  session = next;
  let demandKey = '';
  const synchronize = () => {
    if (session !== next || useClusterStore.getState().currentContext !== context) return Promise.resolve([]);
    const { tabs, activeTabId, splitTabId } = useWorkspaceStore.getState();
    const { inspectorCollapsed, rightTab } = useUiStore.getState();
    const dock = useDockStore.getState();
    const dockType = !dock.dockCollapsed ? dock.sessions.find(entry => entry.id === dock.activeSessionId)?.type : undefined;
    const demand = resourceDemand({ context, tabs, activeTabId, splitTabId, inspectorCollapsed, rightTab, eventsVisible: dockType === 'events', portsVisible: dockType === 'ports', selectedItem: useResourceStore.getState().selectedItem });
    const available = useClusterStore.getState().availableResourceKinds;
    const extra = [...useResourceRequirements.getState().entries.values()].filter(entry => entry.context === context).flatMap(entry => entry.kinds);
    const kinds = [...new Set([...demand.kinds, ...extra])].filter(kind => RESOURCE_TYPES.some(type => type.kind === kind) && (!available || available.includes(kind)));
    const key = JSON.stringify([kinds, [...demand.clusterKinds]]);
    if (key === demandKey) return Promise.resolve([]);
    demandKey = key;
    return next.setKinds(kinds, demand.clusterKinds);
  };
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void synchronize(); });
  };
  unsubscribers = [useClusterStore.subscribe((state, previous) => {
    if (session === next && state.currentContext === context && state.selectedNamespace !== previous.selectedNamespace) {
      void next.setNamespace(state.selectedNamespace);
      void syncResourceCounts(context, state.selectedNamespace);
    }
  }), useWorkspaceStore.subscribe(schedule), useUiStore.subscribe(schedule), useDockStore.subscribe(schedule), useResourceRequirements.subscribe(schedule), useResourceStore.subscribe((state, previous) => {
    if (state.selectedItem !== previous.selectedItem) schedule();
  })];
  useResourceStore.getState().setSyncMode(k8s.supportsResourceWatch ? 'watch' : 'snapshot');
  void syncResourceCounts(context, useClusterStore.getState().selectedNamespace);
  return synchronize();
}
export async function refreshResourceWatches(kind?: ResourceKind): Promise<boolean> {
  if (!session) return false;
  if (kind) await session.refresh(kind);
  else {
    const context = useClusterStore.getState().currentContext;
    if (context) void syncResourceCounts(context, useClusterStore.getState().selectedNamespace);
    const results = await session.refreshAll();
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  return true;
}
