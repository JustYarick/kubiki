import { useTableViewStore } from './table_view_store';
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
import { useYamlDraftStore, yamlDraftKey } from './yaml_draft_store';
import type { ResourceRef } from '../core/resources/resource_types';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import type { DockSession } from './dock_store';
import { activeWorkspaceArea, workspaceArea } from '../core/workspace_areas';
import { useAiStore } from '../domains/ai/store';

interface AreaSelection {
  activeTabId: string;
  splitTabId: string | null;
  splitDirection: 'horizontal' | 'vertical';
}

export type WorkspaceTabType =
  | 'extension'
  | 'overview'        // Follows the global cluster and namespace selection
  | 'flux-dashboard'
  | 'argocd-dashboard'
  | 'helm-releases'
  | 'helm-repositories'
  | 'resource-list'   // DataGrip-grade resource table (e.g. Pods, Deployments)
  | 'yaml-editor'     // Full-screen / split Monaco YAML editor
  | 'resource-detail' // Dedicated resource inspector overview
  | 'logs'            // Pod log stream
  | 'terminal'
  | 'terminal-session'
  | 'analysis'
  | 'topology';       // Pod interactive terminal session

export interface WorkspaceTab {
  panelId?: string;
  session?: DockSession;
  id: string;
  type: WorkspaceTabType;
  title: string;
  context?: string | null;
  subtitle?: string;
  kind?: ResourceKind;
  name?: string;
  namespace?: string;
  namespacePinned?: boolean;
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
  activeArea: string;
  areaSelections: Record<string, AreaSelection>;
  activeTabId: string;
  splitTabId: string | null;
  splitDirection: 'horizontal' | 'vertical';

