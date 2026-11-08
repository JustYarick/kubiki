import { Select } from '../ui/Select';
import { createTerminalView, type TerminalView } from '../../core/terminal_view';
import { useTerminalAppearance } from './useTerminalAppearance';
import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { ArrowDown, ArrowUp, Eraser, RotateCw, Search, Unplug, X } from 'lucide-react';
import { connectPodExec, connectPodAttach, connectHostTerminal, connectNodeExec, getHostTerminalInfo, type HostTerminalInfo, type ExecConnection } from '../../providers/tauri_exec';
import { errorHint, normalizeK8sError } from '../../providers/errors';
import { resourceQuery } from '../../core/resources/resource_types';
import type { ResourceRef } from '../../core/resources/resource_types';
import { useUiStore } from '../../state/ui_store';
import type { DockSession } from '../../state/dock_store';
import { useDockStore } from '../../state/dock_store';
import { ContainerSelect } from './ContainerSelect';
import { useSessionContainers } from './useSessionContainers';
import { IconButton } from '../ui/Button';

export function LiveTerminalPane({ session, visible, onContainerChange, nodeDebug }: { nodeDebug?: { sessionId: string; node: string; resource: ResourceRef; shell: string }; session: DockSession; visible: boolean; onContainerChange?: (name: string) => void }) {
  const { containers, container, context, uid } = useSessionContainers(session, true);
  const local = session.targetType === 'local';
  const isAttach = session.terminalMode === 'attach';
  const [hostInfo, setHostInfo] = useState<HostTerminalInfo>();
  const [hostError, setHostError] = useState('');
  const [shell, setShell] = useState(local ? '' : '/bin/bash'); const [nodeShell, setNodeShell] = useState(''); const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState('Connecting'); const [error, setError] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const searchOpen = useRef(showSearch); searchOpen.current = showSearch;
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFound, setSearchFound] = useState<boolean | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null); const terminal = useRef<Terminal | null>(null); const fit = useRef<TerminalView | null>(null);
  const connection = useRef<ExecConnection | null>(null); const live = useRef(false); const cancellation = useRef<AbortController | null>(null);
  const selectedShell = nodeShell || nodeDebug?.shell || (shell || hostInfo?.default_shell || '');
  useEffect(() => {
    if (!local) return;
    let cancelled = false; setHostError('');
    void getHostTerminalInfo().then((info) => { if (!cancelled) setHostInfo(info); }).catch((error) => { if (!cancelled) setHostError(normalizeK8sError(error, { operation: 'host_terminal' }).message); });
    return () => { cancelled = true; };
  }, [local, attempt]);
  const target = JSON.stringify([nodeDebug?.sessionId, local, isAttach, session.id, hostInfo?.cwd, hostError, context, session.namespace, session.resourceName, uid, container, selectedShell, attempt]);
  useEffect(() => {
    if (local && !hostInfo) { setPhase(hostError ? 'Failed' : 'Loading shell'); setError(hostError); return; }
    if (!box.current) return;
    const abort = new AbortController(); cancellation.current = abort; let finished = false; let started = false; let acknowledged = false;
    const view = createTerminalView(box.current, useUiStore.getState(), (cols, rows) => {
      if (!abort.signal.aborted) connection.current?.resize(cols, rows);
    });
    const term = view.terminal; terminal.current = term; fit.current = view;
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.key === 'Tab' && event.type === 'keydown') {
        event.stopPropagation();
        return true;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        setShowSearch(true);
        return false;
      }
      if (event.key === 'Escape' && event.type === 'keydown' && searchOpen.current) {
        setShowSearch(false);
        view.search?.clearDecorations();
        term.focus();
        return false;
      }
      return true;
    });
    const fitNow = view.fit;
    let pendingInput = '';
    setError(''); setPhase('Connecting'); live.current = false;
    const enable = () => { if (started && !finished && !abort.signal.aborted) { term.options.disableStdin = false; if (acknowledged) { live.current = true; setPhase('Connected'); } } };
    const write = (bytes: Uint8Array | string) => new Promise<void>((resolve) => {
      if (abort.signal.aborted) return resolve();
      const finish = () => { abort.signal.removeEventListener('abort', finish); resolve(); };
      abort.signal.addEventListener('abort', finish, { once: true }); term.write(bytes, finish);
    });
    const data = term.onData((data) => {
      if (abort.signal.aborted || finished) return;
      if (connection.current) connection.current.write(data);
      else if (pendingInput.length + data.length <= 16384) pendingInput += data;
    });
    async function start() {
      try {
        await view.ready;
        if (abort.signal.aborted) return;
        fitNow();
        if (!local && (!context || !session.namespace || !session.resourceName || !uid || !container)) throw new Error('Open the current Pod and select a container before connecting.');
        const receive = async (event: import('../../providers/tauri_exec').ExecEvent) => {
          if (abort.signal.aborted) return;
          if (event.type === 'Started') { started = true; enable(); }
          else if (event.type === 'Output') await write(new Uint8Array(event.payload.data));
          else { finished = true; live.current = false; term.options.disableStdin = true;
            if (event.type === 'Exited') { setPhase(`Exited (${event.payload.code})`); await write(`\r\n[Process exited with code ${event.payload.code}]\r\n`); }
            else { const failure = normalizeK8sError(event.payload.error, { operation: nodeDebug ? 'node_debug' : local ? 'host_terminal' : isAttach ? 'attach' : 'exec', context: local ? undefined : context ?? undefined }); setError(`${failure.message} ${failure.code === 'unsupported' ? '' : errorHint(failure)}`); setPhase('Failed'); }
          }
        };
        const conn = local ? await connectHostTerminal({ shell: selectedShell, cols: term.cols, rows: term.rows }, receive, abort.signal)
          : nodeDebug ? await connectNodeExec({ resource: nodeDebug.resource, debug_session_id: nodeDebug.sessionId, shell: selectedShell, cols: term.cols, rows: term.rows }, receive, abort.signal)
          : isAttach
            ? await connectPodAttach({ resource: { ...resourceQuery(context!, 'Pod', session.namespace), name: session.resourceName!, uid: uid! }, container, cols: term.cols, rows: term.rows }, receive, abort.signal)
            : await connectPodExec({ resource: { ...resourceQuery(context!, 'Pod', session.namespace), name: session.resourceName!, uid: uid! }, container, shell: selectedShell, cols: term.cols, rows: term.rows }, receive, abort.signal);
        if (abort.signal.aborted) conn.close(); else { connection.current = conn; conn.write(pendingInput); pendingInput = ''; acknowledged = true; enable(); fitNow(); if (box.current?.offsetParent) term.focus(); }
      } catch (error) {
        if (!abort.signal.aborted) {
          const failure = normalizeK8sError(error, { operation: nodeDebug ? 'node_debug' : local ? 'host_terminal' : isAttach ? 'attach' : 'exec' });
          if (failure.code === 'cancelled') {
            setPhase('Cancelled');
            setError('Attach confirmation was cancelled.');
          } else {
            setError(`${failure.message} ${failure.code === 'unsupported' ? '' : errorHint(failure)}`);
            setPhase('Failed');
          }
        }
      }
    }
    void start();
    return () => { live.current = false; abort.abort(); connection.current?.close(); connection.current = null; data.dispose(); view.dispose(); terminal.current = null; fit.current = null; };
    // A new container/shell/reconnect owns a fresh backend session and xterm decoder.
  }, [target]);
  useTerminalAppearance(fit, () => { const term = terminal.current; if (term && box.current?.clientWidth) { fit.current?.fit(); connection.current?.resize(term.cols, term.rows); } }, visible, target);
  useEffect(() => { if (visible) { const timer = setTimeout(() => { fit.current?.fit(); const term = terminal.current; if (term) { connection.current?.resize(term.cols, term.rows); term.focus(); } }, 0); return () => clearTimeout(timer); } }, [visible]);
  useEffect(() => {
    if (showSearch) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [showSearch]);
  return <div className="h-full flex flex-col min-h-0 min-w-0" data-testid="live-terminal">
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
      <span className="flex-[1_1_160px] min-w-0 truncate font-mono text-xs" title={local ? hostInfo?.cwd : `${context} / ${session.namespace} / ${session.resourceName}`}>{nodeDebug ? `Node: ${nodeDebug.node}` : local ? 'Local host' : session.resourceName}<span className="text-[var(--text-muted)] ml-2">{local ? hostInfo?.cwd : session.namespace}</span></span>
      {!local && !nodeDebug && <div className="min-w-0 max-w-full"><ContainerSelect shell containers={containers} value={container} onChange={onContainerChange ?? ((name) => useDockStore.getState().updateSessionContainer(session.id, name))} /></div>}
      {!isAttach && <Select aria-label="Shell binary" className="ide-select max-w-full" value={selectedShell} onChange={(e) => nodeDebug ? setNodeShell(e.target.value) : setShell(e.target.value)}>{(local ? hostInfo?.shells ?? [] : ['/bin/bash', '/bin/sh', '/bin/ash', '/bin/zsh']).map((value) => <option key={value}>{value}</option>)}</Select>}
      <span role="status" className="text-xs text-[var(--text-secondary)]">{phase}</span>
      <div className="flex gap-1 ml-auto">
        <IconButton icon={Search} size="sm" aria-label="Find in terminal (Ctrl+F)" tooltip="Find in terminal (Ctrl+F)" onClick={() => setShowSearch((s) => !s)} />
        <IconButton icon={RotateCw} size="sm" aria-label="Reconnect" tooltip="Reconnect" onClick={() => setAttempt((n) => n + 1)} />
        <IconButton icon={Unplug} size="sm" aria-label="Disconnect" tooltip="Disconnect" onClick={() => { live.current = false; cancellation.current?.abort(); connection.current?.close(); if (terminal.current) terminal.current.options.disableStdin = true; setPhase('Disconnected'); }} />
        <IconButton icon={Eraser} size="sm" aria-label="Clear terminal" tooltip="Clear terminal" onClick={() => terminal.current?.clear()} />
      </div>
    </div>
    {error && <div role="alert" className="shrink-0 px-3 py-2 text-xs text-[var(--status-danger)] break-words">{error}</div>}
    <div className="terminal-frame relative">
      {showSearch && (
        <div className="absolute top-2 right-4 z-20 flex items-center gap-1.5 p-1.5 bg-[var(--bg-card)] border border-[var(--border-default)] shadow-lg rounded-md text-xs backdrop-blur-sm">
          <Search size={13} className="text-[var(--text-muted)] ml-1 shrink-0" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Find in terminal…"
            value={searchQuery}
            onChange={(e) => {
              const query = e.target.value;
              setSearchQuery(query);
              if (query) {
                const res = fit.current?.search?.findNext(query, { incremental: true }) ?? false;
                setSearchFound(res);
              } else {
                fit.current?.search?.clearDecorations();
                setSearchFound(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (searchQuery) {
                  const res = e.shiftKey
                    ? fit.current?.search?.findPrevious(searchQuery)
                    : fit.current?.search?.findNext(searchQuery);
                  setSearchFound(Boolean(res));
                }
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setShowSearch(false);
                fit.current?.search?.clearDecorations();
                terminal.current?.focus();
              }
            }}
            className="ide-select h-6 text-xs px-2 py-0 w-44 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] focus:border-[var(--accent)] outline-none"
          />
          {searchQuery && searchFound === false && (
            <span className="text-[10px] text-[var(--status-warn)] shrink-0 px-1 font-sans">No results</span>
          )}
          <IconButton
            icon={ArrowUp}
            size="sm"
            aria-label="Previous match (Shift+Enter)"
            tooltip="Previous match (Shift+Enter)"
            onClick={() => {
              if (searchQuery) {
                const res = fit.current?.search?.findPrevious(searchQuery);
                setSearchFound(Boolean(res));
              }
            }}
          />
          <IconButton
            icon={ArrowDown}
            size="sm"
            aria-label="Next match (Enter)"
            tooltip="Next match (Enter)"
            onClick={() => {
              if (searchQuery) {
                const res = fit.current?.search?.findNext(searchQuery);
                setSearchFound(Boolean(res));
              }
            }}
          />
          <IconButton
            icon={X}
            size="sm"
            aria-label="Close search (Esc)"
            tooltip="Close search (Esc)"
            onClick={() => {
              setShowSearch(false);
              fit.current?.search?.clearDecorations();
              terminal.current?.focus();
            }}
          />
        </div>
      )}
      <div ref={box} className="terminal-surface" />
    </div>
  </div>;
}
