import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  FileCode,
  FileText,
  Plus,
  RefreshCw,
  Send,
  Server,
  Settings,
  Shield,
  Sparkles,
  Square,
  WandSparkles,
  Zap,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { toast } from '../../../state/notifications_store';
import { useClusterStore } from '../../../state/cluster_store';
import { currentAgentScope } from '../navigation';
import { useAiStore } from '../store';
import { desktopAiAvailable } from '../transport';
import { MODE_LABELS, PHASE_LABELS, type AgentMode, type AgentPhase, type AgentScope, type ChatMessage, type Conversation } from '../types';
import { AgentSettings, type AgentSettingsHandle } from './AgentSettings';
import '../ai.css';

const statusLabels: Record<string, string> = {
  idle: 'Ready', connecting: 'Connecting', running: 'Working', awaiting_approval: 'Waiting for your review',
  executing: 'Applying change', completed: 'Complete', cancelled: 'Stopped', stopping: 'Stopping; awaiting in-flight requests', failed: 'Failed',
};

export function AgentView({ visible = true }: { visible?: boolean }) {
  const state = useAiStore();
  const conversation = state.conversations.find(c => c.id === state.activeId);
  const settingsOpen = state.settingsOpen;
  const setSettingsOpen = state.setSettingsOpen;
  const settingsRef = useRef<AgentSettingsHandle>(null);
  const [settingsStatus, setSettingsStatus] = useState<{ message?: string; error?: string; saving?: boolean }>({});

  useEffect(() => { void useAiStore.getState().load(); }, []);
  useEffect(() => () => {
    // Closing the workspace tab stops runs; hiding it preserves conversation state.
    for (const c of useAiStore.getState().conversations) if (c.busy) void useAiStore.getState().stop(c.id);
  }, []);
  useEffect(() => {
    for (const c of useAiStore.getState().conversations) {
      if (c.sessionId) continue;
      const profile = state.settings.providers.find(p => p.id === c.providerId)
        ?? state.settings.providers.find(p => p.id === state.settings.defaultProvider) ?? state.settings.providers[0];
      if (!profile) continue;
      const model = c.model || (profile.id === state.settings.defaultProvider ? state.settings.defaultModel ?? '' : '');
      if (profile.id !== c.providerId || model !== c.model) state.update(c.id, { providerId: profile.id, model });
    }
  }, [state.settings, state.update]);

  async function saveSettingsModal() {
    if (settingsRef.current) {
      const ok = await settingsRef.current.save();
      if (ok) {
        toast.success('Settings saved');
      }
    }
  }

  return <section className="ai-workspace">
    <div className="ai-chat">
      <div className="ai-mobile-conversations">
        <label className="ai-field ai-grow">Conversation<Select aria-label="Active AI conversation" className="ide-select" value={state.activeId ?? ''} onChange={e => useAiStore.setState({ activeId: e.target.value || null })}>
          <option value="">+ New conversation</option>{state.conversations.map(c => <option key={c.id} value={c.id}>{c.scope.context ? `[${c.scope.context}] ` : ''}{c.title}</option>)}
        </Select></label>
        <Button size="sm" onClick={() => useAiStore.setState({ activeId: null })}><Plus size={12} aria-hidden="true" />New</Button>
        <Button size="sm" onClick={() => setSettingsOpen(true)}><Settings size={12} aria-hidden="true" />Settings</Button>
      </div>
      {!desktopAiAvailable() && <p className="ai-notice">AI connections and cluster tools run in the desktop app. You can explore the interface here; no data is sent.</p>}
      {state.error && <p role="alert" className="ai-error">{state.error}</p>}
      {conversation ? <Chat conversation={conversation} visible={visible} onSettings={() => setSettingsOpen(true)} /> : <AgentHome onSettings={() => setSettingsOpen(true)} />}
    </div>
    <Modal
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      title="AI Agent settings"
      width={780}
      footer={<div className="flex items-center justify-between w-full">
        <span className={`text-xs truncate max-w-[420px] ${settingsStatus.error ? 'text-[var(--status-danger)]' : 'text-emerald-400'}`} role="status">
          {settingsStatus.message || settingsStatus.error}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="primary" loading={settingsStatus.saving} disabled={!desktopAiAvailable() || settingsStatus.saving} onClick={() => void saveSettingsModal()}><Check size={12} aria-hidden="true" />Save</Button>
          <Button size="sm" variant="secondary" onClick={() => setSettingsOpen(false)}>Done</Button>
        </div>
      </div>}
    >
      <AgentSettings ref={settingsRef} onStatusChange={setSettingsStatus} />
    </Modal>
  </section>;
}

