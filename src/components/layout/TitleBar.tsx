import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ChevronDown,
  Circle,
  Command,
  Layers,
  RefreshCw,
  Server,
  Settings,
  Menu,
  PanelLeft,
  PanelBottom,
  PanelRight,
  Check,
  Clock,
} from 'lucide-react';
import { useClusterStore } from '../../state/cluster_store';
import { useResourceStore } from '../../state/resource_store';
import { useDockStore } from '../../state/dock_store';
import { useUiStore } from '../../state/ui_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { isValidNamespaceName } from '../../core/resources/resource_types';
import { k8s } from '../../providers/k8s_provider';
import { refreshResourceWatches } from '../../state/resource_watch';
import { Popover, MenuList, type MenuItem } from '../ui/Dropdown';
import { IconButton, Tooltip } from '../ui/Button';
import { SearchableSelect } from '../ui/SearchableSelect';
import { toast } from '../../state/notifications_store';
import type { ResourceKind } from '../../types/k8s';
import { cx } from '../../core/utils/cx';

interface TitleBarProps {
  onSelectContext: (name: string) => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({ onSelectContext }) => {
  const { dockCollapsed, toggleDock } = useDockStore();
  const {
    contexts, currentContext, selectedNamespace, selectNamespace, availableNamespaces,
    isConnected, clusterVersion,
  } = useClusterStore();

  const {
    sidebarCollapsed, toggleSidebar,
    inspectorCollapsed, toggleInspector,
    setPaletteOpen, setSettingsOpen,
    density, setDensity, resetLayout,
  } = useUiStore();

  const { openResourceList, toggleSplit } = useWorkspaceStore();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(0); // 0 = off

  const refreshing = useRef(false);
  const handleRefresh = useCallback(async () => {
    if (!currentContext || refreshing.current) return;
    refreshing.current = true;
    setIsRefreshing(true);
    try {
      if (await refreshResourceWatches()) return;
      const kinds = Object.keys(useResourceStore.getState().resources) as ResourceKind[];
      const results = await Promise.allSettled(kinds.map(async (kind) => {
        try {
          const items = await k8s.getResources(currentContext, kind, 'all');
          if (useClusterStore.getState().currentContext === currentContext) useResourceStore.getState().setResourcesForKind(kind, items);
        } catch (error) {
          if (useClusterStore.getState().currentContext === currentContext) useResourceStore.getState().setLoadError(kind, error);
          throw error;
        }
      }));
      if (useClusterStore.getState().currentContext !== currentContext) return;
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) toast.warn('Sync incomplete', `${failed} resource types could not be refreshed`);
    } catch (error) {
      toast.error('Sync incomplete', String(error));
    } finally {
      refreshing.current = false;
      setIsRefreshing(false);
    }
  }, [currentContext]);

