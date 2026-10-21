import { namespaceScopeLabel } from '../core/resources/namespace_scope';
import { SIDEBAR_TREE } from '../core/perspectives';
import { customResourcePlacement, customResourceType } from '../core/resources/custom_resource_types';
import { useResourceStore } from './resource_store';
import { useContainerLaunchStore } from './container_launch_store';
import { findWorkloadPods, preferredWorkloadPod } from '../core/resources/workload_pods';
import { toast } from './notifications_store';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useClusterStore } from './cluster_store';
import { resourceRef, resourceTabId } from '../core/resources/identity';
import type { ResourceRef } from '../core/resources/resource_types';
import type { ResourceItem, ResourceKind } from '../types/k8s';

export type WorkspaceTabType =
  | 'overview'        // Follows the global cluster and namespace selection
  | 'helm-releases'
  | 'helm-repositories'
  | 'resource-list'   // DataGrip-grade resource table (e.g. Pods, Deployments)
  | 'yaml-editor'     // Full-screen / split Monaco YAML editor
  | 'resource-detail' // Dedicated resource inspector overview
  | 'logs'            // Pod log stream
  | 'terminal'
  | 'topology';       // Pod interactive terminal session

export interface WorkspaceTab {
  id: string;
  type: WorkspaceTabType;
  title: string;
  context?: string | null;
  subtitle?: string;
  kind?: ResourceKind;
  name?: string;
  namespace?: string;
  uid?: string;
  apiVersion?: string;
  pinned?: boolean;
  dirty?: boolean;
  item?: ResourceItem;
  resource?: ResourceRef;
  container?: string;
}

interface WorkspaceState {
  tabs: WorkspaceTab[];
  activeTabId: string;
  splitTabId: string | null;
  splitDirection: 'horizontal' | 'vertical';

