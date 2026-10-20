import { create } from 'zustand';
import { ResourceDeltaPayload, ResourceItem, ResourceKind } from '../types/k8s';
import { useClusterStore } from './cluster_store';
import { normalizeK8sError, type K8sRequestError } from '../providers/errors';

interface ResourceState {
  resources: Record<ResourceKind, Map<string, ResourceItem>>;
  loadErrors: Partial<Record<ResourceKind, K8sRequestError>>;
  activeKind: ResourceKind;
  searchQuery: string;
  selectedItem: ResourceItem | null;
  selectionHistory: ResourceItem[];
  goBack: () => void;

  setActiveKind: (kind: ResourceKind) => void;
  reset: () => void;
  setLoadError: (kind: ResourceKind, error: unknown) => void;
  setSearchQuery: (query: string) => void;
  selectItem: (item: ResourceItem | null) => void;
  setResourcesForKind: (kind: ResourceKind, items: ResourceItem[]) => void;
  updateItem: (kind: ResourceKind, uid: string, patch: Partial<ResourceItem>) => void;
  deleteItem: (kind: ResourceKind, uid: string) => void;
  applyDelta: (delta: ResourceDeltaPayload) => void;
  getActiveResources: () => ResourceItem[];
}

const initialResources = (): Record<ResourceKind, Map<string, ResourceItem>> => ({
  Pod: new Map(),
  Deployment: new Map(),
  ReplicaSet: new Map(),
  StatefulSet: new Map(),
  DaemonSet: new Map(),
  Job: new Map(),
  CronJob: new Map(),
  Service: new Map(),
  Ingress: new Map(),
  ConfigMap: new Map(),
  Secret: new Map(),
  PersistentVolumeClaim: new Map(),
  PersistentVolume: new Map(),
  StorageClass: new Map(),
  Node: new Map(),
  Namespace: new Map(),
  Event: new Map(),
  CustomResourceDefinition: new Map(),
});

export const useResourceStore = create<ResourceState>((set, get) => ({
  resources: initialResources(),
  loadErrors: {},
  activeKind: 'Pod',
  searchQuery: '',
  selectedItem: null,
  selectionHistory: [],
  goBack: () => set((state) => ({ selectedItem: state.selectionHistory[state.selectionHistory.length - 1] ?? state.selectedItem, selectionHistory: state.selectionHistory.slice(0, -1) })),
  reset: () => set({ resources: initialResources(), selectedItem: null, selectionHistory: [], loadErrors: {}, searchQuery: '' }),
  setLoadError: (kind, error) => set((state) => ({ loadErrors: { ...state.loadErrors, [kind]: error == null ? undefined : normalizeK8sError(error, { operation: 'resources', context: useClusterStore.getState().currentContext ?? undefined }) } })),

  setActiveKind: (activeKind) => set({ activeKind }),

  setSearchQuery: (searchQuery) => set({ searchQuery }),

  selectItem: (selectedItem) => set((state) => ({ selectedItem, selectionHistory: selectedItem && state.selectedItem && selectedItem.uid !== state.selectedItem.uid ? [...state.selectionHistory, state.selectedItem].slice(-40) : state.selectionHistory })),

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
        selectedItem: state.selectedItem?.kind === kind ? map.get(state.selectedItem.uid) ?? null : state.selectedItem,
      };
    });
  },

  updateItem: (kind, uid, patch) => {
    set((state) => {
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
          selectedItem: state.selectedItem?.kind === kind ? newMap.get(state.selectedItem.uid) ?? null : state.selectedItem,
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
    const { resources, activeKind, searchQuery } = get();
    const selectedNamespace = useClusterStore.getState().selectedNamespace;
    const map = resources[activeKind] || new Map();
    let list = Array.from(map.values());

    if (selectedNamespace !== 'all') {
      list = list.filter((item) => !item.namespace || item.namespace === selectedNamespace);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          (item.namespace && item.namespace.toLowerCase().includes(q)) ||
          (item.status && item.status.toLowerCase().includes(q))
      );
    }

    return list;
  },
}));
