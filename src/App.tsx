import { refreshExtensions } from './extensions/registry';
import { desktopExtensions } from './providers/extensions';
import { ContainerLaunchDialog } from './components/k8s/ContainerLaunchDialog';
import { MutationConfirmModal } from './components/dialogs/MutationConfirmModal';
import { setupMutationConfirmListener } from './state/mutation_confirm_store';
import { RESOURCE_TYPES, SCOPE_INDEPENDENT_KINDS, setDiscoveredResourceTypes } from './core/resources/resource_types';
import { closePortForwards, resetPortForwards, listPortForwards } from './providers/port_forward';
import { useEffect, useCallback, useRef, useState, type CSSProperties } from 'react';
import { TitleBar } from './components/layout/TitleBar';
import { ActivityBar } from './components/layout/ActivityBar';
import { Sidebar } from './components/layout/Sidebar';
import { WorkspaceArea } from './components/layout/WorkspaceArea';
import { InspectorPanel } from './components/layout/InspectorPanel';
import { BottomDock } from './components/layout/BottomDock';
import { StatusBar } from './components/layout/StatusBar';
import { Resizer } from './components/layout/Resizer';
import { CommandPalette } from './navigation/CommandPalette';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { AppUpdatePrompt } from './components/updates/AppUpdates';
import { Toasts } from './components/ui/Toasts';
import { OverflowTooltip } from './components/ui/OverflowTooltip';
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
import { closeNodeDebugConnections } from './providers/node_debug';
import { cancelResourceSnapshots, syncResourceSnapshot } from './providers/snapshot_sync';
import { startResourceWatches, stopResourceWatches } from './state/resource_watch';