  /* Actions */
  openTab: (tab: Omit<WorkspaceTab, 'id'> & { id?: string }) => void;
  openOverview: () => void;
  openHelm: (section: import('../providers/helm_types').HelmSection) => void;
  openResourceList: (kind: ResourceKind, namespace?: string) => void;
  openYamlEditor: (item: ResourceItem) => void;
  openResourceDetail: (item: ResourceItem) => void;
  openLogsTab: (item: ResourceItem, container?: string) => void;
  openTerminalTab: (item: ResourceItem, container?: string) => void;
  openTopology: (item?: ResourceItem, namespace?: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (id: string) => void;
  togglePinTab: (id: string) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
  setTabContainer: (id: string, container: string) => void;
  setSplit: (splitTabId: string | null, direction?: 'horizontal' | 'vertical') => void;
  toggleSplit: (tabId?: string) => void;
  reorderTabs: (sourceIndex: number, destIndex: number) => void;
}

export function restoreWorkspace(persisted: unknown, current: WorkspaceState): WorkspaceState {
  const saved = persisted as Partial<WorkspaceState> | undefined;
  const tabs = (saved?.tabs ?? current.tabs).map(tab => {
    // Previously saved Helm tabs now use the same resource details route.
    if ((tab.type as string) !== 'helm-release' || !tab.name || !tab.namespace) return tab;
    const uid = JSON.stringify(['helm', tab.context, tab.namespace, tab.name]);
    return { ...tab, type: 'resource-detail' as const, kind: 'HelmRelease' as const, apiVersion: 'helm.sh/v1', uid,
      resource: { context: tab.context ?? '', group: 'helm.sh', version: 'v1', kind: 'HelmRelease', namespace: tab.namespace, name: tab.name, uid } };
  });
  return { ...current, ...saved, tabs };
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: '',
      splitTabId: null,
      splitDirection: 'vertical',

      openTab: (tabInput) => {
        const { tabs } = get();
        const id = tabInput.id || `tab-${tabInput.type}-${tabInput.kind || ''}-${tabInput.name || ''}-${Date.now()}`;
        const existing = tabs.find((t) =>
          t.id === id ||
          (t.type === tabInput.type &&
            t.kind === tabInput.kind &&
            (tabInput.type === 'resource-list' || (t.name === tabInput.name && t.namespace === tabInput.namespace && t.context === tabInput.context && t.container === tabInput.container && t.uid === tabInput.uid && t.apiVersion === tabInput.apiVersion)))
        );

        if (existing) {
          get().setActiveTab(existing.id);
          return;
        }

        const newTab: WorkspaceTab = {
          ...tabInput,
          id,
        };

        set({
          tabs: [...tabs, newTab],
          activeTabId: id,
        });
      },

      openOverview: () => get().openTab({ id: 'tab-overview', type: 'overview', title: 'Overview' }),
      openHelm: (section) => get().openTab({ id: `tab-helm-${section}`, type: `helm-${section}`, title: section === 'releases' ? 'Helm Releases' : 'Helm Repositories' }),

      openResourceList: (kind, namespace) => {
        const { tabs } = get();
        const definition = [...useResourceStore.getState().resources.CustomResourceDefinition.values()]
          .map(customResourceType)
          .find(type => type?.key === kind || type?.name === kind || (kind.startsWith('custom:') ? false : type?.kind === kind));
        const effectiveKind = definition?.key ?? kind;
        const id = `tab-list-${effectiveKind}`;
        const existing = tabs.find((t) => t.id === id || (t.type === 'resource-list' && t.kind === effectiveKind));

        if (existing) {
          get().setActiveTab(existing.id);
        } else {
          const newTab: WorkspaceTab = {
            id,
            type: 'resource-list',
            title: definition ? customResourcePlacement(definition)?.label ?? definition.plural.charAt(0).toUpperCase() + definition.plural.slice(1) : SIDEBAR_TREE.flatMap(category => category.groups.flatMap(group => group.kinds)).find(entry => entry.kind === effectiveKind)?.label ?? `${effectiveKind}s`,
            subtitle: definition?.group ?? namespace ?? 'all namespaces',
            kind: effectiveKind,
          };
          set({
            tabs: [...tabs, newTab],
            activeTabId: id,
          });
        }
      },

      openYamlEditor: (item) => get().openTab({
        id: resourceTabId('yaml', useClusterStore.getState().currentContext, item),
        type: 'yaml-editor', title: `${item.name}.yaml`, subtitle: `${item.kind} · ${item.namespace || 'cluster'}`,
        resource: resourceRef(useClusterStore.getState().currentContext ?? '', item),
        kind: item.kind, apiVersion: item.apiVersion, name: item.name, namespace: item.namespace, uid: item.uid, item,
        context: useClusterStore.getState().currentContext,
      }),
      openResourceDetail: (item) => get().openTab({
        id: resourceTabId('detail', useClusterStore.getState().currentContext, item),
        type: 'resource-detail', title: item.kind === 'HelmRelease' ? `Helm: ${item.name}` : item.name, subtitle: `${item.kind} · ${item.namespace || 'cluster'}`,
        resource: resourceRef(useClusterStore.getState().currentContext ?? '', item),
        kind: item.kind, apiVersion: item.apiVersion, name: item.name, namespace: item.namespace, uid: item.uid, item,
        context: useClusterStore.getState().currentContext,
      }),
      setTabContainer: (id, container) => set((state) => ({ tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, container, subtitle: `${tab.namespace} · ${container}` } : tab) })),
      openLogsTab: (item, container) => {
        let targetItem = item;
        if (item.kind !== 'Pod') {
          const resources = useResourceStore.getState().resources;
          const childPods = findWorkloadPods(item, resources);
          const activePod = preferredWorkloadPod(childPods);
          if (activePod) {
            targetItem = activePod;
          } else {
            toast.info(`No active pods found for ${item.kind}/${item.name}`);
            return;
          }
        }
        if (useContainerLaunchStore.getState().request(targetItem, container, false, chosen => get().openLogsTab(targetItem, chosen))) return;
        get().openTab({
          id: resourceTabId('logs', useClusterStore.getState().currentContext, targetItem, container),
          type: 'logs',
          title: item.kind === 'Pod' ? `Logs: ${item.name}` : `Logs: ${item.name} (${targetItem.name})`,
          subtitle: `${targetItem.namespace} · ${container || 'default container'}`,
          resource: resourceRef(useClusterStore.getState().currentContext ?? '', targetItem),
          kind: targetItem.kind, apiVersion: targetItem.apiVersion, name: targetItem.name, namespace: targetItem.namespace, uid: targetItem.uid, item: targetItem, container,
          context: useClusterStore.getState().currentContext,
        });
      },
      openTerminalTab: (item, container) => {
        let targetItem = item;
        if (item.kind !== 'Pod') {
          const resources = useResourceStore.getState().resources;
          const childPods = findWorkloadPods(item, resources);
          const activePod = preferredWorkloadPod(childPods);
          if (activePod) {
            targetItem = activePod;
          } else {
            toast.info(`No active pods found for ${item.kind}/${item.name}`);
            return;
          }
        }
        if (useContainerLaunchStore.getState().request(targetItem, container, true, chosen => get().openTerminalTab(targetItem, chosen))) return;
        get().openTab({
          id: resourceTabId('terminal', useClusterStore.getState().currentContext, targetItem, container),
          type: 'terminal',
          title: item.kind === 'Pod' ? `Terminal: ${item.name}` : `Terminal: ${item.name} (${targetItem.name})`,
          subtitle: targetItem.namespace,
          resource: resourceRef(useClusterStore.getState().currentContext ?? '', targetItem),
          kind: targetItem.kind, apiVersion: targetItem.apiVersion, name: targetItem.name, namespace: targetItem.namespace, uid: targetItem.uid, item: targetItem, container,
          context: useClusterStore.getState().currentContext,
        });
      },
      openTopology: (item, namespace) => get().openTab({
        id: JSON.stringify(['topology', useClusterStore.getState().currentContext, item?.uid, namespace]),
        type: 'topology', title: item ? `Topology: ${item.name}` : namespace ? `Topology: ${namespaceScopeLabel(namespace)}` : 'Cluster topology',
        resource: item ? resourceRef(useClusterStore.getState().currentContext ?? '', item) : undefined,
        kind: item?.kind, apiVersion: item?.apiVersion, name: item?.name, uid: item?.uid, namespace: item?.namespace ?? namespace,
        context: useClusterStore.getState().currentContext,
      }),

      closeTab: (id) => {
        const { tabs, activeTabId, splitTabId } = get();
        const target = tabs.find((t) => t.id === id);
        if (!target) return;

        const newTabs = tabs.filter((t) => t.id !== id);
        if (newTabs.length === 0) {
          set({
            tabs: [],
            activeTabId: '',
            splitTabId: null,
          });
          return;
        }

        let nextActive = activeTabId;
        if (activeTabId === id) {
          const idx = tabs.findIndex((t) => t.id === id);
          const candidate = newTabs[Math.max(0, idx - 1)] || newTabs[0];
          nextActive = candidate.id;
        }

        set({
          tabs: newTabs,
          activeTabId: nextActive,
          splitTabId: splitTabId === id || splitTabId === nextActive ? null : splitTabId,
        });
      },

      closeOtherTabs: (id) => {
        const { tabs } = get();
        const kept = tabs.filter((t) => t.id === id);
        set({
          tabs: kept,
          activeTabId: id,
          splitTabId: null,
        });
      },

      closeTabsToRight: (id) => {
        const { tabs } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx === -1) return;
        const kept = tabs.filter((_, i) => i <= idx);
        set({
          tabs: kept,
          activeTabId: id,
          splitTabId: get().splitTabId !== id && kept.some((t) => t.id === get().splitTabId) ? get().splitTabId : null,
        });
      },

      closeAllTabs: () => {
        set({
          tabs: [],
          activeTabId: '',
          splitTabId: null,
        });
      },

      setActiveTab: (activeTabId) => set((state) => ({ activeTabId, splitTabId: state.splitTabId === activeTabId ? state.activeTabId === activeTabId ? null : state.activeTabId : state.splitTabId })),

      togglePinTab: (id) => {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
        }));
      },

      setTabDirty: (id, dirty) => {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === id ? { ...t, dirty } : t)),
        }));
      },

      setSplit: (splitTabId, direction = 'vertical') => {
        const state = get();
        const primary = splitTabId === state.activeTabId ? state.tabs.find((tab) => tab.id !== splitTabId)?.id : state.activeTabId;
        set({ activeTabId: primary ?? state.activeTabId, splitTabId: primary ? splitTabId : null, splitDirection: direction });
      },

      toggleSplit: (tabId) => {
        const { activeTabId, splitTabId, tabs } = get();
        if (splitTabId) {
          set({ splitTabId: null });
        } else {
          const target = tabId || tabs.find((t) => t.id !== activeTabId)?.id;
          if (target) get().setSplit(target, 'vertical');
        }
      },

      reorderTabs: (sourceIndex, destIndex) => {
        set((state) => {
          const result = Array.from(state.tabs);
          const [removed] = result.splice(sourceIndex, 1);
          result.splice(destIndex, 0, removed);
          return { tabs: result };
        });
      },
    }),
    {
      name: 'kubiki.workspace.v3',
      merge: restoreWorkspace,
      partialize: (s) => ({
        tabs: s.tabs.map((t) => ({ ...t, item: undefined })), // Don't persist full mock memory objects
        activeTabId: s.activeTabId,
      }),
    }
  )
);
