import { ContainerChoices } from '../k8s/ContainerLaunchDialog';
import { PFDialog } from '../dialogs/PFDialog';
import { stopPortForward, openForwardUrl } from '../../providers/port_forward';
import type { ResourceItem } from '../../types/k8s';
import { terminalFontStack } from '../../core/terminal_appearance';
import { useTerminalAppearance } from '../k8s/useTerminalAppearance';
import { shortcutLabel } from '../../core/shortcuts';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  ChevronDown,
  Eraser,
  Plus,
  RotateCw,
  Terminal as TerminalIcon,
  X,
  Maximize2,
  Minimize2,
  Box,
  Check,
  ArrowRightLeft,
  Laptop,
  Server,
  FileText,
} from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { LogBuffer, type LogLine } from '../../core/utils/log_buffer';
import { fetchLogSlice, type LogSliceParams } from '../../providers/tauri_logs';
import { resourceRef } from '../../core/resources/identity';
import { inNamespaceScope } from '../../core/resources/namespace_scope';
import { LogsToolbar } from '../k8s/LogsToolbar';
import { NodeShellPane } from '../k8s/NodeShellPane';
import { LiveTerminalPane } from '../k8s/LiveTerminalPane';
import { ContainerSelect } from '../k8s/ContainerSelect';
import { useSessionContainers } from '../k8s/useSessionContainers';
import { k8s } from '../../providers/k8s_provider';
import { usePfStore } from '../../state/pf_store';
import { useResourceStore } from '../../state/resource_store';
import { useClusterStore } from '../../state/cluster_store';
import { useDockStore, type DockSession } from '../../state/dock_store';
import { LOG_POLL_PRESETS, useUiStore } from '../../state/ui_store';
import { uiPixels, uiFactor } from '../../core/appearance';
import { IconButton } from '../ui/Button';
import { Button } from '../ui/Button';
import { Popover } from '../ui/Dropdown';
import { Modal } from '../ui/Modal';
import { SearchInput } from '../ui/Input';
import { toast } from '../../state/notifications_store';
import { fmtBytes, fmtElapsed } from '../../core/utils/fmt';
import { cx } from '../../core/utils/cx';

