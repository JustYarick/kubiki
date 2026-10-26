import { gitOpsFamily, gitOpsGroup } from '../../core/resources/gitops';
import { customResourcePlacement, customResourceType } from '../../core/resources/custom_resource_types';
import { resourceIcon } from '../../core/resource_icons';
import { inNamespaceScope } from '../../core/resources/namespace_scope';
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
import { SIDEBAR_TREE, HELM_VIEWS, assignCategoryTones, type KindEntry, type TreeGroup, type TreeCategory } from '../../core/perspectives';
import { useResourceStore } from '../../state/resource_store';
import { useClusterStore } from '../../state/cluster_store';
import { useUiStore } from '../../state/ui_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { FixedMenu, type MenuItem } from '../ui/Dropdown';
import { Tooltip, IconButton } from '../ui/Button';
import { cx } from '../../core/utils/cx';
import { groupTone } from '../../core/palette';
import type { ResourceKind } from '../../types/k8s';

const key = (cat: string, group?: string) => (group ? `${cat}/${group}` : cat);

export const Sidebar: React.FC = () => {
  const { activeKind, setActiveKind, resources } = useResourceStore();
  const selectedNamespace = useClusterStore((s) => s.selectedNamespace);
  const availableKinds = useClusterStore(state => state.availableResourceKinds);
  const groups = useUiStore((s) => s.sidebarGroups);
  const toggleGroup = useUiStore((s) => s.toggleGroup);
  const { openResourceList, toggleSplit, openOverview, openHelm, openGitOpsDashboard, tabs, activeTabId } = useWorkspaceStore();
  const activeTab = tabs.find(tab => tab.id === activeTabId);
  const overviewActive = activeTab?.type === 'overview';
  const dashboardActive = activeTab?.type.endsWith('-dashboard');
  const helmActive = activeTab?.type === 'helm-releases' || activeTab?.type === 'helm-repositories' || activeTab?.kind === 'HelmRelease' && !activeTab?.resource?.group?.endsWith('.toolkit.fluxcd.io');

  const [filter, setFilter] = useState('');
  const [contextMenu, setContextMenu] = useState<{ kind: ResourceKind; x: number; y: number } | null>(null);

  const q = filter.trim().toLowerCase();
  const searching = q.length > 0;

  const tree = useMemo<TreeCategory[]>(() => {
    const definitions = [...resources.CustomResourceDefinition.values()].map(customResourceType).filter(type => !!type);
    const byGroup = new Map<string, KindEntry[]>();
    const featured: Record<'config' | 'gateway', KindEntry[]> = { config: [], gateway: [] };
    const gitops = { flux: new Map<string, KindEntry[]>(), argocd: new Map<string, KindEntry[]>() };
    for (const type of definitions.sort((a, b) => a.kind.localeCompare(b.kind))) {
      const keywords = [
        type.name,
        type.group,
        type.plural,
        type.singular,
        ...(type.shortNames ?? []),
      ].filter(Boolean).join(' ');

      const placement = customResourcePlacement(type);
      if (placement) {
        featured[placement.category].push({
          kind: type.key,
          label: placement.label,
          icon: resourceIcon(type.kind, type.group),
          group: placement.category,
          tone: groupTone(placement.category),
          apiGroup: type.group,
          nativeKind: type.kind,
          keywords,
        });
      }
      const family = gitOpsFamily(type);
      if (family) {
        const group = family === 'argocd' ? '' : gitOpsGroup(type);
        if (!gitops[family].has(group)) gitops[family].set(group, []);
        gitops[family].get(group)!.push({
          kind: type.key,
          label: type.kind,
          icon: resourceIcon(type.kind, type.group),
          group: family,
          tone: groupTone(family),
          apiGroup: type.group,
          nativeKind: type.kind,
          keywords,
        });
      }

      // Parity with Lens: ALL CRDs are listed under Custom Resources by API group
      if (!byGroup.has(type.group)) byGroup.set(type.group, []);
      byGroup.get(type.group)!.push({
        kind: type.key,
        label: type.kind,
        icon: resourceIcon(type.kind, type.group),
        group: 'crd',
        tone: groupTone('crd'),
        apiGroup: type.group,
        nativeKind: type.kind,
        keywords,
      });
    }
    const tree = SIDEBAR_TREE.map(category => {
      if (category.id === 'flux' || category.id === 'argocd') return { ...category, groups: [...gitops[category.id]].map(([group, kinds]) => ({ id: group || category.id, label: group || undefined, kinds })) };
      if (category.id === 'gateway') return { ...category, groups: [{ id: 'gateway', kinds: featured.gateway }] };
      if (category.id === 'config') return { ...category, groups: category.groups.map(group => ({ ...group, kinds: [...group.kinds.slice(0, 5), ...featured.config, ...group.kinds.slice(5)] })) };
      if (category.id === 'crd') return { ...category, groups: [...category.groups, ...[...byGroup].sort(([a], [b]) => a.localeCompare(b)).map(([group, kinds]) => ({ id: `custom-${group}`, label: group, kinds }))] };
      return category;
    }).map(category => ({ ...category, groups: category.groups.map(group => ({ ...group, kinds: group.kinds.filter(entry => !availableKinds || entry.kind.startsWith('custom:') || availableKinds.includes(entry.kind)) })) })).filter(category => category.id === 'flux' || category.id === 'argocd' || category.groups.some(group => group.kinds.length || (group as TreeGroup).helmViews?.length));
    // Shades are resolved after the dynamic kinds are in place, so every view shows the same color.
    assignCategoryTones(tree);
    return tree;
  }, [resources.CustomResourceDefinition, availableKinds]);

  const matchKind = (e: KindEntry) => {
    const label = e.label.toLowerCase();
    const kind = e.kind.toLowerCase();
    const keywords = (e.keywords ?? '').toLowerCase();
    const acronym = e.kind.replace(/[^A-Z]/g, '').toLowerCase();
    return (
      label.includes(q) ||
      (label + 's').includes(q) ||
      (label.endsWith('s') && label.slice(0, -1).includes(q)) ||
      kind.includes(q) ||
      keywords.includes(q) ||
      acronym.includes(q)
    );
  };

  const filtered = useMemo(() => {
    if (!searching) return tree;
    return tree.map((cat) => {
      const hitCat = cat.label.toLowerCase().includes(q) || cat.label.toLowerCase().replace(/\s/g, '').includes(q.replace(/\s/g, ''));
      return {
        ...cat,
        groups: cat.groups
          .map((g: TreeGroup) => {
            const hitGroup = (g.label ?? '').toLowerCase().includes(q) || g.id.toLowerCase().includes(q);
            return {
              ...g,
              kinds: g.kinds.filter((e: KindEntry) => matchKind(e) || hitCat || hitGroup),
              helmViews: g.helmViews?.filter(view => hitCat || hitGroup || HELM_VIEWS[view].toLowerCase().includes(q)),
            };
          })
          .filter((g: TreeGroup) => g.kinds.length > 0 || g.helmViews?.length || (g.placeholder && (g.placeholder.toLowerCase().includes(q) || hitCat)) || (g.label ?? '').toLowerCase().includes(q) || g.id.toLowerCase().includes(q)),
      } satisfies TreeCategory;
    }).filter((cat) => cat.groups.length > 0 || cat.label.toLowerCase().includes(q));
  }, [q, searching, tree]);

  const countsByKind = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [kind, map] of Object.entries(resources)) {
      if (!map) continue;
      if (selectedNamespace === 'all') {
        counts.set(kind, map.size);
      } else {
        let ns = 0;
        for (const item of map.values()) {
          if (inNamespaceScope(selectedNamespace, item.namespace)) ns++;
        }
        counts.set(kind, ns);
      }
    }
    return counts;
  }, [resources, selectedNamespace]);

  const countFor = (kind: string) => countsByKind.get(kind) ?? 0;

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

  const expandAll = () => useUiStore.setState({ sidebarGroups: { '*': true } });
  const collapseAll = () => useUiStore.setState({ sidebarGroups: {} });

  return (
    <nav className="h-full flex flex-col bg-[var(--bg-sidebar)] select-none overflow-hidden font-sans border-r border-[var(--border-default)]">
      {/* Header — JetBrains Tool Window Header */}
      <div className="h-9 px-2.5 min-w-0 gap-1 flex items-center justify-between border-b border-[var(--border-subtle)] shrink-0 bg-[var(--bg-secondary)]/50">
        <span className="min-w-0 flex-1 truncate text-[length:calc(11.5px*var(--ui-factor))] font-semibold text-[var(--text-secondary)] tracking-wide uppercase">
          Cluster Explorer
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
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
          const catOpen = searching || (groups[cat.id] ?? groups['*']) === true;
          const CatIcon = cat.icon;
          const catCount = cat.groups.reduce((acc, g) => acc + g.kinds.reduce((a, e) => a + countFor(e.kind), 0), 0);

          if (cat.directKind) {
            const kind = cat.directKind;
            const selected = activeTab?.type === 'resource-list' && activeTab.kind === kind;
            return <button key={cat.id} aria-current={selected ? 'page' : undefined} onClick={() => handleSelectKind(kind)} onContextMenu={event => handleContextMenu(event, kind)}
              className={cx('w-full flex items-center gap-2 pl-[calc(22px*var(--ui-factor))] pr-2 h-[calc(26px*var(--ui-factor))] text-[length:calc(11.5px*var(--ui-factor))] text-left hover:bg-[var(--bg-hover)]', selected ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>
              <CatIcon size="calc(13px * var(--ui-factor))" className="shrink-0" /><span className="flex-1 truncate">{cat.label}</span>{catCount > 0 && <span className="text-[length:calc(10px*var(--ui-factor))] font-mono text-[var(--text-muted)]">{catCount}</span>}
            </button>;
          }
          return (
            <div key={cat.id} className="mb-0.5">
              {/* Category Level */}
              <button
                aria-expanded={catOpen} aria-controls={`sidebar-category-${cat.id}`}
                onClick={() => { if (!searching) toggleGroup(cat.id); }}
                className={cx(
                  'w-full flex items-center gap-1.5 px-2 h-[calc(24px*var(--ui-factor))] text-[length:calc(11.5px*var(--ui-factor))] font-medium transition-colors',
                  catOpen ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
                  'hover:bg-[var(--bg-hover)]'
                )}
              >
                {catOpen ? <ChevronDown size="calc(11px * var(--ui-factor))" className="opacity-60 shrink-0" /> : <ChevronRight size="calc(11px * var(--ui-factor))" className="opacity-60 shrink-0" />}
                <CatIcon aria-hidden="true" size="calc(13px * var(--ui-factor))" strokeWidth={1.75} className="text-[var(--text-secondary)] shrink-0" />
                <span className="truncate text-left flex-1">{cat.label}</span>
                {catCount > 0 && (
                  <span className="text-[length:calc(10px*var(--ui-factor))] font-mono text-[var(--text-muted)] tabular-nums px-1 rounded bg-[var(--bg-canvas)]/50">
                    {catCount}
                  </span>
                )}
              </button>

              <div id={`sidebar-category-${cat.id}`}>
              {catOpen && (cat.id === 'flux' || cat.id === 'argocd') && <button aria-label={`Open ${cat.label} Overview`} aria-current={activeTab?.type === `${cat.id}-dashboard` ? 'page' : undefined} onClick={() => openGitOpsDashboard(cat.id as 'flux' | 'argocd')} className={cx('w-full flex items-center gap-2 pl-[calc(32px*var(--ui-factor))] pr-2 py-1 text-xs hover:bg-[var(--bg-hover)]', activeTab?.type === `${cat.id}-dashboard` ? 'text-[var(--accent)] bg-[var(--bg-hover)]' : 'text-[var(--text-secondary)]')}><LayoutDashboard size={13} aria-hidden="true" />Overview</button>}
              {catOpen && cat.groups.map((g) => {
                const gOpen = !g.label || searching || (groups[key(cat.id, g.id)] ?? groups['*']) === true;
                const gCount = g.kinds.reduce((a, e) => a + countFor(e.kind), 0);

                return (
                  <div key={g.id}>
                    {g.label && (
                      <button
                        aria-expanded={gOpen} aria-controls={`sidebar-group-${encodeURIComponent(key(cat.id, g.id))}`}
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
                      <div id={`sidebar-group-${encodeURIComponent(key(cat.id, g.id))}`} className="py-0.5">
                        {g.kinds.map((entry) => {
                          const selected = !overviewActive && !dashboardActive && !helmActive && activeKind === entry.kind;
                          const total = countFor(entry.kind);
                          const Icon = entry.icon;

                          return (
                            <button
                              key={entry.kind}
                              data-resource-type={entry.kind}
                              onClick={() => handleSelectKind(entry.kind)}
                              onContextMenu={(e) => handleContextMenu(e, entry.kind)}
                              className={cx(
                                'group relative w-full flex items-center gap-2 h-[calc(24px*var(--ui-factor))] pr-2 text-[length:calc(11.5px*var(--ui-factor))] transition-colors',
                                g.label ? 'pl-[calc(42px*var(--ui-factor))]' : 'pl-[calc(32px*var(--ui-factor))]',
                                selected
                                  ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium shadow-2xs'
                                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                              )}
                            >
                              {selected && (
                                <span className="absolute left-0 top-1 bottom-1 w-[calc(2px*var(--ui-factor))] bg-[var(--accent)] rounded-r" />
                              )}
                              <Icon aria-hidden="true" size="calc(13px * var(--ui-factor))" strokeWidth={1.75} className="shrink-0" style={{ color: entry.tone.color }} />
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
              })}</div>
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
