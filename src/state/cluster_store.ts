import { create } from 'zustand';
import { KubeContextInfo } from '../types/k8s';
import { normalizeK8sError, type K8sRequestError } from '../providers/errors';

interface ClusterState {
  contexts: KubeContextInfo[];
  currentContext: string | null;
  selectedNamespace: string;
  availableNamespaces: string[];
  isConnected: boolean;
  clusterVersion: string | null;
  isLoading: boolean;
  error: K8sRequestError | null;

  setContexts: (contexts: KubeContextInfo[]) => void;
  selectContext: (contextName: string) => void;
  selectNamespace: (namespace: string) => void;
  setAvailableNamespaces: (namespaces: string[]) => void;
  setConnected: (connected: boolean, version?: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: unknown) => void;
}

export const useClusterStore = create<ClusterState>((set) => ({
  contexts: [],
  currentContext: null,
  selectedNamespace: 'all',
  availableNamespaces: ['default', 'kube-system', 'kube-public', 'kube-node-lease'],
  isConnected: false,
  clusterVersion: null,
  isLoading: false,
  error: null,

  setContexts: (contexts) => {
    const current = contexts.find((c) => c.is_current)?.name || contexts[0]?.name || null;
    set({ contexts, currentContext: current });
  },

  selectContext: (contextName) => {
    set((state) => ({
      currentContext: contextName,
      contexts: state.contexts.map((c) => ({
        ...c,
        is_current: c.name === contextName,
      })),
      isConnected: false,
      clusterVersion: null,
      selectedNamespace: 'all',
      availableNamespaces: [],
      error: null,
    }));
  },

  selectNamespace: (selectedNamespace) => set({ selectedNamespace }),

  setAvailableNamespaces: (availableNamespaces) => set({ availableNamespaces }),

  setConnected: (isConnected, clusterVersion) =>
    set({ isConnected, clusterVersion: clusterVersion || null, error: null }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set((state) => ({ error: error == null ? null : normalizeK8sError(error, { operation: 'connect', context: state.currentContext ?? undefined }), isConnected: false })),
}));
