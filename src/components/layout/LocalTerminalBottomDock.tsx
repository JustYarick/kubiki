import React, { useEffect, useState } from 'react';
import {
  ChevronDown,
  Plus,
  Terminal as TerminalIcon,
  X,
  Maximize2,
  Minimize2,
  Laptop,
  ExternalLink,
} from 'lucide-react';
import { TerminalSessionPane } from '../k8s/TerminalSessionPane';
import { useDockStore } from '../../state/dock_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { useUiStore } from '../../state/ui_store';
import { uiPixels, uiFactor } from '../../core/appearance';
import { IconButton, Button } from '../ui/Button';
import { shortcutLabel } from '../../core/shortcuts';
import { cx } from '../../core/utils/cx';

export const LocalTerminalBottomDock: React.FC = () => {
  const {
    sessions: allSessions,
    activeSessionId,
    dockHeight,
    dockCollapsed,
    toggleDock,
    setDockHeight,
    closeSession,
    setActiveSession,
    openLocalTerminal,
  } = useDockStore();

  const sessions = allSessions.filter((s) => s.targetType === 'local');
  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

  const [visited, setVisited] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!dockCollapsed && activeSession) {
      setVisited((previous) => {
        if (previous.has(activeSession.id)) return previous;
        return new Set([...previous, activeSession.id]);
      });
    }
  }, [dockCollapsed, activeSession?.id]);

  const [isMaximized, setIsMaximized] = useState(false);
  const [prevHeight, setPrevHeight] = useState(dockHeight);

  const toggleMaximize = () => {
    if (isMaximized) {
      setDockHeight(prevHeight);
      setIsMaximized(false);
    } else {
      setPrevHeight(dockHeight);
      setDockHeight((window.innerHeight - 170) / uiFactor(useUiStore.getState().uiScale));
      setIsMaximized(true);
    }
  };

  if (dockCollapsed) {
    return (
      <div className="shrink-0 min-h-0">
        <button
          onClick={toggleDock}
          className="w-full h-7 flex items-center gap-2 px-3 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          aria-label="Expand bottom panel"
        >
          <TerminalIcon size="calc(12px * var(--ui-factor))" />
          <span>Local Terminal</span>
          <span className="text-[var(--text-muted)]">{sessions.length} open tabs</span>
          <span className="ml-auto text-[length:calc(10px*var(--ui-factor))]">{shortcutLabel('⌘J')}</span>
        </button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div
        className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col z-20 overflow-hidden font-sans"
        style={{ height: uiPixels(dockHeight), maxHeight: 'calc(100dvh - 170px)' }}
      >
        <div className="h-[calc(32px*var(--ui-factor))] shrink-0 flex items-center justify-between px-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] select-none">
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <TerminalIcon size="calc(13px * var(--ui-factor))" />
            <span className="font-semibold uppercase tracking-wider text-[length:calc(10px*var(--ui-factor))]">
              Local Terminal · no open sessions
            </span>
          </div>
          <div className="flex items-center gap-1">
            <IconButton
              icon={Plus}
              size="sm"
              onClick={() => openLocalTerminal()}
              tooltip="Open Local Terminal"
              aria-label="New Session"
            />
            <IconButton
              icon={ChevronDown}
              size="sm"
              onClick={toggleDock}
              tooltip="Collapse Panel (⌘J)"
              aria-label="Collapse"
            />
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-xs text-[var(--text-muted)] bg-[var(--bg-canvas)]">
          <Laptop size="calc(32px * var(--ui-factor))" className="text-[var(--text-muted)] mb-2 opacity-60" />
          <p className="mb-3 text-[var(--text-secondary)]">
            No local terminal sessions are open.
          </p>
          <Button size="sm" variant="primary" onClick={() => openLocalTerminal()}>
            <Laptop size="calc(12px * var(--ui-factor))" className="mr-1.5" /> Open Local Terminal (Host PC)
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col z-20 overflow-hidden font-sans"
      style={{ height: uiPixels(dockHeight), maxHeight: 'calc(100dvh - 170px)' }}
    >
      {/* Session Tab Strip */}
      <div className="h-[calc(32px*var(--ui-factor))] shrink-0 flex items-stretch border-b border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-x-auto overflow-y-hidden kubiki-scrollbar select-none">
        {sessions.map((s) => {
          const isActive = s.id === activeSession?.id;
          return (
            <div
              key={s.id}
              onClick={() => setActiveSession(s.id)}
              className={cx(
                'group relative flex items-center gap-1.5 px-3 min-w-[calc(130px*var(--ui-factor))] max-w-[calc(240px*var(--ui-factor))] h-full border-r border-[var(--border-default)] cursor-pointer transition-colors',
                isActive
                  ? 'bg-[var(--bg-canvas)] text-[var(--text-primary)] font-medium'
                  : 'bg-[var(--bg-inactive-tab)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              )}
              title={`${s.title} (${s.subtitle || ''})`}
            >
              {isActive && (
                <div className="absolute bottom-0 left-0 right-0 h-[calc(2px*var(--ui-factor))] bg-[var(--accent)]" />
              )}

              <Laptop size="calc(12px * var(--ui-factor))" className="shrink-0 text-sky-400" />

              <div className="flex flex-col min-w-0 flex-1 leading-tight text-left">
                <span className="truncate text-[length:calc(11.5px*var(--ui-factor))]">{s.title}</span>
                {s.subtitle && (
                  <span className="truncate text-[length:calc(9.5px*var(--ui-factor))] font-mono text-[var(--text-muted)]">
                    {s.subtitle}
                  </span>
                )}
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(s.id);
                }}
                className={cx(
                  'p-0.5 rounded hover:bg-[var(--bg-elevated)] hover:text-white transition-opacity ml-1',
                  isActive ? 'opacity-70 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-70'
                )}
                title="Close Session"
              >
                <X size="calc(11px * var(--ui-factor))" />
              </button>
            </div>
          );
        })}

        <div className="flex-1" />

        <div className="flex items-center px-1 gap-0.5 shrink-0 bg-[var(--bg-secondary)]">
          <IconButton
            icon={Plus}
            size="sm"
            onClick={() => openLocalTerminal()}
            tooltip="Open Local Terminal"
            aria-label="New Session"
          />

          {activeSession && (
            <IconButton
              icon={ExternalLink}
              size="sm"
              aria-label="Open terminal in tab"
              tooltip="Open a new terminal tab for this target"
              onClick={() => {
                useWorkspaceStore.getState().openTerminalSession({
                  ...activeSession,
                  id: `terminal-${crypto.randomUUID()}`,
                });
                useDockStore.getState().setDockCollapsed(true);
              }}
            />
          )}

          <IconButton
            icon={isMaximized ? Minimize2 : Maximize2}
            size="sm"
            onClick={toggleMaximize}
            tooltip={isMaximized ? 'Restore Height' : 'Maximize Panel'}
            aria-label="Maximize"
          />

          <IconButton
            icon={ChevronDown}
            size="sm"
            onClick={toggleDock}
            tooltip="Collapse Panel (⌘J)"
            aria-label="Collapse"
          />
        </div>
      </div>

      {/* Active Local Terminal Pane */}
      <div className="flex-1 min-h-0 relative bg-[var(--bg-canvas)]">
        {sessions
          .filter((session) => visited.has(session.id))
          .map((session) => {
            const visible = !dockCollapsed && session.id === activeSession?.id;
            return (
              <div key={session.id} hidden={!visible} className="h-full min-h-0">
                <TerminalSessionPane session={session} visible={visible} />
              </div>
            );
          })}
      </div>
    </div>
  );
};
