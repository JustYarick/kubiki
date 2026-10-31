import { namespaceScopeLabel } from '../../core/resources/namespace_scope';
import React from 'react';
import { ChevronRight, Server, Layers, Box, FileCode, Terminal as TermIcon, FileText, LayoutDashboard } from 'lucide-react';
import { useClusterStore } from '../../state/cluster_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { useResourceStore } from '../../state/resource_store';
import { Popover, MenuList, type MenuItem } from '../ui/Dropdown';
import { CATEGORY_ICONS, resourceIcon } from '../../core/resource_icons';

export const BreadcrumbBar: React.FC<{ onSelectContext: (context: string) => void }> = ({ onSelectContext }) => {
  const { currentContext, contexts, selectedNamespace } = useClusterStore();
  const { tabs, activeTabId } = useWorkspaceStore();
  const selectedItem = useResourceStore((s) => s.selectedItem);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const ctxItems: MenuItem[] = contexts.map((c) => ({
    id: c.name,
    label: c.name,
    icon: Server,
    checked: c.name === currentContext,
    onSelect: () => onSelectContext(c.name),
  }));

  const KindIcon = activeTab?.kind ? resourceIcon(activeTab.kind, activeTab.apiVersion) : Box;
  const DashboardIcon = activeTab?.type === 'flux-dashboard' ? CATEGORY_ICONS.flux : activeTab?.type === 'argocd-dashboard' ? CATEGORY_ICONS.argocd : LayoutDashboard;

  return (
    <div className="h-6 bg-[var(--bg-secondary)]/70 border-b border-[var(--border-subtle)] flex items-center px-3 gap-1 text-[length:calc(11px*var(--ui-factor))] select-none text-[var(--text-secondary)] shrink-0 font-sans overflow-hidden whitespace-nowrap">
      {/* Cluster */}
      <Popover
        width={220}
        trigger={({ open }) => (
          <button
            className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors ${open ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]' : ''}`}
            title="Cluster Context"
          >
            <Server size="calc(11px * var(--ui-factor))" className="text-[var(--status-ok)]" />
            <span className="font-mono font-medium">{currentContext || 'cluster'}</span>
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="px-2.5 py-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Cluster Contexts
            </div>
            <MenuList items={ctxItems} onSelect={(item) => { item.onSelect?.(); close(); }} />
          </>
        )}
      </Popover>

      <ChevronRight size="calc(11px * var(--ui-factor))" className="text-[var(--text-muted)] opacity-60 shrink-0" />

      {/* Namespace */}
      <span className="flex items-center gap-1 px-1.5 min-w-0"><Layers size="calc(11px * var(--ui-factor))" className="text-violet-400 shrink-0" /><span className="truncate">{namespaceScopeLabel(selectedNamespace)}</span></span>

      {activeTab && (
        <>
          <ChevronRight size="calc(11px * var(--ui-factor))" className="text-[var(--text-muted)] opacity-60 shrink-0" />

          {/* Kind or Category */}
          <div className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[var(--text-primary)] font-medium">
            {activeTab.type === 'overview' && <LayoutDashboard size={11} className="text-[var(--accent)]" />}
            {activeTab.type.endsWith('-dashboard') && <DashboardIcon aria-hidden="true" size="calc(11px * var(--ui-factor))" strokeWidth={1.75} className="text-[var(--accent)]" />}
            {activeTab.type === 'yaml-editor' && <FileCode size="calc(11px * var(--ui-factor))" className="text-amber-400" />}
            {activeTab.type === 'terminal' && <TermIcon size="calc(11px * var(--ui-factor))" className="text-emerald-400" />}
            {activeTab.type === 'logs' && <FileText size="calc(11px * var(--ui-factor))" className="text-blue-400" />}
            {activeTab.type === 'resource-list' && <KindIcon size="calc(11px * var(--ui-factor))" className="text-blue-400" />}
            {activeTab.type === 'resource-detail' && <KindIcon size="calc(11px * var(--ui-factor))" className="text-purple-400" />}
            <span>{activeTab.type === 'topology' ? 'Topology' : activeTab.type === 'resource-list' ? activeTab.title : activeTab.kind ? activeTab.kind : activeTab.title}</span>
          </div>
        </>
      )}

      {/* Resource Name if selected or viewing detail/yaml */}
      {activeTab?.type !== 'extension' && activeTab?.type !== 'overview' && activeTab?.type !== 'terminal-session' && !activeTab?.type.endsWith('-dashboard') && activeTab?.type !== 'helm-releases' && activeTab?.type !== 'helm-repositories' && (activeTab?.name || selectedItem?.name) && (
        <>
          <ChevronRight size="calc(11px * var(--ui-factor))" className="text-[var(--text-muted)] opacity-60 shrink-0" />
          <span className="font-mono text-[var(--text-primary)] min-w-0 truncate px-1 py-0.5 rounded bg-[var(--bg-surface)]/40 font-medium">
            {activeTab?.name || selectedItem?.name}
          </span>
        </>
      )}

      <div className="flex-1 min-w-0" />

      {/* Active Tab metadata */}
      {activeTab?.subtitle && (
        <span className="hidden xl:inline text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono truncate">
          {activeTab.subtitle}
        </span>
      )}
    </div>
  );
};
