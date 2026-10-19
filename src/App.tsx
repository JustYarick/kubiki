import { useEffect, useCallback } from 'react';
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
import { useDockStore } from './state/dock_store';
import { k8s } from './providers/k8s_provider';
import { buildMockResources } from './providers/mock/mock_resources';
import { startMockWatchEngine, stopMockWatchEngine } from './providers/mock/mock_watch_engine';
import { toast } from './state/notifications_store';
import type { ResourceItem, ResourceKind } from './types/k8s';

export default function App() {
  const {
    sidebarWidth, sidebarCollapsed, setSidebarWidth,
    inspectorWidth, inspectorCollapsed, setInspectorWidth,
  } = useUiStore();

  const {
    dockHeight, dockCollapsed, setDockHeight, toggleDock,
  } = useDockStore();

  const setContexts = useClusterStore((s) => s.setContexts);
  const setAvailableNamespaces = useClusterStore((s) => s.setAvailableNamespaces);
  const setConnected = useClusterStore((s) => s.setConnected);
  const setLoading = useClusterStore((s) => s.setLoading);
  const setResourcesForKind = useResourceStore((s) => s.setResourcesForKind);

  const connectToContext = useCallback(async (contextName: string) => {
    useClusterStore.getState().selectContext(contextName);
    setLoading(true);
    toast.info(`Connecting to cluster context: ${contextName}…`);

    try {
      // 1. Verify health & version
      const ping = await k8s.pingCluster(contextName);
      const version = ping.version || 'v1.35.5';

      // 2. Load accessible namespaces
      const namespaces = await k8s.getNamespaces(contextName);
      setAvailableNamespaces(namespaces);

      // 3. Pre-load resources for primary workloads
      const kindsToLoad: ResourceKind[] = [
        'Pod', 'Deployment', 'StatefulSet', 'DaemonSet',
        'Job', 'CronJob', 'Service', 'Ingress', 'Node', 'Namespace',
      ];

      await Promise.all(
        kindsToLoad.map(async (k) => {
          const items = await k8s.getResources(contextName, k, 'all');
          setResourcesForKind(k, items);
        })
      );

      setConnected(true, version);
      toast.success('Connected', `${contextName} · ${version} (${namespaces.length} namespaces)`);
    } catch (err: any) {
      console.error('Cluster connection error:', err);
      const fallback = buildMockResources();
      for (const [k, items] of Object.entries(fallback) as Array<[ResourceKind, ResourceItem[]]>) {
        setResourcesForKind(k, items);
      }
      setConnected(true, '1.35.5');
      toast.warn('Connected with Cached Resources', `${contextName}`);
    } finally {
      setLoading(false);
    }
  }, [setAvailableNamespaces, setConnected, setLoading, setResourcesForKind]);

  /* Load real cluster contexts on startup and auto-connect to current context */
  useEffect(() => {
    let cancelled = false;

    async function initCluster() {
      try {
        const contexts = await k8s.getContexts();
        if (cancelled) return;
        setContexts(contexts);

        const current = contexts.find((c) => c.is_current)?.name || contexts[0]?.name || 'default';
        await connectToContext(current);
      } catch (e) {
        console.warn('Contexts discovery failed, using fallback:', e);
      }
    }

    initCluster();
    startMockWatchEngine();

    return () => {
      cancelled = true;
      stopMockWatchEngine();
    };
  }, [connectToContext, setContexts]);

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
        toggleDock();
      } else if (key === 'w') {
        const activeTabId = useWorkspaceStore.getState().activeTabId;
        if (activeTabId) {
          e.preventDefault();
          useWorkspaceStore.getState().closeTab(activeTabId);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleDock]);

  const onSelectContext = (name: string) => {
    connectToContext(name);
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

      {/* Bottom Global Status Bar */}
      <StatusBar />

      {/* Global Modals & Overlays */}
      <CommandPalette />
      <SettingsDialog />
      <Toasts />
    </div>
  );
}
