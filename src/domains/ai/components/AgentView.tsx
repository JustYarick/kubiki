import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, Copy, Plus, RefreshCw, Send, Settings, Shield, Square, Trash2, WandSparkles } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { toast } from '../../../state/notifications_store';
import { currentAgentScope } from '../navigation';
import { useAiStore } from '../store';
import { desktopAiAvailable } from '../transport';
import { MODE_LABELS, PHASE_LABELS, type AgentMode, type AgentPhase, type ChatMessage, type Conversation } from '../types';
import { AgentSettings, type AgentSettingsHandle } from './AgentSettings';
import '../ai.css';

const statusLabels: Record<string, string> = {
  idle: 'Ready', connecting: 'Connecting', running: 'Working', awaiting_approval: 'Waiting for your review',
  executing: 'Applying change', completed: 'Complete', cancelled: 'Stopped', stopping: 'Stopping; awaiting in-flight requests', failed: 'Failed',
};

export function AgentView({ visible = true }: { visible?: boolean }) {
  const state = useAiStore();
  const conversation = state.conversations.find(c => c.id === state.activeId);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const add = (create = false) => state.create(currentAgentScope(), create ? 'Create an application in Kubernetes. ' : '', create ? 'Create with AI' : undefined);

  async function saveSettingsModal() {
    if (settingsRef.current) {
      const ok = await settingsRef.current.save();
      if (ok) {
        toast.success('Settings saved');
      }
    }
  }

  return <section className="ai-workspace" aria-label="AI Agent workspace">
    <aside className="ai-conversations" aria-label="AI conversations">
      <div className="ai-form-line"><strong><Bot size={15} aria-hidden="true" />AI Agent</strong><Button size="sm" aria-label="New AI conversation" onClick={() => add()}><Plus size={13} aria-hidden="true" /></Button></div>
      <div className="ai-conversation-list">{state.conversations.map(c => <div key={c.id} className={`ai-conversation-row ${c.id === state.activeId ? 'is-active' : ''}`}>
        <button type="button" aria-pressed={c.id === state.activeId} onClick={() => useAiStore.setState({ activeId: c.id })}><span>{c.title}</span><small>{c.scope.context || 'General chat'} · {PHASE_LABELS[c.phase]} · {MODE_LABELS[c.mode]}</small></button>
        <Button variant="ghost" size="sm" aria-label={`Delete conversation ${c.title}`} onClick={() => void state.remove(c.id)}><Trash2 size={12} aria-hidden="true" /></Button>
      </div>)}</div>
      <p className="ai-help">Conversations stay in memory. Permissions and provider connections are saved on this device.</p>
      <Button size="sm" onClick={() => setSettingsOpen(true)}><Settings size={13} aria-hidden="true" />AI settings</Button>
    </aside>
    <div className="ai-chat">
      <div className="ai-mobile-conversations">
        <label className="ai-field ai-grow">Conversation<Select aria-label="Active AI conversation" className="ide-select" value={state.activeId ?? ''} onChange={e => useAiStore.setState({ activeId: e.target.value })}>
          <option value="">Choose conversation</option>{state.conversations.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
        </Select></label>
        <Button size="sm" onClick={() => add()}><Plus size={12} aria-hidden="true" />New</Button>
        <Button size="sm" onClick={() => setSettingsOpen(true)}><Settings size={12} aria-hidden="true" />Settings</Button>
      </div>
      {!desktopAiAvailable() && <p className="ai-notice">AI connections and cluster tools run in the desktop app. You can explore the interface here; no data is sent.</p>}
      {state.error && <p role="alert" className="ai-error">{state.error}</p>}
      {conversation ? <Chat conversation={conversation} visible={visible} onSettings={() => setSettingsOpen(true)} /> : <div className="ai-welcome">
        <Bot size={30} aria-hidden="true" /><h2>Your Kubernetes assistant</h2>
        <p>Ask a question, investigate a failing resource, or describe the application you want to create.</p>
        <div className="ai-form-line"><Button variant="primary" onClick={() => add()}><Plus size={13} aria-hidden="true" />New conversation</Button><Button onClick={() => add(true)}><WandSparkles size={13} aria-hidden="true" />Create with AI</Button></div>
        <p className="ai-help"><Shield size={13} aria-hidden="true" />Starts in Plan and Read only. Secret contents, ConfigMap contents and logs are excluded by default.</p>
      </div>}
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

function Chat({ conversation: c, visible, onSettings }: { conversation: Conversation; visible: boolean; onSettings: () => void }) {
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
  useEffect(() => { if (selectedModel && c.model) void useAiStore.getState().inspectModel(c.providerId, c.model); }, [c.providerId, c.model, selectedModel]);

  return <>
    <header className="ai-chat-header">
      <div className="ai-scope">
        <Shield size={14} aria-hidden="true" />
        <span title={c.scope.context}>{c.scope.context || 'General chat · no cluster'}</span>
        <span>{c.scope.allNamespaces ? 'All namespaces' : c.scope.namespaces.join(', ') || 'No namespaces'}</span>
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
    </div>

    <footer className="ai-composer">
      <div className="ai-composer-config">
        <div className="ai-compact-inputs">
          <label className="ai-compact-field">
            <span className="sr-only">Scope</span>
            <Select className="ide-select ai-compact-select" aria-label="AI conversation scope" disabled={!!c.sessionId || c.busy} value={c.scope.context ? 'cluster' : 'general'} onChange={e => update(c.id, { scope: e.target.value === 'general' ? { context: '', namespaces: [], allNamespaces: false } : currentAgentScope() })}>
              <option value="general">General chat · no cluster</option>
              <option value="cluster" disabled={!currentAgentScope().context}>Cluster: {c.scope.context || currentAgentScope().context || 'none'}</option>
            </Select>
          </label>
          <label className="ai-compact-field">
            <span className="sr-only">Provider</span>
            <Select className="ide-select ai-compact-select" aria-label="Conversation AI provider" disabled={!!c.sessionId || c.busy} value={c.providerId} onChange={e => update(c.id, { providerId: e.target.value, model: e.target.value === settings.defaultProvider ? settings.defaultModel ?? '' : '' })}>
              <option value="">Configure provider</option>
              {settings.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
          <label className="ai-compact-field ai-grow">
            <span className="sr-only">Model</span>
            <Select className="ide-select ai-compact-select" aria-label="Conversation AI model" disabled={!!c.sessionId || c.busy} value={c.model} onChange={e => update(c.id, { model: e.target.value })}>
              <option value="">Select model</option>
              {c.model && !models?.some(m => m.id === c.model) && <option value={c.model}>{c.model} (refresh to verify)</option>}
              {models?.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}
            </Select>
          </label>
          <Button size="sm" aria-label="Refresh conversation models" loading={loading} disabled={!c.providerId || !desktopAiAvailable()} onClick={() => void refresh(c.providerId)}><RefreshCw size={12} aria-hidden="true" /></Button>
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

      <div className="ai-mode-description">
        {c.phase === 'plan'
          ? (c.mode === 'read_only'
              ? 'Plan (Read only): Safely explore cluster and propose plans. Cluster changes are strictly blocked.'
              : c.mode === 'ask'
              ? 'Plan: Inspection and proposal mode. Switch to Action to review and apply proposed changes.'
              : 'Plan: Inspection and proposal mode. Switch to Action to execute permitted changes.')
          : (c.mode === 'ask'
              ? 'Action (Ask): Changes require explicit native confirmation for each operation.'
              : 'Action (Accept): Permitted changes execute automatically within policy bounds.')}
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
      <div className="ai-form-line"><span className="ai-run-status" role="status">{statusLabels[c.status] ?? c.status}{c.inputTokens + c.outputTokens > 0 ? ` · ${c.inputTokens.toLocaleString()} input / ${c.outputTokens.toLocaleString()} output tokens` : ''}</span><span className="ai-grow" />
        <span className="ai-help">Enter to send · Shift+Enter for a new line</span>
        {c.busy ? <Button size="sm" variant="danger" onClick={() => void useAiStore.getState().stop(c.id)}><Square size={12} aria-hidden="true" />Stop</Button>
          : <Button size="sm" variant="primary" disabled={!desktopAiAvailable() || !c.draft.trim() || !c.providerId || !c.model || modePending || c.invalidated} onClick={() => void useAiStore.getState().send(c.id)}><Send size={12} aria-hidden="true" />Send</Button>}
      </div>
    </footer>
  </>;
}

function copy(text: string) { void navigator.clipboard.writeText(text).then(() => toast.success('Copied')).catch(() => toast.error('Clipboard unavailable')); }

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return <div className="ai-code"><div className="ai-code-actions"><Button size="sm" variant="ghost" aria-label="Copy code" onClick={() => copy(ref.current?.textContent ?? '')}><Copy size={12} aria-hidden="true" />Copy</Button></div><pre ref={ref}>{children}</pre></div>;
}

function Message({ message: m, conversation: c }: { message: ChatMessage; conversation: Conversation }) {
  if (m.role === 'tool') {
    const result = m.result;
    const proposal = result?.proposal === true && typeof result.yaml === 'string';
    const error = typeof result?.error === 'string' ? result.error : undefined;
    return <article className={`ai-tool ${error ? 'has-error' : ''}`} aria-label={`AI tool ${m.call?.name}`}>
      <details open={proposal || !!error}>
        <summary><span>{!result ? <RefreshCw size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}{m.call?.name}</span><span>{!result ? 'Requested' : error ? 'Denied or failed' : typeof result.status === 'string' ? result.status : proposal ? 'Proposal · not executed' : 'Complete'}</span></summary>
        {error ? <p className="ai-error">{error}</p> : proposal ? <><h4>{String(result.title ?? 'Proposed resources')}</h4><CodeBlock><code>{String(result.yaml)}</code></CodeBlock>
          {c.mode !== 'read_only' && !c.busy && <Button size="sm" onClick={() => {
            useAiStore.getState().update(c.id, { draft: 'Apply the YAML proposal above using apply_manifest for each document, within the current access policy. Report the actual tool receipts and verify the resulting resources when permitted.' });
            void useAiStore.getState().send(c.id);
          }}>Ask agent to apply proposal</Button>}
        </> : <pre className="ai-tool-result">{result ? JSON.stringify(result, null, 2) : JSON.stringify(m.call?.arguments, null, 2)}</pre>}
      </details>
    </article>;
  }
  return <article className={`ai-message is-${m.role}`} aria-label={m.role === 'user' ? 'Your message' : 'Agent response'}>
    <div className="ai-message-heading"><strong>{m.role === 'user' ? 'You' : 'Kubiki AI'}</strong><Button variant="ghost" size="sm" aria-label="Copy message" onClick={() => copy(m.text)}><Copy size={12} aria-hidden="true" /></Button></div>
    <div className="ai-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => /^https?:\/\//i.test(url) ? url : ''} components={{
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      // Images would make unreviewed network requests to model-selected URLs.
      img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>,
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" onClick={e => { if (desktopAiAvailable()) { e.preventDefault(); void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(href)).catch(() => toast.error('Cannot open link')); } }}>{children}</a> : <span>{children}</span>,
    }}>{m.text}</Markdown></div>
  </article>;
}
