import React from 'react';
import { ChevronRight, Server, Layers, Box, FileCode, Terminal as TermIcon, FileText } from 'lucide-react';
import { useClusterStore } from '../../state/cluster_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { useResourceStore } from '../../state/resource_store';
import { Popover, MenuList, type MenuItem } from '../ui/Dropdown';
import { KIND_ICONS } from '../../core/perspectives';

export const BreadcrumbBar: React.FC = () => {
  const { currentContext, contexts, selectedNamespace, selectNamespace, availableNamespaces } = useClusterStore();
  const { tabs, activeTabId } = useWorkspaceStore();
  const selectedItem = useResourceStore((s) => s.selectedItem);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const ctxItems: MenuItem[] = contexts.map((c) => ({
    id: c.name,
    label: c.name,
    icon: Server,
    checked: c.name === currentContext,
    onSelect: () => useClusterStore.getState().selectContext(c.name),
  }));

  const nsItems: MenuItem[] = [
    { id: 'all', label: 'All Namespaces', checked: selectedNamespace === 'all', onSelect: () => selectNamespace('all') },
    ...availableNamespaces.map((ns) => ({
      id: ns,
      label: ns,
      checked: selectedNamespace === ns,
      onSelect: () => selectNamespace(ns),
    })),
  ];

  const KindIcon = activeTab?.kind ? KIND_ICONS[activeTab.kind] || Box : Box;

  return (
    <div className="h-6 bg-[var(--bg-secondary)]/70 border-b border-[var(--border-subtle)] flex items-center px-3 gap-1 text-[11px] select-none text-[var(--text-secondary)] shrink-0 font-sans">
      {/* Cluster */}
      <Popover
        width={220}
        trigger={({ open }) => (
          <button
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors ${open ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]' : ''}`}
            title="Cluster Context"
          >
            <Server size={11} className="text-[var(--status-ok)]" />
            <span className="font-mono font-medium">{currentContext || 'cluster'}</span>
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Cluster Contexts
            </div>
            <MenuList items={ctxItems} onSelect={(item) => { item.onSelect?.(); close(); }} />
          </>
        )}
      </Popover>

      <ChevronRight size={11} className="text-[var(--text-muted)] opacity-60" />

      {/* Namespace */}
      <Popover
        width={200}
        trigger={({ open }) => (
          <button
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors ${open ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]' : ''}`}
            title="Namespace"
          >
            <Layers size={11} className="text-violet-400" />
            <span>{selectedNamespace === 'all' ? 'all-namespaces' : selectedNamespace}</span>
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Namespaces
            </div>
            <MenuList items={nsItems} onSelect={(item) => { item.onSelect?.(); close(); }} />
          </>
        )}
      </Popover>

      {activeTab && (
        <>
          <ChevronRight size={11} className="text-[var(--text-muted)] opacity-60" />

          {/* Kind or Category */}
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[var(--text-primary)] font-medium">
            {activeTab.type === 'yaml-editor' && <FileCode size={11} className="text-amber-400" />}
            {activeTab.type === 'terminal' && <TermIcon size={11} className="text-emerald-400" />}
            {activeTab.type === 'logs' && <FileText size={11} className="text-blue-400" />}
            {activeTab.type === 'resource-list' && <KindIcon size={11} className="text-blue-400" />}
            {activeTab.type === 'resource-detail' && <KindIcon size={11} className="text-purple-400" />}
            <span>{activeTab.kind ? `${activeTab.kind}s` : activeTab.title}</span>
          </div>
        </>
      )}

      {/* Resource Name if selected or viewing detail/yaml */}
      {(activeTab?.name || selectedItem?.name) && (
        <>
          <ChevronRight size={11} className="text-[var(--text-muted)] opacity-60" />
          <span className="font-mono text-[var(--text-primary)] px-1 py-0.5 rounded bg-[var(--bg-surface)]/40 font-medium">
            {activeTab?.name || selectedItem?.name}
          </span>
        </>
      )}

      <div className="flex-1" />

      {/* Active Tab metadata */}
      {activeTab?.subtitle && (
        <span className="text-[10px] text-[var(--text-muted)] font-mono">
          {activeTab.subtitle}
        </span>
      )}
    </div>
  );
};
