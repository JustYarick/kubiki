import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  ChevronDown,
  Download,
  Eraser,
  Pause,
  Play,
  Plus,
  RotateCw,
  Terminal as TerminalIcon,
  WrapText,
  X,
  ArrowDownToLine,
  Maximize2,
  Minimize2,
  Clock,
  Box,
  Check,
  ArrowRightLeft,
} from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { usePfStore } from '../../state/pf_store';
import { useResourceStore } from '../../state/resource_store';
import { useDockStore, type DockSession } from '../../state/dock_store';
import { IconButton } from '../ui/Button';
import { Button } from '../ui/Button';
import { Popover } from '../ui/Dropdown';
import { Modal } from '../ui/Modal';
import { Input, SearchInput, Label } from '../ui/Input';
import { toast } from '../../state/notifications_store';
import { fmtBytes, fmtElapsed } from '../../core/utils/fmt';
import { cx } from '../../core/utils/cx';

export const BottomDock: React.FC = () => {
  const {
    sessions,
    activeSessionId,
    dockHeight,
    dockCollapsed,
    toggleDock,
    setDockHeight,
    closeSession,
    setActiveSession,
    openTerminal,
    openLogs,
    openPorts,
    openEvents,
  } = useDockStore();

  const pfCount = usePfStore((s) => s.sessions.length);
  const resources = useResourceStore((s) => s.resources);
  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

  const [isMaximized, setIsMaximized] = useState(false);
  const [prevHeight, setPrevHeight] = useState(dockHeight);

  const toggleMaximize = () => {
    if (isMaximized) {
      setDockHeight(prevHeight);
      setIsMaximized(false);
    } else {
      setPrevHeight(dockHeight);
      setDockHeight(Math.floor(window.innerHeight * 0.7));
      setIsMaximized(true);
    }
  };

  const allPods = useMemo(() => Array.from(resources['Pod']?.values() || []), [resources]);

  if (dockCollapsed) {
    return (
      <div
        onClick={toggleDock}
        className="shrink-0 h-[28px] border-t border-[var(--border-default)] bg-[var(--bg-secondary)] flex items-center px-3 gap-2 select-none cursor-pointer hover:bg-[var(--bg-hover)] transition-colors z-20"
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
          Terminal &amp; Logs Drawer
        </span>
        <div className="h-3 w-px bg-[var(--border-default)]" />
        <span className="text-[11px] font-mono text-[var(--text-secondary)]">
          {activeSession?.title || 'Terminal'}
        </span>
        <span className="text-[10px] text-[var(--text-muted)]">
          ({sessions.length} active sessions)
        </span>
        <div className="flex-1" />
        <IconButton
          icon={ChevronDown}
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            toggleDock();
          }}
          tooltip="Expand Drawer (⌘J)"
          className="rotate-180"
          aria-label="Expand"
        />
      </div>
    );
  }

  const getSessionIcon = (type: DockSession['type']) => {
    if (type === 'terminal') return TerminalIcon;
    if (type === 'logs') return ArrowDownToLine;
    if (type === 'ports') return ArrowRightLeft;
    return Bell;
  };

  return (
    <div
      className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col z-20 overflow-hidden font-sans"
      style={{ height: dockHeight }}
    >
      {/* Lens-Grade Multi-Session Tab Strip */}
      <div className="h-[32px] shrink-0 flex items-stretch px-1 gap-0.5 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-x-auto overflow-y-hidden kubiki-scrollbar select-none">
        {sessions.map((s) => {
          const isActive = s.id === activeSessionId;
          const Icon = getSessionIcon(s.type);

          return (
            <div
              key={s.id}
              onClick={() => setActiveSession(s.id)}
              className={cx(
                'group relative flex items-center gap-1.5 px-3 min-w-[130px] max-w-[240px] h-full border-r border-[var(--border-default)] cursor-pointer transition-colors',
                isActive
                  ? 'bg-[var(--bg-canvas)] text-[var(--text-primary)] font-medium'
                  : 'bg-[var(--bg-inactive-tab)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              )}
              title={`${s.title} (${s.subtitle || ''})`}
            >
              {isActive && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
              )}

              <Icon
                size={12}
                className={cx(
                  'shrink-0',
                  s.type === 'terminal' && 'text-emerald-400',
                  s.type === 'logs' && 'text-blue-400',
                  s.type === 'ports' && 'text-amber-400',
                  s.type === 'events' && 'text-purple-400'
                )}
              />

              <div className="flex flex-col min-w-0 flex-1 leading-tight text-left">
                <span className="truncate text-[11.5px]">{s.title}</span>
                {s.subtitle && (
                  <span className="truncate text-[9.5px] font-mono text-[var(--text-muted)]">
                    {s.subtitle}
                  </span>
                )}
              </div>

              {s.type === 'ports' && pfCount > 0 && (
                <span className="text-[9.5px] font-mono px-1 rounded-full bg-[var(--status-ok)]/20 text-[var(--status-ok)]">
                  {pfCount}
                </span>
              )}

              {!s.pinned && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(s.id);
                  }}
                  className={cx(
                    'p-0.5 rounded hover:bg-[var(--bg-elevated)] hover:text-white transition-opacity',
                    isActive ? 'opacity-70 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-70'
                  )}
                  title="Close Session"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          );
        })}

        <div className="flex-1" />

        {/* Plus Button: Add New Session (Lens Style) */}
        <div className="flex items-center px-1 gap-0.5 shrink-0 bg-[var(--bg-secondary)]">
          <Popover
            width={240}
            trigger={({ open }) => (
              <IconButton
                icon={Plus}
                size="sm"
                active={open}
                tooltip="New Terminal or Log Session"
                aria-label="New Session"
              />
            )}
          >
            {(close) => (
              <div className="py-1">
                <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                  Start New Session
                </div>
                <button
                  onClick={() => {
                    openTerminal('host', 'default', 'sh');
                    close();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                >
                  <TerminalIcon size={12} className="text-emerald-400" />
                  <span>Host Terminal (Node Shell)</span>
                </button>
                <button
                  onClick={() => {
                    openPorts();
                    close();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                >
                  <ArrowRightLeft size={12} className="text-amber-400" />
                  <span>Port Forwarding Manager</span>
                </button>
                <button
                  onClick={() => {
                    openEvents();
                    close();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                >
                  <Bell size={12} className="text-purple-400" />
                  <span>Cluster Event Stream</span>
                </button>

                <div className="my-1 h-px bg-[var(--border-subtle)]" />
                <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Attach to Running Pod
                </div>
                {allPods.slice(0, 8).map((p) => (
                  <div key={p.uid} className="flex items-center justify-between px-2.5 py-1 hover:bg-[var(--bg-hover)] text-[11px]">
                    <span className="font-mono truncate max-w-[130px] text-[var(--text-secondary)]">{p.name}</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          openTerminal(p.name, p.namespace, p.containers?.[0]?.name || 'app', p.containers?.map((c) => c.name));
                          close();
                        }}
                        className="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] hover:bg-[var(--accent)] hover:text-white text-[10px]"
                      >
                        Shell
                      </button>
                      <button
                        onClick={() => {
                          openLogs(p.name, p.namespace, p.containers?.[0]?.name || 'app', p.containers?.map((c) => c.name));
                          close();
                        }}
                        className="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] hover:bg-[var(--accent)] hover:text-white text-[10px]"
                      >
                        Logs
                      </button>
                    </div>
                  </div>
                ))}
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
        {activeSession.type === 'terminal' && <TerminalSessionPane key={activeSession.id} session={activeSession} />}
        {activeSession.type === 'logs' && <LogsSessionPane key={activeSession.id} session={activeSession} />}
        {activeSession.type === 'ports' && <PortsPane />}
        {activeSession.type === 'events' && <EventsPane visible={true} />}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Terminal Session Component                                         */
/* ------------------------------------------------------------------ */

function TerminalSessionPane({ session }: { session: DockSession }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lineRef = useRef('');

  const podMap = useResourceStore((s) => s.resources['Pod']);
  const pods = useMemo(() => Array.from(podMap?.values() || []), [podMap]);
  const updateSessionContainer = useDockStore((s) => s.updateSessionContainer);

  const [activeContainer, setActiveContainer] = useState(session.container || 'app');
  const [shellBinary, setShellBinary] = useState('/bin/sh');

  const containers = session.allContainers && session.allContainers.length > 0
    ? session.allContainers
    : ['app', 'istio-proxy'];

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
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
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    term.focus();

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  const writePrompt = (term: XTerm) => {
    const isHost = session.resourceName?.startsWith('node/') || session.resourceName === 'host';
    const hostStr = isHost ? 'yarick@kubiki' : `${session.resourceName?.slice(0, 16)}:${activeContainer}`;
    term.write(`\r\n\x1b[32m${hostStr}\x1b[0m:\x1b[34m~\x1b[0m$ `);
  };

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const isHost = session.resourceName?.startsWith('node/') || session.resourceName === 'host';
    const intro = isHost
      ? '\r\n\x1b[1mKubiki Node Shell Session\x1b[0m — interactive kubectl sandbox. Type `help`.\r\n'
      : `\r\n\x1b[1;32mConnected to Pod\x1b[0m \x1b[1m${session.resourceName}\x1b[0m (\x1b[36mcontainer: ${activeContainer}\x1b[0m, \x1b[35mns: ${session.namespace}\x1b[0m) using \x1b[33m${shellBinary}\x1b[0m.\r\nType \`help\` or any shell command.\r\n`;

    term.write(intro);
    writePrompt(term);
  }, [session.resourceName, activeContainer, shellBinary]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const onData = term.onData((data) => {
      if (data === '\r') {
        terminalExec(lineRef.current, (s) => term.write(s), pods);
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
  }, [session.resourceName, activeContainer, pods]);

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
      <div className="h-8 shrink-0 flex items-center gap-2 px-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-[var(--status-ok)] shrink-0 animate-pulse" />
          <span className="text-[var(--text-muted)]">Target:</span>
          <span className="font-mono font-medium text-[var(--text-primary)]">
            {session.resourceName}
          </span>
          {session.namespace && (
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--bg-surface)] text-[var(--text-muted)] border border-[var(--border-subtle)]">
              ns: {session.namespace}
            </span>
          )}
        </div>

        <div className="h-3.5 w-px bg-[var(--border-default)] mx-1" />

        {/* Container Selector Dropdown (Fixed Popover) */}
        <Popover
          width={200}
          trigger={({ open }) => (
            <button
              className={cx(
                'flex items-center gap-1 h-[22px] px-2 rounded-[3px] border text-[11px] font-mono transition-colors',
                open ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
              )}
              title="Select Container"
            >
              <Box size={11} className="text-blue-400" />
              <span>{activeContainer}</span>
              <ChevronDown size={10} className="opacity-60" />
            </button>
          )}
        >
          {(close) => (
            <div className="py-1">
              <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Select Container
              </div>
              {containers.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setActiveContainer(c);
                    updateSessionContainer(session.id, c);
                    toast.info(`Switched to container: ${c}`);
                    close();
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <span className="font-mono">{c}</span>
                  {activeContainer === c && <Check size={11} className="text-[var(--accent)]" />}
                </button>
              ))}
            </div>
          )}
        </Popover>

        {/* Shell Binary Selector Dropdown */}
        <Popover
          width={150}
          trigger={({ open }) => (
            <button
              className={cx(
                'flex items-center gap-1 h-[22px] px-1.5 rounded-[3px] border text-[10.5px] font-mono transition-colors',
                open ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-default)] text-[var(--text-secondary)]'
              )}
              title="Shell Binary"
            >
              <span>{shellBinary}</span>
              <ChevronDown size={10} className="opacity-60" />
            </button>
          )}
        >
          {(close) => (
            <div className="py-1">
              {['/bin/sh', '/bin/bash', '/bin/zsh'].map((sh) => (
                <button
                  key={sh}
                  onClick={() => {
                    setShellBinary(sh);
                    close();
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  <span className="font-mono">{sh}</span>
                  {shellBinary === sh && <Check size={11} className="text-[var(--accent)]" />}
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

interface LogLine { t: string; level: string; msg: string; seq: number }

function LogsSessionPane({ session }: { session: DockSession }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [filter, setFilter] = useState('');
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [activeContainer, setActiveContainer] = useState(session.container || 'app');

  const updateSessionContainer = useDockStore((s) => s.updateSessionContainer);
  const seqRef = useRef(1);

  const containers = session.allContainers && session.allContainers.length > 0
    ? session.allContainers
    : ['app', 'istio-proxy'];

  useEffect(() => {
    // Generate initial tail
    const initial: LogLine[] = [];
    for (let i = 0; i < 20; i++) {
      const [level, tpl] = LOG_TEMPLATES[i % LOG_TEMPLATES.length];
      const msg = `[${session.resourceName}/${activeContainer}] ` + tpl.replace('{ms}', String(20 + i * 15)).replace(/\{n\}/g, String(i + 1));
      initial.push({
        t: new Date(Date.now() - (20 - i) * 1000).toISOString().slice(11, 23),
        level,
        msg,
        seq: seqRef.current++,
      });
    }
    setLines(initial);

    // Live streamer interval
    const iv = setInterval(() => {
      if (paused) return;
      const [level, tpl] = LOG_TEMPLATES[Math.floor(Math.random() * LOG_TEMPLATES.length)];
      const msg = `[${session.resourceName}/${activeContainer}] ` + tpl
        .replace('{ms}', String(20 + Math.floor(Math.random() * 400)))
        .replace(/\{n\}/g, () => String(1 + Math.floor(Math.random() * 240)));

      const t = new Date().toISOString().slice(11, 23);
      setLines((prev) => [...prev, { t, level, msg, seq: seqRef.current++ }].slice(-500));
    }, 750);

    return () => clearInterval(iv);
  }, [session.resourceName, activeContainer, paused]);

  const shown = useMemo(() => {
    if (!filter.trim()) return lines;
    const q = filter.toLowerCase();
    return lines.filter((l) => (l.level + ' ' + l.msg).toLowerCase().includes(q));
  }, [lines, filter]);

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-canvas)]">
      {/* Logs Target Header Bar */}
      <div className="h-8 shrink-0 flex items-center gap-2 px-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 text-xs">
        <div className="flex items-center gap-1.5">
          <ArrowDownToLine size={13} className="text-blue-400 shrink-0" />
          <span className="text-[var(--text-muted)]">Logs:</span>
          <span className="font-mono font-medium text-[var(--text-primary)]">
            {session.resourceName}
          </span>
          {session.namespace && (
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--bg-surface)] text-[var(--text-muted)] border border-[var(--border-subtle)]">
              ns: {session.namespace}
            </span>
          )}
        </div>

        <div className="h-3.5 w-px bg-[var(--border-default)] mx-1" />

        {/* Container Selector */}
        <Popover
          width={200}
          trigger={({ open }) => (
            <button
              className={cx(
                'flex items-center gap-1 h-[22px] px-2 rounded-[3px] border text-[11px] font-mono transition-colors',
                open ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
              )}
              title="Select Container"
            >
              <Box size={11} className="text-blue-400" />
              <span>{activeContainer}</span>
              <ChevronDown size={10} className="opacity-60" />
            </button>
          )}
        >
          {(close) => (
            <div className="py-1">
              <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Select Container
              </div>
              {containers.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setActiveContainer(c);
                    updateSessionContainer(session.id, c);
                    toast.info(`Switched logs to container: ${c}`);
                    close();
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <span className="font-mono">{c}</span>
                  {activeContainer === c && <Check size={11} className="text-[var(--accent)]" />}
                </button>
              ))}
            </div>
          )}
        </Popover>

        <SearchInput
          value={filter}
          onChange={setFilter}
          placeholder="Filter log lines…"
          className="w-[180px] h-[22px]"
        />

        <div className="flex-1" />

        <IconButton
          icon={paused ? Play : Pause}
          size="sm"
          active={paused}
          onClick={() => setPaused(!paused)}
          tooltip={paused ? 'Resume Live Stream' : 'Pause Live Stream'}
          aria-label="Pause"
        />

        <IconButton
          icon={Clock}
          size="sm"
          active={showTimestamps}
          onClick={() => setShowTimestamps(!showTimestamps)}
          tooltip={showTimestamps ? 'Hide Timestamps' : 'Show Timestamps'}
          aria-label="Timestamps"
        />

        <IconButton
          icon={WrapText}
          size="sm"
          active={wrap}
          onClick={() => setWrap(!wrap)}
          tooltip="Toggle Word Wrap"
          aria-label="Wrap"
        />

        <IconButton
          icon={Download}
          size="sm"
          tooltip="Download .log File"
          onClick={() => {
            const blob = new Blob([lines.map((l) => `${l.t} ${l.level.toUpperCase()} ${l.msg}`).join('\n')], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${session.resourceName}-${activeContainer}.log`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success('Logs downloaded', `${session.resourceName}.log`);
          }}
          aria-label="Download logs"
        />

        <IconButton
          icon={Eraser}
          size="sm"
          tooltip="Clear Log Buffer"
          onClick={() => setLines([])}
          aria-label="Clear"
        />
      </div>

      {/* Log Output Body */}
      <div className="flex-1 min-h-0 overflow-auto kubiki-scrollbar bg-[var(--bg-canvas)] px-3 py-2 select-text">
        {shown.length === 0 ? (
          <div className="text-[11px] text-[var(--text-muted)] font-mono py-4 text-center">
            No logs matching filter “{filter}” for {session.resourceName}
          </div>
        ) : (
          <div className="font-mono text-[11px] leading-[1.5]">
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

function terminalExec(input: string, write: (s: string) => void, pods: { name: string; namespace?: string; status?: string; ready?: string }[]) {
  const cmd = input.trim();
  if (!cmd) return;
  const parts = cmd.split(/\s+/);
  if (cmd === 'clear') {
    write('\x1b[2J\x1b[H');
    return;
  }
  if (cmd === 'help') {
    write('\r\nCommands: kubectl get <pods|deployments|services|configmaps|secrets> [-n ns], kubectl version, kubectl config get-contexts, clear, exit\r\n');
    return;
  }
  if (parts[0] === 'kubectl') {
    if (parts[1] === 'version') {
      write('\r\nClient Version: v1.31.2\r\nServer Version: v1.31.2 (minikube)\r\n');
      return;
    }
    if (parts[1] === 'config' && parts[2] === 'get-contexts') {
      write('\r\nCURRENT  NAME        CLUSTER     NAMESPACE\r\n*        minikube    minikube    default\r\n         staging     k8s-stage   backend\r\n');
      return;
    }
    if (parts[1] === 'get') {
      const kindWanted = (parts[2] ?? '').replace(/s$/, '');
      const map: Record<string, string> = { pod: 'Pod', po: 'Pod', deploy: 'Deployment', deployment: 'Deployment', svc: 'Service', service: 'Service', cm: 'ConfigMap', configmap: 'ConfigMap', secret: 'Secret' };
      const resolved = map[kindWanted];
      if (!resolved) {
        write(`\r\nerror: unknown resource "${parts[2] ?? ''}" (try pods|deployments|services|configmaps|secrets)\r\n`);
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
  write(`\r\n${cmd}: command executed (demo session)\r\n`);
}

/* ------------------------------------------------------------------ */
/* Port Forwarding Session Pane                                        */
/* ------------------------------------------------------------------ */

function PortsPane() {
  const sessions = usePfStore((s) => s.sessions);
  const remove = usePfStore((s) => s.remove);
  const add = usePfStore((s) => s.add);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    const iv = setInterval(() => usePfStore.getState().tick(), 800);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-canvas)]">
      <div className="h-8 shrink-0 flex items-center justify-between px-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50">
        <span className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Active Port Forwarding Tunnels ({sessions.length})</span>
        <Button size="sm" variant="primary" onClick={() => setAddOpen(true)}>
          <Plus size={12} /> Add Tunnel
        </Button>
      </div>

      <div className="flex-1 overflow-auto kubiki-scrollbar p-2">
        {sessions.length === 0 ? (
          <div className="text-center py-8 text-[11px] text-[var(--text-muted)]">
            No active port forward sessions. Forward ports from Pods/Services or click Add Tunnel above.
          </div>
        ) : (
          <table className="datagrip-grid w-full">
            <thead>
              <tr>
                <th className="datagrip-th">Target Resource</th>
                <th className="datagrip-th">Namespace</th>
                <th className="datagrip-th">Local URL</th>
                <th className="datagrip-th text-right">Target Port</th>
                <th className="datagrip-th text-right">Traffic (TX/RX)</th>
                <th className="datagrip-th text-right">Uptime</th>
                <th className="datagrip-th w-[60px]" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="datagrip-row">
                  <td className="datagrip-cell font-mono text-[var(--text-primary)] font-medium">
                    {s.targetKind}/{s.targetName}
                  </td>
                  <td className="datagrip-cell text-[var(--text-secondary)]">{s.namespace}</td>
                  <td className="datagrip-cell font-mono">
                    <a
                      href={`http://localhost:${s.localPort}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--accent)] hover:underline flex items-center gap-1"
                    >
                      <span>http://localhost:{s.localPort}</span>
                    </a>
                  </td>
                  <td className="datagrip-cell font-mono text-right">{s.remotePort}</td>
                  <td className="datagrip-cell font-mono text-right text-[10.5px]">
                    {fmtBytes(s.bytesOut)} / {fmtBytes(s.bytesIn)}
                  </td>
                  <td className="datagrip-cell text-right text-[var(--text-muted)] font-mono">
                    {fmtElapsed(s.startedAt)}
                  </td>
                  <td className="datagrip-cell text-right">
                    <button
                      onClick={() => remove(s.id)}
                      className="px-1.5 py-0.5 rounded text-[10.5px] text-[var(--status-danger)] hover:bg-[var(--status-danger)]/15"
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

      <AddPfModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreate={(name, ns, targetPort, localPort) => {
          add({
            targetKind: 'Pod',
            targetName: name,
            namespace: ns,
            remotePort: targetPort,
            localPort,
            openBrowser: false,
          });
          toast.success('Port forward started', `http://localhost:${localPort} -> ${name}:${targetPort}`);
          setAddOpen(false);
        }}
      />
    </div>
  );
}

function AddPfModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, ns: string, targetPort: number, localPort: number) => void;
}) {
  const [name, setName] = useState('api-gateway');
  const [ns, setNs] = useState('default');
  const [target, setTarget] = useState('8080');
  const [local, setLocal] = useState('8080');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Port Forward"
      width={420}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => onCreate(name, ns, Number(target) || 8080, Number(local) || 8080)}
          >
            Start Tunnel
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs">
        <div>
          <Label>Resource Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Namespace</Label>
          <Input value={ns} onChange={(e) => setNs(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Target Container Port</Label>
            <Input value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>
          <div>
            <Label>Local Port</Label>
            <Input value={local} onChange={(e) => setLocal(e.target.value)} />
          </div>
        </div>
      </div>
    </Modal>
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

function EventsPane({ visible: _visible }: { visible?: boolean }) {
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'All' | 'Normal' | 'Warning'>('All');

  const filtered = useMemo(() => {
    let list = MOCK_EVENTS;
    if (typeFilter !== 'All') list = list.filter((e) => e.type === typeFilter);
    if (filter) {
      const q = filter.toLowerCase();
      list = list.filter((e) => (e.reason + ' ' + e.object + ' ' + e.message).toLowerCase().includes(q));
    }
    return list;
  }, [typeFilter, filter]);

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
                'px-2 py-0.5 rounded text-[10.5px]',
                typeFilter === t ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter events…" className="w-[180px] h-[22px]" />
      </div>

      <div className="flex-1 overflow-auto kubiki-scrollbar p-2">
        <table className="datagrip-grid w-full">
          <thead>
            <tr>
              <th className="datagrip-th w-[90px]">Type</th>
              <th className="datagrip-th w-[130px]">Reason</th>
              <th className="datagrip-th w-[240px]">Resource</th>
              <th className="datagrip-th">Message</th>
              <th className="datagrip-th w-[60px] text-right">Count</th>
              <th className="datagrip-th w-[80px] text-right">Age</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id} className="datagrip-row">
                <td className="datagrip-cell">
                  <span
                    className={cx(
                      'text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded',
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
