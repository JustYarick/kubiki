import { shortcutLabel } from '../../core/shortcuts';
import React, { useRef, useState } from 'react';
import {
  X,
  Pin,
  Plus,
  FileCode,
  Terminal as TermIcon,
  FileText,
  Boxes,
  Columns2,
  LayoutDashboard,
  Anchor,
} from 'lucide-react';
import { useWorkspaceStore, type WorkspaceTab } from '../../state/workspace_store';
import { useResourceStore } from '../../state/resource_store';
import { KIND_ICONS, kindTone } from '../../core/perspectives';
import { FixedMenu, Popover, type MenuItem } from '../ui/Dropdown';
import { Tooltip, IconButton } from '../ui/Button';
import { cx } from '../../core/utils/cx';
import type { ResourceKind } from '../../types/k8s';

export const MainTabBar: React.FC = () => {
  const {
    tabs,
    activeTabId,
    setActiveTab,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    closeAllTabs,
    togglePinTab,
    splitTabId,
    toggleSplit,
    openResourceList,
  } = useWorkspaceStore();

  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const setActiveKind = useResourceStore((s) => s.setActiveKind);

  const [contextMenu, setContextMenu] = useState<{
    tab: WorkspaceTab;
    x: number;
    y: number;
  } | null>(null);

  const handleTabClick = (tab: WorkspaceTab) => {
    setActiveTab(tab.id);
    if (tab.type === 'resource-list' && tab.kind) {
      setActiveKind(tab.kind);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, tab: WorkspaceTab) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ tab, x: e.clientX, y: e.clientY });
  };

  const handleAuxClick = (e: React.MouseEvent, tab: WorkspaceTab) => {
    if (e.button === 1) {
      // Middle click to close tab
      e.preventDefault();
      closeTab(tab.id);
    }
  };

  const getTabIcon = (tab: WorkspaceTab) => {
    if (tab.type === 'helm-releases' || tab.type === 'helm-repositories' || tab.kind === 'HelmRelease') return <Anchor size={13} className="text-[var(--accent)] shrink-0" />;
    if (tab.type === 'overview') return <LayoutDashboard size="calc(13px * var(--ui-factor))" className="text-[var(--accent)] shrink-0" />;
    if (tab.type === 'yaml-editor') return <FileCode size="calc(13px * var(--ui-factor))" className="text-amber-400 shrink-0" />;
    if (tab.type === 'terminal') return <TermIcon size="calc(13px * var(--ui-factor))" className="text-emerald-400 shrink-0" />;
    if (tab.type === 'logs') return <FileText size="calc(13px * var(--ui-factor))" className="text-blue-400 shrink-0" />;
    if (tab.kind && KIND_ICONS[tab.kind]) {
      const Icon = KIND_ICONS[tab.kind];
      return <Icon size="calc(13px * var(--ui-factor))" className="shrink-0" style={{ color: kindTone(tab.kind).color }} />;
    }
    return <Boxes size="calc(13px * var(--ui-factor))" className="text-[var(--text-muted)] shrink-0" />;
  };

  const contextMenuItems: MenuItem[] = contextMenu
    ? [
        {
          id: 'close',
          label: 'Close Tab',
          kbd: '⌘W',
          onSelect: () => closeTab(contextMenu.tab.id),
        },
        {
          id: 'close-others',
          label: 'Close Other Tabs',
          onSelect: () => closeOtherTabs(contextMenu.tab.id),
        },
        {
          id: 'close-right',
          label: 'Close Tabs to the Right',
          onSelect: () => closeTabsToRight(contextMenu.tab.id),
        },
        {
          id: 'close-all',
          label: 'Close All Tabs',
          onSelect: () => closeAllTabs(),
        },
        { id: 'sep1', label: '', separator: true, onSelect: () => {} },
        {
          id: 'pin',
          label: contextMenu.tab.pinned ? 'Unpin Tab' : 'Pin Tab',
          icon: Pin,
          onSelect: () => togglePinTab(contextMenu.tab.id),
        },
        {
          id: 'split',
          label: splitTabId === contextMenu.tab.id ? 'Close Split' : 'Split Right',
          icon: Columns2,
          onSelect: () => toggleSplit(contextMenu.tab.id),
        },
      ]
    : [];

  const newTabKinds: Array<{ kind: ResourceKind; group: string }> = [
    { kind: 'Pod', group: 'Workloads' },
    { kind: 'Deployment', group: 'Workloads' },
    { kind: 'StatefulSet', group: 'Workloads' },
    { kind: 'DaemonSet', group: 'Workloads' },
    { kind: 'Service', group: 'Network' },
    { kind: 'Ingress', group: 'Network' },
    { kind: 'ConfigMap', group: 'Config' },
    { kind: 'Secret', group: 'Config' },
    { kind: 'PersistentVolumeClaim', group: 'Storage' },
    { kind: 'Node', group: 'Cluster' },
  ];

  return (
    <div className="h-[calc(34px*var(--ui-factor))] bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-stretch select-none shrink-0 overflow-hidden relative">
      {/* Scrollable Tabs */}
      <div role="tablist" aria-label="Workspace tabs" className="flex-1 flex items-stretch overflow-x-auto overflow-y-hidden kubiki-scrollbar min-w-0">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isSplitActive = tab.id === splitTabId;

          return (
            <div
              key={tab.id}
              ref={(node) => { if (node) tabRefs.current.set(tab.id, node); else tabRefs.current.delete(tab.id); }}
              role="tab" aria-selected={isActive} tabIndex={isActive ? 0 : -1}
              id={`workspace-tab-${encodeURIComponent(tab.id)}`}
              aria-controls={`workspace-panel-${encodeURIComponent(tab.id)}`}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                const index = tabs.findIndex((candidate) => candidate.id === tab.id);
                const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1]
                  : event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length]
                  : event.key === 'ArrowLeft' ? tabs[(index - 1 + tabs.length) % tabs.length] : undefined;
                if (next) { event.preventDefault(); handleTabClick(next); tabRefs.current.get(next.id)?.focus(); }
                else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleTabClick(tab); }
                else if (event.key === 'Delete') { event.preventDefault(); const adjacent = tabs[index + 1] ?? tabs[index - 1]; closeTab(tab.id); if (adjacent) tabRefs.current.get(adjacent.id)?.focus(); }
              }}
              onClick={() => handleTabClick(tab)}
              onContextMenu={(e) => handleContextMenu(e, tab)}
              onAuxClick={(e) => handleAuxClick(e, tab)}
              className={cx(
                'group relative flex items-center gap-1.5 px-3 min-w-[calc(120px*var(--ui-factor))] max-w-[calc(220px*var(--ui-factor))] h-full border-r border-[var(--border-default)] cursor-pointer transition-colors',
                isActive
                  ? 'bg-[var(--bg-canvas)] text-[var(--text-primary)] font-medium'
                  : isSplitActive
                  ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]'
                  : 'bg-[var(--bg-inactive-tab)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              )}
              title={`${tab.title}${tab.subtitle ? ` (${tab.subtitle})` : ''}`}
            >
              {/* Active Tab bottom accent line */}
              {isActive && (
                <div className="absolute bottom-0 left-0 right-0 h-[calc(2px*var(--ui-factor))] bg-[var(--accent)]" />
              )}

              {/* Pin indicator */}
              {tab.pinned && (
                <Pin size="calc(10px * var(--ui-factor))" className="text-[var(--accent)] rotate-45 shrink-0" />
              )}

              {/* Icon */}
              {getTabIcon(tab)}

              {/* Title & Dirty indicator */}
              <span className="truncate text-[length:calc(11.5px*var(--ui-factor))] flex-1 text-left">
                {tab.title}
              </span>

              {tab.dirty && (
                <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
              )}

              {/* Close Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className={cx(
                  'p-0.5 rounded focus-visible:opacity-100 hover:bg-[var(--bg-elevated)] hover:text-white transition-opacity',
                  isActive ? 'opacity-70 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-70'
                )}
                title={shortcutLabel("Close Tab (⌘W)")}
                aria-label="Close tab"
              >
                <X size="calc(12px * var(--ui-factor))" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Right Tab Controls: New Tab (+), Split Pane, Overflow list */}
      <div className="flex items-center px-1.5 gap-0.5 bg-[var(--bg-secondary)] border-l border-[var(--border-default)] shrink-0">
        {/* Split Editor Toggle */}
        <Tooltip label={splitTabId ? 'Close Split View' : 'Split View Right'} delay={300}>
          <IconButton
            icon={Columns2}
            size="sm"
            active={!!splitTabId}
            onClick={() => toggleSplit()}
            aria-label="Split Editor"
          />
        </Tooltip>

        {/* New Tab Menu */}
        <Popover
          width={220}
          trigger={({ open }) => (
            <IconButton
              icon={Plus}
              size="sm"
              active={open}
              tooltip="New Tab"
              aria-label="New Tab"
            />
          )}
        >
          {(close) => (
            <div className="py-1">
              <button className="w-full flex items-center gap-2 px-2.5 py-2 text-xs text-left hover:bg-[var(--bg-hover)]" onClick={() => { useWorkspaceStore.getState().openOverview(); close(); }}><LayoutDashboard size={14} />Overview</button>
              <div className="px-2.5 py-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Open Resource Table
              </div>
              {newTabKinds.map(({ kind, group }) => {
                const Icon = KIND_ICONS[kind] || Boxes;
                return (
                  <button
                    key={kind}
                    onClick={() => {
                      openResourceList(kind);
                      close();
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1 text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    <Icon size="calc(12px * var(--ui-factor))" className="text-blue-400 shrink-0" />
                    <span className="flex-1 text-left">{kind}s</span>
                    <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono">{group}</span>
                  </button>
                );
              })}
            </div>
          )}
        </Popover>
      </div>

      {/* Tab Context Menu */}
      {contextMenu && (
        <FixedMenu
          rect={{ x: contextMenu.x, y: contextMenu.y }}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
