import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Lock,
  Search as SearchIcon,
  X,
  FolderMinus,
  FolderPlus,
  Columns2,
  ExternalLink,
  LayoutDashboard,
  Anchor,
} from 'lucide-react';
import { SIDEBAR_TREE, HELM_VIEWS, type KindEntry, type TreeGroup, type TreeCategory } from '../../core/perspectives';
import { useResourceStore } from '../../state/resource_store';
import { useClusterStore } from '../../state/cluster_store';
import { useUiStore } from '../../state/ui_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { FixedMenu, type MenuItem } from '../ui/Dropdown';
import { Tooltip, IconButton } from '../ui/Button';
import { cx } from '../../core/utils/cx';
import type { ResourceKind } from '../../types/k8s';

const key = (cat: string, group?: string) => (group ? `${cat}/${group}` : cat);

export const Sidebar: React.FC = () => {
  const { activeKind, setActiveKind, resources } = useResourceStore();
  const selectedNamespace = useClusterStore((s) => s.selectedNamespace);
  const groups = useUiStore((s) => s.sidebarGroups);
  const toggleGroup = useUiStore((s) => s.toggleGroup);
  const { openResourceList, toggleSplit, openOverview, openHelm, tabs, activeTabId } = useWorkspaceStore();
  const activeTab = tabs.find(tab => tab.id === activeTabId);
  const overviewActive = activeTab?.type === 'overview';
  const helmActive = activeTab?.type === 'helm-releases' || activeTab?.type === 'helm-repositories' || activeTab?.type === 'helm-release';

  const [filter, setFilter] = useState('');
  const [contextMenu, setContextMenu] = useState<{ kind: ResourceKind; x: number; y: number } | null>(null);

  const q = filter.trim().toLowerCase();
  const searching = q.length > 0;

  const matchKind = (e: KindEntry) => e.label.toLowerCase().includes(q);

  const filtered = useMemo(() => {
    if (!searching) return SIDEBAR_TREE;
    return SIDEBAR_TREE.map((cat) => {
      const hitCat = cat.label.toLowerCase().includes(q);
      return {
        ...cat,
        groups: cat.groups
          .map((g: TreeGroup) => ({
            ...g,
            kinds: g.kinds.filter((e: KindEntry) => matchKind(e) || hitCat || (g.label ?? '').toLowerCase().includes(q)),
            helmViews: g.helmViews?.filter(view => hitCat || HELM_VIEWS[view].toLowerCase().includes(q)),
          }))
          .filter((g: TreeGroup) => g.kinds.length > 0 || g.helmViews?.length || (g.placeholder && (g.placeholder.toLowerCase().includes(q) || hitCat)) || (g.label ?? '').toLowerCase().includes(q)),
      } satisfies TreeCategory;
    }).filter((cat) => cat.groups.length > 0 || cat.label.toLowerCase().includes(q));
  }, [q, searching]);

  const countFor = (kind: string) => {
    const map = resources[kind as keyof typeof resources];
    const total = map?.size ?? 0;
    if (selectedNamespace === 'all') return total;
    let ns = 0;
    map?.forEach((item) => {
      if (!item.namespace || item.namespace === selectedNamespace) ns++;
    });
    return ns;
  };

  const handleSelectKind = (kind: ResourceKind) => {
    setActiveKind(kind);
    openResourceList(kind);
  };

  const handleContextMenu = (e: React.MouseEvent, kind: ResourceKind) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ kind, x: e.clientX, y: e.clientY });
  };

  const contextMenuItems: MenuItem[] = contextMenu
    ? [
        {
          id: 'open-tab',
          label: `Open ${contextMenu.kind}s in New Tab`,
          icon: ExternalLink,
          onSelect: () => openResourceList(contextMenu.kind),
        },
        {
          id: 'open-split',
          label: `Open ${contextMenu.kind}s in Split Right`,
          icon: Columns2,
          onSelect: () => {
            openResourceList(contextMenu.kind);
            toggleSplit(`tab-list-${contextMenu.kind}`);
          },
        },
      ]
    : [];

  const expandAll = () => {
    SIDEBAR_TREE.forEach((cat) => {
      useUiStore.setState((s) => ({
        sidebarGroups: { ...s.sidebarGroups, [cat.id]: true },
      }));
      cat.groups.forEach((g) => {
        useUiStore.setState((s) => ({
          sidebarGroups: { ...s.sidebarGroups, [key(cat.id, g.id)]: true },
        }));
      });
    });
  };

  const collapseAll = () => {
    const newGroups: Record<string, boolean> = {};
    SIDEBAR_TREE.forEach((cat) => {
      newGroups[cat.id] = false;
      cat.groups.forEach((g) => {
        newGroups[key(cat.id, g.id)] = false;
      });
    });
    useUiStore.setState({ sidebarGroups: newGroups });
  };

  return (
    <nav className="h-full flex flex-col bg-[var(--bg-sidebar)] select-none overflow-hidden font-sans border-r border-[var(--border-default)]">
      {/* Header — JetBrains Tool Window Header */}
      <div className="h-9 px-2.5 flex items-center justify-between border-b border-[var(--border-subtle)] shrink-0 bg-[var(--bg-secondary)]/50">
        <span className="text-[length:calc(11.5px*var(--ui-factor))] font-semibold text-[var(--text-secondary)] tracking-wide uppercase">
          Cluster Explorer
        </span>
        <div className="flex items-center gap-0.5">
          <Tooltip label="Expand All" delay={400}>
            <IconButton icon={FolderPlus} size="sm" onClick={expandAll} aria-label="Expand All" />
          </Tooltip>
          <Tooltip label="Collapse All" delay={400}>
            <IconButton icon={FolderMinus} size="sm" onClick={collapseAll} aria-label="Collapse All" />
          </Tooltip>
        </div>
      </div>

      {/* Filter as you type */}
      <div className="px-2 py-1.5 shrink-0 border-b border-[var(--border-subtle)]/60">
        <div className="relative flex items-center">
          <SearchIcon size="calc(12px * var(--ui-factor))" className="absolute left-2 text-[var(--text-muted)] pointer-events-none" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
            placeholder="Filter tree (e.g. pods, cm)…"
            className="w-full h-[calc(24px*var(--ui-factor))] bg-[var(--bg-canvas)] text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] rounded-[calc(4px*var(--ui-factor))] border border-[var(--border-default)] hover:border-[var(--border-strong)] focus:border-[var(--accent)] outline-none transition-colors placeholder:text-[var(--text-muted)] pl-7 pr-6"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="absolute right-1 p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X size="calc(11px * var(--ui-factor))" />
            </button>
          )}
        </div>
      </div>

      {(!searching || 'overview'.includes(q)) && <button aria-label="Open Overview" aria-pressed={overviewActive} onClick={openOverview} className={cx('flex items-center gap-2 px-3 py-2 text-xs text-left shrink-0 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]', overviewActive ? 'text-[var(--accent)] bg-[var(--bg-hover)]' : 'text-[var(--text-secondary)]')}><LayoutDashboard size={14} />Overview</button>}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto kubiki-scrollbar py-1">
        {filtered.map((cat) => {
          const catOpen = searching || groups[cat.id] !== false;
          const CatIcon = cat.icon;
          const catCount = cat.groups.reduce((acc, g) => acc + g.kinds.reduce((a, e) => a + countFor(e.kind), 0), 0);

          return (
            <div key={cat.id} className="mb-0.5">
              {/* Category Level */}
              <button
                onClick={() => { if (!searching) toggleGroup(cat.id); }}
                className={cx(
                  'w-full flex items-center gap-1.5 px-2 h-[calc(24px*var(--ui-factor))] text-[length:calc(11.5px*var(--ui-factor))] font-medium transition-colors',
                  catOpen ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
                  'hover:bg-[var(--bg-hover)]'
                )}
              >
                {catOpen ? <ChevronDown size="calc(11px * var(--ui-factor))" className="opacity-60 shrink-0" /> : <ChevronRight size="calc(11px * var(--ui-factor))" className="opacity-60 shrink-0" />}
                <CatIcon size="calc(13px * var(--ui-factor))" strokeWidth={1.75} className="text-[var(--text-secondary)] shrink-0" />
                <span className="truncate text-left flex-1">{cat.label}</span>
                {catCount > 0 && (
                  <span className="text-[length:calc(10px*var(--ui-factor))] font-mono text-[var(--text-muted)] tabular-nums px-1 rounded bg-[var(--bg-canvas)]/50">
                    {catCount}
                  </span>
                )}
              </button>

              {catOpen && cat.groups.map((g) => {
                const gOpen = searching || groups[key(cat.id, g.id)] !== false;
                const gCount = g.kinds.reduce((a, e) => a + countFor(e.kind), 0);

                return (
                  <div key={g.id}>
                    {g.label && (
                      <button
                        onClick={() => { if (!searching) toggleGroup(key(cat.id, g.id)); }}
                        className="w-full flex items-center gap-1.5 pl-[calc(22px*var(--ui-factor))] pr-2 h-[calc(22px*var(--ui-factor))] text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        {gOpen
                          ? <ChevronDown size="calc(10px * var(--ui-factor))" className="opacity-50 shrink-0" />
                          : <ChevronRight size="calc(10px * var(--ui-factor))" className="opacity-50 shrink-0" />}
                        <span className="truncate text-left flex-1">{g.label}</span>
                        {!gOpen && gCount > 0 && (
                          <span className="text-[length:calc(10px*var(--ui-factor))] font-mono text-[var(--text-muted)] tabular-nums">{gCount}</span>
                        )}
                      </button>
                    )}

                    {gOpen && g.placeholder && (
                      <div className="flex items-center gap-1.5 pl-[calc(34px*var(--ui-factor))] pr-2 h-[calc(22px*var(--ui-factor))] text-[length:calc(11px*var(--ui-factor))] text-[var(--text-disabled)] italic cursor-default">
                        <Lock size="calc(10px * var(--ui-factor))" className="shrink-0" />
                        <span className="truncate">{g.placeholder}</span>
                      </div>
                    )}

                    {gOpen && (
                      <div className="py-0.5">
                        {g.kinds.map((entry) => {
                          const selected = !overviewActive && !helmActive && activeKind === entry.kind;
                          const total = countFor(entry.kind);
                          const Icon = entry.icon;

                          return (
                            <button
                              key={entry.kind}
                              onClick={() => handleSelectKind(entry.kind)}
                              onContextMenu={(e) => handleContextMenu(e, entry.kind)}
                              className={cx(
                                'group relative w-full flex items-center gap-2 h-[calc(24px*var(--ui-factor))] pl-[calc(32px*var(--ui-factor))] pr-2 text-[length:calc(11.5px*var(--ui-factor))] transition-colors',
                                selected
                                  ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium shadow-2xs'
                                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                              )}
                            >
                              {selected && (
                                <span className="absolute left-0 top-1 bottom-1 w-[calc(2px*var(--ui-factor))] bg-[var(--accent)] rounded-r" />
                              )}
                              <Icon size="calc(13px * var(--ui-factor))" strokeWidth={1.75} className={cx('shrink-0', entry.hue)} />
                              <span className="truncate flex-1 text-left">{entry.label}</span>
                              {total > 0 && (
                                <span className={cx(
                                  'text-[length:calc(10px*var(--ui-factor))] font-mono tabular-nums px-1 rounded',
                                  selected ? 'bg-[var(--bg-canvas)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                                )}>
                                  {total}
                                </span>
                              )}
                            </button>
                          );
                        })}
                        {g.helmViews?.map(section => <button key={section} aria-label={`Open Helm ${HELM_VIEWS[section]}`} aria-current={activeTab?.type === `helm-${section}` ? 'page' : undefined} onClick={() => openHelm(section)} className={cx('relative w-full flex items-center gap-2 pl-[calc(34px*var(--ui-factor))] pr-2 py-1 text-xs hover:bg-[var(--bg-hover)]', activeTab?.type === `helm-${section}` ? 'text-[var(--accent)] bg-[var(--bg-hover)]' : 'text-[var(--text-secondary)]')}><Anchor size={14} aria-hidden="true" /><span>{HELM_VIEWS[section]}</span></button>)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="px-3 py-8 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] text-center">
            No matching resources found for “{filter}”
          </div>
        )}
      </div>

      {/* Context Menu for Tree Item */}
      {contextMenu && (
        <FixedMenu
          rect={{ x: contextMenu.x, y: contextMenu.y }}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </nav>
  );
};
