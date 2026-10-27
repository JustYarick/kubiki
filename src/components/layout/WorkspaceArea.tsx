import { RegisteredPanel } from '../../core/workspace_panels';
import { useCustomResources } from '../../providers/use_custom_resources';
import { customResourceType, resourceBucket } from '../../core/resources/custom_resource_types';
import React, { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { MainTabBar } from './MainTabBar';
import { BreadcrumbBar } from './BreadcrumbBar';
import { OverviewView } from '../../views/OverviewView';
import { ResourceView } from '../../views/ResourceView';
import { useWorkspaceStore, type WorkspaceTab } from '../../state/workspace_store';
import { useResourceStore } from '../../state/resource_store';
import { ResourceDetails } from './InspectorPanel';
import { LogsSessionPane, TerminalSessionPane } from './BottomDock';
import { useClusterStore } from '../../state/cluster_store';
import { useUiStore } from '../../state/ui_store';
import { uiFactor } from '../../core/appearance';
import { parse } from 'yaml';
import { mapK8sResource } from '../../core/utils/k8s_mapper';
import { k8s } from '../../providers/k8s_provider';
import { AnalysisView } from '../../views/AnalysisView';
import { IconButton } from '../ui/Button';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { Resizer } from './Resizer';
import { cx } from '../../core/utils/cx';
import { toast } from '../../state/notifications_store';
import { FileCode, Loader2, LayoutDashboard, Boxes, Layers, Network, X } from 'lucide-react';
import { NamespaceScopeNotice } from '../k8s/NamespaceScopeNotice';
import { RequestErrorNotice } from '../k8s/RequestErrorNotice';
import { refreshResourceWatches } from '../../state/resource_watch';
import { ResourceLoading } from '../ui/ResourceLoading';
import { RESOURCE_TYPES, namespaceIsOutsideScope } from '../../core/resources/resource_types';
import { matchesResourceRef } from '../../core/resources/identity';

const YamlEditor = lazy(() => import('../../views/YamlEditor').then((m) => ({ default: m.YamlEditor })));
const HelmView = lazy(() => import('../../views/HelmView').then(m => ({ default: m.HelmView })));
const GitOpsDashboard = lazy(() => import('../../views/GitOpsDashboard').then(m => ({ default: m.GitOpsDashboard })));

export const WorkspaceArea: React.FC<{
  onSelectContext: (context: string) => void;
  /** Height of the tab bar and breadcrumb row, so overlays can start below them. */
  onHeaderHeight?: (height: number) => void;
}> = ({ onSelectContext, onHeaderHeight }) => {
  const { tabs, activeTabId, splitTabId } = useWorkspaceStore();
  const [splitRatio, setSplitRatio] = useState(0.5); // 50% split by default
  const uiScale = useUiStore((state) => state.uiScale);
  const factor = uiFactor(uiScale);
  const headerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = headerRef.current;
    if (!element || !onHeaderHeight) return;
    const report = () => onHeaderHeight(Math.round(element.getBoundingClientRect().height / factor));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [factor, onHeaderHeight]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const splitTab = splitTabId && splitTabId !== activeTab?.id ? tabs.find((t) => t.id === splitTabId) : null;

  const [visited, setVisited] = useState<Set<string>>(new Set());
  useEffect(() => { setVisited((previous) => {
    const next = new Set([...previous].filter((id) => tabs.some((tab) => tab.id === id)));
    if (activeTab) next.add(activeTab.id); if (splitTab) next.add(splitTab.id);
    if (next.size === previous.size && [...next].every((id) => previous.has(id))) return previous;
    return next;
  }); }, [tabs, activeTab?.id, splitTab?.id]);
  const mounted = tabs.filter((tab) => tab.id === activeTab?.id || tab.id === splitTab?.id || (visited.has(tab.id) && (tab.type === 'terminal' || tab.type === 'terminal-session' || tab.type === 'analysis' || tab.type === 'logs' || tab.type === 'yaml-editor' || tab.type === 'extension')));
  return <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[var(--bg-canvas)] overflow-hidden">
    <div ref={headerRef} className="shrink-0 flex flex-col">
      <MainTabBar /><BreadcrumbBar onSelectContext={onSelectContext} />
    </div>
    <div className="flex-1 min-h-0 min-w-0 relative grid overflow-hidden" style={{ gridTemplateColumns: splitTab ? `minmax(0, ${splitRatio}fr) auto minmax(0, ${1 - splitRatio}fr)` : 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' }}>
      {!activeTab && <TabContent />}
      {mounted.map((tab) => {
        const split = tab.id === splitTab?.id;
        const visible = tab.id === activeTab?.id || split;
        // The resource table keeps its full width and scrolls under the floating
        // details panel; every other view is pushed to the left of the panel so
        // no control ends up hidden behind it.
        const underOverlay = tab.type === 'resource-list';
        return <div key={tab.id} role="tabpanel" id={`workspace-panel-${encodeURIComponent(tab.id)}`} aria-labelledby={`workspace-tab-${encodeURIComponent(tab.id)}`} hidden={!visible} data-testid="workspace-tab-panel" className={cx('min-h-0 min-w-0 flex-col overflow-hidden', !underOverlay && 'workspace-overlay-inset')} style={{ display: visible ? 'flex' : 'none', gridRow: 1, gridColumn: split ? 3 : 1 }}>
          {split && <div className="h-7 shrink-0 px-2.5 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] flex items-center gap-2 text-xs text-[var(--text-muted)]"><span className="truncate flex-1">{tab.title}</span><span className="shrink-0">Split View</span><IconButton icon={X} size="sm" aria-label="Close split view" tooltip="Close split view" onClick={() => { useWorkspaceStore.getState().setSplit(null); document.getElementById(`workspace-tab-${encodeURIComponent(activeTab.id)}`)?.focus(); }} /></div>}
          <ErrorBoundary key={tab.id}><TabContent tab={tab} visible={visible} /></ErrorBoundary>
        </div>;
      })}
      {splitTab && <div className="min-h-0 flex z-10 border-l border-[var(--border-default)]" style={{ gridRow: 1, gridColumn: 2 }}><Resizer orientation="vertical" onDelta={(d) => setSplitRatio((previous) => Math.min(0.8, Math.max(0.2, previous + d / (window.innerWidth * 0.6))))} /></div>}
    </div>
  </div>;
};

function TabContent({ tab, visible = true }: { tab?: WorkspaceTab; visible?: boolean }) {
  const { resources, updateItem, syncMode, watchStates, loadErrors } = useResourceStore();
  const selectedNamespace = useClusterStore((s) => s.selectedNamespace);
  const context = useClusterStore((s) => s.currentContext);
  const clusterLoading = useClusterStore(state => state.isLoading);
  const loadingKinds = useResourceStore(state => state.loadingKinds);
  const customKey = tab?.type === 'resource-list' ? tab.kind : tab?.kind ? resourceBucket({ kind: tab.kind, apiVersion: tab.apiVersion }) : '';
  const customDefinition = useMemo(() => [...resources.CustomResourceDefinition.values()].map(customResourceType).find(type => type?.key === customKey), [resources.CustomResourceDefinition, customKey]);
  const custom = useCustomResources(visible && tab?.type !== 'resource-list' && tab?.context === context ? customDefinition : undefined, tab?.namespace);

  if (!tab) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center select-none bg-[var(--bg-canvas)]">
        <img
          src="/brand/kubiki-mark-gray-dark.svg"
          alt=""
          aria-hidden="true"
          width={96}
          height={96}
          draggable={false}
          className="w-12 h-12 mb-3 shrink-0"
        />
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">No Open Tabs</h2>
        <p className="text-xs text-[var(--text-muted)] mt-1 max-w-sm">
          Select a resource from the sidebar to inspect your cluster, or use quick actions below.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-2 mt-4 max-w-md">
          <button
            type="button"
            onClick={() => useWorkspaceStore.getState().openOverview()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] text-xs font-medium text-[var(--text-primary)] transition-colors"
          >
            <LayoutDashboard size={13} className="text-[var(--accent)]" />
            Overview
          </button>
          <button
            type="button"
            onClick={() => useWorkspaceStore.getState().openResourceList('Pod')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] text-xs font-medium text-[var(--text-primary)] transition-colors"
          >
            <Boxes size={13} className="text-blue-400" />
            Pods
          </button>
          <button
            type="button"
            onClick={() => useWorkspaceStore.getState().openResourceList('Deployment')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] text-xs font-medium text-[var(--text-primary)] transition-colors"
          >
            <Layers size={13} className="text-cyan-400" />
            Deployments
          </button>
          <button
            type="button"
            onClick={() => useWorkspaceStore.getState().openResourceList('Service')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] text-xs font-medium text-[var(--text-primary)] transition-colors"
          >
            <Network size={13} className="text-emerald-400" />
            Services
          </button>
        </div>

        <div className="mt-5 text-[length:calc(10.5px*var(--ui-factor))] text-[var(--text-muted)] font-mono">
          Press <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">Ctrl+K</kbd> / <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">⌘K</kbd> for Command Palette
        </div>
      </div>
    );
  }

  if (tab.type === 'extension') {
    if (tab.context && tab.context !== context) return <p role="status" className="p-4 text-sm">Switch back to context {tab.context} to use this panel.</p>;
    return <RegisteredPanel tab={tab} visible={visible} />;
  }
  if (tab.type === 'overview') return <OverviewView />;
  if (tab.type === 'terminal-session' || tab.type === 'analysis') {
    if (!tab.session) return <div className="p-4 text-sm text-[var(--text-secondary)]">This terminal session has ended. Open a new terminal or analyze the resource again.</div>;
    if (tab.session.analysis) return <AnalysisView session={tab.session} visible={visible} />;
    if (tab.session.targetType !== 'local' && tab.session.context && tab.session.context !== context) return <p className="p-4 text-sm text-[var(--text-secondary)]">This terminal belongs to context {tab.session.context}. Switch back to that context to reconnect.</p>;
    return <TerminalSessionPane session={tab.session} visible={visible} onContainerChange={name => useWorkspaceStore.setState(state => ({ tabs: state.tabs.map(entry => entry.id === tab.id ? { ...entry, session: { ...entry.session!, container: name } } : entry) }))} />;
  }
  if (tab.type === 'flux-dashboard' || tab.type === 'argocd-dashboard') return <Suspense fallback={<ResourceLoading label="Loading dashboard…" />}><GitOpsDashboard family={tab.type === 'flux-dashboard' ? 'flux' : 'argocd'} /></Suspense>;
  if (tab.type === 'helm-releases' || tab.type === 'helm-repositories') return <Suspense fallback={<ResourceLoading label="Loading Helm…" />}><HelmView section={tab.type === 'helm-releases' ? 'releases' : 'repositories'} /></Suspense>;

  if (tab.type !== 'resource-list' && tab.context !== context) {
    return <div className="p-6 text-[var(--text-secondary)]">This tab belongs to context {tab.context || 'unknown'}. Switch back to that context to use it.</div>;
  }
  if (tab.kind && !tab.kind.startsWith('custom:') && !tab.apiVersion?.includes('/') && !RESOURCE_TYPES.some(type => type.kind === tab.kind) && tab.kind !== 'HelmRelease') return <div role="status" className="p-4 text-xs text-[var(--text-secondary)]">This resource type is no longer part of the resource catalog. Choose a resource from the explorer.</div>;
  if (tab.type === 'resource-list' && tab.kind && !tab.kind.startsWith('custom:') && !RESOURCE_TYPES.some(type => type.kind === tab.kind)) return <div role="status" className="p-4 text-xs text-[var(--text-secondary)]">This resource type is no longer part of the resource catalog. Choose a resource from the explorer.</div>;
  if (tab.type === 'topology' && !tab.uid) return <Suspense fallback={<ResourceLoading label="Loading topology…" />}><RegisteredPanel tab={tab} visible={visible} /></Suspense>;

  if (tab.type !== 'resource-list') {
    // A pinned UID must never silently bind to a recreated object with the same name.
    const kind = resourceBucket({ kind: tab.kind || 'Pod', apiVersion: tab.apiVersion });
    const candidate = tab.uid ? resources[kind]?.get(tab.uid)
      : tab.name ? Array.from(resources[kind]?.values() || []).find((item) => matchesResourceRef(item, { ...tab, kind, name: tab.name! })) : undefined;
    const loaded = candidate && matchesResourceRef(candidate, tab.resource ?? { ...tab, kind, name: tab.name ?? candidate.name }) ? candidate : undefined;
    // Live sessions own their pinned target: changing an inventory's namespace
    // must not unmount the pane and close its connection during a new snapshot.
    const item = loaded ?? (tab.item?.kind === 'HelmRelease' ? tab.item : tab.kind === 'HelmRelease' && tab.name && tab.namespace ? { kind: 'HelmRelease' as const, apiVersion: tab.apiVersion ?? 'helm.sh/v1', name: tab.name, namespace: tab.namespace, uid: tab.uid ?? tab.id, raw: { context: tab.context } } : undefined) ?? ((tab.type === 'terminal' || tab.type === 'logs') ? tab.item : undefined);

    if (!item && namespaceIsOutsideScope(tab.namespace, selectedNamespace, syncMode)) {
      return <div className="p-6"><h2 className="text-sm font-medium mb-3">Resource outside namespace scope</h2><NamespaceScopeNotice namespace={tab.namespace} /></div>;
    }
    if (!item && custom.loading) return <ResourceLoading label="Loading custom resource…" />;
    if (!item && loadErrors[kind]) {
      const error = loadErrors[kind];
      return <div className="p-6"><RequestErrorNotice error={error} onRetry={() => { if (customDefinition) { custom.refresh(); } else { void refreshResourceWatches(kind).catch(() => {}); } }} /></div>;
    }
    if (!item && !customDefinition && syncMode !== 'watch' && (loadingKinds[kind] ?? clusterLoading)) return <ResourceLoading label={`Loading ${kind}…`} />;
    if (!item && !customDefinition && syncMode === 'watch' && (watchStates[kind] || clusterLoading) && watchStates[kind]?.phase !== 'live') {
      const error = loadErrors[kind];
      return <div className="p-6">{error ? <RequestErrorNotice error={error} onRetry={() => { void refreshResourceWatches(kind).catch(() => {}); }} /> : <ResourceLoading label={`Loading ${kind}…`} description={`Waiting for a complete ${kind} snapshot…`} />}</div>;
    }
    if (!item) {
      return (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <div>
            <FileCode size="calc(36px * var(--ui-factor))" className="mx-auto text-[var(--text-muted)] mb-2" />
            <div className="text-sm font-medium text-[var(--text-primary)]">Resource Not Found</div>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              {tab.title} was deleted or is not currently available.
            </p>
          </div>
        </div>
      );
    }

    if (tab.type === 'resource-detail') return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {loadErrors[kind] && <div className="p-4 border-b border-[var(--border-subtle)]"><RequestErrorNotice error={loadErrors[kind]} onRetry={() => { if (customDefinition) { custom.refresh(); } else { void refreshResourceWatches(kind).catch(() => {}); } }} retainedData={true} /></div>}
        <ResourceDetails key={item.uid} item={item} onClose={() => useWorkspaceStore.getState().closeTab(tab.id)} onNavigate={(next) => useWorkspaceStore.getState().openResourceDetail(next)} />
      </div>
    );
    if (tab.type === 'topology') return <Suspense fallback={<ResourceLoading label="Loading topology…" />}><RegisteredPanel tab={tab} item={item} visible={visible} /></Suspense>;
    if (tab.type === 'logs' || tab.type === 'terminal') {
      const session = { context: tab.context, uid: item.uid, id: tab.id, type: tab.type, title: tab.title, resourceName: item.name, namespace: item.namespace,
        container: tab.container, allContainers: item.containers?.map((c) => c.name), targetType: item.kind === 'Node' ? 'node' as const : 'pod' as const };
      return tab.type === 'logs' ? <LogsSessionPane key={tab.id} session={session} visible={visible} onContainerChange={(name) => useWorkspaceStore.getState().setTabContainer(tab.id, name)} /> : <TerminalSessionPane key={tab.id} session={session} visible={visible} onContainerChange={(name) => useWorkspaceStore.getState().setTabContainer(tab.id, name)} />;
    }

    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {loadErrors[kind] && <div className="p-4 border-b border-[var(--border-subtle)]"><RequestErrorNotice error={loadErrors[kind]} onRetry={() => { if (customDefinition) { custom.refresh(); } else { void refreshResourceWatches(kind).catch(() => {}); } }} retainedData={true} /></div>}
        <Suspense
          fallback={
            <div className="h-full flex items-center justify-center gap-2 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">
              <Loader2 size="calc(14px * var(--ui-factor))" className="animate-spin" />
              Loading editor…
            </div>
          }
        >
          <YamlEditor
            item={item}
            onApply={async (yaml) => {
              try {
                if (k8s.demo) {
                  updateItem(item.kind, item.uid, { ...mapK8sResource(parse(yaml), item.kind), uid: item.uid });
                  toast.success('Manifest saved in demo memory', `${item.kind}/${item.name}`);
                } else {
                  const currentContext = useClusterStore.getState().currentContext;
                  if (!currentContext) {
                    toast.error('No active cluster context');
                    return;
                  }
                  const output = await k8s.applyManifest(currentContext, yaml, item);
                  toast.success(output || 'Manifest applied', `${item.kind}/${item.name}`);
                }
              } catch (err: any) {
                if (err?.code === 'cancelled') {
                  toast.info('Apply cancelled');
                } else {
                  toast.error('Apply failed', String(err?.message || err));
                }
                throw err;
              }
            }}
          />
        </Suspense>
      </div>
    );
  }

  // Default: Resource List Table
  if (tab.kind?.startsWith('custom:') && !customDefinition) return <p className="p-3 text-xs text-[var(--text-secondary)]">This custom resource definition is not loaded in the current cluster.</p>;
  return <ResourceView key={tab.id} explicitKind={tab.kind} customType={customDefinition} />;
}