const ExpandedDock: React.FC = () => {
  const {
    sessions,
    activeSessionId,
    dockHeight,
    dockCollapsed,
    toggleDock,
    setDockHeight,
    closeSession,
    setActiveSession,
    openLocalTerminal,
    openNodeShell,
    openTerminal,
    openLogs,
    openPorts,
    openEvents,
  } = useDockStore();

  const pfCount = usePfStore((s) => s.sessions.length);
  const resources = useResourceStore((s) => s.resources);
  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

  const [visited, setVisited] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!dockCollapsed && activeSession) setVisited((previous) => {
      if (previous.has(activeSession.id)) return previous;
      return new Set([...previous, activeSession.id]);
    });
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

  const allPods = useMemo(() => Array.from(resources['Pod']?.values() || []), [resources]);
  const allNodes = useMemo(() => Array.from(resources['Node']?.values() || []), [resources]);

  if (sessions.length === 0) {
    return (
      <div
        className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col z-20 overflow-hidden font-sans"
        style={{ height: uiPixels(dockHeight), maxHeight: 'calc(100dvh - 170px)' }}
      >
        <div className="h-[calc(32px*var(--ui-factor))] shrink-0 flex items-center justify-between px-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] select-none">
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <TerminalIcon size="calc(13px * var(--ui-factor))" />
            <span className="font-semibold uppercase tracking-wider text-[length:calc(10px*var(--ui-factor))]">Bottom panel · no open sessions</span>
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
          <p className="mb-3 text-[var(--text-secondary)]">All bottom drawer tabs have been closed.</p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => openLocalTerminal()}>
              <Laptop size="calc(12px * var(--ui-factor))" className="mr-1.5" /> Open Local Terminal (Host PC)
            </Button>
            <Button size="sm" onClick={() => openPorts()}>
              <ArrowRightLeft size="calc(12px * var(--ui-factor))" className="mr-1.5" /> Port Forwarding
            </Button>
            <Button size="sm" onClick={() => openEvents()}>
              <Bell size="calc(12px * var(--ui-factor))" className="mr-1.5" /> Cluster Events
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const getSessionIcon = (s: DockSession) => {
    if (s.type === 'terminal') {
      if (s.targetType === 'local') return Laptop;
      if (s.targetType === 'node') return Server;
      return TerminalIcon;
    }
    if (s.type === 'logs') return FileText;
    if (s.type === 'ports') return ArrowRightLeft;
    return Bell;
  };

  const getSessionColor = (s: DockSession) => {
    if (s.type === 'terminal') {
      if (s.targetType === 'local') return 'text-sky-400';
      if (s.targetType === 'node') return 'text-amber-400';
      return 'text-emerald-400';
    }
    if (s.type === 'logs') return 'text-blue-400';
    if (s.type === 'ports') return 'text-amber-400';
    return 'text-purple-400';
  };

  return (
    <div
      className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col z-20 overflow-hidden font-sans"
      style={{ height: uiPixels(dockHeight), maxHeight: 'calc(100dvh - 170px)' }}
    >
      {/* Lens-Grade Multi-Session Tab Strip */}
      <div className="h-[calc(32px*var(--ui-factor))] shrink-0 flex items-stretch px-1 gap-0.5 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-x-auto overflow-y-hidden kubiki-scrollbar select-none">
        {sessions.map((s) => {
          const isActive = s.id === activeSessionId;
          const Icon = getSessionIcon(s);
          const iconColor = getSessionColor(s);

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

              <Icon
                size="calc(12px * var(--ui-factor))"
                className={cx('shrink-0', iconColor)}
              />

              <div className="flex flex-col min-w-0 flex-1 leading-tight text-left">
                <span className="truncate text-[length:calc(11.5px*var(--ui-factor))]">{s.title}</span>
                {s.subtitle && (
                  <span className="truncate text-[length:calc(9.5px*var(--ui-factor))] font-mono text-[var(--text-muted)]">
                    {s.subtitle}
                  </span>
                )}
              </div>

              {s.type === 'ports' && pfCount > 0 && (
                <span className="text-[length:calc(9.5px*var(--ui-factor))] font-mono px-1 rounded-full bg-[var(--status-ok)]/20 text-[var(--status-ok)]">
                  {pfCount}
                </span>
              )}

              {/* Unconditional close button for every session */}
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

        {/* Plus Button: Add New Session (Lens Style) */}
        <div className="flex items-center px-1 gap-0.5 shrink-0 bg-[var(--bg-secondary)]">
          <Popover
            width={260}
            trigger={({ open }) => (
              <IconButton
                icon={Plus}
                size="sm"
                active={open}
                tooltip="New Terminal, Logs, or Tool"
                aria-label="New Session"
              />
            )}
          >
            {(close) => (
              <div className="py-1 max-h-[calc(380px*var(--ui-factor))] overflow-y-auto kubiki-scrollbar">
                <div className="px-2.5 py-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                  Workstation &amp; Cluster Tools
                </div>
                <button
                  onClick={() => {
                    openLocalTerminal();
                    close();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                >
                  <Laptop size="calc(13px * var(--ui-factor))" className="text-sky-400" />
                  <div className="flex flex-col text-left">
                    <span className="font-medium">Local Terminal (Host PC)</span>
                    <span className="text-[length:calc(9.5px*var(--ui-factor))] text-[var(--text-muted)]">{k8s.demo ? 'Simulated local shell' : 'Your workstation · home directory'}</span>
                  </div>
                </button>
                <button
                  onClick={() => {
                    openPorts();
                    close();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                >
                  <ArrowRightLeft size="calc(13px * var(--ui-factor))" className="text-amber-400" />
                  <span>Port Forwarding Manager</span>
                </button>
                <button
                  onClick={() => {
                    openEvents();
                    close();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                >
                  <Bell size="calc(13px * var(--ui-factor))" className="text-purple-400" />
                  <span>Cluster Event Stream</span>
                </button>

                {/* Node Shells */}
                <div className="my-1 h-px bg-[var(--border-subtle)]" />
                <div className="px-2.5 py-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Node Shells (Cluster Nodes)
                </div>
                {allNodes.length === 0 ? (
                  <div className="px-3 py-2 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">No loaded nodes</div>
                ) : (
                  allNodes.slice(0, 6).map((node) => (
                    <button
                      key={node.uid}
                      onClick={() => {
                        openNodeShell(node.name);
                        close();
                      }}
                      className="w-full flex items-center justify-between px-2.5 py-1 text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Server size="calc(12px * var(--ui-factor))" className="text-amber-400 shrink-0" />
                        <span className="font-mono text-[length:calc(11px*var(--ui-factor))] truncate">{node.name}</span>
                      </div>
                      <span className="text-[length:calc(9.5px*var(--ui-factor))] font-mono px-1.5 py-0.2 rounded bg-[var(--bg-surface)] text-[var(--text-muted)]">
                        Shell
                      </span>
                    </button>
                  ))
                )}

                {/* Attach to Pod */}
                <div className="my-1 h-px bg-[var(--border-subtle)]" />
                <div className="px-2.5 py-1 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Attach to Running Pod
                </div>
                {allPods.length === 0 ? (
                  <div className="px-2.5 py-1 text-[length:calc(10.5px*var(--ui-factor))] text-[var(--text-muted)]">No pods found</div>
                ) : (
                  allPods.slice(0, 8).map((p) => (
                    <div key={p.uid} className="flex items-center justify-between px-2.5 py-1 hover:bg-[var(--bg-hover)] text-[length:calc(11px*var(--ui-factor))]">
                      <span className="font-mono truncate max-w-[calc(130px*var(--ui-factor))] text-[var(--text-secondary)]">{p.name}</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            openTerminal(p.name, p.namespace, undefined, p.containers?.map((c) => c.name));
                            close();
                          }}
                          className="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] hover:bg-[var(--accent)] hover:text-white text-[length:calc(10px*var(--ui-factor))]"
                        >
                          Shell
                        </button>
                        <button
                          onClick={() => {
                            openLogs(p.name, p.namespace, undefined, p.containers?.map((c) => c.name));
                            close();
                          }}
                          className="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] hover:bg-[var(--accent)] hover:text-white text-[length:calc(10px*var(--ui-factor))]"
                        >
                          Logs
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </Popover>

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

      {/* Active Session Content */}
      <div className="flex-1 min-h-0 relative bg-[var(--bg-canvas)]">
        {sessions.filter((session) => visited.has(session.id)).map((session) => {
          const visible = !dockCollapsed && session.id === activeSession?.id;
          return <div key={session.id} hidden={!visible} className="h-full min-h-0">
            {session.type === 'terminal' && <TerminalSessionPane session={session} visible={visible} />}
            {session.type === 'logs' && <LogsSessionPane session={session} visible={visible} />}
            {session.type === 'ports' && <PortsPane />}
            {session.type === 'events' && <EventsPane />}
          </div>;
        })}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Terminal Session Component                                         */
/* ------------------------------------------------------------------ */

export function TerminalSessionPane({ session, visible = true, onContainerChange }: { session: DockSession; visible?: boolean; onContainerChange?: (name: string) => void }) {
  const choice = useSessionContainers(session, true);
  if (choice.needsSelection) return <SessionContainerChoice session={session} shell onContainerChange={onContainerChange} />;
  if (!k8s.demo && session.targetType === 'node') return <NodeShellPane session={session} visible={visible} />;
  if (!k8s.demo && (session.targetType === 'pod' || session.targetType === 'local')) return <LiveTerminalPane session={session} visible={visible} onContainerChange={onContainerChange} />;
  if (!k8s.demo) return <div className="p-5 text-xs text-[var(--text-secondary)]">{session.targetType === 'node' ? 'Node debug shell requires a managed debug Pod; this transport is not connected yet.' : 'Local host PTY is not connected yet. Open Shell from a Pod to use Kubernetes exec.'}</div>;
  return <DemoTerminalSessionPane session={session} visible={visible} onContainerChange={onContainerChange} />;
}

function DemoTerminalSessionPane({ session, visible, onContainerChange }: { session: DockSession; visible: boolean; onContainerChange?: (name: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lineRef = useRef('');

  const podMap = useResourceStore((s) => s.resources['Pod']);
  const pods = useMemo(() => Array.from(podMap?.values() || []), [podMap]);
  const updateSessionContainer = useDockStore((s) => s.updateSessionContainer);

  const isLocal = session.targetType === 'local' || session.resourceName === 'localhost' || session.resourceName === 'local' || !session.resourceName;
  const isNode = session.targetType === 'node' || session.resourceName?.startsWith('node/');
  const isPod = !isLocal && !isNode;

  const activeContainer = session.container || (isLocal ? 'host' : isNode ? 'sh' : 'app');
  const [shellBinary, setShellBinary] = useState(isLocal ? '/bin/zsh' : '/bin/sh');

  const { containers } = useSessionContainers(session, true);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      fontFamily: terminalFontStack(useUiStore.getState().terminalFontFamily),
      fontSize: useUiStore.getState().terminalFontSize,
      lineHeight: useUiStore.getState().terminalLineHeight,
      theme: {
        background: '#1e1f22',
        foreground: '#dfe1e5',
        cursor: '#3574f0',
        selectionBackground: 'rgba(53, 116, 240, 0.35)',
        black: '#1e1f22',
        red: '#e05555',
        green: '#59a869',
        yellow: '#e5b742',
        blue: '#3574f0',
        magenta: '#b392f0',
        cyan: '#39c5bb',
        white: '#dfe1e5',
      },
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try { fit.fit(); } catch { /* Wait for visible dimensions. */ }
    termRef.current = term;
    fitRef.current = fit;
    term.focus();

    const ro = new ResizeObserver(() => { if (containerRef.current?.offsetHeight) fit.fit(); });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useTerminalAppearance(termRef, () => { if (containerRef.current?.offsetHeight) fitRef.current?.fit(); }, visible);

  useEffect(() => { if (visible && containerRef.current?.offsetHeight) { fitRef.current?.fit(); termRef.current?.focus(); } }, [visible]);

  const writePrompt = (term: XTerm) => {
    if (isLocal) {
      term.write(`\r\n\x1b[1;32mdemo@localhost\x1b[0m:\x1b[1;34m~\x1b[0m$ `);
    } else if (isNode) {
      term.write(`\r\n\x1b[1;33mroot@${session.resourceName || 'node'}\x1b[0m:\x1b[1;34m/\x1b[0m# `);
    } else {
      const hostStr = `${session.resourceName?.slice(0, 16)}:${activeContainer}`;
      term.write(`\r\n\x1b[32m${hostStr}\x1b[0m:\x1b[34m~\x1b[0m$ `);
    }
  };

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    let intro = '';
    if (isLocal) {
      intro = `\r\n\x1b[1;36mKubiki Local Terminal (Host PC)\x1b[0m — simulated shell session using \x1b[33m${shellBinary}\x1b[0m.\r\nWorkstation: \x1b[1;32mdemo@localhost\x1b[0m (demo workstation)\r\nType \`help\`, \`kubectl get pods\`, \`whoami\`, \`pwd\`, or any command.\r\n`;
    } else if (isNode) {
      intro = `\r\n\x1b[1;33mKubiki Node Shell\x1b[0m — simulated shell for node \x1b[1m${session.resourceName}\x1b[0m.\r\nDemo only. No debug container is created.\r\nType \`help\` or any node inspection command.\r\n`;
    } else {
      intro = `\r\n\x1b[1;32mDemo Pod shell for\x1b[0m \x1b[1m${session.resourceName}\x1b[0m (\x1b[36mcontainer: ${activeContainer}\x1b[0m, \x1b[35mns: ${session.namespace}\x1b[0m) using \x1b[33m${shellBinary}\x1b[0m.\r\nType \`help\` or any container command.\r\n`;
    }

    term.write(intro);
    writePrompt(term);
  }, [session.resourceName, activeContainer, shellBinary, isLocal, isNode]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const onData = term.onData((data) => {
      if (data === '\r') {
        terminalExec(lineRef.current, (s) => term.write(s), pods, isLocal, isNode, session.resourceName);
        lineRef.current = '';
        writePrompt(term);
        return;
      }
      if (data === '\u007f') {
        if (lineRef.current.length > 0) {
          lineRef.current = lineRef.current.slice(0, -1);
          term.write('\b \b');
        }
        return;
      }
      if (data === '\u0003') {
        lineRef.current = '';
        term.write('^C');
        writePrompt(term);
        return;
      }
      if (data >= ' ') {
        lineRef.current += data;
        term.write(data);
      }
    });

    return () => onData.dispose();
  }, [session.resourceName, activeContainer, pods, isLocal, isNode]);

  const resetSession = () => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.write('\x1b[2J\x1b[H');
    term.write('\r\nTerminal session restarted.\r\n');
    writePrompt(term);
    toast.info('Terminal session restarted');
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-canvas)]">
      {/* Target Info Header (Lens-grade) */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-2.5 py-1 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 text-xs">
        <div className="flex items-center gap-1.5">
          <span
            className={cx(
              'w-2 h-2 rounded-full shrink-0 animate-pulse',
              isLocal ? 'bg-sky-400' : isNode ? 'bg-amber-400' : 'bg-[var(--status-ok)]'
            )}
          />
          <span className="text-[var(--text-muted)]">Target:</span>
          {isLocal && (
            <div className="flex items-center gap-1 font-mono font-medium text-sky-400">
              <Laptop size="calc(12px * var(--ui-factor))" />
              <span>Local PC (localhost)</span>
            </div>
          )}
          {isNode && (
            <div className="flex items-center gap-1 font-mono font-medium text-amber-400">
              <Server size="calc(12px * var(--ui-factor))" />
              <span>Node Shell: {session.resourceName}</span>
            </div>
          )}
          {isPod && (
            <div className="flex items-center gap-1 font-mono font-medium text-[var(--text-primary)]">
              <Box size="calc(12px * var(--ui-factor))" className="text-emerald-400" />
              <span>{session.resourceName}</span>
            </div>
          )}
          {session.namespace && isPod && (
            <span className="text-[length:calc(10px*var(--ui-factor))] font-mono px-1.5 py-0.2 rounded bg-[var(--bg-surface)] text-[var(--text-muted)] border border-[var(--border-subtle)]">
              ns: {session.namespace}
            </span>
          )}
        </div>

        <div className="h-3.5 w-px bg-[var(--border-default)] mx-1" />

        {isPod && <ContainerSelect shell containers={containers} value={activeContainer} onChange={onContainerChange ?? ((name) => updateSessionContainer(session.id, name))} />}

        {/* Shell Binary Selector Dropdown */}
        <Popover
          width={150}
          trigger={({ open }) => (
            <button
              className={cx(
                'flex items-center gap-1 h-[calc(22px*var(--ui-factor))] px-1.5 rounded-[calc(3px*var(--ui-factor))] border text-[length:calc(10.5px*var(--ui-factor))] font-mono transition-colors',
                open ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-default)] text-[var(--text-secondary)]'
              )}
              title="Shell Binary"
            >
              <span>{shellBinary}</span>
              <ChevronDown size="calc(10px * var(--ui-factor))" className="opacity-60" />
            </button>
          )}
        >
          {(close) => (
            <div className="py-1">
              {(isLocal ? ['/bin/zsh', '/bin/bash', '/bin/sh'] : ['/bin/sh', '/bin/bash']).map((sh) => (
                <button
                  key={sh}
                  onClick={() => {
                    setShellBinary(sh);
                    close();
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-1 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  <span className="font-mono">{sh}</span>
                  {shellBinary === sh && <Check size="calc(11px * var(--ui-factor))" className="text-[var(--accent)]" />}
                </button>
              ))}
            </div>
          )}
        </Popover>

        <div className="flex-1" />

        <IconButton
          icon={RotateCw}
          size="sm"
          onClick={resetSession}
          tooltip="Restart Shell Session"
          aria-label="Restart"
        />
        <IconButton
          icon={Eraser}
          size="sm"
          tooltip="Clear Terminal Screen"
          onClick={() => {
            termRef.current?.clear();
            termRef.current?.write('\x1b[2J\x1b[H');
          }}
          aria-label="Clear"
        />
      </div>

      {/* Xterm Shell Output */}
      <div ref={containerRef} className="flex-1 min-h-0 pl-2 pt-1" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Logs Session Component                                             */
/* ------------------------------------------------------------------ */

const LOG_TEMPLATES = [
  ['info', 'GET /api/v1/items 200 in {ms}ms'],
  ['info', 'metrics flushed to prometheus: points={ms}'],
  ['info', 'ingress connection accepted from 10.42.{n}.{n}'],
  ['warn', 'retry attempt {n} for upstream endpoint payment-api'],
  ['warn', 'slow query execution detected: 8{n}ms'],
  ['error', 'dial tcp 10.43.0.25:5432: connection refused (retrying in 2s)'],
  ['info', 'readiness probe probe HTTP 200 OK (container healthy)'],
  ['warn', 'grpc keepalive timeout probe missed ({n})'],
];


function SessionContainerChoice({ session, shell = false, onContainerChange }: { session: DockSession; shell?: boolean; onContainerChange?: (name: string) => void }) {
  const { containers, recreated } = useSessionContainers(session, shell);
  return <div className="p-4 max-w-lg overflow-auto"><h3 className="text-sm font-medium mb-3">Choose container · {shell ? 'Shell' : 'Logs'}</h3>{recreated ? <p>This Pod was recreated. Open a new session from the current resource.</p> : <ContainerChoices containers={containers} shell={shell} onChoose={name => onContainerChange ? onContainerChange(name) : useDockStore.getState().updateSessionContainer(session.id, name)} />}</div>;
}
export function LogsSessionPane(props: { session: DockSession; visible?: boolean; onContainerChange?: (name: string) => void }) {
  const { needsSelection } = useSessionContainers(props.session);
  return needsSelection ? <SessionContainerChoice session={props.session} onContainerChange={props.onContainerChange} /> : <LogsSessionContent {...props} />;
}

function LogsSessionContent({ session, visible = true, onContainerChange }: { session: DockSession; visible?: boolean; onContainerChange?: (name: string) => void }) {
  const [error, setError] = useState('');
  const { containers, container: activeContainer, context, recreated, uid } = useSessionContainers(session);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  /* Session toggles initialized from the Logs page defaults in settings. */
  const [wrap, setWrap] = useState(() => useUiStore.getState().logsWrap);
  const [filter, setFilter] = useState('');
  const [showTimestamps, setShowTimestamps] = useState(() => useUiStore.getState().logsTimestamps);
  const [pollMs, setPollMs] = useState(() => useUiStore.getState().logsPollMs);

  const updateSessionContainer = useDockStore((s) => s.updateSessionContainer);
  const seqRef = useRef(1);
  const native = !k8s.demo && '__TAURI_INTERNALS__' in window;
  const [previous, setPrevious] = useState(false);
  const [tail, setTail] = useState(500);
  const [since, setSince] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState('Connecting');
  const [truncated, setTruncated] = useState(false);
  const bufferRef = useRef(new LogBuffer());
  const outputRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /* Keeps the loop on the live cadence without tearing down scrollback. */
  const pollRef = useRef(pollMs);
  pollRef.current = pollMs;

  /* Lens-style reads: a bounded initial slice, then cadence polls that resume
     after the newest timestamp and drop the refetched overlap by signature. */
  useEffect(() => {
    if (paused) { setPhase('Paused'); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const buffer = new LogBuffer(); bufferRef.current = buffer;
    setLines([]); setError(''); setTruncated(false); setPhase('Connecting'); pinned.current = true;
    let retries = 0;

    const run = async () => {
      if (cancelled) return;
      if (!visible) { timer = setTimeout(run, pollRef.current); return; }
      try {
        if (k8s.demo) {
          const [level, template] = LOG_TEMPLATES[seqRef.current % LOG_TEMPLATES.length];
          const msg = `[demo ${session.resourceName}/${activeContainer}] ` + template.replace('{ms}', '42').replace(/\{n\}/g, '3');
          const line = { t: new Date().toISOString().slice(11, 23), level, msg, seq: seqRef.current++ };
          setLines((current) => [...current, line].slice(-500));
        } else {
          if (recreated) throw new Error('The Pod was recreated. Open the current Pod to read its logs.');
          if (!context || !session.resourceName || !session.namespace) throw new Error('Select a Pod and namespace to view logs.');
          if (!activeContainer) throw new Error('Select a container to view logs.');
          let text: string;
          let replace = false;
          if (native) {
            if (!uid) throw new Error('A Pod with UID is required. Reopen logs from the current Pod.');
            const resource = resourceRef(context, { kind: 'Pod', apiVersion: 'v1', uid, name: session.resourceName, namespace: session.namespace });
            const last = buffer.lines[buffer.lines.length - 1]?.t ?? '';
            const params: LogSliceParams = last
              ? { resource, container: activeContainer, previous, since_time: last }
              : { resource, container: activeContainer, previous, tail_lines: tail, since_seconds: since || undefined };
            text = await fetchLogSlice(params);
          } else {
            text = await k8s.getLogs(context, session.resourceName, session.namespace, activeContainer);
            replace = true;
          }
          if (cancelled) return;
          if (replace) {
            /* Browser mode returns a whole snapshot; it always replaces history. */
            buffer.clear();
            buffer.push([...new TextEncoder().encode(text)], true);
          } else {
            /* The overlap from the last second is refetched; drop exact repeats. */
            const decoded = new LogBuffer();
            decoded.push([...new TextEncoder().encode(text)], true);
            const seen = new Set(buffer.lines.map((l) => `${l.t}\u0000${l.msg}`));
            for (const line of decoded.lines) {
              const signature = `${line.t}\u0000${line.msg}`;
              if (seen.has(signature)) continue;
              seen.add(signature);
              buffer.addLine(line.t ? `${line.t} ${line.msg}` : line.msg);
            }
          }
          setLines([...buffer.lines]); setTruncated(buffer.truncated);
          retries = 0;
          setError('');
          if (native && previous) { setPhase('Snapshot'); return; }
          setPhase(`Polling every ${Math.round(pollRef.current / 1000)}s`);
        }
      } catch (read) {
        if (cancelled) return;
        retries++;
        const message = read instanceof Error ? read.message : String(read);
        setPhase(retries >= 3 ? 'Failed' : `Stalled · retry ${retries} of 3`);
        setError(retries >= 3 ? `${message} · press Reconnect logs to retry` : message);
        if (retries >= 3) return;
      }
      if (cancelled) return;
      /* Failures back off (1×, 2×, 4×) and stop after three consecutive misses. */
      timer = setTimeout(run, pollRef.current * [1, 2, 4][Math.min(retries, 2)]);
    };
    void run();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [native, session.resourceName, session.namespace, uid, activeContainer, context, paused, previous, tail, since, generation, recreated, visible]);

  useEffect(() => {
    const output = outputRef.current;
    if (visible && pinned.current && output) output.scrollTop = output.scrollHeight;
  }, [lines, visible, filter]);

  const [filterRegex, setFilterRegex] = useState(false);
  const shown = useMemo(() => {
    if (!filter.trim()) return lines;
    if (filterRegex) {
      try {
        const rx = new RegExp(filter.trim(), 'i');
        return lines.filter((l) => rx.test(l.level + ' ' + l.msg));
      } catch {
        return [];
      }
    }
    const q = filter.toLowerCase();
    return lines.filter((l) => (l.level + ' ' + l.msg).toLowerCase().includes(q));
  }, [lines, filter, filterRegex]);

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-canvas)]">
      {error && <div role="alert" className="px-3 py-1 text-[var(--status-danger)] text-xs">{error}</div>}
      <div className="px-3 py-0.5 text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)]">{k8s.demo ? `Simulated logs · poll every ${Math.round(pollMs / 1000)}s` : native ? `${phase} · ${previous ? 'previous container snapshot' : `initial tail ${tail}`} · history up to 1000 lines` : `Browser snapshot · latest 500 lines · refresh every ${Math.round(pollMs / 1000)}s`}{truncated && ' · older or oversized output discarded'}</div>
      <LogsToolbar sourceControls={native ? <div className="border-t border-[var(--border-default)] p-2 space-y-2 text-xs">
        <label className="flex items-center gap-2"><input type="checkbox" checked={previous} onChange={(event) => setPrevious(event.target.checked)} />Previous container instance</label>
        <label className="flex items-center justify-between gap-2">Initial tail<select aria-label="Initial log tail" value={tail} onChange={(event) => setTail(Number(event.target.value))} className="bg-[var(--bg-primary)] p-1 rounded">{[100, 500, 1000].map((n) => <option key={n} value={n}>{n} lines</option>)}</select></label>
        <label className="flex items-center justify-between gap-2">Since<select aria-label="Log time range" value={since} onChange={(event) => setSince(Number(event.target.value))} className="bg-[var(--bg-primary)] p-1 rounded">{[[0, 'Any time'], [300, '5 minutes'], [3600, '1 hour'], [86400, '24 hours']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="flex items-center justify-between gap-2">Poll frequency<select aria-label="Log poll frequency" value={pollMs} onChange={(event) => { const value = Number(event.target.value); setPollMs(value); useUiStore.getState().setLogsPollMs(value); }} className="bg-[var(--bg-primary)] p-1 rounded">{LOG_POLL_PRESETS.map((value) => <option key={value} value={value}>{value / 1000}s</option>)}</select></label>
        <Button size="sm" onClick={() => { setPaused(false); setGeneration((value) => value + 1); }}>Reconnect logs</Button>
        <p className="text-[var(--text-muted)]">Reads reload the recent tail, then poll only lines after the newest timestamp. Previous logs are a snapshot.</p>
      </div> : undefined} name={session.resourceName} namespace={session.namespace} context={context} containers={containers} container={activeContainer}
        onContainer={onContainerChange ?? ((name) => updateSessionContainer(session.id, name))} filter={filter} onFilter={setFilter} isRegex={filterRegex} onToggleRegex={setFilterRegex}
        paused={paused} onPause={() => setPaused(!paused)} timestamps={showTimestamps} onTimestamps={() => setShowTimestamps(!showTimestamps)} wrap={wrap} onWrap={() => setWrap(!wrap)}
        onClear={() => { bufferRef.current.clear(); setLines([]); setTruncated(false); }} onDownload={() => {
          const blob = new Blob([lines.map((l) => `${l.t} ${l.msg}`).join('\n')], { type: 'text/plain' });
          const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${session.resourceName}-${activeContainer}.log`; anchor.click(); URL.revokeObjectURL(url);
        }} />

      {/* Log Output Body */}
      <div ref={outputRef} onScroll={() => { const el = outputRef.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }} className="flex-1 min-h-0 overflow-auto kubiki-scrollbar bg-[var(--bg-canvas)] px-3 py-2 select-text">
        {shown.length === 0 ? (
          <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] font-mono py-4 text-center">
            No logs matching filter “{filter}” for {session.resourceName}
          </div>
        ) : (
          <div className="font-mono text-[length:calc(11px*var(--ui-factor))] leading-[1.5]">
            {shown.map((l) => (
              <div
                key={l.seq}
                className={cx(
                  wrap ? 'whitespace-pre-wrap' : 'whitespace-nowrap',
                  l.level === 'error' ? 'text-[#e05555]' : l.level === 'warn' ? 'text-[#e5b742]' : 'text-[var(--text-primary)]'
                )}
              >
                {showTimestamps && (
                  <span className="text-[var(--text-muted)] select-none pr-2 font-mono">{l.t}</span>
                )}
                <span
                  className={cx(
                    'select-none pr-2 font-semibold',
                    l.level === 'error' ? 'text-[var(--status-danger)]' : l.level === 'warn' ? 'text-[var(--status-warn)]' : 'text-[var(--status-ok)]'
                  )}
                >
                  {l.level.toUpperCase().padEnd(5)}
                </span>
                <span>{l.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Terminal kubectl execution logic                                    */
/* ------------------------------------------------------------------ */

const PODS_LINE = (pods: { name: string; namespace?: string; status?: string; ready?: string }[]) => {
  const w = 52;
  let out = `NAME${' '.repeat(4)} READY  STATUS       RESTARTS  AGE\n`;
  for (const p of pods.slice(0, 12)) {
    const ready = (p.ready ?? '0/1').padEnd(6);
    const status = (p.status ?? 'Running').padEnd(12);
    out += `${p.name.padEnd(w)} ${ready} ${status} 0         3h\n`;
  }
  return out;
};

function terminalExec(
  input: string,
  write: (s: string) => void,
  pods: { name: string; namespace?: string; status?: string; ready?: string }[],
  isLocal = false,
  isNode = false,
  resourceName?: string
) {
  const cmd = input.trim();
  if (!cmd) return;
  const parts = cmd.split(/\s+/);

  if (cmd === 'clear') {
    write('\x1b[2J\x1b[H');
    return;
  }

  if (cmd === 'help') {
    if (isLocal) {
      write('\r\nLocal Commands: kubectl <get|describe|logs|exec|config>, whoami, pwd, ls, uname, hostname, date, clear, exit\r\n');
    } else if (isNode) {
      write('\r\nNode Commands: crictl ps, journalctl -u k3s, df -h, free -m, whoami, uname -a, clear, exit\r\n');
    } else {
      write('\r\nPod Commands: cat /etc/hosts, env, ps aux, ls -la, whoami, pwd, clear, exit\r\n');
    }
    return;
  }

  if (cmd === 'whoami') {
    write(`\r\n${isLocal ? 'yarick' : isNode ? 'root' : 'app'}\r\n`);
    return;
  }

  if (cmd === 'pwd') {
    write(`\r\n${isLocal ? '/home/yarick/my/myproject/kubiki' : isNode ? '/' : '/app'}\r\n`);
    return;
  }

  if (cmd === 'hostname') {
    write(`\r\n${isLocal ? 'localhost' : resourceName || 'k8s-node'}\r\n`);
    return;
  }

  if (cmd === 'uname' || cmd === 'uname -a') {
    write('\r\nLinux localhost 6.13.0-custom #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\r\n');
    return;
  }

  if (cmd === 'date') {
    write(`\r\n${new Date().toString()}\r\n`);
    return;
  }

  if (cmd === 'ls' || cmd === 'ls -la' || cmd === 'ls -l') {
    if (isLocal) {
      write('\r\ntotal 56\r\ndrwxr-xr-x 12 yarick users  4096 Oct 19 23:40 .\r\ndrwxr-xr-x  6 yarick users  4096 Oct 19 12:00 ..\r\n-rw-r--r--  1 yarick users  1420 Oct 19 21:10 Cargo.toml\r\n-rw-r--r--  1 yarick users 28540 Oct 19 21:10 Cargo.lock\r\ndrwxr-xr-x  4 yarick users  4096 Oct 19 20:30 crates\r\ndrwxr-xr-x  8 yarick users  4096 Oct 19 22:50 node_modules\r\n-rw-r--r--  1 yarick users  1890 Oct 19 22:15 package.json\r\n-rw-r--r--  1 yarick users 94210 Oct 19 22:15 pnpm-lock.yaml\r\ndrwxr-xr-x  2 yarick users  4096 Oct 19 19:10 public\r\ndrwxr-xr-x  8 yarick users  4096 Oct 19 23:30 src\r\n-rw-r--r--  1 yarick users   620 Oct 19 18:00 tsconfig.json\r\n-rw-r--r--  1 yarick users  1240 Oct 19 22:30 vite.config.ts\r\n');
    } else if (isNode) {
      write('\r\nbin  boot  dev  etc  home  lib  lib64  media  mnt  opt  proc  root  run  sbin  srv  sys  tmp  usr  var\r\n');
    } else {
      write('\r\nDockerfile  app.js  config.json  node_modules  package.json  src\r\n');
    }
    return;
  }

  if (parts[0] === 'kubectl') {
    if (parts[1] === 'version') {
      write('\r\nClient Version: v1.35.5+k3s1\r\nServer Version: v1.35.5+k3s1 (default)\r\n');
      return;
    }
    if (parts[1] === 'config' && parts[2] === 'get-contexts') {
      write('\r\nCURRENT   NAME      CLUSTER   AUTHINFO   NAMESPACE\r\n*         default   default   default    default\r\n');
      return;
    }
    if (parts[1] === 'get') {
      const kindWanted = (parts[2] ?? '').replace(/s$/, '').toLowerCase();
      if (kindWanted === 'node' || kindWanted === 'no') {
        write('\r\nNAME       STATUS   ROLES                  AGE   VERSION\r\ndefault    Ready    control-plane,master   3d    v1.35.5+k3s1\r\n');
        return;
      }
      const map: Record<string, string> = {
        pod: 'Pod',
        po: 'Pod',
        deploy: 'Deployment',
        deployment: 'Deployment',
        svc: 'Service',
        service: 'Service',
        cm: 'ConfigMap',
        configmap: 'ConfigMap',
        secret: 'Secret',
      };
      const resolved = map[kindWanted];
      if (!resolved) {
        write(`\r\nerror: unknown resource "${parts[2] ?? ''}" (try pods|nodes|deployments|services|configmaps|secrets)\r\n`);
        return;
      }
      const nsIdx = parts.indexOf('-n');
      const ns = nsIdx >= 0 ? parts[nsIdx + 1] : undefined;
      if (resolved === 'Pod') {
        write('\r\n' + PODS_LINE(ns ? pods.filter((p) => p.namespace === ns) : pods));
        return;
      }
      write(`\r\nShowing ${resolved}s in namespace ${ns || 'all'}\r\n`);
      return;
    }
  }

  write(`\r\n${cmd}: command executed\r\n`);
}

/* ------------------------------------------------------------------ */
/* Port Forwarding Session Pane                                        */
/* ------------------------------------------------------------------ */

function PortsPane() {
  const sessions = usePfStore((s) => s.sessions);
  const remove = usePfStore((s) => s.remove);
  const resources = useResourceStore(state => state.resources);
  const scope = useClusterStore((s) => s.selectedNamespace);
  const [addOpen, setAddOpen] = useState(false);
  const [targetSearch, setTargetSearch] = useState('');
  const [target, setTarget] = useState<ResourceItem | null>(null);
  const [stopping, setStopping] = useState<string>();
  const candidates = [...resources.Pod.values(), ...resources.Service.values()].filter(item => inNamespaceScope(scope, item.namespace) && (item.name.toLowerCase().includes(targetSearch.trim().toLowerCase()) || (item.namespace ?? '').toLowerCase().includes(targetSearch.trim().toLowerCase())));

  useEffect(() => {
    if (!k8s.demo) return;
    const iv = setInterval(() => usePfStore.getState().tick(), 800);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-canvas)]">
      <div className="h-8 shrink-0 flex items-center justify-between px-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50">
        <span className="text-[length:calc(11.5px*var(--ui-factor))] font-semibold text-[var(--text-secondary)]">Port forwarding ({sessions.length})</span>
        <Button size="sm" variant="primary" onClick={() => setAddOpen(true)}>
          <Plus size="calc(12px * var(--ui-factor))" /> Add Tunnel
        </Button>
      </div>

      <div className="flex-1 overflow-auto kubiki-scrollbar p-2">
        {sessions.length === 0 ? (
          <div className="text-center py-8 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">
            No active port forward sessions. Forward ports from Pods/Services or click Add Tunnel above.
          </div>
        ) : (
          <table className="datagrip-grid w-full table-fixed" aria-label="Port forward sessions">
            <thead>
              <tr>
                <th className="datagrip-th">Target / selected Pod</th>
                <th className="datagrip-th">Local URL / traffic</th>
                <th className="datagrip-th" style={{ width: uiPixels(58) }}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="datagrip-row">
                  <td className="datagrip-cell font-mono text-[var(--text-primary)] font-medium">
                    {s.targetKind}/{s.targetName}
                    <span className="block text-xs text-[var(--text-secondary)] whitespace-normal break-all">{s.namespace} · {s.context ?? 'Demo'}</span>
                    <span className="block text-xs text-[var(--text-secondary)] whitespace-normal break-all">{s.live ? `${s.phase} · ${s.podName}:${s.podPort}` : 'Demo · simulated'} · requested :{s.remotePort}</span>
                    {s.error && <span role="status" className="block text-xs text-[var(--status-warn)] whitespace-normal max-w-80">{s.error}</span>}
                  </td>
                  <td className="datagrip-cell font-mono">
                    <button className="text-[var(--accent)] hover:underline whitespace-normal break-all text-left" onClick={() => { if (!s.live) toast.info('Demo tunnel', 'No real listener is open'); else void openForwardUrl(s.localPort).catch(failure => toast.error('Could not open URL', String(failure))); }}>http://127.0.0.1:{s.localPort}</button>
                    <span className="block text-xs text-[var(--text-secondary)] whitespace-normal mt-1">TX {fmtBytes(s.bytesOut)} · RX {fmtBytes(s.bytesIn)}</span>
                    <span className="block text-xs text-[var(--text-secondary)]">{fmtElapsed(Math.max(0, Date.now() - s.startedAt))}</span>
                  </td>
                  <td className="datagrip-cell text-right">
                    <button
                      disabled={stopping === s.id} aria-label={`Stop forward ${s.targetName}`}
                      onClick={() => { setStopping(s.id); void (s.live ? stopPortForward(s.id) : Promise.resolve()).then(() => remove(s.id)).catch(failure => toast.error('Could not stop tunnel', String(failure))).finally(() => setStopping(undefined)); }}
                      className="px-1.5 py-0.5 rounded text-[length:calc(10.5px*var(--ui-factor))] text-[var(--status-danger)] hover:bg-[var(--status-danger)]/15"
                    >
                      Stop
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Choose a port-forward target" width={500}>
        <p className="text-xs text-[var(--text-secondary)] mb-3">Select a loaded Pod or Service in the current context. Use resource search and namespace scope to load another target.</p>
        <SearchInput value={targetSearch} onChange={setTargetSearch} placeholder="Find Pod or Service…" className="mb-2" /><p className="text-xs text-[var(--text-secondary)] mb-2">Showing {Math.min(100, candidates.length)} of {candidates.length}</p>
        <div className="max-h-80 overflow-auto kubiki-scrollbar">{candidates.slice(0, 100).map(item => <button key={`${item.kind}/${item.uid}`} className="w-full text-left px-2 py-2 hover:bg-[var(--bg-hover)] text-xs" onClick={() => { setTarget(item); setAddOpen(false); }}><span className="text-[var(--text-secondary)]">{item.kind} · {item.namespace}</span><span className="block font-mono break-all">{item.name}</span></button>)}{!candidates.length && <p className="text-xs">No Pod or Service snapshots loaded.</p>}</div>
      </Modal>
      {target && <PFDialog item={target} onClose={() => setTarget(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Events Session Pane                                                */
/* ------------------------------------------------------------------ */

interface ClusterEvent {
  id: string;
  type: 'Normal' | 'Warning';
  reason: string;
  object: string;
  message: string;
  count: number;
  age: string;
}

const MOCK_EVENTS: ClusterEvent[] = [
  { id: 'ev-1', type: 'Normal', reason: 'Scheduled', object: 'Pod/web-frontend-5d8b7c6f84-v8n7m', message: 'Successfully assigned frontend/web-frontend to node-1b', count: 1, age: '3m' },
  { id: 'ev-2', type: 'Normal', reason: 'Pulling', object: 'Pod/web-frontend-5d8b7c6f84-v8n7m', message: 'Pulling image "ghcr.io/kubiki/web:v0.34.0"', count: 1, age: '2m' },
  { id: 'ev-3', type: 'Normal', reason: 'Pulled', object: 'Pod/web-frontend-5d8b7c6f84-v8n7m', message: 'Successfully pulled image in 1.42s', count: 1, age: '2m' },
  { id: 'ev-4', type: 'Warning', reason: 'FailedMount', object: 'Pod/backup-worker-0', message: 'MountVolume.SetUp failed for volume "backup-cache": pvc pending', count: 4, age: '4m' },
  { id: 'ev-5', type: 'Normal', reason: 'ScalingReplicaSet', object: 'Deployment/api-gateway', message: 'Scaled up replica set api-gateway-7f98c76b9 to 1', count: 1, age: '14m' },
  { id: 'ev-6', type: 'Warning', reason: 'BackOff', object: 'Pod/payment-worker-6789b-9876x', message: 'Back-off restarting failed container worker in pod', count: 12, age: '18m' },
];

function EventsPane() {
  const events = useResourceStore((s) => s.resources.Event);
  const loadError = useResourceStore((s) => s.loadErrors.Event);
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'All' | 'Normal' | 'Warning'>('All');

  const filtered = useMemo(() => {
    let list: ClusterEvent[] = k8s.demo ? MOCK_EVENTS : [...events.values()].map((event) => {
      const raw = event.raw ?? {};
      const ref = raw.involvedObject ?? raw.regarding ?? {};
      return { id: event.uid, type: raw.type === 'Warning' ? 'Warning' : 'Normal', reason: raw.reason ?? '', object: `${ref.kind ?? ''}/${ref.name ?? ''}`, message: raw.message ?? raw.note ?? '', count: raw.count ?? raw.series?.count ?? 1, age: event.age ?? '—' };
    });
    if (typeFilter !== 'All') list = list.filter((e) => e.type === typeFilter);
    if (filter) {
      const q = filter.toLowerCase();
      list = list.filter((e) => (e.reason + ' ' + e.object + ' ' + e.message).toLowerCase().includes(q));
    }
    return list;
  }, [typeFilter, filter, events]);

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-canvas)]">
      <div className="h-8 shrink-0 flex items-center gap-2 px-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 text-xs">
        <span className="font-semibold text-[var(--text-secondary)]">Cluster Event Log</span>
        <div className="flex items-center gap-1 bg-[var(--bg-canvas)] p-0.5 rounded border border-[var(--border-default)]">
          {(['All', 'Warning', 'Normal'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={cx(
                'px-2 py-0.5 rounded text-[length:calc(10.5px*var(--ui-factor))]',
                typeFilter === t ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter events…" className="w-[calc(180px*var(--ui-factor))] h-[calc(22px*var(--ui-factor))]" />
      </div>

      {loadError && <div role="alert" className="p-2 text-[var(--status-warn)] text-xs">{loadError.message}</div>}
      <div className="flex-1 overflow-auto kubiki-scrollbar p-2">
        <table className="datagrip-grid w-full">
          <thead>
            <tr>
              <th className="datagrip-th w-[calc(90px*var(--ui-factor))]">Type</th>
              <th className="datagrip-th w-[calc(130px*var(--ui-factor))]">Reason</th>
              <th className="datagrip-th w-[calc(240px*var(--ui-factor))]">Resource</th>
              <th className="datagrip-th">Message</th>
              <th className="datagrip-th w-[calc(60px*var(--ui-factor))] text-right">Count</th>
              <th className="datagrip-th w-[calc(80px*var(--ui-factor))] text-right">Age</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id} className="datagrip-row">
                <td className="datagrip-cell">
                  <span
                    className={cx(
                      'text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase px-1.5 py-0.5 rounded',
                      e.type === 'Warning' ? 'bg-[var(--status-warn)]/15 text-[var(--status-warn)]' : 'bg-[var(--status-ok)]/15 text-[var(--status-ok)]'
                    )}
                  >
                    {e.type}
                  </span>
                </td>
                <td className="datagrip-cell font-mono text-[var(--text-primary)] font-medium">{e.reason}</td>
                <td className="datagrip-cell font-mono text-[var(--text-secondary)]">{e.object}</td>
                <td className="datagrip-cell text-[var(--text-primary)]">{e.message}</td>
                <td className="datagrip-cell text-right font-mono text-[var(--text-muted)]">{e.count}</td>
                <td className="datagrip-cell text-right font-mono text-[var(--text-muted)]">{e.age}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BottomDock() {
  const { dockCollapsed, toggleDock, sessions } = useDockStore();
  return <div className="shrink-0 min-h-0">
    {dockCollapsed && <button onClick={toggleDock} className="w-full h-7 flex items-center gap-2 px-3 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]" aria-label="Expand bottom panel"><TerminalIcon size="calc(12px * var(--ui-factor))" /><span>Bottom panel</span><span className="text-[var(--text-muted)]">{sessions.length} open tabs</span><span className="ml-auto text-[length:calc(10px*var(--ui-factor))]">{shortcutLabel('⌘J')}</span></button>}
    <div hidden={dockCollapsed}><ExpandedDock /></div>
  </div>;
}
