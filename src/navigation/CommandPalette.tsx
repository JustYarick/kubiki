import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, Boxes, Braces, Command, FileText, Layout, Maximize2, Minimize2, PanelBottom, PanelLeft, PanelRight, Palette, RefreshCw, Rocket, Settings, Terminal, Trash2, Columns2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PERSPECTIVES, defaultKindFor, kindsFor } from '../core/perspectives';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { useDockStore } from '../state/dock_store';
import { useUiStore } from '../state/ui_store';
import { useWorkspaceStore } from '../state/workspace_store';
import { usePfStore } from '../state/pf_store';
import { toast } from '../state/notifications_store';
import { fuzzyScore, fuzzyRanges } from '../core/utils/fuzzy';
import { k8s } from '../providers/k8s_provider';
import { cx } from '../core/utils/cx';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { DEFAULT_APPEARANCE } from '../core/appearance';

interface Command {
  id: string;
  label: string;
  section: string;
  icon: LucideIcon;
  kbd?: string;
  hint?: string;
  keywords?: string;
  run: () => void;
  resources?: ResourceItem[]; // hidden: used internally
}

function TextWithRanges({ text, query }: { text: string; query: string }) {
  const ranges = fuzzyRanges(query, text);
  if (!ranges || !query) return <>{text}</>;
  return (
    <>
      {text.split('').map((ch, i) => {
        const hot = ranges.some(([a, b]) => i >= a && i < b);
        return hot ? (
          <span key={i} className="text-[var(--accent)] font-semibold">{ch}</span>
        ) : (
          <span key={i}>{ch}</span>
        );
      })}
    </>
  );
}

