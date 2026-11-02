import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Button } from '../../../components/ui/Button';
import { connectOpenCode, OpenCodeNotStartedError, type ExecConnection } from '../../../providers/tauri_exec';
import { loadTerminalFonts, terminalFontStack } from '../../../core/terminal_appearance';
import { useTerminalAppearance } from '../../../components/k8s/useTerminalAppearance';
import { useUiStore } from '../../../state/ui_store';
import { useClusterStore } from '../../../state/cluster_store';
import { currentAgentScope } from '../navigation';
import { useAiStore } from '../store';
import { agentError } from '../transport';

export function OpenCodePane({ visible = true }: { visible?: boolean }) {
  const request = useAiStore(s => s.openCodeRequest);
  const context = useClusterStore(s => s.currentContext);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('Starting');
  const [scopeLabel, setScopeLabel] = useState(context ?? 'No cluster selected');
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const connection = useRef<ExecConnection | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const startup = useRef<AbortController | null>(null);
  const pinnedContext = useRef<string | null>(context);

  function stop() {
    startup.current?.abort();
    connection.current?.close();
    if (terminal.current) terminal.current.options.disableStdin = true;
    setStatus('Stopped');
  }

  useEffect(() => {
    if (!box.current) return;
    const appearance = useUiStore.getState();
    const cancel = new AbortController();
    startup.current = cancel;
    let live = false; let acknowledged = false; let started = false; let finished = false;
    const scope = request && request.scope.context === context ? request.scope : currentAgentScope();
    setScopeLabel(`${scope.context || 'No cluster selected'} / ${scope.allNamespaces ? 'All namespaces' : scope.namespaces.join(', ') || 'No namespaces'}`);
    pinnedContext.current = context;
    const term = new Terminal({
      fontFamily: terminalFontStack(appearance.terminalFontFamily), fontSize: appearance.terminalFontSize,
      lineHeight: appearance.terminalLineHeight, scrollback: appearance.terminalScrollback,
      cursorBlink: true, disableStdin: true, theme: { background: '#1e1f22', foreground: '#dfe1e5' },
    });
    const addon = new FitAddon(); term.loadAddon(addon); term.open(box.current);
    terminal.current = term; fit.current = addon;
    const resize = () => {
      if (!cancel.signal.aborted && box.current?.clientWidth && box.current.clientHeight) {
        addon.fit(); connection.current?.resize(term.cols, term.rows);
      }
    };
    const observer = new ResizeObserver(resize); observer.observe(box.current); resize();
    const enable = () => {
      if (started && acknowledged && !finished && !cancel.signal.aborted) {
        live = true; term.options.disableStdin = false; setStatus('Connected');
      }
    };
    const data = term.onData(value => { if (live && !cancel.signal.aborted) connection.current?.write(value); });
    setError(''); setStatus('Starting');
    let reservation: string | undefined;
    void (async () => {
      await loadTerminalFonts(appearance.terminalFontFamily, appearance.terminalFontSize).catch(() => {});
      if (cancel.signal.aborted) return;
      resize();
      try {
        const prompt = request?.scope.context === scope.context && useAiStore.getState().openCodeRequestConsumed !== request.id ? request.prompt : null;
        // Reserve before dispatch: an ambiguous IPC failure must never replay a Create task.
        if (request && prompt) {
          reservation = crypto.randomUUID();
          useAiStore.setState({ openCodeRequestConsumed: request.id, openCodeRequestReservation: reservation });
        }
        const conn = await connectOpenCode({ scope, cols: term.cols, rows: term.rows, prompt }, async event => {
          if (cancel.signal.aborted) return;
          if (event.type === 'Started') { started = true; enable(); }
          else if (event.type === 'Output') await new Promise<void>(resolve => {
            const done = () => { cancel.signal.removeEventListener('abort', done); resolve(); };
            cancel.signal.addEventListener('abort', done, { once: true });
            term.write(new Uint8Array(event.payload.data), done);
          });
          else {
            finished = true; live = false; term.options.disableStdin = true;
            setStatus(event.type === 'Exited' ? `Exited (${event.payload.code})` : 'Failed');
            if (event.type === 'Failed') setError(event.payload.error.message);
          }
        }, cancel.signal);
        if (cancel.signal.aborted) { conn.close(); return; }
        connection.current = conn; acknowledged = true; enable(); resize(); term.focus();
      } catch (e) {
        // This envelope proves that no process was started. Retain the task for a manual retry.
        if (e instanceof OpenCodeNotStartedError && request && reservation && useAiStore.getState().openCodeRequestReservation === reservation) {
          useAiStore.setState({ openCodeRequestConsumed: undefined, openCodeRequestReservation: undefined });
        }
        if (!cancel.signal.aborted) { setError(agentError(e)); setStatus('Failed'); }
      }
    })();
    return () => {
      cancel.abort(); connection.current?.close(); connection.current = null;
      observer.disconnect(); data.dispose(); term.dispose(); terminal.current = null; fit.current = null;
      if (startup.current === cancel) startup.current = null;
    };
  }, [attempt, request?.id]);

  useEffect(() => {
    if (pinnedContext.current !== context) { stop(); setStatus('Cluster changed · Restart to reconnect'); }
  }, [context]);
  useTerminalAppearance(terminal, () => {
    fit.current?.fit(); const t = terminal.current; if (t) connection.current?.resize(t.cols, t.rows);
  }, visible, String(attempt));
  useEffect(() => {
    if (visible) { fit.current?.fit(); const t = terminal.current; if (t) { connection.current?.resize(t.cols, t.rows); t.focus(); } }
  }, [visible]);

  return <div className="ai-workspace" data-testid="opencode-pane"><div className="ai-chat">
    <div className="ai-form-line px-3 py-2 border-b border-[var(--border-default)]">
      <strong>OpenCode</strong><span className="ai-help ai-grow">{scopeLabel} · {status}</span>
      <Button size="sm" onClick={stop}>Stop</Button>
      <Button size="sm" onClick={() => setAttempt(v => v + 1)}>Restart</Button>
      <Button size="sm" onClick={() => useAiStore.getState().setSettingsOpen(true)}>Settings</Button>
    </div>
    {error && <div role="alert" className="ai-error px-3 py-2">{error}</div>}
    <div ref={box} className="flex-1 min-h-0 min-w-0 overflow-hidden pl-2 pt-1" />
  </div></div>;
}
