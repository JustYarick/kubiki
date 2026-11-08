import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { createTerminalView, type TerminalView } from '../../../core/terminal_view';
import { Button } from '../../../components/ui/Button';
import { CheckboxRow } from '../../../components/ui/Checkbox';
import { Select } from '../../../components/ui/Select';
import { connectOpenCode, OpenCodeNotStartedError, type ExecConnection } from '../../../providers/tauri_exec';
import { useTerminalAppearance } from '../../../components/k8s/useTerminalAppearance';
import { useUiStore } from '../../../state/ui_store';
import { useClusterStore } from '../../../state/cluster_store';
import { currentAgentScope } from '../navigation';
import { useAiStore } from '../store';
import { normalizeMcpPolicy, syncSharedPolicyFields, isToolActiveInPolicy, toggleReadOnlyMcpPolicy, externalAgentName, MCP_TOOL_CATALOG, type AgentPolicy } from '../types';
import { agentError, desktopAiAvailable } from '../transport';

export function OpenCodePane({ visible = true }: { visible?: boolean }) {
  const runtime = useAiStore(s => s.settings.runtime);
  const mcpPolicy = normalizeMcpPolicy(useAiStore(s => s.settings.mcpPolicy));
  const savedMcpPhase = useAiStore(s => s.settings.mcpPhase);
  const mcpPhase = !savedMcpPhase || savedMcpPhase === 'plan' ? 'plan' : 'action';
  const saving = useAiStore(s => s.saving);
  const name = externalAgentName(runtime);
  const request = useAiStore(s => s.openCodeRequest);
  const context = useClusterStore(s => s.currentContext);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('Starting');
  const [scopeLabel, setScopeLabel] = useState(context ?? 'No cluster selected');
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const connection = useRef<ExecConnection | null>(null);
  const fit = useRef<TerminalView | null>(null);
  const startup = useRef<AbortController | null>(null);
  const pinnedContext = useRef<string | null>(context);

  const readOnly = Boolean(mcpPolicy.readOnly);
  const activeToolCount = MCP_TOOL_CATALOG.filter(tool => isToolActiveInPolicy(tool.id, mcpPolicy, mcpPhase)).length;

  async function updateMcpPolicyLive(patch: Partial<AgentPolicy>) {
    if (!desktopAiAvailable()) return;
    setError('');
    const current = useAiStore.getState().settings;
    const base = normalizeMcpPolicy(current.mcpPolicy);
    const nextMcp: AgentPolicy = {
      ...base,
      ...patch,
      alwaysAsk: [],
      confirmReads: false,
      rules: [],
    };
    try {
      await useAiStore.getState().save({
        ...current,
        mcpPolicy: nextMcp,
        policy: syncSharedPolicyFields(nextMcp, current.policy),
      });
    } catch (e) {
      setError(agentError(e));
    }
  }

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
    let acknowledged = false; let started = false; let finished = false;
    const scope = request && request.scope.context === context ? request.scope : currentAgentScope();
    setScopeLabel(`${scope.context || 'No cluster selected'} / ${scope.allNamespaces ? 'All namespaces' : scope.namespaces.join(', ') || 'No namespaces'}`);
    pinnedContext.current = context;
    const view = createTerminalView(box.current, appearance, (cols, rows) => {
      if (!cancel.signal.aborted) connection.current?.resize(cols, rows);
    });
    const term = view.terminal;
    terminal.current = term; fit.current = view;
    const resize = view.fit;
    let pendingInput = '';
    const enable = () => {
      if (started && !finished && !cancel.signal.aborted) {
        // Parser responses (DA/OSC/DSR) also use stdin, before IPC acknowledgement.
        term.options.disableStdin = false;
        if (acknowledged) setStatus('Connected');
      }
    };
    const data = term.onData(value => {
      if (cancel.signal.aborted || finished) return;
      if (connection.current) connection.current.write(value);
      else if (pendingInput.length + value.length <= 16384) pendingInput += value;
    });
    setError(''); setStatus('Starting');
    let reservation: string | undefined;
    void (async () => {
      await view.ready;
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
            finished = true; term.options.disableStdin = true;
            setStatus(event.type === 'Exited' ? `Exited (${event.payload.code})` : 'Failed');
            if (event.type === 'Failed') setError(event.payload.error.message);
          }
        }, cancel.signal);
        if (cancel.signal.aborted) { conn.close(); return; }
        connection.current = conn; conn.write(pendingInput); pendingInput = ''; acknowledged = true; enable(); resize(); term.focus();
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
      data.dispose(); view.dispose(); terminal.current = null; fit.current = null;
      if (startup.current === cancel) startup.current = null;
    };
  }, [attempt, request?.id, runtime]);

  useEffect(() => {
    if (pinnedContext.current !== context) { stop(); setStatus('Cluster changed · Restart to reconnect'); }
  }, [context]);
  useTerminalAppearance(fit, () => {
    fit.current?.fit(); const t = terminal.current; if (t) connection.current?.resize(t.cols, t.rows);
  }, visible, String(attempt));
  useEffect(() => {
    if (visible) { fit.current?.fit(); const t = terminal.current; if (t) { connection.current?.resize(t.cols, t.rows); t.focus(); } }
  }, [visible]);

  return <div className="ai-workspace" data-testid="opencode-pane"><div className="ai-chat">
    <div className="ai-form-line px-3 py-2 border-b border-[var(--border-default)]">
      <strong>{name}</strong><span className="ai-help ai-grow">{scopeLabel} · {status}</span>
      <label className="flex items-center gap-1.5 text-xs" title="Enforced by the Kubiki MCP server. The external agent's own mode is independent.">
        MCP phase
        <Select aria-label="MCP server phase" value={mcpPhase} disabled={saving} onChange={e => {
          const current = useAiStore.getState().settings;
          void useAiStore.getState().save({ ...current, mcpPhase: e.target.value as 'plan' | 'action' }).catch(e => setError(agentError(e)));
        }}><option value="plan">Plan</option><option value="action">Action</option></Select>
      </label>
      <CheckboxRow
        label="Read-only MCP"
        checked={readOnly}
        disabled={saving}
        onChange={e => void updateMcpPolicyLive(toggleReadOnlyMcpPolicy(e.target.checked, mcpPolicy))}
      />
      <Button
        size="sm"
        variant="secondary"
        aria-label="Live MCP tools"
        onClick={() => useAiStore.getState().openSettings('mcp')}
      >
        MCP Tools ({activeToolCount}/{MCP_TOOL_CATALOG.length})
      </Button>
      <Button size="sm" onClick={stop}>Stop</Button>
      <Button size="sm" onClick={() => setAttempt(v => v + 1)}>Restart</Button>
      <Button size="sm" onClick={() => useAiStore.getState().openSettings('agent')}>Settings</Button>
    </div>
    {error && <div role="alert" className="ai-error px-3 py-2">{error}</div>}
    <div className="terminal-frame"><div ref={box} className="terminal-surface" /></div>
  </div></div>;
}
