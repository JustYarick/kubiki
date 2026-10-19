import { create } from 'zustand';
import { ResourceDeltaPayload, ResourceItem, ResourceKind } from '../types/k8s';

interface ResourceState {
  resources: Record<ResourceKind, Map<string, ResourceItem>>;
  activeKind: ResourceKind;
  searchQuery: string;
  selectedItem: ResourceItem | null;
  selectedNamespace: string;

  setActiveKind: (kind: ResourceKind) => void;
  setSearchQuery: (query: string) => void;
  selectItem: (item: ResourceItem | null) => void;
  setResourcesForKind: (kind: ResourceKind, items: ResourceItem[]) => void;
  applyDelta: (delta: ResourceDeltaPayload) => void;
  getActiveResources: () => ResourceItem[];
}

const initialResources = (): Record<ResourceKind, Map<string, ResourceItem>> => ({
  Pod: new Map(),
  Deployment: new Map(),
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
  activeKind: 'Pod',
  searchQuery: '',
  selectedItem: null,
  selectedNamespace: 'all',

  setActiveKind: (activeKind) => set({ activeKind, selectedItem: null }),

  setSearchQuery: (searchQuery) => set({ searchQuery }),

  selectItem: (selectedItem) => set({ selectedItem }),

  setResourcesForKind: (kind, items) => {
    set((state) => {
      const map = new Map<string, ResourceItem>();
      items.forEach((item) => map.set(item.uid, item));
      return {
        resources: {
          ...state.resources,
          [kind]: map,
        },
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
        };
      }

      if (type === 'Applied' && payload.gvk && payload.data) {
        const kind = payload.gvk as ResourceKind;
        const map = new Map(state.resources[kind] || new Map());
        map.set(payload.data.uid, payload.data);
        return {
          resources: { ...state.resources, [kind]: map },
        };
      }

      if (type === 'Deleted' && payload.gvk && payload.uid) {
        const kind = payload.gvk as ResourceKind;
        const map = new Map(state.resources[kind] || new Map());
        map.delete(payload.uid);
        return {
          resources: { ...state.resources, [kind]: map },
        };
      }

      return state;
    });
  },

  getActiveResources: () => {
    const { resources, activeKind, searchQuery, selectedNamespace } = get();
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
