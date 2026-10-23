import { loadTerminalFonts, terminalFontStack } from '../../core/terminal_appearance';
import { useTerminalAppearance } from './useTerminalAppearance';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Eraser, RotateCw, Unplug } from 'lucide-react';
import { connectPodExec, connectHostTerminal, connectNodeExec, getHostTerminalInfo, type HostTerminalInfo, type ExecConnection } from '../../providers/tauri_exec';
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
  const [hostInfo, setHostInfo] = useState<HostTerminalInfo>();
  const [hostError, setHostError] = useState('');
  const [shell, setShell] = useState(local ? '' : '/bin/sh'); const [nodeShell, setNodeShell] = useState(''); const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState('Connecting'); const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null); const terminal = useRef<Terminal | null>(null); const fit = useRef<FitAddon | null>(null);
  const connection = useRef<ExecConnection | null>(null); const live = useRef(false); const cancellation = useRef<AbortController | null>(null);
  const selectedShell = nodeShell || nodeDebug?.shell || (shell || hostInfo?.default_shell || '');
  useEffect(() => {
    if (!local) return;
    let cancelled = false; setHostError('');
    void getHostTerminalInfo().then((info) => { if (!cancelled) setHostInfo(info); }).catch((error) => { if (!cancelled) setHostError(normalizeK8sError(error, { operation: 'host_terminal' }).message); });
    return () => { cancelled = true; };
  }, [local, attempt]);
  const target = JSON.stringify([nodeDebug?.sessionId, local, session.id, hostInfo?.cwd, hostError, context, session.namespace, session.resourceName, uid, container, selectedShell, attempt]);
  useEffect(() => {
    if (local && !hostInfo) { setPhase(hostError ? 'Failed' : 'Loading shell'); setError(hostError); return; }
    if (!box.current) return;
    const abort = new AbortController(); cancellation.current = abort; let finished = false; let started = false; let acknowledged = false; let resizeTimer: ReturnType<typeof setTimeout>;
    const term = new Terminal({ fontFamily: terminalFontStack(useUiStore.getState().terminalFontFamily), lineHeight: useUiStore.getState().terminalLineHeight, fontSize: useUiStore.getState().terminalFontSize, cursorBlink: true, disableStdin: true, scrollback: useUiStore.getState().terminalScrollback,
      theme: { background: '#1e1f22', foreground: '#dfe1e5', cursor: '#3574f0', selectionBackground: '#3574f055' } });
    const addon = new FitAddon(); term.loadAddon(addon); term.open(box.current); terminal.current = term; fit.current = addon;
    const fitNow = () => { if (!abort.signal.aborted && box.current?.clientWidth && box.current.clientHeight) { addon.fit(); connection.current?.resize(term.cols, term.rows); } };
    const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitNow, 80); }); observer.observe(box.current);
    fitNow(); setError(''); setPhase('Connecting'); live.current = false;
    const enable = () => { if (started && acknowledged && !finished && !abort.signal.aborted) { live.current = true; term.options.disableStdin = false; setPhase('Connected'); } };
    const write = (bytes: Uint8Array | string) => new Promise<void>((resolve) => {
      if (abort.signal.aborted) return resolve();
      const finish = () => { abort.signal.removeEventListener('abort', finish); resolve(); };
      abort.signal.addEventListener('abort', finish, { once: true }); term.write(bytes, finish);
    });
    const data = term.onData((data) => { if (live.current) connection.current?.write(data); });
    async function start() {
      try {
        const appearance = useUiStore.getState();
        // A missing custom face still uses the bundled/system fallbacks.
        await loadTerminalFonts(appearance.terminalFontFamily, appearance.terminalFontSize).catch(() => {});
        if (abort.signal.aborted) return;
        fitNow();
        if (!local && (!context || !session.namespace || !session.resourceName || !uid || !container)) throw new Error('Open the current Pod and select a container before connecting.');
        const receive = async (event: import('../../providers/tauri_exec').ExecEvent) => {
          if (abort.signal.aborted) return;
          if (event.type === 'Started') { started = true; enable(); }
          else if (event.type === 'Output') await write(new Uint8Array(event.payload.data));
          else { finished = true; live.current = false; term.options.disableStdin = true;
            if (event.type === 'Exited') { setPhase(`Exited (${event.payload.code})`); await write(`\r\n[Process exited with code ${event.payload.code}]\r\n`); }
            else { const failure = normalizeK8sError(event.payload.error, { operation: nodeDebug ? 'node_debug' : local ? 'host_terminal' : 'exec', context: local ? undefined : context ?? undefined }); setError(`${failure.message} ${failure.code === 'unsupported' ? '' : errorHint(failure)}`); setPhase('Failed'); }
          }
        };
        const conn = local
          ? await connectHostTerminal({ shell: selectedShell, cols: term.cols, rows: term.rows }, receive, abort.signal)
          : nodeDebug ? await connectNodeExec({ resource: nodeDebug.resource, debug_session_id: nodeDebug.sessionId, shell: selectedShell, cols: term.cols, rows: term.rows }, receive, abort.signal)
          : await connectPodExec({ resource: { ...resourceQuery(context!, 'Pod', session.namespace), name: session.resourceName!, uid: uid! }, container, shell: selectedShell, cols: term.cols, rows: term.rows }, receive, abort.signal);
        if (abort.signal.aborted) conn.close(); else { connection.current = conn; acknowledged = true; enable(); fitNow(); if (box.current?.offsetParent) term.focus(); }
      } catch (error) { if (!abort.signal.aborted) { const failure = normalizeK8sError(error, { operation: nodeDebug ? 'node_debug' : local ? 'host_terminal' : 'exec' }); setError(`${failure.message} ${failure.code === 'unsupported' ? '' : errorHint(failure)}`); setPhase('Failed'); } }
    }
    void start();
    return () => { live.current = false; abort.abort(); connection.current?.close(); connection.current = null; clearTimeout(resizeTimer); observer.disconnect(); data.dispose(); term.dispose(); terminal.current = null; fit.current = null; };
    // A new container/shell/reconnect owns a fresh backend session and xterm decoder.
  }, [target]);
  useTerminalAppearance(terminal, () => { const term = terminal.current; if (term && box.current?.clientWidth) { fit.current?.fit(); connection.current?.resize(term.cols, term.rows); } }, visible, target);
  useEffect(() => { if (visible) { const timer = setTimeout(() => { fit.current?.fit(); const term = terminal.current; if (term) { connection.current?.resize(term.cols, term.rows); term.focus(); } }, 0); return () => clearTimeout(timer); } }, [visible]);
  return <div className="h-full flex flex-col min-h-0 min-w-0" data-testid="live-terminal">
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
      <span className="flex-[1_1_160px] min-w-0 truncate font-mono text-xs" title={local ? hostInfo?.cwd : `${context} / ${session.namespace} / ${session.resourceName}`}>{nodeDebug ? `Node: ${nodeDebug.node}` : local ? 'Local host' : session.resourceName}<span className="text-[var(--text-muted)] ml-2">{local ? hostInfo?.cwd : session.namespace}</span></span>
      {!local && !nodeDebug && <div className="min-w-0 max-w-full"><ContainerSelect shell containers={containers} value={container} onChange={onContainerChange ?? ((name) => useDockStore.getState().updateSessionContainer(session.id, name))} /></div>}
      <select aria-label="Shell binary" className="ide-select max-w-full" value={selectedShell} onChange={(e) => nodeDebug ? setNodeShell(e.target.value) : setShell(e.target.value)}>{(local ? hostInfo?.shells ?? [] : ['/bin/sh', '/bin/bash', '/bin/ash', '/bin/zsh']).map((value) => <option key={value}>{value}</option>)}</select>
      <span role="status" className="text-xs text-[var(--text-secondary)]">{phase}</span>
      <div className="flex gap-1 ml-auto"><IconButton icon={RotateCw} size="sm" aria-label="Reconnect shell" tooltip="Reconnect shell" onClick={() => setAttempt((n) => n + 1)} /><IconButton icon={Unplug} size="sm" aria-label="Disconnect shell" tooltip="Disconnect shell" onClick={() => { live.current = false; cancellation.current?.abort(); connection.current?.close(); if (terminal.current) terminal.current.options.disableStdin = true; setPhase('Disconnected'); }} /><IconButton icon={Eraser} size="sm" aria-label="Clear terminal" tooltip="Clear terminal" onClick={() => terminal.current?.clear()} /></div>
    </div>
    {error && <div role="alert" className="shrink-0 px-3 py-2 text-xs text-[var(--status-danger)] break-words">{error}</div>}
    <div ref={box} className="flex-1 min-h-0 min-w-0 overflow-hidden pl-2 pt-1" />
  </div>;
}
