import React from 'react';
import {
  FolderOpen,
  PanelRight,
  Search,
  Settings,
  Terminal,
} from 'lucide-react';
import { useUiStore } from '../../state/ui_store';
import { Tooltip } from '../ui/Button';
import { cx } from '../../core/utils/cx';

export const ActivityBar: React.FC = () => {
  const {
    sidebarCollapsed,
    toggleSidebar,
    toggleInspector,
    inspectorCollapsed,
    toggleDock,
    dockCollapsed,
    setPaletteOpen,
    setSettingsOpen,
  } = useUiStore();

  return (
    <aside className="w-10 bg-[var(--bg-secondary)] border-r border-[var(--border-default)] flex flex-col items-center py-2 shrink-0 select-none z-20">
      {/* Top tool window buttons */}
      <div className="flex flex-col items-center gap-1 w-full">
        <Tooltip label={sidebarCollapsed ? 'Cluster Explorer (⌘B)' : 'Hide Explorer (⌘B)'} side="bottom" delay={300}>
          <button
            onClick={toggleSidebar}
            aria-label="Cluster Explorer"
            className={cxRail(!sidebarCollapsed)}
          >
            <FolderOpen size={16} strokeWidth={1.75} />
            {!sidebarCollapsed && (
              <span className="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--accent)] rounded-r" />
            )}
          </button>
        </Tooltip>

        <Tooltip label="Search Everywhere (⌘K)" side="bottom" delay={300}>
          <button
            onClick={() => setPaletteOpen(true)}
            aria-label="Search Everywhere"
            className={cxRail(false)}
          >
            <Search size={16} strokeWidth={1.75} />
          </button>
        </Tooltip>
      </div>

      {/* Bottom tool window buttons */}
      <div className="flex flex-col items-center gap-1 w-full mt-auto">
        <Tooltip label={dockCollapsed ? 'Terminal & Services (⌘J)' : 'Hide Terminal & Services (⌘J)'} side="top" delay={300}>
          <button
            onClick={toggleDock}
            aria-label="Toggle Terminal & Services"
            className={cxRail(!dockCollapsed)}
          >
            <Terminal size={16} strokeWidth={1.75} />
            {!dockCollapsed && (
              <span className="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--accent)] rounded-r" />
            )}
          </button>
        </Tooltip>

        <Tooltip label={inspectorCollapsed ? 'Show Details Inspector' : 'Hide Details Inspector'} side="top" delay={300}>
          <button
            onClick={toggleInspector}
            aria-label="Toggle Inspector"
            className={cxRail(!inspectorCollapsed)}
          >
            <PanelRight size={16} strokeWidth={1.75} />
            {!inspectorCollapsed && (
              <span className="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--accent)] rounded-r" />
            )}
          </button>
        </Tooltip>

        <div className="w-6 h-px bg-[var(--border-default)] my-1" />

        <Tooltip label="IDE Settings" side="top" delay={300}>
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            className={cxRail(false)}
          >
            <Settings size={16} strokeWidth={1.75} />
          </button>
        </Tooltip>
      </div>
    </aside>
  );
};

const cxRail = (active: boolean): string =>
  cx(
    'relative w-8 h-8 flex items-center justify-center rounded-[4px] transition-all',
    active
      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
  );
