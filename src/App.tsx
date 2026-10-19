import { useEffect } from 'react';
import { TitleBar } from './components/layout/TitleBar';
import { ActivityBar } from './components/layout/ActivityBar';
import { Sidebar } from './components/layout/Sidebar';
import { WorkspaceArea } from './components/layout/WorkspaceArea';
import { InspectorPanel } from './components/layout/InspectorPanel';
import { BottomDock } from './components/layout/BottomDock';
import { StatusBar } from './components/layout/StatusBar';
import { Resizer } from './components/layout/Resizer';
import { CommandPalette } from './navigation/CommandPalette';
import { SettingsDialog } from './components/SettingsModal';
import { Toasts } from './components/ui/Toasts';
import { useClusterStore } from './state/cluster_store';
import { useResourceStore } from './state/resource_store';
import { useUiStore } from './state/ui_store';
import { useWorkspaceStore } from './state/workspace_store';
import { buildMockResources, MOCK_NAMESPACES } from './providers/mock/mock_resources';
import { toast } from './state/notifications_store';
import type { ResourceItem, ResourceKind } from './types/k8s';

const MOCK_CONTEXTS = [
  { name: 'minikube', cluster: 'minikube-local', user: 'developer', namespace: 'default', is_current: true },
  { name: 'staging-us-east', cluster: 'k8s-staging', user: 'developer', namespace: 'backend', is_current: false },
  { name: 'prod-europe-west', cluster: 'k8s-prod', user: 'deployer', namespace: 'frontend', is_current: false },
];

export default function App() {
  const {
    sidebarWidth, sidebarCollapsed, setSidebarWidth,
    inspectorWidth, inspectorCollapsed, setInspectorWidth,
    dockHeight, dockCollapsed, setDockHeight,
  } = useUiStore();

  const setContexts = useClusterStore((s) => s.setContexts);
  const setAvailableNamespaces = useClusterStore((s) => s.setAvailableNamespaces);
  const setConnected = useClusterStore((s) => s.setConnected);
  const setResourcesForKind = useResourceStore((s) => s.setResourcesForKind);

  /* Seed the mock cluster on startup */
  useEffect(() => {
    setContexts(MOCK_CONTEXTS);
    setAvailableNamespaces(MOCK_NAMESPACES);
    const data = buildMockResources();
    for (const [kind, items] of Object.entries(data) as Array<[ResourceKind, ResourceItem[]]>) {
      setResourcesForKind(kind, items);
    }
    setConnected(true, '1.31.2');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* JetBrains Global Shortcuts */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        useUiStore.getState().setPaletteOpen(!useUiStore.getState().paletteOpen);
      } else if (key === 'b') {
        e.preventDefault();
        useUiStore.getState().toggleSidebar();
      } else if (key === 'j') {
        e.preventDefault();
        useUiStore.getState().toggleDock();
      } else if (key === 'w') {
        // Cmd/Ctrl+W closes active tab if not dirty/pinned
        const activeTabId = useWorkspaceStore.getState().activeTabId;
        if (activeTabId) {
          e.preventDefault();
          useWorkspaceStore.getState().closeTab(activeTabId);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSelectContext = (name: string) => {
    useClusterStore.getState().selectContext(name);
    toast.info(`Connecting to cluster context: ${name}`);
    setTimeout(() => {
      useClusterStore.getState().setConnected(true, '1.31.2');
      toast.success('Connected', `${name} · v1.31.2 ready`);
    }, 550);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)] overflow-hidden font-sans">
      {/* JetBrains New UI Top TitleBar */}
      <TitleBar onSelectContext={onSelectContext} />

      {/* Main IDE Frame: Left Rails + Tool Windows + Workspaces + Right Tool Windows */}
      <div className="flex-1 flex min-h-0 min-w-0">
        <ActivityBar />

        {/* Left Tool Window (Cluster Explorer) */}
        {!sidebarCollapsed && (
          <>
            <div style={{ width: sidebarWidth }} className="shrink-0 min-h-0">
              <Sidebar />
            </div>
            <Resizer orientation="vertical" onDelta={(d) => setSidebarWidth(sidebarWidth + d)} />
          </>
        )}

        {/* Central Workspace: Tabs + Breadcrumbs + DataGrid/Editor + Bottom Dock */}
        <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-[var(--bg-canvas)]">
          <WorkspaceArea />

          {!dockCollapsed && (
            <>
              <Resizer orientation="horizontal" onDelta={(d) => setDockHeight(dockHeight - d)} />
              <BottomDock />
            </>
          )}
          {dockCollapsed && <BottomDock />}
        </main>

        {/* Right Tool Window (Inspector / Details) */}
        {!inspectorCollapsed && (
          <>
            <Resizer orientation="vertical" onDelta={(d) => setInspectorWidth(inspectorWidth - d)} />
            <div style={{ width: inspectorWidth }} className="shrink-0 border-l border-[var(--border-default)] min-h-0">
              <InspectorPanel />
            </div>
          </>
        )}
      </div>

      {/* JetBrains Bottom Status Bar */}
      <StatusBar />

      {/* Dialogs and Popups */}
      <CommandPalette />
      <SettingsDialog />
      <Toasts />
    </div>
  );
}
