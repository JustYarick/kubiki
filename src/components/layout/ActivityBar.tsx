import { usePanelRegistry, openWorkspacePanel } from '../../core/workspace_panels';
import React from 'react';
import {
  FolderOpen,
  PanelRight,
  Search,
  Settings,
  Terminal,
} from 'lucide-react';
import { useDockStore } from '../../state/dock_store';
import { useUiStore } from '../../state/ui_store';
import { Tooltip } from '../ui/Button';
import { cx } from '../../core/utils/cx';
import { activeWorkspaceArea, areaHasInspector } from '../../core/workspace_areas';
import { useWorkspaceStore } from '../../state/workspace_store';

export const ActivityBar: React.FC = () => {
  const panels = usePanelRegistry(s => s.panels);
  const area = useWorkspaceStore(activeWorkspaceArea);
  const { dockCollapsed, toggleDock } = useDockStore();
  const {
    toggleInspector,
    inspectorCollapsed,
    setPaletteOpen,
    setSettingsOpen,
  } = useUiStore();

  return (
    <aside className="w-10 bg-[var(--bg-secondary)] border-r border-[var(--border-default)] flex flex-col items-center py-2 shrink-0 select-none z-20">
      {/* Top tool window buttons */}
      <div className="flex flex-col items-center gap-1 w-full">
        <Tooltip label="Cluster Explorer (⌘B)" side="bottom" delay={300}>
          <button
            onClick={() => { useWorkspaceStore.getState().activateArea('explorer'); useUiStore.setState({ sidebarCollapsed: false }); }}
            aria-label="Cluster Explorer"
            aria-pressed={area === 'explorer'}
            className={cxRail(area === 'explorer')}
          >
            <FolderOpen size="calc(16px * var(--ui-factor))" strokeWidth={1.75} />
            {area === 'explorer' && (
              <span className="absolute left-0 top-1 bottom-1 w-[calc(2px*var(--ui-factor))] bg-[var(--accent)] rounded-r" />
            )}
          </button>
        </Tooltip>

        <Tooltip label="Search Everywhere (⌘K)" side="bottom" delay={300}>
          <button
            onClick={() => setPaletteOpen(true)}
            aria-label="Search Everywhere"
            className={cxRail(false)}
          >
            <Search size="calc(16px * var(--ui-factor))" strokeWidth={1.75} />
          </button>
        </Tooltip>
      </div>

      {panels.map(panel => <Tooltip key={panel.id} label={panel.title} side="bottom" delay={300}><button className={cxRail(area === panel.id)} aria-label={panel.title} aria-pressed={area === panel.id} onClick={() => openWorkspacePanel(panel)}><panel.icon size="calc(16px * var(--ui-factor))" />{area === panel.id && <span className="absolute left-0 top-1 bottom-1 w-[calc(2px*var(--ui-factor))] bg-[var(--accent)] rounded-r" />}</button></Tooltip>)}
      {/* Bottom tool window buttons */}
      <div className="flex flex-col items-center gap-1 w-full mt-auto">
        <Tooltip label={dockCollapsed ? 'Bottom Panel (⌘J)' : 'Hide Bottom Panel (⌘J)'} side="top" delay={300}>
          <button
            onClick={toggleDock}
            aria-label="Toggle Bottom Panel"
            className={cxRail(!dockCollapsed)}
          >
            <Terminal size="calc(16px * var(--ui-factor))" strokeWidth={1.75} />
            {!dockCollapsed && (
              <span className="absolute left-0 top-1 bottom-1 w-[calc(2px*var(--ui-factor))] bg-[var(--accent)] rounded-r" />
            )}
          </button>
        </Tooltip>

        <Tooltip label={inspectorCollapsed ? 'Show Details Inspector' : 'Hide Details Inspector'} side="top" delay={300}>
          <button
            onClick={toggleInspector}
            disabled={!areaHasInspector(area)}
            aria-label="Toggle Inspector"
            className={cx(cxRail(areaHasInspector(area) && !inspectorCollapsed), 'disabled:opacity-40')}
          >
            <PanelRight size="calc(16px * var(--ui-factor))" strokeWidth={1.75} />
            {areaHasInspector(area) && !inspectorCollapsed && (
              <span className="absolute left-0 top-1 bottom-1 w-[calc(2px*var(--ui-factor))] bg-[var(--accent)] rounded-r" />
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
            <Settings size="calc(16px * var(--ui-factor))" strokeWidth={1.75} />
          </button>
        </Tooltip>
      </div>
    </aside>
  );
};

const cxRail = (active: boolean): string =>
  cx(
    'relative w-8 h-8 flex items-center justify-center rounded-[calc(4px*var(--ui-factor))] transition-all',
    active
      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
  );
