import { activeWorkspaceArea, areaHasInspector } from '../../core/workspace_areas';
import { RESOURCE_TYPES } from '../../core/resources/resource_types';
import { syncResourceSnapshot } from '../../providers/snapshot_sync';
import { shortcutLabel } from '../../core/shortcuts';
import React, { useState, useCallback, useRef } from 'react';
import {
  ChevronDown,
  Circle,
  Command,
  RefreshCw,
  Server,
  Settings,
  Menu,
  PanelLeft,
  PanelBottom,
  PanelRight,
} from 'lucide-react';
import { useClusterStore } from '../../state/cluster_store';
import { useDockStore } from '../../state/dock_store';
import { useUiStore } from '../../state/ui_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { refreshResourceWatches } from '../../state/resource_watch';
import { Popover, MenuList, type MenuItem } from '../ui/Dropdown';
import { IconButton, Tooltip } from '../ui/Button';
import { NamespaceSelect } from '../ui/NamespaceSelect';
import { toast } from '../../state/notifications_store';
import type { ResourceKind } from '../../types/k8s';
import { cx } from '../../core/utils/cx';

interface TitleBarProps {
  onSelectContext: (name: string) => void;
  compact?: boolean;
  narrow?: boolean;
}

export const TitleBar: React.FC<TitleBarProps> = ({ onSelectContext, compact = false, narrow = false }) => {
  const { dockCollapsed, toggleDock } = useDockStore();
  const {
    contexts, currentContext, selectedNamespace, selectNamespace, availableNamespaces,
    isConnected, clusterVersion,
  } = useClusterStore();

  const {
    sidebarCollapsed,
    inspectorCollapsed, toggleInspector,
    setPaletteOpen, setSettingsOpen,
    density, setDensity, resetLayout,
  } = useUiStore();

  const { openResourceList, toggleSplit } = useWorkspaceStore();
  const area = useWorkspaceStore(activeWorkspaceArea);
  const explorerVisible = area === 'explorer' && !sidebarCollapsed;
  const inspectorVisible = areaHasInspector(area) && !inspectorCollapsed;
  const toggleSidebar = () => {
    if (area !== 'explorer') {
      useWorkspaceStore.getState().activateArea('explorer');
      useUiStore.setState({ sidebarCollapsed: false });
    } else useUiStore.getState().toggleSidebar();
  };

  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshing = useRef(false);
  const handleRefresh = useCallback(async () => {
    if (!currentContext || refreshing.current) return;
    refreshing.current = true;
    setIsRefreshing(true);
    const scope = useClusterStore.getState().selectedNamespace;
    const current = () => useClusterStore.getState().currentContext === currentContext && useClusterStore.getState().selectedNamespace === scope;
    try {
      if (await refreshResourceWatches()) return;
      const kinds = RESOURCE_TYPES.filter(type => !useClusterStore.getState().availableResourceKinds || useClusterStore.getState().availableResourceKinds!.includes(type.kind)).map(type => type.kind) as ResourceKind[];
      const results = await Promise.allSettled(kinds.map(async (kind) => {
        await syncResourceSnapshot(currentContext, kind, scope);
      }));
      if (!current()) return;
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) toast.warn('Sync incomplete', `${failed} resource types could not be refreshed`);
    } catch (error) {
      toast.error('Sync incomplete', String(error));
    } finally {
      refreshing.current = false;
      setIsRefreshing(false);
    }
  }, [currentContext]);

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
      label: explorerVisible ? 'Hide Tool Window: Explorer' : 'Show Tool Window: Explorer',
      kbd: '⌘B',
      onSelect: () => toggleSidebar(),
    },
    {
      id: 'view-dock',
      label: dockCollapsed ? 'Show Tool Window: Bottom Panel' : 'Hide Tool Window: Bottom Panel',
      kbd: '⌘J',
      onSelect: () => toggleDock(),
    },
    {
      id: 'view-inspector',
      disabled: !areaHasInspector(area),
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

  return (
    <header data-layout={narrow ? 'narrow' : compact ? 'compact' : 'wide'} className="app-titlebar h-9 bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between px-2 select-none shrink-0 z-30 font-sans">
      {/* Left: Main Menu + Brand + Cluster Context Widget */}
      <div className="app-titlebar-context flex items-center gap-1 min-w-0">
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
        <div className="app-titlebar-brand flex items-center gap-1.5 px-1">
          <img
            src="/brand/kubiki-logo-color-dark.svg"
            alt="kubiki"
            width={360}
            height={128}
            draggable={false}
            className="block h-[calc(28px*var(--ui-factor))] w-auto shrink-0"
          />
        </div>

        <div className="app-titlebar-divider h-4 w-px bg-[var(--border-default)] mx-1" />

        {/* JetBrains Cluster Context Widget */}
        <Popover
          width={280}
          trigger={({ open }) => (
            <button
              className={cx(
                'app-titlebar-cluster flex items-center gap-1.5 h-[calc(25px*var(--ui-factor))] px-2 rounded-[calc(4px*var(--ui-factor))] text-[length:calc(12px*var(--ui-factor))] font-medium transition-colors max-w-[calc(210px*var(--ui-factor))]',
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
              <span className="app-titlebar-version text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono">
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
        <NamespaceSelect value={selectedNamespace} onChange={selectNamespace} options={availableNamespaces}
          className="app-titlebar-namespace max-w-[calc(170px*var(--ui-factor))] font-mono" />
      </div>

      {/* Center: JetBrains "Search Everywhere" Widget */}
      <div className="titlebar-search flex-1 flex justify-center min-w-0 px-4">
        <button
          onClick={() => setPaletteOpen(true)}
          className="group flex items-center gap-2 h-[calc(26px*var(--ui-factor))] w-[calc(380px*var(--ui-factor))] max-w-full px-2.5 rounded-[calc(5px*var(--ui-factor))] bg-[var(--bg-canvas)] border border-[var(--border-default)] hover:border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors shadow-xs"
          title={shortcutLabel("Search Everywhere (⌘K)")}
        >
          <Command size="calc(13px * var(--ui-factor))" className="text-[var(--accent)] shrink-0" />
          <span className="text-xs flex-1 text-left truncate">
            Search resources, YAML, actions…
          </span>
          <kbd className="text-[length:calc(10px*var(--ui-factor))] font-mono border border-[var(--border-default)] rounded px-1.5 py-0.5 bg-[var(--bg-surface)] text-[var(--text-secondary)] shadow-2xs">
            {shortcutLabel('⌘K')}
          </kbd>
        </button>
      </div>

      {/* Right: Sync Controls + Layout Toggles + Settings */}
      <div className="app-titlebar-tools flex items-center gap-1 shrink-0">
        {/* Refresh Cluster Button */}
        <Tooltip label="Synchronize cluster state" delay={300}>
          <button
            onClick={handleRefresh}
            className={cx(
              'app-titlebar-sync flex items-center gap-1 h-[calc(25px*var(--ui-factor))] px-2 rounded-[calc(4px*var(--ui-factor))] text-[length:calc(11.5px*var(--ui-factor))] transition-colors',
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

        <div className="app-titlebar-divider h-4 w-px bg-[var(--border-default)] mx-1" />

        {/* JetBrains Layout Switcher: Left, Bottom, Right Tool Windows */}
        <div className="app-titlebar-layout flex items-center bg-[var(--bg-primary)] p-0.5 rounded-[calc(4px*var(--ui-factor))] border border-[var(--border-default)]">
          <Tooltip label={explorerVisible ? 'Hide Explorer (⌘B)' : 'Show Explorer (⌘B)'} delay={300}>
            <button
              onClick={toggleSidebar}
              className={cx(
                'w-5 h-5 flex items-center justify-center rounded-[calc(3px*var(--ui-factor))] transition-colors',
                explorerVisible ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
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
              disabled={!areaHasInspector(area)}
              className={cx(
                'w-5 h-5 flex items-center justify-center rounded-[calc(3px*var(--ui-factor))] transition-colors disabled:opacity-40',
                inspectorVisible ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
              aria-label="Toggle Details Panel"
            >
              <PanelRight size="calc(12px * var(--ui-factor))" />
            </button>
          </Tooltip>
        </div>

        <div className="app-titlebar-divider h-4 w-px bg-[var(--border-default)] mx-0.5" />

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
