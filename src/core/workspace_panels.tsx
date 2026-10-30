import { lazy, Suspense, type ComponentType } from 'react';
import { Bot, GitBranch, Puzzle, type LucideIcon } from 'lucide-react';
import { openAiChat } from '../domains/ai';
import { create } from 'zustand';
import { useWorkspaceStore, type WorkspaceTab } from '../state/workspace_store';
import { useClusterStore } from '../state/cluster_store';
import type { ResourceItem } from '../types/k8s';
import { ResourceLoading } from '../components/ui/ResourceLoading';
import { workspaceArea } from './workspace_areas';

export interface WorkspacePanelProps { tab: WorkspaceTab; visible: boolean; item?: ResourceItem }
/** Registration for bundled features. This does not load or grant permissions to external code. */
export interface WorkspacePanel {
  id: string;
  title: string;
  icon: LucideIcon;
  component: ComponentType<WorkspacePanelProps>;
  sidebarComponent?: ComponentType;
  secondarySidebarComponent?: ComponentType;
  context: 'global' | 'cluster';
  tabType?: WorkspaceTab['type'];
  open?: () => void;
}
const TopologyView = lazy(() => import('../views/TopologyView').then(module => ({ default: module.TopologyView })));
const ExtensionsView = lazy(() => import('../views/ExtensionsView').then(module => ({ default: module.ExtensionsView })));
const AgentView = lazy(() => import('../domains/ai/components/AgentView').then(module => ({ default: module.AgentView })));
const AiConversationsSidebar = lazy(() => import('../domains/ai/components/AiConversationsSidebar').then(module => ({ default: module.AiConversationsSidebar })));
const agent: WorkspacePanel = {
  id: 'ai-agent',
  title: 'AI Agent',
  icon: Bot,
  context: 'global',
  open: () => openAiChat(),
  sidebarComponent: () => <Suspense fallback={null}><AiConversationsSidebar /></Suspense>,
  component: ({ visible }) => <AgentView visible={visible} />,
};
const extensions: WorkspacePanel = { id: 'extensions', title: 'Extensions', icon: Puzzle, context: 'global', component: () => <ExtensionsView /> };
const topology: WorkspacePanel = {
  id: 'topology',
  title: 'Cluster topology',
  icon: GitBranch,
  context: 'cluster',
  tabType: 'topology',
  open: () => useWorkspaceStore.getState().openTopology(),
  component: ({ tab, item, visible }) => <TopologyView item={item} namespace={tab.namespace} visible={visible} />,
};
export const usePanelRegistry = create<{ panels: readonly WorkspacePanel[] }>(() => ({ panels: [topology, agent, extensions] }));
export function registerWorkspacePanel(panel: WorkspacePanel): () => void {
  if (!/^[a-z][a-z0-9.-]*$/.test(panel.id) || !panel.title.trim()) throw new Error('Panel requires a stable ID and title');
  if (usePanelRegistry.getState().panels.some(entry => entry.id === panel.id || panel.tabType && entry.tabType === panel.tabType)) throw new Error(`Panel already registered: ${panel.id}`);
  usePanelRegistry.setState(state => ({ panels: [...state.panels, panel] }));
  return () => usePanelRegistry.setState(state => ({ panels: state.panels.filter(entry => entry !== panel) }));
}
export function openWorkspacePanel(panel: WorkspacePanel) {
  const context = panel.context === 'cluster' ? useClusterStore.getState().currentContext : null;
  if (panel.context === 'cluster' && !context) return;
  const workspace = useWorkspaceStore.getState();
  const candidates = workspace.tabs.filter(tab => workspaceArea(tab) === panel.id && (!context || tab.context === context));
  const remembered = workspace.areaSelections[panel.id]?.activeTabId;
  const existing = candidates.find(tab => tab.id === workspace.activeTabId) ?? candidates.find(tab => tab.id === remembered) ?? candidates[candidates.length - 1];
  if (existing) { workspace.setActiveTab(existing.id); return; }
  if (panel.open) { panel.open(); return; }
  useWorkspaceStore.getState().openTab({ id: `panel:${panel.id}:${encodeURIComponent(context ?? '')}`, type: 'extension', panelId: panel.id, title: panel.title, context });
}
export function RegisteredPanel(props: WorkspacePanelProps) {
  const panels = usePanelRegistry(s => s.panels);
  const panel = panels.find(entry => props.tab.panelId ? entry.id === props.tab.panelId : entry.tabType === props.tab.type);
  if (!panel) return <p role="status" className="p-4 text-sm">This panel is unavailable. Enable its extension to open it.</p>;
  const Component = panel.component;
  return <Suspense fallback={<ResourceLoading label={`Loading ${panel.title}…`} />}><Component {...props} /></Suspense>;
}
