import React, { useState, lazy, Suspense } from 'react';
import { MainTabBar } from './MainTabBar';
import { BreadcrumbBar } from './BreadcrumbBar';
import { ResourceView } from '../../views/ResourceView';
import { useWorkspaceStore, type WorkspaceTab } from '../../state/workspace_store';
import { useResourceStore } from '../../state/resource_store';
import { ResourceDetails } from './InspectorPanel';
import { LogsSessionPane, TerminalSessionPane } from './BottomDock';
import { useClusterStore } from '../../state/cluster_store';
import { parse } from 'yaml';
import { mapK8sResource } from '../../core/utils/k8s_mapper';
import { k8s } from '../../providers/k8s_provider';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { Resizer } from './Resizer';
import { toast } from '../../state/notifications_store';
import { FileCode, Loader2 } from 'lucide-react';
import { NamespaceScopeNotice } from '../k8s/NamespaceScopeNotice';
import { RequestErrorNotice } from '../k8s/RequestErrorNotice';
import { refreshResourceWatches } from '../../state/resource_watch';
import { namespaceIsOutsideScope } from '../../core/resources/resource_types';
import { matchesResourceRef } from '../../core/resources/identity';

const TopologyView = lazy(() => import('../../views/TopologyView').then((m) => ({ default: m.TopologyView })));
const YamlEditor = lazy(() => import('../../views/YamlEditor').then((m) => ({ default: m.YamlEditor })));

export const WorkspaceArea: React.FC<{ onSelectContext: (context: string) => void }> = ({ onSelectContext }) => {
  const { tabs, activeTabId, splitTabId } = useWorkspaceStore();
  const [splitRatio, setSplitRatio] = useState(0.5); // 50% split by default

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const splitTab = splitTabId ? tabs.find((t) => t.id === splitTabId) : null;

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[var(--bg-canvas)] overflow-hidden">
      {/* Top JetBrains Tab Bar */}
      <MainTabBar />

      {/* JetBrains Interactive Breadcrumb Bar */}
      <BreadcrumbBar onSelectContext={onSelectContext} />

      {/* Main Content Area: Single Pane or Split Panes */}
      <div className="flex-1 min-h-0 min-w-0 relative flex overflow-hidden">
        {splitTab ? (
          <div className="flex-1 flex min-h-0 min-w-0">
            {/* Primary Left Pane */}
            <div
              style={{ flex: `${splitRatio} 1 0%` }}
              className="min-w-0 min-h-0 flex flex-col border-r border-[var(--border-default)]"
            >
              <ErrorBoundary key={activeTab?.id}><TabContent tab={activeTab} /></ErrorBoundary>
            </div>

            {/* Split Resizer */}
            <Resizer
              orientation="vertical"
              onDelta={(d) => {
                setSplitRatio((prev) => {
                  const deltaFrac = d / (window.innerWidth * 0.6);
                  return Math.min(0.8, Math.max(0.2, prev + deltaFrac));
                });
              }}
            />

            {/* Secondary Right Pane */}
            <div
              style={{ flex: `${1 - splitRatio} 1 0%` }}
              className="min-w-0 min-h-0 flex flex-col"
            >
              <div className="h-6 px-2.5 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] flex items-center justify-between text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] select-none">
                <span className="font-medium text-[var(--text-secondary)]">{splitTab.title}</span>
                <span className="text-[length:calc(10px*var(--ui-factor))] uppercase font-mono">Split View</span>
              </div>
              <ErrorBoundary key={splitTab.id}><TabContent tab={splitTab} /></ErrorBoundary>
            </div>
          </div>
        ) : (
          /* Single Full Pane */
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">
            <ErrorBoundary key={activeTab?.id}><TabContent tab={activeTab} /></ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
};

function TabContent({ tab }: { tab?: WorkspaceTab }) {
  const { resources, updateItem, syncMode, watchStates, loadErrors } = useResourceStore();
  const selectedNamespace = useClusterStore((s) => s.selectedNamespace);
  const context = useClusterStore((s) => s.currentContext);

  if (!tab) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
        No active tab
      </div>
    );
  }

  if (tab.type !== 'resource-list' && tab.context !== context) {
    return <div className="p-6 text-[var(--text-secondary)]">This tab belongs to context {tab.context || 'unknown'}. Switch back to that context to use it.</div>;
  }
  if (tab.type === 'topology' && !tab.uid) return <Suspense fallback={<div className="p-4">Loading topology…</div>}><TopologyView namespace={tab.namespace} /></Suspense>;

  if (tab.type !== 'resource-list') {
    // A pinned UID must never silently bind to a recreated object with the same name.
    const kind = tab.kind || 'Pod';
    const candidate = tab.uid ? resources[kind]?.get(tab.uid)
      : tab.name ? Array.from(resources[kind]?.values() || []).find((item) => matchesResourceRef(item, { ...tab, kind, name: tab.name! })) : undefined;
    const item = candidate && matchesResourceRef(candidate, tab.resource ?? { ...tab, kind, name: tab.name ?? candidate.name }) ? candidate : undefined;

    if (!item && namespaceIsOutsideScope(tab.namespace, selectedNamespace, syncMode)) {
      return <div className="p-6"><h2 className="text-sm font-medium mb-3">Resource outside namespace scope</h2><NamespaceScopeNotice namespace={tab.namespace} /></div>;
    }
    if (!item && syncMode === 'watch' && watchStates[kind]?.phase !== 'live') {
      const error = loadErrors[kind];
      return <div className="p-6">{error ? <RequestErrorNotice error={error} onRetry={() => { void refreshResourceWatches(kind).catch(() => {}); }} /> : <p role="status" className="text-xs text-[var(--text-secondary)]">Waiting for a complete {kind} snapshot…</p>}</div>;
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

    if (tab.type === 'resource-detail') return <ResourceDetails key={item.uid} item={item} onNavigate={(next) => useWorkspaceStore.getState().openResourceDetail(next)} />;
    if (tab.type === 'topology') return <Suspense fallback={<div className="p-4">Loading topology…</div>}><TopologyView item={item} namespace={tab.namespace} /></Suspense>;
    if (tab.type === 'logs' || tab.type === 'terminal') {
      const session = { id: tab.id, type: tab.type, title: tab.title, resourceName: item.name, namespace: item.namespace,
        container: tab.container ?? item.containers?.[0]?.name, allContainers: item.containers?.map((c) => c.name), targetType: item.kind === 'Node' ? 'node' as const : 'pod' as const };
      return tab.type === 'logs' ? <LogsSessionPane key={tab.id} session={session} /> : <TerminalSessionPane key={tab.id} session={session} />;
    }

    return (
      <div className="flex-1 min-h-0 min-w-0">
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
            onApply={(yaml) => {
              if (!k8s.demo) { toast.error('Live manifest apply is not connected yet'); return; }
              updateItem(item.kind, item.uid, { ...mapK8sResource(parse(yaml), item.kind), uid: item.uid });
              toast.success('Manifest saved in demo memory', `${item.kind}/${item.name}`);
            }}
          />
        </Suspense>
      </div>
    );
  }

  // Default: Resource List Table
  return <ResourceView key={tab.id} explicitKind={tab.kind} />;
}