export const CommandPalette: React.FC = () => {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSel(0);
    }
  }, [open]);

  if (!open) return null;

  const st = useResourceStore.getState();
  const ui = useUiStore.getState();
  const cluster = useClusterStore.getState();

  /* ------------------- command list ------------------- */
  const commands: Command[] = [];

  // Navigate: perspectives
  for (const p of PERSPECTIVES) {
    commands.push({
      id: `persp-${p.id}`,
      label: p.label,
      section: 'Go to',
      icon: p.icon,
      hint: 'perspective',
      run: () => {
        ui.setActivePerspective(p.id);
        const dk = defaultKindFor(p.id);
        if (dk) useWorkspaceStore.getState().openResourceList(dk);
      },
    });
  }

  // Navigate: kinds inside active perspective
  for (const kind of kindsFor(ui.activePerspective)) {
    commands.push({
      id: `kind-${kind}`,
      label: kind,
      section: 'Go to resource',
      icon: Boxes,
      hint: 'kind',
      keywords: 'list view',
      run: () => useWorkspaceStore.getState().openResourceList(kind),
    });
  }

  // View toggles
  commands.push(
    { id: 'ui-zoom-in', label: 'Increase interface scale', section: 'View', icon: Maximize2, kbd: 'Ctrl/⌘ +', run: () => ui.setUiScale(ui.uiScale + 10) },
    { id: 'ui-zoom-out', label: 'Decrease interface scale', section: 'View', icon: Minimize2, kbd: 'Ctrl/⌘ −', run: () => ui.setUiScale(ui.uiScale - 10) },
    { id: 'ui-zoom-reset', label: 'Reset interface scale', section: 'View', icon: Layout, kbd: 'Ctrl/⌘ 0', run: () => ui.setUiScale(DEFAULT_APPEARANCE.uiScale) },
    { id: 'side', label: 'Toggle sidebar', section: 'View', icon: PanelLeft, kbd: '⌘B', run: ui.toggleSidebar },
    { id: 'insp', label: 'Toggle details pane', section: 'View', icon: PanelRight, run: ui.toggleInspector },
    { id: 'dock', label: 'Toggle bottom panel', section: 'View', icon: PanelBottom, kbd: '⌘J', run: useDockStore.getState().toggleDock },
    { id: 'density', label: ui.density === 'compact' ? 'Row density: comfortable' : 'Row density: compact', section: 'View', icon: Maximize2, run: () => ui.setDensity(ui.density === 'compact' ? 'comfortable' : 'compact') },
    { id: 'tabmode', label: ui.rightTab === 'overview' ? 'Details: focus YAML editor' : 'Details: focus overview', section: 'View', icon: Palette, run: () => ui.setRightTab(ui.rightTab === 'overview' ? 'yaml' : 'overview') },
    { id: 'layout', label: 'Reset layout sizes', section: 'View', icon: Layout, run: () => { ui.resetLayout(); toast.success('Layout reset'); } },
    { id: 'split', label: 'Toggle Split View Right', section: 'View', icon: Columns2, run: () => useWorkspaceStore.getState().toggleSplit() },
    { id: 'close-tab', label: 'Close Active Tab', section: 'Tabs', icon: X, kbd: '⌘W', run: () => {
      const activeId = useWorkspaceStore.getState().activeTabId;
      if (activeId) useWorkspaceStore.getState().closeTab(activeId);
    }},
    { id: 'close-all-tabs', label: 'Close All Tabs', section: 'Tabs', icon: X, run: () => useWorkspaceStore.getState().closeAllTabs() },
  );

  // Actions on selection
  const current = st.selectedItem;
  if (current) {
    commands.push({
      id: 'yaml',
      label: `Edit YAML: ${current.name}`,
      section: 'Resource',
      icon: Braces,
      kbd: 'Y',
      run: () => {
        st.selectItem(current);
        ui.setRightTab('yaml');
        if (ui.inspectorCollapsed) ui.toggleInspector();
      },
    });
  }

  commands.push(
    { id: 'new', label: 'Create new resource (demo)', section: 'Resource', icon: Rocket, run: () => toast.info('Use the “New” button', 'Toolbar → New opens the create form') },
    { id: 'term', label: 'Focus terminal', section: 'Panel', icon: Terminal, run: () => useDockStore.getState().focusTool('terminal') },
    { id: 'pf', label: `Port-forwards (${usePfStore.getState().sessions.length})`, section: 'Panel', icon: ArrowRightLeft, run: () => useDockStore.getState().openPorts() },
    { id: 'events', label: 'Cluster events snapshot', section: 'Panel', icon: FileText, run: () => useDockStore.getState().openEvents() },
    { id: 'refresh', label: 'Refresh current list', section: 'Data', icon: RefreshCw, run: () => { if (!cluster.currentContext) return; const context = cluster.currentContext; void k8s.getResources(context, st.activeKind, 'all').then((items) => { if (useClusterStore.getState().currentContext === context) st.setResourcesForKind(st.activeKind, items); }).catch((error) => toast.error('Refresh failed', String(error))); } },
    { id: 'ns', label: `Namespace: ${cluster.selectedNamespace}`, section: 'Data', icon: Boxes, keywords: 'namespace filter', run: () => { const list = ['all', ...cluster.availableNamespaces]; const next = list[(list.indexOf(cluster.selectedNamespace) + 1) % list.length]; cluster.selectNamespace(next); toast.info(`Namespace: ${next}`); } },
    { id: 'settings', label: 'Open settings', section: 'System', icon: Settings, run: () => ui.setSettingsOpen(true) },
    { id: 'clear', label: 'Clear all filters', section: 'Data', icon: Trash2, run: () => { st.setSearchQuery(''); cluster.selectNamespace('all'); toast.success('Filters cleared'); } },
  );

  // Resources (global search across every kind in the current perspective first, then all)
  const allKinds = Object.keys(st.resources) as ResourceKind[];
  for (const kind of allKinds) {
    const items = Array.from(st.resources[kind].values());
    for (const item of items) {
      commands.push({
        id: `res-${item.uid}`,
        label: item.name,
        section: `${item.kind}${item.namespace ? ` · ${item.namespace}` : ''}`,
        icon: Boxes,
        hint: 'inspect resource',
        keywords: item.namespace,
        resources: [item],
        run: () => {
          st.selectItem(item);
          ui.setRightTab('overview');
          if (ui.inspectorCollapsed) ui.toggleInspector();
        },
      });
    }
  }

  /* ------------------- filtering ------------------- */
  const scored = commands
    .map((c) => ({ c, s: fuzzyScore(query, `${c.label} ${c.section} ${c.keywords ?? ''} ${c.id}`) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40);

  const grouped: Array<{ section: string; items: Command[] }> = [];
  for (const { c } of scored) {
    const last = grouped[grouped.length - 1];
    if (last && last.section === c.section) last.items.push(c);
    else grouped.push({ section: c.section, items: [c] });
  }
  const flat = grouped.flatMap((g) => g.items);

  const exec = (c: Command) => {
    setOpen(false);
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setSel((p) => (flat.length ? (p + delta + flat.length) % flat.length : 0));
      requestAnimationFrame(() => {
        listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
      });
    }
    if (e.key === 'Enter' && flat[sel]) exec(flat[sel]);
    if (e.key === 'Escape') setOpen(false);
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh]" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/40 kub-fade" onClick={() => setOpen(false)} />
      <div className="relative w-[calc(560px*var(--ui-factor))] max-w-[92vw] max-h-[60vh] flex flex-col rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-dialog)] kub-pop overflow-hidden">
        {/* input */}
        <div className="flex items-center gap-2 px-3 h-10 border-b border-[var(--border-subtle)] shrink-0">
          <Command size="calc(14px * var(--ui-factor))" className="text-[var(--text-muted)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSel(0); }}
            placeholder="Search resources, run commands…"
            className="flex-1 bg-transparent outline-none text-[length:calc(13px*var(--ui-factor))] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <kbd className="text-[length:calc(10px*var(--ui-factor))] font-mono border border-[var(--border-default)] rounded px-1 py-px text-[var(--text-muted)] bg-[var(--bg-surface)]">esc</kbd>
        </div>

        {/* results */}
        <div ref={listRef} className="flex-1 overflow-y-auto kubiki-scrollbar py-1">
          {flat.length === 0 && (
            <div className="px-4 py-8 text-center text-[length:calc(12px*var(--ui-factor))] text-[var(--text-muted)]">No matches — try fewer characters</div>
          )}
          {grouped.map((g) => (
            <div key={g.section}>
              <div className="px-3 pt-1.5 pb-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-[0.07em] text-[var(--text-muted)]">{g.section}</div>
              {g.items.map((c) => {
                const idx = flat.indexOf(c);
                const isActive = idx === sel;
                const Icon = c.icon;
                return (
                  <button
                    key={c.id}
                    data-active={isActive}
                    onMouseEnter={() => setSel(idx)}
                    onClick={() => exec(c)}
                    className={cx(
                      'w-full flex items-center gap-2.5 px-3 h-[calc(28px*var(--ui-factor))] text-left transition-colors',
                      isActive ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]/60'
                    )}
                  >
                    <Icon size="calc(13px * var(--ui-factor))" className={cx('shrink-0', isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')} strokeWidth={1.75} />
                    <span className="text-[length:calc(12px*var(--ui-factor))] text-[var(--text-primary)] flex-1 truncate">
                      <TextWithRanges text={c.label} query={query} />
                    </span>
                    {c.hint && <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)]">{c.hint}</span>}
                    {c.kbd && <kbd className="text-[length:calc(10px*var(--ui-factor))] font-mono border border-[var(--border-subtle)] rounded px-1 text-[var(--text-muted)] bg-[var(--bg-surface)]">{c.kbd}</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* footer */}
        <div className="h-6 shrink-0 border-t border-[var(--border-subtle)] flex items-center gap-3 px-3 text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span className="ml-auto">{flat.length} results</span>
        </div>
      </div>
    </div>,
    document.body
  );
};
