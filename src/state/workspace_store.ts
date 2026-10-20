import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useClusterStore } from './cluster_store';
import { resourceRef, resourceTabId } from '../core/resources/identity';
import type { ResourceRef } from '../core/resources/resource_types';
import type { ResourceItem, ResourceKind } from '../types/k8s';

export type WorkspaceTabType =
  | 'overview'        // Follows the global cluster and namespace selection
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

const DEFAULT_TABS: WorkspaceTab[] = [
  {
    id: 'tab-pods',
    type: 'resource-list',
    title: 'Pods',
    subtitle: 'all namespaces',
    kind: 'Pod',
    pinned: true,
  },
  {
    id: 'tab-deployments',
    type: 'resource-list',
    title: 'Deployments',
    subtitle: 'all namespaces',
    kind: 'Deployment',
  },
  { id: 'tab-overview', type: 'overview', title: 'Overview' },
];

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      tabs: DEFAULT_TABS,
      activeTabId: 'tab-pods',
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

      openResourceList: (kind, namespace) => {
        const { tabs } = get();
        const id = `tab-list-${kind}`;
        const existing = tabs.find((t) => t.id === id || (t.type === 'resource-list' && t.kind === kind));

        if (existing) {
          get().setActiveTab(existing.id);
        } else {
          const newTab: WorkspaceTab = {
            id,
            type: 'resource-list',
            title: `${kind}s`,
            subtitle: namespace || 'all namespaces',
            kind,
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
        type: 'resource-detail', title: item.name, subtitle: `${item.kind} · ${item.namespace || 'cluster'}`,
        resource: resourceRef(useClusterStore.getState().currentContext ?? '', item),
        kind: item.kind, apiVersion: item.apiVersion, name: item.name, namespace: item.namespace, uid: item.uid, item,
        context: useClusterStore.getState().currentContext,
      }),
      setTabContainer: (id, container) => set((state) => ({ tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, container, subtitle: `${tab.namespace} · ${container}` } : tab) })),
      openLogsTab: (item, container) => get().openTab({
        id: resourceTabId('logs', useClusterStore.getState().currentContext, item, container),
        type: 'logs', title: `Logs: ${item.name}`, subtitle: `${item.namespace} · ${container || 'default container'}`,
        resource: resourceRef(useClusterStore.getState().currentContext ?? '', item),
        kind: item.kind, apiVersion: item.apiVersion, name: item.name, namespace: item.namespace, uid: item.uid, item, container,
        context: useClusterStore.getState().currentContext,
      }),
      openTerminalTab: (item, container) => get().openTab({
        id: resourceTabId('terminal', useClusterStore.getState().currentContext, item, container),
        type: 'terminal', title: `Terminal: ${item.name}`, subtitle: item.namespace,
        resource: resourceRef(useClusterStore.getState().currentContext ?? '', item),
        kind: item.kind, apiVersion: item.apiVersion, name: item.name, namespace: item.namespace, uid: item.uid, item, container,
        context: useClusterStore.getState().currentContext,
      }),
      openTopology: (item, namespace) => get().openTab({
        id: JSON.stringify(['topology', useClusterStore.getState().currentContext, item?.uid, namespace]),
        type: 'topology', title: item ? `Topology: ${item.name}` : namespace ? `Topology: ${namespace}` : 'Cluster topology',
        resource: item ? resourceRef(useClusterStore.getState().currentContext ?? '', item) : undefined,
        kind: item?.kind, apiVersion: item?.apiVersion, name: item?.name, uid: item?.uid, namespace: item?.namespace ?? namespace,
        context: useClusterStore.getState().currentContext,
      }),

      closeTab: (id) => {
        const { tabs, activeTabId, splitTabId } = get();
        const target = tabs.find((t) => t.id === id);
        if (target?.pinned) return; // Cannot close pinned tabs

        const newTabs = tabs.filter((t) => t.id !== id);
        if (newTabs.length === 0) {
          // Keep at least default Pods tab
          set({
            tabs: DEFAULT_TABS,
            activeTabId: DEFAULT_TABS[0].id,
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
        const kept = tabs.filter((t) => t.id === id || t.pinned);
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
        const kept = tabs.filter((t, i) => i <= idx || t.pinned);
        set({
          tabs: kept,
          activeTabId: id,
          splitTabId: get().splitTabId !== id && kept.some((t) => t.id === get().splitTabId) ? get().splitTabId : null,
        });
      },

      closeAllTabs: () => {
        const { tabs } = get();
        const pinned = tabs.filter((t) => t.pinned);
        const finalTabs = pinned.length > 0 ? pinned : DEFAULT_TABS;
        set({
          tabs: finalTabs,
          activeTabId: finalTabs[0].id,
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
      name: 'kubiki.workspace.v2',
      partialize: (s) => ({
        tabs: s.tabs.map((t) => ({ ...t, item: undefined })), // Don't persist full mock memory objects
        activeTabId: s.activeTabId,
      }),
    }
  )
);
