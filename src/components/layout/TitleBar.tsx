import React, { useState } from 'react';
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
import { useUiStore } from '../../state/ui_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { Popover, MenuList, type MenuItem } from '../ui/Dropdown';
import { IconButton, Tooltip } from '../ui/Button';
import { toast } from '../../state/notifications_store';
import { cx } from '../../core/utils/cx';

interface TitleBarProps {
  onSelectContext: (name: string) => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({ onSelectContext }) => {
  const {
    contexts, currentContext, selectedNamespace, selectNamespace, availableNamespaces,
    isConnected, clusterVersion,
  } = useClusterStore();

  const {
    sidebarCollapsed, toggleSidebar,
    dockCollapsed, toggleDock,
    inspectorCollapsed, toggleInspector,
    setPaletteOpen, setSettingsOpen,
    density, setDensity, resetLayout,
  } = useUiStore();

  const { openResourceList, toggleSplit } = useWorkspaceStore();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(0); // 0 = off

  const handleRefresh = () => {
    setIsRefreshing(true);
    toast.info('Synchronizing with cluster…');
    setTimeout(() => {
      setIsRefreshing(false);
      toast.success('Cluster Synchronized', `${currentContext || 'minikube'} · latest state`);
    }, 550);
  };

  const ctxItems: MenuItem[] = contexts.length
    ? contexts.map((c) => ({
        id: c.name,
        label: c.name,
        icon: Server,
        checked: c.name === currentContext,
        onSelect: () => onSelectContext(c.name),
      }))
    : [{ id: 'none', label: 'No contexts found', disabled: true }];

  const nsItems: MenuItem[] = [
    { id: 'all', label: 'All Namespaces', checked: selectedNamespace === 'all', onSelect: () => selectNamespace('all') },
    ...availableNamespaces.map((ns) => ({
      id: ns,
      label: ns,
      checked: selectedNamespace === ns,
      onSelect: () => selectNamespace(ns),
    })),
  ];

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
                'w-7 h-7 flex items-center justify-center rounded-[4px] transition-colors',
                open ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              )}
              title="Main Menu"
              aria-label="Main Menu"
            >
              <Menu size={15} />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                Kubiki IDE Menu
              </div>
              <MenuList items={mainMenuSections} onSelect={(item) => { item.onSelect?.(); close(); }} />
            </>
          )}
        </Popover>

        {/* Kubiki Brand Logo */}
        <div className="flex items-center gap-1.5 px-1">
          <span className="w-5 h-5 rounded-[4px] bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white text-[11px] font-bold shadow-xs shrink-0">
            ⎈
          </span>
          <span className="font-semibold text-[12.5px] tracking-tight text-[var(--text-primary)]">
            Kubiki
          </span>
          <span className="text-[9px] font-mono font-medium px-1 py-0.2 rounded bg-blue-500/15 text-blue-400 border border-blue-500/25">
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
                'flex items-center gap-1.5 h-[25px] px-2 rounded-[4px] text-[12px] font-medium transition-colors max-w-[210px]',
                open
                  ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              )}
              title="Switch Kubernetes Cluster Context"
            >
              <Circle
                size={8}
                strokeWidth={0}
                className={cx(
                  isConnected ? 'fill-[var(--status-ok)]' : 'fill-[var(--status-warn)]',
                  isConnected && 'animate-pulse'
                )}
              />
              <span className="truncate font-mono text-[11.5px]">{currentContext ?? 'No Context'}</span>
              <span className="text-[10px] text-[var(--text-muted)] font-mono">
                {clusterVersion ? `v${clusterVersion}` : ''}
              </span>
              <ChevronDown size={11} className="opacity-50 shrink-0 ml-0.5" />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Active Kubernetes Context
              </div>
              <MenuList items={ctxItems} onSelect={(item) => { item.onSelect?.(); close(); }} />
            </>
          )}
        </Popover>

        {/* Namespace Picker */}
        <Popover
          width={240}
          trigger={({ open }) => (
            <button
              className={cx(
                'flex items-center gap-1.5 h-[25px] px-2 rounded-[4px] text-[11.5px] transition-colors max-w-[170px]',
                open
                  ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              )}
              title="Namespace Scope"
            >
              <Layers size={12} className="text-violet-400 shrink-0" />
              <span className="truncate font-mono">
                {selectedNamespace === 'all' ? 'all-namespaces' : selectedNamespace}
              </span>
              <ChevronDown size={11} className="opacity-50 shrink-0" />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Namespace Scope
              </div>
              <MenuList items={nsItems} onSelect={(item) => { item.onSelect?.(); close(); }} />
            </>
          )}
        </Popover>
      </div>

      {/* Center: JetBrains "Search Everywhere" Widget */}
      <div className="flex-1 flex justify-center min-w-0 px-4">
        <button
          onClick={() => setPaletteOpen(true)}
          className="group flex items-center gap-2 h-[26px] w-[380px] max-w-full px-2.5 rounded-[5px] bg-[var(--bg-canvas)] border border-[var(--border-default)] hover:border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-all shadow-xs"
          title="Search Everywhere (Double Shift / ⌘K)"
        >
          <Command size={13} className="text-[var(--accent)] shrink-0" />
          <span className="text-xs flex-1 text-left truncate">
            Search resources, YAML, actions…
          </span>
          <kbd className="text-[10px] font-mono border border-[var(--border-default)] rounded px-1.5 py-0.5 bg-[var(--bg-surface)] text-[var(--text-secondary)] shadow-2xs">
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
              'flex items-center gap-1 h-[25px] px-2 rounded-[4px] text-[11.5px] transition-colors',
              'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            )}
            aria-label="Refresh"
          >
            <RefreshCw
              size={12}
              className={cx('shrink-0', isRefreshing && 'animate-spin text-[var(--accent)]')}
            />
            <span className="text-[11px] hidden md:inline">Sync</span>
          </button>
        </Tooltip>

        {/* Auto-refresh interval popover */}
        <Popover
          width={150}
          trigger={({ open }) => (
            <button
              className={cx(
                'flex items-center gap-1 h-[25px] px-1.5 rounded-[4px] text-[10.5px] font-mono transition-colors',
                open ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              )}
              title="Auto-refresh interval"
            >
              <Clock size={11} />
              <span>{autoRefreshInterval === 0 ? 'Manual' : `${autoRefreshInterval}s`}</span>
              <ChevronDown size={10} className="opacity-50" />
            </button>
          )}
        >
          {(close) => (
            <div className="py-1">
              <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
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
                  className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <span>{opt.label}</span>
                  {autoRefreshInterval === opt.val && <Check size={11} className="text-[var(--accent)]" />}
                </button>
              ))}
            </div>
          )}
        </Popover>

        <div className="h-4 w-px bg-[var(--border-default)] mx-1" />

        {/* JetBrains Layout Switcher: Left, Bottom, Right Tool Windows */}
        <div className="flex items-center bg-[var(--bg-primary)] p-0.5 rounded-[4px] border border-[var(--border-default)]">
          <Tooltip label={sidebarCollapsed ? 'Show Explorer (⌘B)' : 'Hide Explorer (⌘B)'} delay={300}>
            <button
              onClick={toggleSidebar}
              className={cx(
                'w-5 h-5 flex items-center justify-center rounded-[3px] transition-colors',
                !sidebarCollapsed ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
              aria-label="Toggle Explorer"
            >
              <PanelLeft size={12} />
            </button>
          </Tooltip>

          <Tooltip label={dockCollapsed ? 'Show Bottom Panel (⌘J)' : 'Hide Bottom Panel (⌘J)'} delay={300}>
            <button
              onClick={toggleDock}
              className={cx(
                'w-5 h-5 flex items-center justify-center rounded-[3px] transition-colors',
                !dockCollapsed ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
              aria-label="Toggle Bottom Panel"
            >
              <PanelBottom size={12} />
            </button>
          </Tooltip>

          <Tooltip label={inspectorCollapsed ? 'Show Details Panel' : 'Hide Details Panel'} delay={300}>
            <button
              onClick={toggleInspector}
              className={cx(
                'w-5 h-5 flex items-center justify-center rounded-[3px] transition-colors',
                !inspectorCollapsed ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
              aria-label="Toggle Details Panel"
            >
              <PanelRight size={12} />
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
