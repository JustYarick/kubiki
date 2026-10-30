import { useExtensions } from '../extensions/registry';
import { extensionRequest } from '../providers/extensions';
import { usePanelRegistry, openWorkspacePanel } from '../core/workspace_panels';
import { useTableViewStore } from '../state/table_view_store';
import { namespaceScopeLabel } from '../core/resources/namespace_scope';
import { shortcutLabel } from '../core/shortcuts';
import { customResourceType, resourceBucket } from '../core/resources/custom_resource_types';
import { useSearchInventory } from './use_search_inventory';
import { useResourceSearch } from './use_resource_search';
import { Select } from '../components/ui/Select';
import { Button } from '../components/ui/Button';
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { refreshResourceWatches } from '../state/resource_watch';
import { syncResourceSnapshot } from '../providers/snapshot_sync';
import { cx } from '../core/utils/cx';
import type { ResourceItem } from '../types/k8s';
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
  const extensions = useExtensions(s => s.installed);
  const panels = usePanelRegistry(s => s.panels);
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [mode, setMode] = useState<'all' | 'resources' | 'commands'>('all');
  const [limit, setLimit] = useState(40);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const previousOpen = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  if (open && !previousOpen.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousOpen.current = open;

  useEffect(() => {
    if (open) {
      setQuery('');
      setSel(0);
    }
  }, [open]);

  const resources = useResourceStore((s) => (open ? s.resources : null));
  const selectedItem = useResourceStore((s) => (open ? s.selectedItem : null));
  const activeKind = useResourceStore((s) => (open ? s.activeKind : 'Pod'));
  const selectedNamespace = useClusterStore((s) => (open ? s.selectedNamespace : 'all'));
  const currentContext = useClusterStore((s) => (open ? s.currentContext : null));
  const activePerspective = useUiStore((s) => s.activePerspective);
  const density = useUiStore((s) => s.density);
  const rightTab = useUiStore((s) => s.rightTab);
  const inspectorCollapsed = useUiStore((s) => s.inspectorCollapsed);
  const pfCount = usePfStore((s) => (open ? s.sessions.length : 0));
  const inventory = useSearchInventory(open && mode !== 'commands', currentContext, scope === 'all' ? 'all' : selectedNamespace);
  const search = useResourceSearch(inventory.items, { query, regex, caseSensitive }, open && mode !== 'commands');
  useEffect(() => { setSel(0); setLimit(40); }, [query, regex, caseSensitive, mode, scope]);
  useEffect(() => {
    if (!open) return;
    const previous = returnFocus.current;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const nodes = [...(dialogRef.current?.querySelectorAll<HTMLElement>('input, select:not(:disabled), summary, button:not(:disabled):not([tabindex="-1"])') ?? [])].filter(node => node.getClientRects().length);
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus(); };
  }, [open]);

  const { grouped, flat, matched } = useMemo(() => {
    if (!open || !resources) return { grouped: [] as Array<{ section: string; items: Command[] }>, flat: [] as Command[], matched: 0 };
    const st = useResourceStore.getState();
    const ui = useUiStore.getState();
    const cluster = useClusterStore.getState();

    const commands: Command[] = [{ id: 'overview', label: 'Open Overview', section: 'Go to', icon: Layout, keywords: 'cluster namespace statistics summary', run: () => useWorkspaceStore.getState().openOverview() }];

    for (const panel of panels) commands.push({ id: `panel:${panel.id}`, label: `Open ${panel.title}`, section: 'Extensions', icon: panel.icon, run: () => openWorkspacePanel(panel) });
    for (const extension of extensions.filter(entry => entry.enabled)) for (const command of extension.manifest.contributes.commands ?? []) commands.push({
      id: `${extension.manifest.id}:${command.id}`, label: command.title, section: extension.manifest.name, icon: Command,
      run: () => { void extensionRequest('call', { id: extension.manifest.id, method: command.method, params: null }).catch(error => toast.error('Extension command failed', error.message)); },
    });

    for (const p of PERSPECTIVES) {
      commands.push({
        id: `persp-${p.id}`,
        label: p.label,
        section: 'Go to',
        icon: p.icon,
        hint: 'perspective',
        run: () => {
          ui.setActivePerspective(p.id);
          if (p.id === 'helm') { useWorkspaceStore.getState().openHelm('releases'); return; }
          if (p.id === 'flux' || p.id === 'argocd') { useWorkspaceStore.getState().openGitOpsDashboard(p.id); return; }
          const dk = defaultKindFor(p.id);
          if (dk) useWorkspaceStore.getState().openResourceList(dk);
        },
      });
    }

    for (const kind of kindsFor(activePerspective)) {
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

    const crdMap = resources.CustomResourceDefinition;
    if (crdMap) {
      for (const crdItem of crdMap.values()) {
        const type = customResourceType(crdItem);
        if (!type) continue;
        commands.push({
          id: `crd-${type.key}`,
          label: `${type.kind} (${type.group})`,
          section: 'Custom Resources',
          icon: Boxes,
          hint: 'custom resource',
          keywords: `${type.name} ${type.plural} ${type.singular ?? ''} ${(type.shortNames ?? []).join(' ')} ${type.group}`,
          run: () => useWorkspaceStore.getState().openResourceList(type.key),
        });
      }
    }

    commands.push(
      { id: 'helm-repositories', label: 'Helm repositories', section: 'Go to', icon: Boxes, run: () => useWorkspaceStore.getState().openHelm('repositories') },
      { id: 'ui-zoom-in', label: 'Increase interface scale', section: 'View', icon: Maximize2, kbd: 'Ctrl/⌘ +', run: () => ui.setUiScale(ui.uiScale + 10) },
      { id: 'ui-zoom-out', label: 'Decrease interface scale', section: 'View', icon: Minimize2, kbd: 'Ctrl/⌘ −', run: () => ui.setUiScale(ui.uiScale - 10) },
      { id: 'ui-zoom-reset', label: 'Reset interface scale', section: 'View', icon: Layout, kbd: 'Ctrl/⌘ 0', run: () => ui.setUiScale(DEFAULT_APPEARANCE.uiScale) },
      { id: 'side', label: 'Toggle sidebar', section: 'View', icon: PanelLeft, kbd: '⌘B', run: ui.toggleSidebar },
      { id: 'insp', label: 'Toggle details pane', section: 'View', icon: PanelRight, run: ui.toggleInspector },
      { id: 'dock', label: 'Toggle bottom panel', section: 'View', icon: PanelBottom, kbd: '⌘J', run: useDockStore.getState().toggleDock },
      { id: 'density', label: density === 'compact' ? 'Row density: comfortable' : 'Row density: compact', section: 'View', icon: Maximize2, run: () => ui.setDensity(density === 'compact' ? 'comfortable' : 'compact') },
      { id: 'tabmode', label: rightTab === 'overview' ? 'Details: focus YAML editor' : 'Details: focus overview', section: 'View', icon: Palette, run: () => ui.setRightTab(rightTab === 'overview' ? 'yaml' : 'overview') },
      { id: 'layout', label: 'Reset layout sizes', section: 'View', icon: Layout, run: () => { ui.resetLayout(); toast.success('Layout reset'); } },
      { id: 'split', label: 'Toggle Split View Right', section: 'View', icon: Columns2, run: () => useWorkspaceStore.getState().toggleSplit() },
      { id: 'close-tab', label: 'Close Active Tab', section: 'Tabs', icon: X, kbd: '⌘W', run: () => {
        const activeId = useWorkspaceStore.getState().activeTabId;
        if (activeId) useWorkspaceStore.getState().closeTab(activeId);
      }},
      { id: 'close-all-tabs', label: 'Close All Tabs', section: 'Tabs', icon: X, run: () => useWorkspaceStore.getState().closeAllTabs() },
    );

    if (selectedItem) {
      commands.push({
        id: 'yaml',
        label: `Edit YAML: ${selectedItem.name}`,
        section: 'Resource',
        icon: Braces,
        kbd: 'Y',
        run: () => {
          st.selectItem(selectedItem);
          ui.setRightTab('yaml');
          if (ui.inspectorCollapsed) ui.toggleInspector();
        },
      });
    }

    commands.push(
      { id: 'new', label: 'Create new resource (demo)', section: 'Resource', icon: Rocket, run: () => toast.info('Use the “New” button', 'Toolbar → New opens the create form') },
      { id: 'term', label: 'Focus terminal', section: 'Panel', icon: Terminal, run: () => useDockStore.getState().focusTool('terminal') },
      { id: 'pf', label: `Port-forwards (${pfCount})`, section: 'Panel', icon: ArrowRightLeft, run: () => useDockStore.getState().openPorts() },
      { id: 'events', label: 'Cluster events snapshot', section: 'Panel', icon: FileText, run: () => useDockStore.getState().openEvents() },
      { id: 'refresh', label: 'Refresh current list', section: 'Data', icon: RefreshCw, run: () => { if (!currentContext) return; const context = currentContext; const scope = selectedNamespace; void (async () => { if (await refreshResourceWatches(activeKind)) return; await syncResourceSnapshot(context, activeKind, scope); })().catch((error) => { const cluster = useClusterStore.getState(); if (cluster.currentContext === context && cluster.selectedNamespace === scope) toast.error('Refresh failed', String(error)); }); } },
      { id: 'ns', label: `Namespaces: ${namespaceScopeLabel(selectedNamespace)}`, section: 'Data', icon: Boxes, keywords: 'namespace filter scope select multiple', run: () => { document.querySelector<HTMLButtonElement>('[aria-label="Namespace Scope"]')?.click(); } },
      { id: 'settings', label: 'Open settings', section: 'System', icon: Settings, run: () => ui.setSettingsOpen(true) },
      { id: 'clear', label: 'Clear all filters', section: 'Data', icon: Trash2, run: () => { { const views = useTableViewStore.getState(); const tab = useWorkspaceStore.getState().tabs.find(entry => entry.id === useWorkspaceStore.getState().activeTabId); views.clear(`kind:${tab?.type === 'resource-list' && tab.kind ? tab.kind : activeKind}`); } cluster.selectNamespace('all'); toast.success('Filters cleared'); } },
    );

    const scored: Array<{ c: Command; s: number }> = [];
    for (const c of mode === 'resources' || regex ? [] : commands) {
      const text = `${c.label} ${c.section} ${c.keywords ?? ''} ${c.id}`;
      const s = caseSensitive && query && !text.includes(query) ? -1 : fuzzyScore(query, text);
      if (s >= 0) scored.push({ c, s });
    }

    for (const [index, item] of search.items.entries()) {
      scored.push({ s: 1500 - index, c: {
        id: `res-${item.apiVersion}-${item.uid}`, label: item.name,
        section: `${item.kind}${item.namespace ? ` · ${item.namespace}` : ''}`, icon: Boxes,
        hint: item.apiVersion, resources: [item],
        run: () => {
          if (useClusterStore.getState().currentContext !== currentContext) return;
          const store = useResourceStore.getState();
          const definition = inventory.items.find(candidate => candidate.kind === 'CustomResourceDefinition' && candidate.raw?.spec?.names?.kind === item.kind && item.apiVersion.startsWith(`${candidate.raw?.spec?.group}/`));
          if (definition && !store.resources.CustomResourceDefinition.has(definition.uid)) store.setResourcesForKind('CustomResourceDefinition', [...store.resources.CustomResourceDefinition.values(), definition]);
          const bucket = resourceBucket(item);
          if (!store.resources[bucket]?.has(item.uid)) store.setResourcesForKind(bucket, [...(store.resources[bucket]?.values() ?? []), item]);
          // A resource detail tab pins its own namespace, including matches outside the list scope.
          useWorkspaceStore.getState().openResourceDetail(item, { namespacePinned: true });
        },
      } });
    }

    scored.sort((a, b) => b.s - a.s);
    const top = scored.slice(0, limit);
    const grouped: Array<{ section: string; items: Command[] }> = [];
    for (const { c } of top) {
      const group = grouped.find(entry => entry.section === c.section);
      if (group) group.items.push(c); else grouped.push({ section: c.section, items: [c] });
    }
    return { grouped, flat: grouped.flatMap((g) => g.items), matched: search.total + (scored.length - search.items.length) };
  }, [open, query, resources, selectedItem, activeKind, selectedNamespace, currentContext, activePerspective, density, rightTab, inspectorCollapsed, pfCount, panels, extensions, search.items, search.total, mode, regex, caseSensitive, limit, inventory.items]);

  useEffect(() => { setSel(previous => previous < flat.length ? previous : 0); }, [flat.length]);

  if (!open) return null;

  const exec = (c: Command) => {
    setOpen(false);
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    if ((e.target as HTMLElement).closest('select, button, summary')) return;
    if (e.altKey && e.key.toLowerCase() === 'r' && mode !== 'commands') { e.preventDefault(); setRegex(value => !value); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setSel((p) => (flat.length ? (p + delta + flat.length) % flat.length : 0));
      requestAnimationFrame(() => {
        listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
      });
    }
    if (e.key === 'Enter' && flat[sel]) { e.preventDefault(); e.stopPropagation(); exec(flat[sel]); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh]" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/40 kub-fade" onClick={() => setOpen(false)} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Master search" className="relative w-[calc(680px*var(--ui-factor))] max-w-[92vw] max-h-[60vh] flex flex-col rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-dialog)] kub-pop overflow-hidden">
        {/* input */}
        <div className="flex items-center gap-2 px-3 h-10 border-b border-[var(--border-subtle)] shrink-0">
          <Command size="calc(14px * var(--ui-factor))" className="text-[var(--text-muted)]" />
          <input
            autoFocus
            aria-label="Master search query"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={true}
            aria-controls="master-search-results"
            aria-activedescendant={flat[sel] ? `master-result-${sel}` : undefined}
            aria-invalid={!!search.error}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSel(0); }}
            placeholder="Search resources, run commands…"
            className="min-w-0 flex-1 bg-transparent outline-none text-[length:calc(13px*var(--ui-factor))] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <Button size="sm" variant="ghost" aria-label="Use regular expression" aria-pressed={regex} disabled={mode === 'commands'} title="Regular expression (Alt+R)" onClick={() => setRegex(value => !value)}>.*</Button>
          <Button size="sm" variant="ghost" aria-label="Match case" aria-pressed={caseSensitive} onClick={() => setCaseSensitive(value => !value)}>Aa</Button>
          <kbd className="text-[length:calc(10px*var(--ui-factor))] font-mono border border-[var(--border-default)] rounded px-1 py-px text-[var(--text-muted)] bg-[var(--bg-surface)]">esc</kbd>
        </div>

        <div className="flex flex-wrap gap-2 items-center px-3 py-2 border-b border-[var(--border-subtle)] text-xs">
          <Select aria-label="Search category" className="ide-select" value={mode} onChange={event => { setMode(event.target.value as typeof mode); if (event.target.value === 'commands') setRegex(false); }}><option value="all">All</option><option value="resources">Objects</option><option value="commands">Commands</option></Select>
          <Select aria-label="Search namespace scope" className="ide-select min-w-0 max-w-full" value={scope} disabled={mode === 'commands'} onChange={event => setScope(event.target.value as typeof scope)}><option value="all">All namespaces</option><option value="selected">Selected: {namespaceScopeLabel(selectedNamespace)}</option></Select>
          <Button size="sm" variant="ghost" disabled={mode === 'commands' || inventory.loading} onClick={inventory.refresh} aria-label="Refresh search inventory"><RefreshCw size={12} /></Button>
          <span role="status" className="text-[var(--text-muted)]">{mode === 'commands' ? 'Commands' : `${inventory.loading ? 'Loading' : 'Scanned'} ${inventory.completed}/${inventory.total} collections · ${inventory.items.length} objects`}{search.pending && mode !== 'commands' ? ' · Searching…' : ''}</span>
        </div>
        {search.error && mode !== 'commands' && <p role="alert" className="px-3 py-2 text-xs text-[var(--status-danger)]">{search.error}</p>}
        {!!inventory.errors.length && mode !== 'commands' && <details className="px-3 py-1 text-xs text-[var(--status-warn)]"><summary className="cursor-pointer">Partial inventory · {inventory.errors.length} unavailable collections</summary><div className="max-h-24 overflow-auto kubiki-scrollbar">{inventory.errors.map(error => <p key={error}>{error}</p>)}</div></details>}
        <details className="px-3 py-1 text-xs text-[var(--text-muted)]"><summary className="cursor-pointer">Search filters</summary><p>Combine terms: kind:Pod ns:production name:api label:app=web -status:Failed. Fields: name, kind, ns, status, label, annotation, image, node, api, uid. Quote phrases. Regex uses the .* button or Alt+R. Secret values are excluded.</p></details>

        {/* results */}
        <div ref={listRef} role="listbox" id="master-search-results" aria-label="Search results" className="flex-1 overflow-y-auto kubiki-scrollbar py-1">
          {flat.length === 0 && (
            <div className="px-4 py-8 text-center text-[length:calc(12px*var(--ui-factor))] text-[var(--text-muted)]">{inventory.loading || search.pending ? 'Searching available objects…' : 'No matches — try fewer characters or change the filters'}</div>
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
                    role="option"
                    aria-selected={isActive}
                    id={`master-result-${idx}`}
                    tabIndex={-1}
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
                      <TextWithRanges text={c.label} query={regex ? '' : query} />
                    </span>
                    {c.hint && <span title={c.hint} className="max-w-[45%] truncate text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)]">{c.hint}</span>}
                    {c.kbd && <kbd className="text-[length:calc(10px*var(--ui-factor))] font-mono border border-[var(--border-subtle)] rounded px-1 text-[var(--text-muted)] bg-[var(--bg-surface)]">{shortcutLabel(c.kbd)}</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {flat.length < Math.min(1000, matched) && <Button size="sm" variant="ghost" onClick={() => setLimit(value => value + 40)}>Show next 40</Button>}
        {/* footer */}
        <div className="h-6 shrink-0 border-t border-[var(--border-subtle)] flex items-center gap-3 px-3 text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span className="ml-auto">{flat.length} of {matched} matches{matched > 1000 ? ' · Refine filters for more results' : ''}</span>
        </div>
      </div>
    </div>,
    document.body
  );
};
