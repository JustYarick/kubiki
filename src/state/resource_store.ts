import { RESOURCE_TYPES } from '../core/resources/resource_types';
import { resourceBucket } from '../core/resources/custom_resource_types';
import { inNamespaceScope } from '../core/resources/namespace_scope';
import { create } from 'zustand';
import { ResourceDeltaPayload, ResourceItem, ResourceKind } from '../types/k8s';
import { useClusterStore } from './cluster_store';
import { normalizeK8sError, type K8sRequestError } from '../providers/errors';
import type { WatchCommit, WatchState } from '../providers/watch_types';

interface ResourceState {
  resources: Record<ResourceKind, Map<string, ResourceItem>>;
  resourceCounts: Partial<Record<ResourceKind, number>>;
  setResourceCounts: (counts: Partial<Record<ResourceKind, number>>) => void;
  loadErrors: Partial<Record<ResourceKind, K8sRequestError>>;
  loadingKinds: Partial<Record<ResourceKind, boolean>>;
  setKindLoading: (kind: ResourceKind, loading: boolean) => void;
  syncMode: 'snapshot' | 'watch' | 'demo';
  watchStates: Partial<Record<ResourceKind, WatchState>>;
  setSyncMode: (mode: 'snapshot' | 'watch' | 'demo') => void;
  applyWatchCommit: (kind: ResourceKind, update: WatchCommit) => void;
  activeKind: ResourceKind;
  selectedItem: ResourceItem | null;
  selectionHistory: ResourceItem[];
  selectionOrigin: string | null;
  goBack: () => void;

  setActiveKind: (kind: ResourceKind) => void;
  reset: () => void;
  setLoadError: (kind: ResourceKind, error: unknown) => void;
  selectItem: (item: ResourceItem | null, options?: { history?: boolean; origin?: string }) => void;
  setResourcesForKind: (kind: ResourceKind, items: ResourceItem[]) => void;
  updateItem: (kind: ResourceKind, uid: string, patch: Partial<ResourceItem>) => void;
  deleteItem: (kind: ResourceKind, uid: string) => void;
  applyDelta: (delta: ResourceDeltaPayload) => void;
  getActiveResources: () => ResourceItem[];
}

const initialResources = (): Record<ResourceKind, Map<string, ResourceItem>> => Object.fromEntries([...RESOURCE_TYPES.map(type => type.kind), 'HelmRelease'].map(kind => [kind, new Map<string, ResourceItem>()])) as Record<ResourceKind, Map<string, ResourceItem>>;