export default function App() {
  useEffect(() => { if (desktopExtensions()) void refreshExtensions(); }, []);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => {
    let closed = false;
    let cleanup: (() => void) | undefined;
    void setupMutationConfirmListener().then(close => { if (closed) close(); else cleanup = close; });
    const close = () => { closed = true; cleanup?.(); cleanup = undefined; };
    window.addEventListener('pagehide', close);
    return () => { window.removeEventListener('pagehide', close); close(); };
  }, []);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const {
    sidebarWidth, sidebarCollapsed, setSidebarWidth,
    inspectorWidth, inspectorCollapsed, inspectorPinned, setInspectorWidth,
    uiScale,
  } = useUiStore();

  const {
    dockHeight, dockCollapsed, setDockHeight, toggleDock,
  } = useDockStore();

  const setContexts = useClusterStore((s) => s.setContexts);
  const setAvailableNamespaces = useClusterStore((s) => s.setAvailableNamespaces);
  const setConnected = useClusterStore((s) => s.setConnected);
  const setLoading = useClusterStore((s) => s.setLoading);

  /* The persisted default details tab opens the inspector on the configured tab for the session. */
  useEffect(() => {
    useUiStore.setState({ rightTab: useUiStore.getState().defaultRightTab });
  }, []);

  const connectionGeneration = useRef(0);
  useEffect(() => useClusterStore.subscribe((state, previous) => {
    if (!k8s.demo || state.currentContext !== previous.currentContext || state.selectedNamespace === previous.selectedNamespace || !state.currentContext) return;
    const context = state.currentContext;
    const scope = state.selectedNamespace;
    const current = () => useClusterStore.getState().currentContext === context && useClusterStore.getState().selectedNamespace === scope;
    setLoading(true);
    void Promise.allSettled(RESOURCE_TYPES.filter(type => type.namespaced && !SCOPE_INDEPENDENT_KINDS.has(type.kind) && (!useClusterStore.getState().availableResourceKinds || useClusterStore.getState().availableResourceKinds!.includes(type.kind))).map(async type => {
      await syncResourceSnapshot(context, type.kind, scope);
    })).finally(() => { if (current()) setLoading(false); });
  }), [setLoading]);
  const connectToContext = useCallback(async (contextName: string) => {
    const generation = ++connectionGeneration.current;
    const current = () => generation === connectionGeneration.current;
    stopMockWatchEngine();
    stopResourceWatches();
    cancelResourceSnapshots();
    closeExecConnections();
    closeNodeDebugConnections();
    closePortForwards();
    setDiscoveredResourceTypes();
    k8s.activateContext(contextName);
    useClusterStore.getState().selectContext(contextName);
    useClusterStore.setState({ availableResourceKinds: null });
    useResourceStore.getState().reset();
    useDockStore.getState().clearAllSessions();
    usePfStore.getState().clear();
    useUiStore.setState({ inspectorCollapsed: true });
    setLoading(true);
    try {
      await k8s.resetResourceWatches();
      await resetExecSessions();
      await resetPortForwards();
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
      let available = RESOURCE_TYPES;
      try {
        const discovered = await k8s.getApiResources(contextName);
        if (!current()) return;
        available = discovered;
        setDiscoveredResourceTypes(discovered);
        useClusterStore.setState({ availableResourceKinds: discovered.map(type => type.kind) });
      } catch { /* Discovery can be denied independently; keep explicit per-resource reads available. */ }
      if (!current()) return;
      setConnected(true, ping.version);
      const kinds = available.map(type => type.kind) as ResourceKind[];
      useResourceStore.getState().setSyncMode(k8s.demo ? 'demo' : k8s.supportsResourceWatch ? 'watch' : 'snapshot');
      const results = k8s.demo ? await Promise.allSettled(kinds.map(async (kind) => {
        await syncResourceSnapshot(contextName, kind, 'all');
      })) : await startResourceWatches(contextName);
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
  }, [setAvailableNamespaces, setConnected, setLoading]);

  useEffect(() => {
    let cancelled = false;
    k8s.setDeveloperMode(useUiStore.getState().developerMode);
    const unsubscribeDeveloperMode = useUiStore.subscribe((state, previous) => {
      if (state.developerMode === previous.developerMode) return;
      const contexts = k8s.setDeveloperMode(state.developerMode);
      if (!contexts || cancelled) return;
      const previousContext = useClusterStore.getState().currentContext;
      setContexts(contexts);
      const current = useClusterStore.getState().currentContext;
      if (current && current !== previousContext) void connectToContext(current);
    });
    async function initCluster() {
      setLoading(true);
      try {
        const contexts = await k8s.getContexts();
        if (cancelled) return;
        setContexts(contexts);
        const current = useClusterStore.getState().currentContext;
        if (current) await connectToContext(current);
        else { useClusterStore.getState().setError('No Kubernetes contexts found in kubeconfig.'); setLoading(false); }
      } catch (error) {
        if (!cancelled) { useClusterStore.getState().setError(error); setLoading(false); }
      }
    }
    void initCluster();
    return () => {
      cancelled = true;
      unsubscribeDeveloperMode();
      connectionGeneration.current++;
      stopMockWatchEngine();
      stopResourceWatches();
      cancelResourceSnapshots();
      closeExecConnections();
      closeNodeDebugConnections();
      closePortForwards();
    };
  }, [connectToContext, setContexts, setLoading]);

  useEffect(() => {
    const onPageHide = () => { stopResourceWatches(); cancelResourceSnapshots(); closeExecConnections(); closeNodeDebugConnections(); closePortForwards(); };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  const forwardCount = usePfStore(state => state.sessions.filter(session => session.live).length);
  const forwardContext = useClusterStore(state => state.currentContext);
  useEffect(() => {
    if (!forwardCount || !forwardContext || k8s.demo) return;
    let cancelled = false; let reported = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const ids = usePfStore.getState().sessions.filter(session => session.live).map(session => session.id);
      try { const sessions = await listPortForwards(); reported = false; if (!cancelled && useClusterStore.getState().currentContext === forwardContext) usePfStore.getState().syncLive(sessions, forwardContext, ids); }
      catch (error) { if (!cancelled && !reported) { reported = true; toast.warn('Tunnel status unavailable', String(error)); } }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [forwardCount, forwardContext]);

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

  const activeTabType = useWorkspaceStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.type);
  const showInspector = !inspectorCollapsed;
  useEffect(() => {
    if (activeTabType === 'overview' && !inspectorPinned) useUiStore.setState({ inspectorCollapsed: true });
  }, [activeTabType, inspectorPinned]);
  const factor = uiFactor(uiScale);
  const logicalViewportWidth = viewportWidth / factor;
  const showSidebar = !sidebarCollapsed;
  const compact = logicalViewportWidth < 760;
  const overlaySidebar = compact && showInspector;
  useEffect(() => {
    if (compact && showInspector) useUiStore.setState({ sidebarCollapsed: true });
  }, [compact, showInspector]);
  // The details panel always floats above the workspace: it never resizes the resource table.
  // The store keeps it at least 520px wide, but a narrow viewport still wins over that floor.
  const detailWidth = Math.min(inspectorWidth, Math.max(0, logicalViewportWidth - 56 / factor));
  const [headerHeight, setHeaderHeight] = useState(58);

  const onSelectContext = (name: string) => {
    connectToContext(name);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)] overflow-hidden font-sans" style={{ '--inspector-overlay': showInspector ? uiPixels(detailWidth) : '0px', '--inspector-width': showInspector ? uiPixels(detailWidth) : '0px' } as CSSProperties}>
      {/* JetBrains New UI Top TitleBar */}
      <TitleBar onSelectContext={onSelectContext} compact={compact} narrow={logicalViewportWidth < 500} />
      <AppUpdatePrompt />
      <ConnectionBanner onRetry={() => {
        const context = useClusterStore.getState().currentContext;
        if (context) void connectToContext(context);
        else window.location.reload();
      }} />

      {/* Main IDE Frame: Left Rails + Tool Windows + Workspaces + Right Tool Windows */}
      <div className="flex-1 flex min-h-0 min-w-0 relative">
        <ActivityBar />

        {/* Left Tool Window (Cluster Explorer) */}
        {showSidebar && (
          <>
            <div data-testid="explorer-panel" style={{ width: uiPixels(Math.min(sidebarWidth, logicalViewportWidth - 56)) }} className={`shrink-0 min-h-0 ${overlaySidebar ? "absolute left-[calc(40px*var(--ui-factor))] top-0 bottom-0 z-30 shadow-xl border-r border-[var(--border-default)]" : ""}`}>
              <Sidebar />
            </div>
            {!overlaySidebar && <Resizer orientation="vertical" onDelta={(d) => setSidebarWidth(sidebarWidth + d / factor)} />}
          </>
        )}

        {/* Central Workspace: Tabs + Breadcrumbs + DataGrid/Editor + Bottom Dock */}
        <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-[var(--bg-canvas)]">
          <WorkspaceArea onSelectContext={onSelectContext} onHeaderHeight={setHeaderHeight} />

          {/* Bottom Dock drawer — shares the foreground layer with InspectorPanel, adapting its width */}
          <div
            data-testid="bottom-dock-wrapper"
            style={{ marginRight: showInspector ? uiPixels(detailWidth) : '0px' }}
            className="flex flex-col min-w-0 shrink-0 z-20"
          >
            {!dockCollapsed && <Resizer orientation="horizontal" onDelta={(d) => setDockHeight(Math.min(dockHeight - d / factor, (window.innerHeight - 170) / factor))} />}
            <BottomDock />
          </div>
        </main>

        {/* Right Tool Window (Inspector / Details) — floats above the workspace, the table keeps its size */}
        {showInspector && (
          <div data-testid="inspector-panel" data-layout="overlay" style={{ width: uiPixels(detailWidth), top: uiPixels(headerHeight) }} className="absolute right-0 bottom-0 z-40 min-h-0 border-l border-[var(--border-default)] shadow-xl">
            <Resizer orientation="vertical" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, zIndex: 10 }} onDelta={(d) => setInspectorWidth(inspectorWidth - d / factor)} />
            <InspectorPanel />
          </div>
        )}
      </div>

      {/* Bottom Global Status Bar */}
      <StatusBar />

      {/* Global Modals & Overlays */}
      <CommandPalette />
      <SettingsDialog />
      <ContainerLaunchDialog />
      <MutationConfirmModal />
      <Toasts />
      <OverflowTooltip />
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
