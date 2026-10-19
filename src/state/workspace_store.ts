import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ResourceItem, ResourceKind } from '../types/k8s';

export type WorkspaceTabType =
  | 'resource-list'   // DataGrip-grade resource table (e.g. Pods, Deployments)
  | 'yaml-editor'     // Full-screen / split Monaco YAML editor
  | 'resource-detail' // Dedicated resource inspector overview
  | 'logs'            // Pod log stream
  | 'terminal';       // Pod interactive terminal session

export interface WorkspaceTab {
  id: string;
  type: WorkspaceTabType;
  title: string;
  subtitle?: string;
  kind?: ResourceKind;
  name?: string;
  namespace?: string;
  uid?: string;
  pinned?: boolean;
  dirty?: boolean;
  item?: ResourceItem;
  container?: string;
}

interface WorkspaceState {
  tabs: WorkspaceTab[];
  activeTabId: string;
  splitTabId: string | null;
  splitDirection: 'horizontal' | 'vertical';

  /* Actions */
  openTab: (tab: Omit<WorkspaceTab, 'id'> & { id?: string }) => void;
  openResourceList: (kind: ResourceKind, namespace?: string) => void;
  openYamlEditor: (item: ResourceItem) => void;
  openResourceDetail: (item: ResourceItem) => void;
  openLogsTab: (item: ResourceItem, container?: string) => void;
  openTerminalTab: (item: ResourceItem, container?: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (id: string) => void;
  togglePinTab: (id: string) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
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
            (tabInput.type === 'resource-list' || t.name === tabInput.name))
        );

        if (existing) {
          set({ activeTabId: existing.id });
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

      openResourceList: (kind, namespace) => {
        const { tabs } = get();
        const id = `tab-list-${kind}`;
        const existing = tabs.find((t) => t.id === id || (t.type === 'resource-list' && t.kind === kind));

        if (existing) {
          set({ activeTabId: existing.id });
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

      openYamlEditor: (item) => {
        const { tabs } = get();
        const id = `yaml-${item.kind}-${item.name}`;
        const existing = tabs.find((t) => t.id === id);

        if (existing) {
          set({ activeTabId: existing.id });
        } else {
          const newTab: WorkspaceTab = {
            id,
            type: 'yaml-editor',
            title: `${item.name}.yaml`,
            subtitle: `${item.kind} · ${item.namespace || 'cluster'}`,
            kind: item.kind,
            name: item.name,
            namespace: item.namespace,
            uid: item.uid,
            item,
          };
          set({
            tabs: [...tabs, newTab],
            activeTabId: id,
          });
        }
      },

      openResourceDetail: (item) => {
        const { tabs } = get();
        const id = `detail-${item.kind}-${item.name}`;
        const existing = tabs.find((t) => t.id === id);

        if (existing) {
          set({ activeTabId: existing.id });
        } else {
          const newTab: WorkspaceTab = {
            id,
            type: 'resource-detail',
            title: item.name,
            subtitle: `${item.kind} · Details`,
            kind: item.kind,
            name: item.name,
            namespace: item.namespace,
            uid: item.uid,
            item,
          };
          set({
            tabs: [...tabs, newTab],
            activeTabId: id,
          });
        }
      },

      openLogsTab: (item, container) => {
        const { tabs } = get();
        const id = `logs-${item.name}-${container || 'main'}`;
        const existing = tabs.find((t) => t.id === id);

        if (existing) {
          set({ activeTabId: existing.id });
        } else {
          const newTab: WorkspaceTab = {
            id,
            type: 'logs',
            title: `Logs: ${item.name}`,
            subtitle: container ? `${container}` : item.namespace || 'default',
            kind: item.kind,
            name: item.name,
            namespace: item.namespace,
            uid: item.uid,
            item,
            container,
          };
          set({
            tabs: [...tabs, newTab],
            activeTabId: id,
          });
        }
      },

      openTerminalTab: (item, container) => {
        const { tabs } = get();
        const id = `term-${item.name}-${container || 'sh'}`;
        const existing = tabs.find((t) => t.id === id);

        if (existing) {
          set({ activeTabId: existing.id });
        } else {
          const newTab: WorkspaceTab = {
            id,
            type: 'terminal',
            title: `Terminal: ${item.name}`,
            subtitle: container ? `${container}` : 'sh',
            kind: item.kind,
            name: item.name,
            namespace: item.namespace,
            uid: item.uid,
            item,
            container,
          };
          set({
            tabs: [...tabs, newTab],
            activeTabId: id,
          });
        }
      },

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
          splitTabId: splitTabId === id ? null : splitTabId,
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

      setActiveTab: (activeTabId) => set({ activeTabId }),

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
        set({ splitTabId, splitDirection: direction });
      },

      toggleSplit: (tabId) => {
        const { activeTabId, splitTabId, tabs } = get();
        if (splitTabId) {
          set({ splitTabId: null });
        } else {
          const target = tabId || tabs.find((t) => t.id !== activeTabId)?.id;
          if (target && target !== activeTabId) {
            set({ splitTabId: target, splitDirection: 'vertical' });
          }
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
      name: 'kubiki.workspace.v1',
      partialize: (s) => ({
        tabs: s.tabs.map((t) => ({ ...t, item: undefined })), // Don't persist full mock memory objects
        activeTabId: s.activeTabId,
      }),
    }
  )
);