  /* Actions */
  activateArea: (area: string) => void;
  openTab: (tab: Omit<WorkspaceTab, 'id'> & { id?: string }) => void;
  openOverview: () => void;
  openTerminalSession: (session: DockSession) => void;
  openGitOpsDashboard: (family: 'flux' | 'argocd') => void;
  openHelm: (section: import('../providers/helm_types').HelmSection) => void;
  openResourceList: (kind: ResourceKind, namespace?: string) => void;
  openYamlEditor: (item: ResourceItem) => void;
  openResourceDetail: (item: ResourceItem, options?: { namespacePinned?: boolean }) => void;
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

function selectArea(state: WorkspaceState, area: string, tabId?: string): Partial<WorkspaceState> {
  const previousArea = activeWorkspaceArea(state);
  const areaSelections = { ...state.areaSelections, [previousArea]: {
    activeTabId: state.activeTabId, splitTabId: state.splitTabId, splitDirection: state.splitDirection,
  } };
  const saved = areaSelections[area];
  const tabs = state.tabs.filter(tab => workspaceArea(tab) === area);
  const activeTabId = tabId ?? tabs.find(tab => tab.id === saved?.activeTabId)?.id ?? tabs[tabs.length - 1]?.id ?? '';
  let splitTabId = saved?.splitTabId ?? null;
  if (splitTabId === activeTabId) splitTabId = saved?.activeTabId !== activeTabId ? saved?.activeTabId ?? null : null;
  if (!tabs.some(tab => tab.id === splitTabId) || splitTabId === activeTabId) splitTabId = null;
  return { activeArea: area, areaSelections, activeTabId, splitTabId, splitDirection: saved?.splitDirection ?? 'vertical' };
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
  const restored = { ...current, ...saved, tabs };
  const area = activeWorkspaceArea(restored);
  const selection = restored.areaSelections[area];
  const split = tabs.find(tab => tab.id === selection?.splitTabId && tab.id !== restored.activeTabId && workspaceArea(tab) === area);
  return { ...restored, activeArea: area, splitTabId: split?.id ?? null, splitDirection: selection?.splitDirection ?? restored.splitDirection };
}

function clearDraftForTab(tab?: WorkspaceTab) {
  if (tab) useTableViewStore.getState().clear(tab.id);
  if (tab?.type === 'yaml-editor') {
    useYamlDraftStore.getState().clearDraft(
      yamlDraftKey(tab.context ?? '', tab.kind, tab.namespace, tab.name, tab.uid)
    );
  }
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeArea: 'explorer',
      areaSelections: {},
      activeTabId: '',
      splitTabId: null,
      splitDirection: 'vertical',

      activateArea: area => set(state => selectArea(state, area)),

      openTab: (tabInput) => {
        const { tabs } = get();
        const id = tabInput.id || `tab-${tabInput.type}-${tabInput.kind || ''}-${tabInput.name || ''}-${Date.now()}`;
        const existing = tabs.find((t) =>
          t.id === id ||
          (t.type === tabInput.type &&
            (tabInput.type !== 'extension' || t.panelId === tabInput.panelId) &&
            t.kind === tabInput.kind &&
            (tabInput.type === 'resource-list' || (t.name === tabInput.name && t.namespace === tabInput.namespace && t.context === tabInput.context && t.container === tabInput.container && t.uid === tabInput.uid && t.apiVersion === tabInput.apiVersion)))
        );

        if (existing) {
          if (tabInput.namespacePinned && !existing.namespacePinned) set(state => ({ tabs: state.tabs.map(tab => tab.id === existing.id ? { ...tab, namespacePinned: true } : tab) }));
          get().setActiveTab(existing.id);
          return;
        }

        const newTab: WorkspaceTab = {
          ...tabInput,
          id,
        };

        set(state => ({ tabs: [...tabs, newTab], ...selectArea({ ...state, tabs: [...tabs, newTab] }, workspaceArea(newTab), id) }));
      },

      openOverview: () => get().openTab({ id: 'tab-overview', type: 'overview', title: 'Overview' }),
      openTerminalSession: (session) => {
        const id = `tab-${session.id}`;
        // Each terminal owns its process; two local shells must never collapse into one tab.
        if (get().tabs.some(tab => tab.id === id)) { get().setActiveTab(id); return; }
        const tab: WorkspaceTab = { id, type: session.analysis ? 'analysis' : 'terminal-session', title: session.title, session: { ...session, id } };
        set(state => ({ tabs: [...state.tabs, tab], ...selectArea({ ...state, tabs: [...state.tabs, tab] }, 'explorer', id) }));
      },
      openGitOpsDashboard: (family) => get().openTab({ id: `tab-${family}-dashboard`, type: `${family}-dashboard`, title: `${family === 'flux' ? 'Flux' : 'Argo CD'} Overview` }),
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
          set(state => ({ tabs: [...tabs, newTab], ...selectArea({ ...state, tabs: [...tabs, newTab] }, 'explorer', id) }));
        }
      },

      openYamlEditor: (item) => get().openTab({
        id: resourceTabId('yaml', useClusterStore.getState().currentContext, item),
        type: 'yaml-editor', title: `${item.name}.yaml`, subtitle: `${item.kind} · ${item.namespace || 'cluster'}`,
        resource: resourceRef(useClusterStore.getState().currentContext ?? '', item),
        kind: item.kind, apiVersion: item.apiVersion, name: item.name, namespace: item.namespace, uid: item.uid, item,
        context: useClusterStore.getState().currentContext,
      }),
      openResourceDetail: (item, options) => get().openTab({
        id: resourceTabId('detail', useClusterStore.getState().currentContext, item),
        type: 'resource-detail', title: item.kind === 'HelmRelease' ? `Helm: ${item.name}` : item.name, subtitle: `${item.kind} · ${item.namespace || 'cluster'}`,
        resource: resourceRef(useClusterStore.getState().currentContext ?? '', item),
        kind: item.kind, apiVersion: item.apiVersion, name: item.name, namespace: item.namespace, uid: item.uid, item,
        context: useClusterStore.getState().currentContext,
        namespacePinned: options?.namespacePinned,
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
        const state = get();
        const target = state.tabs.find(tab => tab.id === id);
        if (!target) return;
        clearDraftForTab(target);
        if (target.panelId === 'ai-agent' || id === 'panel:ai-agent') {
          useAiStore.setState({ activeId: null });
        }
        const tabs = state.tabs.filter(tab => tab.id !== id);
        const siblings = state.tabs.filter(tab => workspaceArea(tab) === workspaceArea(target));
        const index = siblings.findIndex(tab => tab.id === id);
        const nextActive = siblings[index - 1]?.id ?? siblings[index + 1]?.id ?? '';
        set({ tabs,
          activeTabId: state.activeTabId === id ? nextActive : state.activeTabId,
          activeArea: activeWorkspaceArea(state),
          splitTabId: state.splitTabId === id || (state.splitTabId === nextActive && state.activeTabId === id) ? null : state.splitTabId,
        });
      },

      closeOtherTabs: (id) => {
        const state = get();
        const target = state.tabs.find(tab => tab.id === id);
        if (!target) return;
        const area = workspaceArea(target);
        const removed = state.tabs.filter(tab => workspaceArea(tab) === area && tab.id !== id);
        removed.forEach(clearDraftForTab);
        if (removed.some(t => t.panelId === 'ai-agent' || t.id === 'panel:ai-agent')) {
          useAiStore.setState({ activeId: null });
        }
        const tabs = state.tabs.filter(tab => !removed.includes(tab));
        set({ tabs, ...selectArea({ ...state, tabs }, area, id), splitTabId: null });
      },

      closeTabsToRight: (id) => {
        const state = get();
        const index = state.tabs.findIndex(tab => tab.id === id);
        if (index === -1) return;
        const area = workspaceArea(state.tabs[index]);
        const removed = state.tabs.filter((tab, i) => i > index && workspaceArea(tab) === area);
        removed.forEach(clearDraftForTab);
        if (removed.some(t => t.panelId === 'ai-agent' || t.id === 'panel:ai-agent')) {
          useAiStore.setState({ activeId: null });
        }
        const tabs = state.tabs.filter(tab => !removed.includes(tab));
        set({ tabs, ...selectArea({ ...state, tabs }, area, id) });
      },

      closeAllTabs: () => {
        const state = get();
        const area = activeWorkspaceArea(state);
        const removed = state.tabs.filter(tab => workspaceArea(tab) === area);
        removed.forEach(clearDraftForTab);
        if (removed.some(t => t.panelId === 'ai-agent' || t.id === 'panel:ai-agent')) {
          useAiStore.setState({ activeId: null });
        }
        set({ tabs: state.tabs.filter(tab => workspaceArea(tab) !== area), activeArea: area, activeTabId: '', splitTabId: null });
      },

      setActiveTab: (id) => set(state => {
        const tab = state.tabs.find(tab => tab.id === id);
        return tab ? selectArea(state, workspaceArea(tab), id) : {};
      }),

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
        const area = activeWorkspaceArea(state);
        if (splitTabId && !state.tabs.some(tab => tab.id === splitTabId && workspaceArea(tab) === area)) return;
        const primary = splitTabId === state.activeTabId ? state.tabs.find(tab => tab.id !== splitTabId && workspaceArea(tab) === area)?.id : state.activeTabId;
        set({ activeTabId: primary ?? state.activeTabId, splitTabId: primary ? splitTabId : null, splitDirection: direction });
      },

      toggleSplit: (tabId) => {
        const { activeTabId, splitTabId, tabs } = get();
        if (splitTabId) {
          set({ splitTabId: null });
        } else {
          const area = activeWorkspaceArea(get());
          const target = tabId || tabs.find(t => t.id !== activeTabId && workspaceArea(t) === area)?.id;
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
        tabs: s.tabs.map((t) => ({ ...t, item: undefined, session: undefined })), // Diagnostic snapshots and PTY sessions stay in memory.
        activeTabId: s.activeTabId,
        activeArea: activeWorkspaceArea(s),
        areaSelections: { ...s.areaSelections, [activeWorkspaceArea(s)]: { activeTabId: s.activeTabId, splitTabId: s.splitTabId, splitDirection: s.splitDirection } },
      }),
    }
  )
);
