import { useEffect, useCallback, useRef, useState } from 'react';
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
import { usePfStore } from './state/pf_store';
import { useDockStore } from './state/dock_store';
import { k8s } from './providers/k8s_provider';
import { startMockWatchEngine, stopMockWatchEngine } from './providers/mock/mock_watch_engine';
import { toast } from './state/notifications_store';
import type { ResourceKind } from './types/k8s';
import { errorHint } from './providers/errors';
import { DEFAULT_APPEARANCE, uiFactor, uiPixels } from './core/appearance';
import { resetExecSessions, closeExecConnections } from './providers/tauri_exec';
import { startResourceWatches, stopResourceWatches } from './state/resource_watch';

export default function App() {
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const {
    sidebarWidth, sidebarCollapsed, setSidebarWidth,
    inspectorWidth, inspectorCollapsed, setInspectorWidth,
    uiScale,
  } = useUiStore();

  const {
    dockHeight, dockCollapsed, setDockHeight, toggleDock,
  } = useDockStore();

  const setContexts = useClusterStore((s) => s.setContexts);
  const setAvailableNamespaces = useClusterStore((s) => s.setAvailableNamespaces);
  const setConnected = useClusterStore((s) => s.setConnected);
  const setLoading = useClusterStore((s) => s.setLoading);
  const setResourcesForKind = useResourceStore((s) => s.setResourcesForKind);

  const connectionGeneration = useRef(0);
  const connectToContext = useCallback(async (contextName: string) => {
    const generation = ++connectionGeneration.current;
    const current = () => generation === connectionGeneration.current;
    stopMockWatchEngine();
    stopResourceWatches();
    closeExecConnections();
    useClusterStore.getState().selectContext(contextName);
    useResourceStore.getState().reset();
    useDockStore.getState().clearAllSessions();
    usePfStore.getState().clear();
    useUiStore.setState({ inspectorCollapsed: true });
    setLoading(true);
    try {
      await k8s.resetResourceWatches();
      await resetExecSessions();
      if (!current()) return;
      const ping = await k8s.pingCluster(contextName);
      if (!current()) return;
      if (ping.status === 'error') throw new Error('Cluster is unavailable');
      // Namespace listing can be forbidden while individual namespace reads are allowed.
      try {
        const namespaces = await k8s.getNamespaces(contextName);
        if (current()) setAvailableNamespaces(namespaces);
      } catch (error) {
        if (current()) toast.warn('Namespace discovery unavailable', String(error));
      }
      if (!current()) return;
      setConnected(true, ping.version);
      const kinds = Object.keys(useResourceStore.getState().resources) as ResourceKind[];
      useResourceStore.getState().setSyncMode(k8s.demo ? 'demo' : k8s.supportsResourceWatch ? 'watch' : 'snapshot');
      const results = k8s.supportsResourceWatch ? await startResourceWatches(contextName) : await Promise.allSettled(kinds.map(async (kind) => {
        try {
          const items = await k8s.getResources(contextName, kind, 'all');
          if (current()) setResourcesForKind(kind, items);
        } catch (error) {
          if (current()) useResourceStore.getState().setLoadError(kind, error);
          throw error;
        }
      }));
      if (!current()) return;
      const failures = results.filter((r) => r.status === 'rejected').length;
      if (failures) toast.warn('Some resources could not be loaded', `${failures} resource types unavailable. See individual views.`);
      if (k8s.demo) startMockWatchEngine();
    } catch (error) {
      if (!current()) return;
      useClusterStore.getState().setError(error);
      toast.error('Connection failed', String(error));
    } finally {
      if (current()) setLoading(false);
    }
  }, [setAvailableNamespaces, setConnected, setLoading, setResourcesForKind]);

  useEffect(() => {
    let cancelled = false;
    async function initCluster() {
      try {
        const contexts = await k8s.getContexts();
        if (cancelled) return;
        setContexts(contexts);
        const current = contexts.find((c) => c.is_current)?.name || contexts[0]?.name;
        if (current) await connectToContext(current);
        else useClusterStore.getState().setError('No Kubernetes contexts found in kubeconfig.');
      } catch (error) {
        if (!cancelled) useClusterStore.getState().setError(error);
      }
    }
    void initCluster();
    return () => {
      cancelled = true;
      connectionGeneration.current++;
      stopMockWatchEngine();
      stopResourceWatches();
      closeExecConnections();
    };
  }, [connectToContext, setContexts]);

  useEffect(() => {
    const onPageHide = () => { stopResourceWatches(); closeExecConnections(); };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  /* JetBrains Global Shortcuts */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (!e.metaKey && e.target instanceof Element && e.target.closest('.xterm') && ['k', 'b', 'j', 'w'].includes(key)) return;
      if (!e.altKey && ['=', '+', '-', '0'].includes(key)) {
        e.preventDefault();
        const ui = useUiStore.getState();
        ui.setUiScale(key === '0' ? DEFAULT_APPEARANCE.uiScale : ui.uiScale + (key === '-' ? -10 : 10));
      } else if (key === ',') {
        e.preventDefault();
        useUiStore.getState().setSettingsOpen(true);
      } else if (key === 'k') {
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

  const factor = uiFactor(uiScale);
  const logicalViewportWidth = viewportWidth / factor;
  const showSidebar = !sidebarCollapsed && (inspectorCollapsed || logicalViewportWidth >= 1200);
  const detailWidth = Math.min(inspectorWidth, Math.max(280, logicalViewportWidth - 40 - 280 - (showSidebar ? sidebarWidth : 0)));

  const onSelectContext = (name: string) => {
    connectToContext(name);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)] overflow-hidden font-sans">
      {/* JetBrains New UI Top TitleBar */}
      <TitleBar onSelectContext={onSelectContext} />
      <ConnectionBanner onRetry={() => {
        const context = useClusterStore.getState().currentContext;
        if (context) void connectToContext(context);
        else window.location.reload();
      }} />

      {/* Main IDE Frame: Left Rails + Tool Windows + Workspaces + Right Tool Windows */}
      <div className="flex-1 flex min-h-0 min-w-0">
        <ActivityBar />

        {/* Left Tool Window (Cluster Explorer) */}
        {showSidebar && (
          <>
            <div style={{ width: uiPixels(sidebarWidth) }} className="shrink-0 min-h-0">
              <Sidebar />
            </div>
            <Resizer orientation="vertical" onDelta={(d) => setSidebarWidth(sidebarWidth + d / factor)} />
          </>
        )}

        {/* Central Workspace: Tabs + Breadcrumbs + DataGrid/Editor + Bottom Dock */}
        <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-[var(--bg-canvas)]">
          <WorkspaceArea onSelectContext={onSelectContext} />

          {!dockCollapsed && <Resizer orientation="horizontal" onDelta={(d) => setDockHeight(dockHeight - d / factor)} />}
          <BottomDock />
        </main>

        {/* Right Tool Window (Inspector / Details) */}
        {!inspectorCollapsed && (
          <>
            <Resizer orientation="vertical" onDelta={(d) => setInspectorWidth(inspectorWidth - d / factor)} />
            <div style={{ width: uiPixels(detailWidth) }} className="shrink-0 border-l border-[var(--border-default)] min-h-0">
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

function ConnectionBanner({ onRetry }: { onRetry: () => void }) {
  const error = useClusterStore((s) => s.error);
  const loading = useClusterStore((s) => s.isLoading);
  if (!error && !k8s.demo) return null;
  return <div role="status" className="flex items-center gap-3 px-3 py-1.5 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] text-xs">
    <span className={error ? 'text-[var(--status-danger)]' : 'text-[var(--status-warn)]'}>{error ? <>{error.message}{errorHint(error) && <span className="ml-2 text-[var(--text-secondary)]">{errorHint(error)}</span>}</> : 'Demo cluster · simulated resources and sessions'}</span>
    {error && <button disabled={loading} onClick={onRetry} className="text-[var(--accent)] shrink-0">Reconnect</button>}
    {error && <a href="?demo=1" className="text-[var(--accent)] shrink-0">Explore demo</a>}
  </div>;
}
