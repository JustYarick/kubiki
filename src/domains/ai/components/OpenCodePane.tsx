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
import { normalizeMcpPolicy, syncSharedPolicyFields, isToolActiveInPolicy, toggleReadOnlyMcpPolicy, externalAgentName, MCP_TOOL_CATALOG, type AgentPolicy, type ExternalTerminalMode } from '../types';
import { agentError, agentTransport, desktopAiAvailable } from '../transport';

export function OpenCodePane({ visible = true }: { visible?: boolean }) {
  const settings = useAiStore(s => s.settings);
  const runtime = settings.runtime;
  const runtimeKey = runtime === 'codex' ? 'codex' : runtime === 'claude' ? 'claude' : 'opencode';
  const terminalMode: ExternalTerminalMode = settings[runtimeKey]?.terminalMode ?? 'embedded';
  const httpMcpEnabled = Boolean(settings.mcpServer?.enabled);
  const httpMcpPort = settings.mcpServer?.port ?? 3847;
  const mcpPolicy = normalizeMcpPolicy(settings.mcpPolicy);
  const savedMcpPhase = settings.mcpPhase;
  const mcpPhase = !savedMcpPhase || savedMcpPhase === 'plan' ? 'plan' : 'action';
  const saving = useAiStore(s => s.saving);
  const name = externalAgentName(runtime);
  const request = useAiStore(s => s.openCodeRequest);
  const context = useClusterStore(s => s.currentContext);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('Starting');
  const [scopeLabel, setScopeLabel] = useState(context ?? 'No cluster selected');
  const [launchedTerminal, setLaunchedTerminal] = useState('');
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const connection = useRef<ExecConnection | null>(null);
  const systemSessionId = useRef<string | null>(null);
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

  async function switchTerminalMode(nextMode: ExternalTerminalMode) {
    if (!desktopAiAvailable()) return;
    setError('');
    const current = useAiStore.getState().settings;
    const prevRuntime = current[runtimeKey] ?? { executable: '', workingDirectory: '' };
    try {
      await useAiStore.getState().save({
        ...current,
        [runtimeKey]: { ...prevRuntime, terminalMode: nextMode },
      });
    } catch (e) {
      setError(agentError(e));
    }
  }

  function stop() {
    startup.current?.abort();
    connection.current?.close();
    if (systemSessionId.current) {
      const id = systemSessionId.current;
      systemSessionId.current = null;
      void agentTransport.stopExternalAgentSystemTerminal(id).catch(() => {});
    }
    if (terminal.current) terminal.current.options.disableStdin = true;
    setLaunchedTerminal('');
    setStatus('Stopped');
  }

  useEffect(() => {
    const cancel = new AbortController();
    startup.current = cancel;
    const scope = request && request.scope.context === context ? request.scope : currentAgentScope();
    setScopeLabel(`${scope.context || 'No cluster selected'} / ${scope.allNamespaces ? 'All namespaces' : scope.namespaces.join(', ') || 'No namespaces'}`);
    pinnedContext.current = context;

    if (terminalMode === 'system') {
      setError('');
      setStatus('Launching system terminal');
      setLaunchedTerminal('');
      let reservation: string | undefined;
      const sessionId = crypto.randomUUID();
      systemSessionId.current = sessionId;
      void (async () => {
        try {
          const prompt = request?.scope.context === scope.context && useAiStore.getState().openCodeRequestConsumed !== request.id ? request.prompt : null;
          if (request && prompt) {
            reservation = crypto.randomUUID();
            useAiStore.setState({ openCodeRequestConsumed: request.id, openCodeRequestReservation: reservation });
          }
          const result = await agentTransport.startExternalAgentSystemTerminal(sessionId, { scope, prompt });
          if (cancel.signal.aborted) {
            void agentTransport.stopExternalAgentSystemTerminal(sessionId).catch(() => {});
            return;
          }
          setLaunchedTerminal(result.terminal);
          setStatus(`Running in ${result.terminal}`);
        } catch (e) {
          if (e instanceof OpenCodeNotStartedError && request && reservation && useAiStore.getState().openCodeRequestReservation === reservation) {
            useAiStore.setState({ openCodeRequestConsumed: undefined, openCodeRequestReservation: undefined });
          }
          if (systemSessionId.current === sessionId) systemSessionId.current = null;
          if (!cancel.signal.aborted) { setError(agentError(e)); setStatus('Failed'); }
        }
      })();
      return () => {
        cancel.abort();
        if (systemSessionId.current === sessionId) {
          systemSessionId.current = null;
          void agentTransport.stopExternalAgentSystemTerminal(sessionId).catch(() => {});
        }
        if (startup.current === cancel) startup.current = null;
      };
    }

    if (!box.current) return;
    const appearance = useUiStore.getState();
    let acknowledged = false; let started = false; let finished = false;
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
  }, [attempt, request?.id, runtime, terminalMode]);

  useEffect(() => {
    if (pinnedContext.current !== context) { stop(); setStatus('Cluster changed · Restart to reconnect'); }
  }, [context]);
  useTerminalAppearance(fit, () => {
    fit.current?.fit(); const t = terminal.current; if (t) connection.current?.resize(t.cols, t.rows);
  }, visible && terminalMode === 'embedded', `${attempt}:${terminalMode}`);
  useEffect(() => {
    if (visible && terminalMode === 'embedded') {
      fit.current?.fit();
      const t = terminal.current;
      if (t) { connection.current?.resize(t.cols, t.rows); t.focus(); }
    }
  }, [visible, terminalMode]);

  return (
    <div className="ai-workspace" data-testid="opencode-pane">
      <div className="ai-chat">
        <div className="ai-form-line px-3 py-2 border-b border-[var(--border-default)]">
          <strong>{name}</strong>
          <span className="ai-help ai-grow">{scopeLabel} · {status}</span>
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
          <Button
            size="sm"
            variant="secondary"
            disabled={saving || !desktopAiAvailable()}
            onClick={() => void switchTerminalMode(terminalMode === 'system' ? 'embedded' : 'system')}
          >
            {terminalMode === 'system' ? 'Use embedded terminal' : 'Open in system terminal'}
          </Button>
          <Button size="sm" onClick={stop}>Stop</Button>
          <Button size="sm" onClick={() => setAttempt(v => v + 1)}>Restart</Button>
          <Button size="sm" onClick={() => useAiStore.getState().openSettings('agent')}>Settings</Button>
        </div>
        {error && <div role="alert" className="ai-error px-3 py-2">{error}</div>}
        {terminalMode === 'system' ? (
          <div className="p-6 flex flex-col gap-3 max-w-xl" data-testid="opencode-system-terminal">
            <div className="ai-settings-card">
              <h3 className="text-sm font-semibold mb-1">
                {launchedTerminal ? `${name} launched in ${launchedTerminal}` : `${name} · System terminal`}
              </h3>
              <p className="ai-help">
                Scope: <code>{scopeLabel}</code> · MCP phase: <strong>{mcpPhase === 'plan' ? 'Plan' : 'Action'}</strong>{readOnly ? ' · Read-only' : ''}
              </p>
              {httpMcpEnabled ? (
                <p className="ai-help mt-1">
                  Desktop HTTP MCP: <code>http://127.0.0.1:{httpMcpPort}/mcp</code>
                </p>
              ) : null}
              <p className="ai-help mt-2">
                {httpMcpEnabled
                  ? <>{name} runs inside your system default terminal with your shell init scripts (e.g. zsh <code>.zshrc</code>) and connects to Kubiki&apos;s Desktop HTTP MCP server. Rules in <strong>Cluster tools (MCP)</strong> and the Plan/Action phase apply live; manage the HTTP MCP server from the status bar or settings.</>
                  : <>{name} runs inside your system default terminal with your shell init scripts (e.g. zsh <code>.zshrc</code>) and connects back to Kubiki&apos;s attached MCP bridge. Click <strong>Stop</strong> in the toolbar to terminate the launched process and revoke this attached session, or enable <strong>Desktop HTTP MCP</strong> to connect from any terminal session.</>}
              </p>
              <div className="ai-form-line mt-3">
                <Button size="sm" onClick={() => setAttempt(v => v + 1)}>Relaunch in system terminal</Button>
                <Button size="sm" variant="secondary" onClick={() => useAiStore.getState().openSettings('mcp')}>
                  {httpMcpEnabled ? 'Cluster tools (MCP)' : 'Enable Desktop HTTP MCP'}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="terminal-frame"><div ref={box} className="terminal-surface" /></div>
        )}
      </div>
    </div>
  );
}
