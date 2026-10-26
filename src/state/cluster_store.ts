import { namespaceNames, namespaceScope } from '../core/resources/namespace_scope';
import { create } from 'zustand';
import { KubeContextInfo } from '../types/k8s';
import { normalizeK8sError, type K8sRequestError } from '../providers/errors';

const REMEMBER_KEY = 'kubiki.namespace.remember.v1';
const SCOPE_KEY = 'kubiki.namespace.scopes.v1';
const CONTEXT_KEY = 'kubiki.cluster.last-context.v1';
const REMEMBER_CONTEXT_KEY = 'kubiki.cluster.remember.v1';

function loadRememberContext(): boolean {
  try { return JSON.parse(localStorage.getItem(REMEMBER_CONTEXT_KEY) ?? 'true') !== false; }
  catch { return true; }
}

function loadLastContext(): string | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CONTEXT_KEY) ?? 'null');
    return typeof value === 'string' && value ? value : null;
  } catch { return null; }
}

function saveLastContext(context: string | null, remember: boolean): void {
  try {
    if (remember && context) localStorage.setItem(CONTEXT_KEY, JSON.stringify(context));
    else localStorage.removeItem(CONTEXT_KEY);
  } catch { /* storage unavailable */ }
}

/* All storage access is guarded: unit tests run in a Node environment without localStorage. */
function loadRememberNamespaceScope(): boolean {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? 'true') !== false;
  } catch { return true; }
}

function loadSavedScopes(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCOPE_KEY) ?? '{}') as Record<string, unknown>;
    const scopes: Record<string, string> = {};
    for (const [context, scope] of Object.entries(parsed)) {
      if (context && typeof scope === 'string' && scope) scopes[context] = scope;
    }
    return scopes;
  } catch { return {}; }
}

function persistScopes(scopes: Record<string, string>): void {
  try { localStorage.setItem(SCOPE_KEY, JSON.stringify(scopes)); } catch { /* storage unavailable */ }
}

function saveScopeFor(context: string | null, scope: string, remember: boolean): void {
  if (!context || !remember) return;
  const scopes = loadSavedScopes();
  if (scopes[context] === scope) return;
  scopes[context] = scope;
  persistScopes(scopes);
}

interface ClusterState {
  contexts: KubeContextInfo[];
  currentContext: string | null;
  selectedNamespace: string;
  availableNamespaces: string[];
  availableResourceKinds: string[] | null;
  isConnected: boolean;
  clusterVersion: string | null;
  isLoading: boolean;
  error: K8sRequestError | null;
  /* restore the namespace scope of a context when it is selected again */
  rememberNamespaceScope: boolean;
  rememberLastContext: boolean;

  setContexts: (contexts: KubeContextInfo[]) => void;
  selectContext: (contextName: string) => void;
  selectNamespace: (namespace: string) => void;
  setRememberNamespaceScope: (remember: boolean) => void;
  setRememberLastContext: (remember: boolean) => void;
  setAvailableNamespaces: (namespaces: string[]) => void;
  setConnected: (connected: boolean, version?: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: unknown) => void;
}

export const useClusterStore = create<ClusterState>((set, get) => ({
  contexts: [],
  currentContext: null,
  selectedNamespace: 'all',
  availableResourceKinds: null,
  availableNamespaces: ['default', 'kube-system', 'kube-public', 'kube-node-lease'],
  isConnected: false,
  clusterVersion: null,
  isLoading: false,
  error: null,
  rememberNamespaceScope: loadRememberNamespaceScope(),
  rememberLastContext: loadRememberContext(),

  setContexts: (contexts) => {
    const previous = get().currentContext;
    const saved = get().rememberLastContext ? loadLastContext() : null;
    const current = contexts.find(c => c.name === previous)?.name || contexts.find(c => c.name === saved)?.name ||
      contexts.find(c => c.is_current)?.name || contexts[0]?.name || null;
    set({ contexts: contexts.map(c => ({ ...c, is_current: c.name === current })), currentContext: current });
  },

  selectContext: (contextName) => {
    saveLastContext(contextName, get().rememberLastContext);
    const saved = get().rememberNamespaceScope ? loadSavedScopes()[contextName] : undefined;
    set((state) => ({
      currentContext: contextName,
      contexts: state.contexts.map((c) => ({
        ...c,
        is_current: c.name === contextName,
      })),
      isConnected: false,
      clusterVersion: null,
      selectedNamespace: saved ? namespaceScope(namespaceNames(saved)) : 'all',
      availableNamespaces: [],
      availableResourceKinds: null,
      error: null,
    }));
  },

  selectNamespace: (namespace) => {
    const selectedNamespace = namespaceScope(namespaceNames(namespace));
    set({ selectedNamespace });
    saveScopeFor(get().currentContext, selectedNamespace, get().rememberNamespaceScope);
  },

  setRememberNamespaceScope: (remember) => {
    set({ rememberNamespaceScope: remember });
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(remember)); } catch { /* storage unavailable */ }
    /* Drop stored scopes when remembering is turned off, so stale scopes do not return later. */
    if (!remember) persistScopes({});
  },

  setRememberLastContext: (remember) => {
    set({ rememberLastContext: remember });
    try { localStorage.setItem(REMEMBER_CONTEXT_KEY, JSON.stringify(remember)); } catch { /* storage unavailable */ }
    saveLastContext(get().currentContext, remember);
  },

  setAvailableNamespaces: (availableNamespaces) => set({ availableNamespaces }),

  setConnected: (isConnected, clusterVersion) =>
    set({ isConnected, clusterVersion: clusterVersion || null, error: null }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set((state) => ({ error: error == null ? null : normalizeK8sError(error, { operation: 'connect', context: state.currentContext ?? undefined }), isConnected: false })),
}));