  useEffect(() => {
    if (!autoRefreshInterval || !isConnected) return;
    const timer = window.setInterval(() => { void handleRefresh(); }, autoRefreshInterval * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefreshInterval, handleRefresh, isConnected]);

  const ctxItems: MenuItem[] = contexts.length
    ? contexts.map((c) => ({
        id: c.name,
        label: c.name,
        icon: Server,
        checked: c.name === currentContext,
        onSelect: () => onSelectContext(c.name),
      }))
    : [{ id: 'none', label: 'No contexts found', disabled: true }];

  /* JetBrains Main Menu items */
  const mainMenuSections: MenuItem[] = [
    {
      id: 'new-tab',
      label: 'New Pods View',
      kbd: '⌘T',
      onSelect: () => openResourceList('Pod'),
    },
    {
      id: 'palette',
      label: 'Search Everywhere…',
      kbd: '⌘K',
      onSelect: () => setPaletteOpen(true),
    },
    { id: 'sep1', label: '', separator: true, onSelect: () => {} },
    {
      id: 'view-explorer',
      label: sidebarCollapsed ? 'Show Tool Window: Explorer' : 'Hide Tool Window: Explorer',
      kbd: '⌘B',
      onSelect: () => toggleSidebar(),
    },
    {
      id: 'view-dock',
      label: dockCollapsed ? 'Show Tool Window: Terminal & Services' : 'Hide Tool Window: Terminal & Services',
      kbd: '⌘J',
      onSelect: () => toggleDock(),
    },
    {
      id: 'view-inspector',
      label: inspectorCollapsed ? 'Show Tool Window: Inspector' : 'Hide Tool Window: Inspector',
      onSelect: () => toggleInspector(),
    },
    {
      id: 'toggle-split',
      label: 'Toggle Split Editor',
      onSelect: () => toggleSplit(),
    },
    { id: 'sep2', label: '', separator: true, onSelect: () => {} },
    {
      id: 'density',
      label: density === 'compact' ? 'Density: Comfortable' : 'Density: Compact',
      onSelect: () => setDensity(density === 'compact' ? 'comfortable' : 'compact'),
    },
    {
      id: 'reset-layout',
      label: 'Restore Default IDE Layout',
      onSelect: () => {
        resetLayout();
        toast.info('IDE Layout Reset to Default');
      },
    },
    { id: 'sep3', label: '', separator: true, onSelect: () => {} },
    {
      id: 'settings',
      label: 'Settings…',
      kbd: '⌘,',
      onSelect: () => setSettingsOpen(true),
    },
  ];

  const refreshOptions = [
    { label: 'Off', val: 0 },
    { label: 'Every 3s', val: 3 },
    { label: 'Every 5s', val: 5 },
    { label: 'Every 15s', val: 15 },
  ];

  return (
    <header className="h-9 bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between px-2 select-none shrink-0 z-30 font-sans">
      {/* Left: Main Menu + Brand + Cluster Context Widget */}
      <div className="flex items-center gap-1 min-w-0">
        {/* JetBrains Hamburger Main Menu */}
        <Popover
          width={260}
          trigger={({ open }) => (
            <button
              className={cx(
                'w-7 h-7 flex items-center justify-center rounded-[calc(4px*var(--ui-factor))] transition-colors',
                open ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              )}
              title="Main Menu"
              aria-label="Main Menu"
            >
              <Menu size="calc(15px * var(--ui-factor))" />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="px-2.5 py-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                Kubiki IDE Menu
              </div>
              <MenuList items={mainMenuSections} onSelect={(item) => { item.onSelect?.(); close(); }} />
            </>
          )}
        </Popover>

        {/* Kubiki Brand Logo */}
        <div className="flex items-center gap-1.5 px-1">
          <span className="w-5 h-5 rounded-[calc(4px*var(--ui-factor))] bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white text-[length:calc(11px*var(--ui-factor))] font-bold shadow-xs shrink-0">
            ⎈
          </span>
          <span className="font-semibold text-[length:calc(12.5px*var(--ui-factor))] tracking-tight text-[var(--text-primary)]">
            Kubiki
          </span>
          <span className="text-[length:calc(9px*var(--ui-factor))] font-mono font-medium px-1 py-0.2 rounded bg-blue-500/15 text-blue-400 border border-blue-500/25">
            IDE
          </span>
        </div>

        <div className="h-4 w-px bg-[var(--border-default)] mx-1" />

        {/* JetBrains Cluster Context Widget */}
        <Popover
          width={280}
          trigger={({ open }) => (
            <button
              className={cx(
                'flex items-center gap-1.5 h-[calc(25px*var(--ui-factor))] px-2 rounded-[calc(4px*var(--ui-factor))] text-[length:calc(12px*var(--ui-factor))] font-medium transition-colors max-w-[calc(210px*var(--ui-factor))]',
                open
                  ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              )}
              title="Switch Kubernetes Cluster Context"
            >
              <Circle
                size="calc(8px * var(--ui-factor))"
                strokeWidth={0}
                className={cx(
                  isConnected ? 'fill-[var(--status-ok)]' : 'fill-[var(--status-warn)]',
                  isConnected && 'animate-pulse'
                )}
              />
              <span className="truncate font-mono text-[length:calc(11.5px*var(--ui-factor))]">{currentContext ?? 'No Context'}</span>
              <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono">
                {clusterVersion ? clusterVersion.replace(/^v?/, 'v') : ''}
              </span>
              <ChevronDown size="calc(11px * var(--ui-factor))" className="opacity-50 shrink-0 ml-0.5" />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="px-2.5 pt-1.5 pb-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Active Kubernetes Context
              </div>
              <MenuList items={ctxItems} onSelect={(item) => { item.onSelect?.(); close(); }} />
            </>
          )}
        </Popover>

        {/* Namespace Picker */}
        <SearchableSelect label="Namespace Scope" value={selectedNamespace} onChange={selectNamespace} icon={Layers}
          customOption={k8s.supportsResourceWatch ? (name) => isValidNamespaceName(name) && name !== 'all' ? { value: name, label: `Use namespace: ${name}` } : undefined : undefined}
          customHint={k8s.supportsResourceWatch ? 'Enter a namespace name when it is not listed. This changes the live data scope.' : undefined}
          className="max-w-[calc(170px*var(--ui-factor))] font-mono" options={[
          { value: 'all', label: 'All Namespaces' },
          ...[...new Set([...availableNamespaces, ...(selectedNamespace !== 'all' ? [selectedNamespace] : [])])].sort().map((name) => ({ value: name, label: name })),
        ]} />
      </div>

      {/* Center: JetBrains "Search Everywhere" Widget */}
      <div className="titlebar-search flex-1 flex justify-center min-w-0 px-4">
        <button
          onClick={() => setPaletteOpen(true)}
          className="group flex items-center gap-2 h-[calc(26px*var(--ui-factor))] w-[calc(380px*var(--ui-factor))] max-w-full px-2.5 rounded-[calc(5px*var(--ui-factor))] bg-[var(--bg-canvas)] border border-[var(--border-default)] hover:border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-all shadow-xs"
          title="Search Everywhere (Ctrl/⌘ K)"
        >
          <Command size="calc(13px * var(--ui-factor))" className="text-[var(--accent)] shrink-0" />
          <span className="text-xs flex-1 text-left truncate">
            Search resources, YAML, actions…
          </span>
          <kbd className="text-[length:calc(10px*var(--ui-factor))] font-mono border border-[var(--border-default)] rounded px-1.5 py-0.5 bg-[var(--bg-surface)] text-[var(--text-secondary)] shadow-2xs">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Right: Sync Controls + Layout Toggles + Settings */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Refresh Cluster Button */}
        <Tooltip label="Synchronize cluster state" delay={300}>
          <button
            onClick={handleRefresh}
            className={cx(
              'flex items-center gap-1 h-[calc(25px*var(--ui-factor))] px-2 rounded-[calc(4px*var(--ui-factor))] text-[length:calc(11.5px*var(--ui-factor))] transition-colors',
              'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            )}
            aria-label="Refresh"
          >
            <RefreshCw
              size="calc(12px * var(--ui-factor))"
              className={cx('shrink-0', isRefreshing && 'animate-spin text-[var(--accent)]')}
            />
            <span className="text-[length:calc(11px*var(--ui-factor))] hidden md:inline">Sync</span>
          </button>
        </Tooltip>

        {/* Auto-refresh interval popover */}
        <Popover
          width={150}
          trigger={({ open }) => (
            <button
              className={cx(
                'flex items-center gap-1 h-[calc(25px*var(--ui-factor))] px-1.5 rounded-[calc(4px*var(--ui-factor))] text-[length:calc(10.5px*var(--ui-factor))] font-mono transition-colors',
                open ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              )}
              title="Auto-refresh interval"
            >
              <Clock size="calc(11px * var(--ui-factor))" />
              <span>{autoRefreshInterval === 0 ? 'Manual' : `${autoRefreshInterval}s`}</span>
              <ChevronDown size="calc(10px * var(--ui-factor))" className="opacity-50" />
            </button>
          )}
        >
          {(close) => (
            <div className="py-1">
              <div className="px-2.5 py-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Auto Sync
              </div>
              {refreshOptions.map((opt) => (
                <button
                  key={opt.val}
                  onClick={() => {
                    setAutoRefreshInterval(opt.val);
                    if (opt.val > 0) toast.info(`Auto-sync set to ${opt.label}`);
                    close();
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-1 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <span>{opt.label}</span>
                  {autoRefreshInterval === opt.val && <Check size="calc(11px * var(--ui-factor))" className="text-[var(--accent)]" />}
                </button>
              ))}
            </div>
          )}
        </Popover>

        <div className="h-4 w-px bg-[var(--border-default)] mx-1" />

        {/* JetBrains Layout Switcher: Left, Bottom, Right Tool Windows */}
        <div className="flex items-center bg-[var(--bg-primary)] p-0.5 rounded-[calc(4px*var(--ui-factor))] border border-[var(--border-default)]">
          <Tooltip label={sidebarCollapsed ? 'Show Explorer (⌘B)' : 'Hide Explorer (⌘B)'} delay={300}>
            <button
              onClick={toggleSidebar}
              className={cx(
                'w-5 h-5 flex items-center justify-center rounded-[calc(3px*var(--ui-factor))] transition-colors',
                !sidebarCollapsed ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
              aria-label="Toggle Explorer"
            >
              <PanelLeft size="calc(12px * var(--ui-factor))" />
            </button>
          </Tooltip>

          <Tooltip label={dockCollapsed ? 'Show Bottom Panel (⌘J)' : 'Hide Bottom Panel (⌘J)'} delay={300}>
            <button
              onClick={toggleDock}
              className={cx(
                'w-5 h-5 flex items-center justify-center rounded-[calc(3px*var(--ui-factor))] transition-colors',
                !dockCollapsed ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
              aria-label="Toggle Bottom Panel"
            >
              <PanelBottom size="calc(12px * var(--ui-factor))" />
            </button>
          </Tooltip>

          <Tooltip label={inspectorCollapsed ? 'Show Details Panel' : 'Hide Details Panel'} delay={300}>
            <button
              onClick={toggleInspector}
              className={cx(
                'w-5 h-5 flex items-center justify-center rounded-[calc(3px*var(--ui-factor))] transition-colors',
                !inspectorCollapsed ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
              aria-label="Toggle Details Panel"
            >
              <PanelRight size="calc(12px * var(--ui-factor))" />
            </button>
          </Tooltip>
        </div>

        <div className="h-4 w-px bg-[var(--border-default)] mx-0.5" />

        {/* Settings */}
        <Tooltip label="IDE Settings" delay={300}>
          <IconButton
            icon={Settings}
            size="sm"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
          />
        </Tooltip>
      </div>
    </header>
  );
};