function AgentHome({ onSettings }: { onSettings: () => void }) {
  const currentContext = useClusterStore(s => s.currentContext);
  const contexts = useClusterStore(s => s.contexts);
  const [selectedCluster, setSelectedCluster] = useState<string>(currentContext || '*');
  const [clusterUserChanged, setClusterUserChanged] = useState(false);
  const settings = useAiStore(s => s.settings);
  const [providerId, setProviderId] = useState(settings.defaultProvider ?? settings.providers[0]?.id ?? '');
  const [model, setModel] = useState(settings.defaultModel ?? '');
  const [phase, setPhase] = useState<AgentPhase>('plan');
  const [mode, setMode] = useState<AgentMode>('read_only');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  // Inherit status from main selector until user explicitly changes it:
  useEffect(() => {
    if (!clusterUserChanged) {
      setSelectedCluster(currentContext || '*');
    }
  }, [currentContext, clusterUserChanged]);

  useEffect(() => {
    if (!providerId && (settings.defaultProvider || settings.providers[0]?.id)) {
      const pid = settings.defaultProvider ?? settings.providers[0]?.id ?? '';
      setProviderId(pid);
      if (!model) setModel(pid === settings.defaultProvider ? settings.defaultModel ?? '' : '');
    }
  }, [settings, providerId, model]);

  const models = useAiStore(s => s.models[providerId]);
  const modelsLoading = useAiStore(s => s.modelLoading[providerId]);
  const modelsError = useAiStore(s => s.modelErrors[providerId]);
  const refresh = useAiStore(s => s.refreshModels);

  useEffect(() => {
    if (providerId && !models && desktopAiAvailable() && !modelsLoading && !modelsError) {
      void refresh(providerId);
    }
  }, [providerId, models, modelsLoading, modelsError, refresh]);

  async function handleStart() {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      let scope: AgentScope;
      if (selectedCluster === 'general' || selectedCluster === '') {
        scope = { context: '', namespaces: [], allNamespaces: false };
      } else if (selectedCluster === '*') {
        scope = { context: '*', namespaces: [], allNamespaces: true };
      } else {
        const cur = currentAgentScope();
        scope = {
          context: selectedCluster,
          namespaces: cur.context === selectedCluster ? cur.namespaces : [],
          allNamespaces: cur.context === selectedCluster ? cur.allNamespaces : true,
        };
      }
      const id = useAiStore.getState().create(scope, draft, undefined, providerId, model, phase, mode);
      await useAiStore.getState().send(id);
    } finally {
      setSending(false);
    }
  }

  const selectedModel = models?.find(m => m.id === model);

  return (
    <div className="ai-home kubiki-scrollbar">
      <div className="ai-home-hero">
        <div className="ai-home-icon">
          <Bot size={32} aria-hidden="true" />
        </div>
        <h2>Your Kubernetes assistant</h2>
        <p>Ask a question, investigate a failing resource, or describe the application you want to create.</p>
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
          <span className="text-[var(--text-muted)]">Active cluster:</span>
          <span className={`ai-cluster-pill ${!currentContext ? 'is-general' : 'is-cluster'}`}>
            <Server size={12} className={!currentContext ? 'text-[var(--text-muted)]' : 'text-emerald-400'} aria-hidden="true" />
            <span>{currentContext || 'No cluster connected'}</span>
          </span>
        </div>
      </div>

      <div className="ai-home-composer-box">
        <textarea
          ref={input}
          aria-label="Message AI agent"
          className="ide-textarea ai-home-textarea"
          value={draft}
          maxLength={24000}
          rows={3}
          placeholder="Ask a question or describe what you want to create…"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (draft.trim() && desktopAiAvailable() && !sending) void handleStart();
            }
          }}
        />

        <div className="ai-composer-config">
          <div className="ai-compact-inputs">
            <label className="ai-compact-field">
              <span className="sr-only">Cluster</span>
              <Select
                className="ide-select ai-compact-select"
                aria-label="AI conversation cluster"
                value={selectedCluster}
                onChange={e => {
                  setSelectedCluster(e.target.value);
                  setClusterUserChanged(true);
                }}
              >
                <option value="*">All clusters</option>
                {contexts.map(ctx => (
                  <option key={ctx.name} value={ctx.name}>Cluster: {ctx.name}</option>
                ))}
                {currentContext && !contexts.some(c => c.name === currentContext) && (
                  <option value={currentContext}>Cluster: {currentContext}</option>
                )}
                <option value="general">General chat · no cluster</option>
              </Select>
            </label>

            <label className="ai-compact-field">
              <span className="sr-only">Provider</span>
              <Select
                className="ide-select ai-compact-select"
                aria-label="Conversation AI provider"
                value={providerId}
                onChange={e => {
                  setProviderId(e.target.value);
                  setModel(e.target.value === settings.defaultProvider ? settings.defaultModel ?? '' : '');
                }}
              >
                <option value="">Configure provider</option>
                {settings.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </label>
            <label className="ai-compact-field ai-grow">
              <span className="sr-only">Model</span>
              <Select
                className="ide-select ai-compact-select"
                aria-label="Conversation AI model"
                value={model}
                onChange={e => setModel(e.target.value)}
                onPointerDown={() => { if (providerId && desktopAiAvailable() && !modelsLoading) void refresh(providerId); }}
                onFocus={() => { if (providerId && desktopAiAvailable() && !modelsLoading) void refresh(providerId); }}
              >
                <option value="">{modelsLoading ? 'Loading models…' : 'Select model'}</option>
                {model && !models?.some(m => m.id === model) && <option value={model}>{model} (refresh to verify)</option>}
                {models?.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}
              </Select>
            </label>
          </div>

          <div className="ai-composer-axes">
            <div role="group" aria-label="AI execution phase" className="ai-phases">
              {(Object.entries(PHASE_LABELS) as [AgentPhase, string][]).map(([value, label]) => {
                const disabled = (value === 'action' && mode === 'read_only');
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={phase === value}
                    disabled={disabled}
                    title={value === 'action' && mode === 'read_only' ? 'Action is forbidden in Read only mode; switch to Ask or Accept first' : undefined}
                    onClick={() => setPhase(value)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div role="group" aria-label="AI execution mode" className="ai-modes">
              {(Object.entries(MODE_LABELS) as [AgentMode, string][]).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => {
                    setMode(value);
                    if (value === 'read_only') setPhase('plan');
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <Button
              size="sm"
              variant="primary"
              disabled={!desktopAiAvailable() || !draft.trim() || !providerId || !model || sending}
              loading={sending}
              onClick={() => void handleStart()}
            >
              <Send size={12} aria-hidden="true" />Send
            </Button>
          </div>
        </div>
      </div>

      {modelsError && <p role="alert" className="ai-error mt-2">{modelsError}</p>}
      {selectedModel?.tools === false && <p className="ai-notice mt-2">This model advertises no tool support. Choose a tool-capable model for cluster operations.</p>}
      {!settings.providers.length && <p className="ai-help mt-2">Add a cloud or local connection in <button className="ai-text-button" type="button" onClick={onSettings}>AI settings</button> to begin.</p>}

      <div className="ai-home-suggestions" aria-label="Suggested prompts">
        <button
          type="button"
          className="ai-suggestion-card"
          onClick={() => { setDraft('Why are my Pods failing or restarting? Check events and logs.'); input.current?.focus(); }}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <Shield size={12} className="text-amber-400" aria-hidden="true" />
            <span>Diagnose failing Pods</span>
          </div>
          <small>Identify scheduling issues, CrashLoopBackOff and OOM events</small>
        </button>
        <button
          type="button"
          className="ai-suggestion-card"
          onClick={() => { setDraft('Create a Nexus deployment with persistent storage in Kubernetes'); input.current?.focus(); }}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <WandSparkles size={12} className="text-cyan-400" aria-hidden="true" />
            <span>Create a deployment</span>
          </div>
          <small>Generate manifests for services, stateful workloads or ingress</small>
        </button>
        <button
          type="button"
          className="ai-suggestion-card"
          onClick={() => { setDraft('Explain the architecture and workload configuration in this cluster'); input.current?.focus(); }}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <Bot size={12} className="text-indigo-400" aria-hidden="true" />
            <span>Cluster overview</span>
          </div>
          <small>Explore resource relationships, namespaces and capacity</small>
        </button>
      </div>
    </div>
  );
}

function Chat({ conversation: c, visible, onSettings }: { conversation: Conversation; visible: boolean; onSettings: () => void }) {
  const contexts = useClusterStore(s => s.contexts);
  const settings = useAiStore(s => s.settings);
  const models = useAiStore(s => s.models[c.providerId]);
  const loading = useAiStore(s => s.modelLoading[c.providerId]);
  const modelError = useAiStore(s => s.modelErrors[c.providerId]);
  const update = useAiStore(s => s.update);
  const refresh = useAiStore(s => s.refreshModels);
  const transcript = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const [modePending, setModePending] = useState(false);

  useEffect(() => { if (c.providerId && !models && desktopAiAvailable() && !loading && !modelError) void refresh(c.providerId); }, [c.providerId, models, loading, modelError, refresh]);
  useEffect(() => {
    if (visible && nearBottom.current && transcript.current) transcript.current.scrollTop = c.messages.length ? transcript.current.scrollHeight : 0;
  }, [c.messages, c.status, visible]);
  useEffect(() => { nearBottom.current = true; if (visible) input.current?.focus(); }, [c.id, visible]);

  async function mode(next: AgentMode) {
    setModePending(true);
    try { await useAiStore.getState().setMode(c.id, next); }
    finally { setModePending(false); }
  }

  async function phase(next: AgentPhase) {
    setModePending(true);
    try { await useAiStore.getState().setPhase(c.id, next); }
    finally { setModePending(false); }
  }

  const selectedModel = models?.find(m => m.id === c.model);
  const maxContextTokens = settings.options.contextTokens || selectedModel?.contextWindow || null;
  const currentContext = c.currentContextTokens || (c.inputTokens > 0 ? c.inputTokens : 0);
  const contextPercent = maxContextTokens && currentContext > 0
    ? Math.min(100, Math.round((currentContext / maxContextTokens) * 100))
    : 0;
  useEffect(() => { if (selectedModel && c.model) void useAiStore.getState().inspectModel(c.providerId, c.model); }, [c.providerId, c.model, selectedModel]);

  return <>
    <header className="ai-chat-header">
      <div className="ai-scope">
        <span className={`ai-cluster-pill ${c.scope.context === '*' ? 'is-all' : !c.scope.context ? 'is-general' : 'is-cluster'}`} title="Pinned cluster context for this conversation">
          <Server size={12} className="text-emerald-400" aria-hidden="true" />
          <span>{c.scope.context === '*' ? 'All clusters' : c.scope.context || 'General'}</span>
        </span>
        <span className="text-[var(--text-secondary)]">
          {c.scope.allNamespaces ? 'All namespaces' : c.scope.namespaces.join(', ') || 'No namespaces'}
        </span>
      </div>
      <span className="ai-grow" />
      <Button size="sm" variant="ghost" onClick={onSettings}><Settings size={13} aria-hidden="true" />Permissions</Button>
    </header>

    <div ref={transcript} className="ai-transcript kubiki-scrollbar" role="log" aria-label="AI conversation messages" aria-live="off" onScroll={e => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      {!c.messages.length && <div className="ai-empty-chat"><h2>{c.title === 'New conversation' ? 'What would you like to investigate?' : c.title}</h2>
        <p>Ask about Kubernetes, describe a deployment, or request evidence from this conversation's cluster.</p>
        <div className="ai-suggestions">{['Why are my Pods failing?', 'Create a Nexus deployment with persistent storage', 'Explain my workload configuration'].map(text => <button type="button" key={text} onClick={() => { update(c.id, { draft: text }); input.current?.focus(); }}>{text}</button>)}</div>
      </div>}
      {c.messages.map(message => <Message key={message.id} message={message} conversation={c} />)}
      {c.busy && (!c.messages.length || c.messages[c.messages.length - 1]?.role !== 'assistant') && (
        <LiveThinkingIndicator status={c.status} />
      )}
    </div>

    <footer className="ai-composer">
      <div className="ai-composer-config">
        <div className="ai-compact-inputs">
          {!c.sessionId && c.messages.length === 0 ? (
            <label className="ai-compact-field">
              <span className="sr-only">Cluster</span>
              <Select
                className="ide-select ai-compact-select"
                aria-label="AI conversation cluster"
                disabled={c.busy}
                value={c.scope.context === '*' ? '*' : c.scope.context || 'general'}
                onChange={e => {
                  const val = e.target.value;
                  let nextScope: AgentScope;
                  if (val === 'general' || val === '') {
                    nextScope = { context: '', namespaces: [], allNamespaces: false };
                  } else if (val === '*') {
                    nextScope = { context: '*', namespaces: [], allNamespaces: true };
                  } else {
                    const cur = currentAgentScope();
                    nextScope = {
                      context: val,
                      namespaces: cur.context === val ? cur.namespaces : [],
                      allNamespaces: cur.context === val ? cur.allNamespaces : true,
                    };
                  }
                  update(c.id, { scope: nextScope });
                }}
              >
                <option value="*">All clusters</option>
                {contexts.map(ctx => <option key={ctx.name} value={ctx.name}>Cluster: {ctx.name}</option>)}
                <option value="general">General chat · no cluster</option>
              </Select>
            </label>
          ) : (
            <span
              className={`ai-cluster-pill ${c.scope.context === '*' ? 'is-all' : !c.scope.context ? 'is-general' : 'is-cluster'}`}
              title="Pinned cluster context for this conversation"
            >
              <Server size={12} className="shrink-0 text-emerald-400" aria-hidden="true" />
              <span className="truncate max-w-[150px]">{c.scope.context === '*' ? 'All clusters' : c.scope.context || 'General'}</span>
            </span>
          )}

          <label className="ai-compact-field">
            <span className="sr-only">Provider</span>
            <Select
              className="ide-select ai-compact-select"
              aria-label="Conversation AI provider"
              disabled={!!c.sessionId || c.busy}
              value={c.providerId}
              onChange={e => update(c.id, { providerId: e.target.value, model: e.target.value === settings.defaultProvider ? settings.defaultModel ?? '' : '' })}
            >
              <option value="">Configure provider</option>
              {settings.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
          <label className="ai-compact-field ai-grow">
            <span className="sr-only">Model</span>
            <Select
              className="ide-select ai-compact-select"
              aria-label="Conversation AI model"
              disabled={!!c.sessionId || c.busy}
              value={c.model}
              onChange={e => update(c.id, { model: e.target.value })}
              onPointerDown={() => { if (c.providerId && desktopAiAvailable() && !loading) void refresh(c.providerId); }}
              onFocus={() => { if (c.providerId && desktopAiAvailable() && !loading) void refresh(c.providerId); }}
            >
              <option value="">{loading ? 'Loading models…' : 'Select model'}</option>
              {c.model && !models?.some(m => m.id === c.model) && <option value={c.model}>{c.model} (refresh to verify)</option>}
              {models?.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}
            </Select>
          </label>
        </div>

        <div className="ai-composer-axes">
          <div role="group" aria-label="AI execution phase" className="ai-phases">
            {(Object.entries(PHASE_LABELS) as [AgentPhase, string][]).map(([value, label]) => {
              const disabled = (value === 'action' && c.mode === 'read_only') || modePending || c.invalidated;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={c.phase === value}
                  disabled={disabled}
                  title={value === 'action' && c.mode === 'read_only' ? 'Action is forbidden in Read only mode; switch to Ask or Accept first' : undefined}
                  onClick={() => void phase(value)}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div role="group" aria-label="AI execution mode" className="ai-modes">
            {(Object.entries(MODE_LABELS) as [AgentMode, string][]).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={c.mode === value}
                disabled={modePending || c.invalidated}
                onClick={() => void mode(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {modelError && <p role="alert" className="ai-error">{modelError}</p>}
      {selectedModel?.tools === false && <p className="ai-notice">This model advertises no tool support. Choose a tool-capable model for cluster operations.</p>}
      {c.error && <p role="alert" className="ai-error">{c.error}</p>}
      {c.invalidated && <Button size="sm" onClick={() => useAiStore.getState().create(c.scope, c.draft, c.title)}>Start a new conversation</Button>}
      {!settings.providers.length && <p className="ai-help">Add a cloud or local connection in <button className="ai-text-button" type="button" onClick={onSettings}>AI settings</button> to begin.</p>}
      <label className="sr-only" htmlFor={`ai-message-${c.id}`}>Message AI agent</label>
      <textarea ref={input} id={`ai-message-${c.id}`} aria-label="Message AI agent" className="ide-textarea" value={c.draft} maxLength={24000} rows={3} placeholder="Ask a question or describe what you want to create…" onChange={e => update(c.id, { draft: e.target.value })} onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!c.busy && !c.invalidated && desktopAiAvailable()) void useAiStore.getState().send(c.id); }
      }} />
      <div className="ai-form-line">
        <span className="ai-run-status flex items-center gap-1.5 flex-wrap" role="status">
          <span>{statusLabels[c.status] ?? c.status}</span>
          {c.inputTokens + c.outputTokens > 0 && (
            <span>· {c.inputTokens.toLocaleString()} input / {c.outputTokens.toLocaleString()} output tokens</span>
          )}
          {maxContextTokens ? (
            <span
              className="ai-context-indicator inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono text-[10.5px]"
              title={`Context window usage: ${currentContext.toLocaleString()} used of ${maxContextTokens.toLocaleString()} tokens maximum (${contextPercent}%)`}
            >
              <span className="text-[var(--text-muted)]">Context:</span>
              <span className={contextPercent > 80 ? 'text-amber-400 font-semibold' : 'text-[var(--text-secondary)]'}>
                {formatTokenCount(currentContext)} / {formatTokenCount(maxContextTokens)}
              </span>
              <span className="text-[var(--text-muted)]">({contextPercent}%)</span>
            </span>
          ) : currentContext > 0 ? (
            <span className="text-[var(--text-muted)] font-mono text-[10.5px]">
              · Context: ~{formatTokenCount(currentContext)}
            </span>
          ) : null}
        </span>
        <span className="ai-grow" />
        {c.busy ? <Button size="sm" variant="danger" onClick={() => void useAiStore.getState().stop(c.id)}><Square size={12} aria-hidden="true" />Stop</Button>
          : <Button size="sm" variant="primary" disabled={!desktopAiAvailable() || !c.draft.trim() || !c.providerId || !c.model || modePending || c.invalidated} onClick={() => void useAiStore.getState().send(c.id)}><Send size={12} aria-hidden="true" />Send</Button>}
      </div>
    </footer>
  </>;
}

function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString();
}

function copy(text: string) { void navigator.clipboard.writeText(text).then(() => toast.success('Copied')).catch(() => toast.error('Clipboard unavailable')); }

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return <div className="ai-code"><div className="ai-code-actions"><Button size="sm" variant="ghost" aria-label="Copy code" onClick={() => copy(ref.current?.textContent ?? '')}><Copy size={12} aria-hidden="true" />Copy</Button></div><pre ref={ref}>{children}</pre></div>;
}

interface ParsedThinking {
  thinking?: string;
  isThinkingActive: boolean;
  content: string;
}

function parseThinking(text: string, isStreaming: boolean): ParsedThinking {
  const thinkMatch = text.match(/<think>([\s\S]*?)(?:<\/think>|$)/i) ||
                     text.match(/<thought>([\s\S]*?)(?:<\/thought>|$)/i);
  if (!thinkMatch) {
    return { isThinkingActive: false, content: text };
  }

  const thinking = thinkMatch[1].trim();
  const hasClosed = /<\/think>|<\/thought>/i.test(text);
  const content = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<thought>[\s\S]*$/gi, '')
    .trim();

  return {
    thinking,
    isThinkingActive: !hasClosed && isStreaming,
    content,
  };
}

function ThinkingBlock({ thinking, isActive }: { thinking: string; isActive: boolean }) {
  const [open, setOpen] = useState(isActive);

  useEffect(() => {
    if (isActive) setOpen(true);
  }, [isActive]);

  return (
    <div className={`ai-thinking-block ${isActive ? 'is-active' : ''}`}>
      <div
        className="ai-thinking-header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}
      >
        <div className="flex items-center gap-2">
          {isActive ? (
            <Sparkles size={13} className="ai-thinking-spinner text-amber-400" aria-hidden="true" />
          ) : (
            <Brain size={13} className="text-indigo-400" aria-hidden="true" />
          )}
          <span className="font-medium">
            {isActive ? 'Thinking…' : 'Thought process'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <span>{open ? 'Hide' : 'Show'}</span>
          <ChevronDown size={13} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </div>
      </div>
      {open && (
        <div className="ai-thinking-content kubiki-scrollbar">
          {thinking || 'Reasoning about prompt and cluster state…'}
        </div>
      )}
    </div>
  );
}

function LiveThinkingIndicator({ status }: { status: string }) {
  const [elapsed, setElapsed] = useState(1);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="ai-live-indicator" role="status" aria-live="polite">
      <Sparkles size={14} className="ai-thinking-spinner text-amber-400" aria-hidden="true" />
      <span className="font-medium text-[var(--text-primary)]">
        {status === 'connecting' ? 'Connecting to model…' : 'Thinking…'}
      </span>
      <span className="text-xs text-[var(--text-muted)] font-mono ml-auto">
        {elapsed}s
      </span>
    </div>
  );
}

function Message({ message: m, conversation: c }: { message: ChatMessage; conversation: Conversation }) {
  if (m.role === 'tool') {
    const result = m.result;
    const proposal = result?.proposal === true && typeof result.yaml === 'string';
    const error = typeof result?.error === 'string' ? result.error : undefined;
    const isRunning = !result && c.busy;
    const args = m.call?.arguments as Record<string, any> | undefined;
    const targetSummary = args ? [args.namespace, args.kind, args.name].filter(Boolean).join('/') : '';

    return (
      <article className={`ai-tool ${error ? 'has-error' : ''} ${isRunning ? 'is-running' : ''}`} aria-label={`AI tool ${m.call?.name}`}>
        <details open={proposal || !!error}>
          <summary>
            <span className="ai-tool-title">
              {isRunning ? (
                <RefreshCw size={12} className="ai-thinking-spinner text-amber-400" aria-hidden="true" />
              ) : error ? (
                <AlertCircle size={12} className="text-[var(--status-danger)]" aria-hidden="true" />
              ) : proposal ? (
                <FileCode size={12} className="text-cyan-400" aria-hidden="true" />
              ) : (
                <Check size={12} className="text-emerald-400" aria-hidden="true" />
              )}
              <span>{m.call?.name}</span>
              {targetSummary && (
                <span className="ai-tool-badge font-mono truncate max-w-[200px]" title={targetSummary}>
                  {targetSummary}
                </span>
              )}
            </span>
            <div className="flex items-center gap-2 text-xs">
              <span className="ai-tool-status">
                {isRunning
                  ? 'Executing…'
                  : error
                  ? 'Denied or failed'
                  : typeof result?.status === 'string'
                  ? result.status
                  : proposal
                  ? 'Proposal · not executed'
                  : 'Complete'}
              </span>
              <ChevronDown size={12} className="text-[var(--text-muted)]" aria-hidden="true" />
            </div>
          </summary>
          {error ? (
            <p className="ai-error p-3">{error}</p>
          ) : proposal ? (
            <div className="p-3">
              <h4 className="text-xs font-semibold mb-2">{String(result.title ?? 'Proposed resources')}</h4>
              <CodeBlock><code>{String(result.yaml)}</code></CodeBlock>
              {c.mode !== 'read_only' && !c.busy && (
                <div className="mt-2.5">
                  <Button size="sm" variant="primary" onClick={() => {
                    useAiStore.getState().update(c.id, { draft: 'Apply the YAML proposal above using apply_manifest for each document, within the current access policy. Report the actual tool receipts and verify the resulting resources when permitted.' });
                    void useAiStore.getState().send(c.id);
                  }}>
                    Ask agent to apply proposal
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="p-3">
              <pre className="ai-tool-result">{result ? JSON.stringify(result, null, 2) : JSON.stringify(m.call?.arguments, null, 2)}</pre>
            </div>
          )}
        </details>
      </article>
    );
  }

  const isUser = m.role === 'user';
  const isPlan = !isUser && (m.phase === 'plan' || /^(#+ Plan|Proposed Plan|Plan:)/im.test(m.text));
  const isStreaming = c.busy && c.messages[c.messages.length - 1]?.id === m.id;
  const { thinking, isThinkingActive, content } = !isUser ? parseThinking(m.text, isStreaming) : { isThinkingActive: false, content: m.text };

  return (
    <article
      className={`ai-message is-${m.role} ${isPlan ? 'is-plan' : ''}`}
      aria-label={isUser ? 'Your message' : 'Agent response'}
    >
      <div className="ai-message-heading">
        <div className="flex items-center gap-2">
          {isUser ? (
            <strong>You</strong>
          ) : (
            <>
              <Bot size={13} className={isPlan ? 'text-emerald-400' : 'text-indigo-400'} aria-hidden="true" />
              <strong>Kubiki AI</strong>
              {isPlan ? (
                <span className="ai-plan-badge" title="Strategic plan proposal phase">
                  <FileText size={10} aria-hidden="true" />
                  Plan
                </span>
              ) : m.phase === 'action' ? (
                <span className="ai-action-badge" title="Execution action phase">
                  Action
                </span>
              ) : null}
            </>
          )}
        </div>
        <Button variant="ghost" size="sm" aria-label="Copy message" onClick={() => copy(m.text)}>
          <Copy size={12} aria-hidden="true" />
        </Button>
      </div>

      {thinking ? <ThinkingBlock thinking={thinking} isActive={isThinkingActive} /> : null}

      <div className="ai-markdown">
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          urlTransform={url => /^https?:\/\//i.test(url) ? url : ''}
          components={{
            pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
            img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>,
            a: ({ href, children }) => href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => {
                  if (desktopAiAvailable()) {
                    e.preventDefault();
                    void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(href)).catch(() => toast.error('Cannot open link'));
                  }
                }}
              >
                {children}
              </a>
            ) : <span>{children}</span>,
          }}
        >
          {content || (isThinkingActive ? '' : m.text)}
        </Markdown>
      </div>

      {!isUser && (
        <div className="ai-message-footer">
          <div className="ai-message-stats">
            {m.model && (
              <span className="ai-stat-chip" title="Model used for this response">
                <Cpu size={11} className="text-indigo-400" aria-hidden="true" />
                <span className="font-mono">{m.model}</span>
              </span>
            )}
            {m.tokensPerSec !== undefined && m.tokensPerSec > 0 && (
              <span className="ai-stat-chip text-emerald-400 font-mono" title="Generation speed">
                <Zap size={11} className="text-emerald-400" aria-hidden="true" />
                <span>{m.tokensPerSec} tok/s</span>
              </span>
            )}
            {m.outputTokens !== undefined && m.outputTokens > 0 && (
              <span className="ai-stat-chip text-[var(--text-muted)] font-mono" title="Tokens generated">
                <span>{m.outputTokens} tokens</span>
                {m.durationMs ? <span>in {(m.durationMs / 1000).toFixed(1)}s</span> : null}
              </span>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