export const useResourceStore = create<ResourceState>((set, get) => ({
  resources: initialResources(),
  resourceCounts: {},
  setResourceCounts: (resourceCounts) => set({ resourceCounts }),
  loadErrors: {},
  loadingKinds: {},
  setKindLoading: (kind, loading) => set(state => ({ loadingKinds: { ...state.loadingKinds, [kind]: loading } })),
  syncMode: 'snapshot', watchStates: {},
  setSyncMode: (syncMode) => set({ syncMode }),
  applyWatchCommit: (kind, update) => set((state) => {
    const map = update.snapshot ? new Map(update.snapshot.map((item) => [item.uid, item])) : update.changes.length ? new Map(state.resources[kind]) : state.resources[kind];
    for (const change of update.changes) { if (change.type === 'apply') map.set(change.item.uid, change.item); else map.delete(change.uid); }
    return {
      resources: map === state.resources[kind] ? state.resources : { ...state.resources, [kind]: map },
      selectedItem: state.selectedItem && resourceBucket(state.selectedItem) === kind ? map.get(state.selectedItem.uid) ?? null : state.selectedItem,
      // Scope changes must not leave navigation history pointing to stale, unloaded objects.
      selectionHistory: update.snapshot && !update.state.hasSnapshot ? state.selectionHistory.filter((item) => resourceBucket(item) !== kind) : state.selectionHistory,
      watchStates: { ...state.watchStates, [kind]: update.state },
      loadingKinds: { ...state.loadingKinds, [kind]: update.state.phase === 'connecting' || update.state.phase === 'syncing' },
      loadErrors: { ...state.loadErrors, [kind]: update.error ? normalizeK8sError(update.error, { operation: 'watch', context: useClusterStore.getState().currentContext ?? undefined }) : undefined },
    };
  }),
  activeKind: 'Pod',
  selectedItem: null,
  selectionHistory: [],
  selectionOrigin: null,
  goBack: () => set(state => {
    for (let index = state.selectionHistory.length - 1; index >= 0; index--) {
      const previous = state.selectionHistory[index];
      const item = state.resources[resourceBucket(previous)]?.get(previous.uid);
      if (item && (item.uid !== state.selectedItem?.uid || resourceBucket(item) !== resourceBucket(state.selectedItem!))) return { selectedItem: item, selectionHistory: state.selectionHistory.slice(0, index) };
    }
    return { selectionHistory: [] };
  }),
  reset: () => set({ resources: initialResources(), resourceCounts: {}, selectedItem: null, selectionHistory: [], selectionOrigin: null, loadErrors: {}, loadingKinds: {}, watchStates: {}, syncMode: 'snapshot' }),
  setLoadError: (kind, error) => set((state) => ({ loadingKinds: error == null ? state.loadingKinds : { ...state.loadingKinds, [kind]: false }, loadErrors: { ...state.loadErrors, [kind]: error == null ? undefined : normalizeK8sError(error, { operation: 'resources', context: useClusterStore.getState().currentContext ?? undefined }) } })),

  setActiveKind: (activeKind) => set({ activeKind }),


  selectItem: (selectedItem, options) => set(state => {
    const push = options?.history || !!options?.origin && options.origin === state.selectionOrigin;
    const previous = state.selectedItem;
    const different = selectedItem && previous && (selectedItem.uid !== previous.uid || resourceBucket(selectedItem) !== resourceBucket(previous));
    return { selectedItem, selectionOrigin: options?.origin ?? (options?.history ? state.selectionOrigin : null),
      selectionHistory: push ? different ? [...state.selectionHistory, previous!].slice(-40) : state.selectionHistory : [] };
  }),

  setResourcesForKind: (kind, items) => {
    set((state) => {
      const map = new Map<string, ResourceItem>();
      items.forEach((item) => map.set(item.uid, item));
      return {
        resources: {
          ...state.resources,
          [kind]: map,
        },
        loadErrors: { ...state.loadErrors, [kind]: undefined },
        loadingKinds: { ...state.loadingKinds, [kind]: false },
        selectedItem: state.selectedItem && resourceBucket(state.selectedItem) === kind ? map.get(state.selectedItem.uid) ?? null : state.selectedItem,
      };
    });
  },

  updateItem: (kind, uid, patch) => {
    set((state) => {
      kind = state.resources[kind]?.has(uid) ? kind : Object.keys(state.resources).find(key => state.resources[key].has(uid)) ?? kind;
      const map = new Map(state.resources[kind]);
      const existing = map.get(uid);
      if (!existing) return state;
      const updated = { ...existing, ...patch };
      map.set(uid, updated);
      return {
        resources: { ...state.resources, [kind]: map },
        selectedItem: state.selectedItem?.uid === uid ? updated : state.selectedItem,
      };
    });
  },

  deleteItem: (kind, uid) => {
    set((state) => {
      kind = state.resources[kind]?.has(uid) ? kind : Object.keys(state.resources).find(key => state.resources[key].has(uid)) ?? kind;
      const map = new Map(state.resources[kind]);
      map.delete(uid);
      return {
        resources: { ...state.resources, [kind]: map },
        selectedItem: state.selectedItem?.uid === uid ? null : state.selectedItem,
      };
    });
  },

  applyDelta: (delta) => {
    set((state) => {
      const { type, payload } = delta;
      if (type === 'Restarted' && payload.gvk && payload.items) {
        const kind = payload.gvk as ResourceKind;
        const newMap = new Map<string, ResourceItem>();
        payload.items.forEach((item) => newMap.set(item.uid, item));
        return {
          resources: { ...state.resources, [kind]: newMap },
          selectedItem: state.selectedItem && resourceBucket(state.selectedItem) === kind ? newMap.get(state.selectedItem.uid) ?? null : state.selectedItem,
        };
      }

      if (type === 'Applied' && payload.gvk && payload.data) {
        const kind = payload.gvk as ResourceKind;
        const map = new Map(state.resources[kind] || new Map());
        map.set(payload.data.uid, payload.data);
        return {
          resources: { ...state.resources, [kind]: map },
          selectedItem: state.selectedItem?.uid === payload.data.uid ? payload.data : state.selectedItem,
        };
      }

      if (type === 'Deleted' && payload.gvk && payload.uid) {
        const kind = payload.gvk as ResourceKind;
        const map = new Map(state.resources[kind] || new Map());
        map.delete(payload.uid);
        return {
          resources: { ...state.resources, [kind]: map },
          selectedItem: state.selectedItem?.uid === payload.uid ? null : state.selectedItem,
        };
      }

      return state;
    });
  },

  getActiveResources: () => {
    const { resources, activeKind } = get();
    const selectedNamespace = useClusterStore.getState().selectedNamespace;
    const map = resources[activeKind] || new Map();
    let list = Array.from(map.values());

    if (selectedNamespace !== 'all') {
      list = list.filter((item) => inNamespaceScope(selectedNamespace, item.namespace));
    }


    return list;
  },
}));
