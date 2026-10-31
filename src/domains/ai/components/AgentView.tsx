import { useEffect, useRef, useState, isValidElement, type ReactNode } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Cpu,
  FileCode,
  FileText,
  HelpCircle,
  Plus,
  RefreshCw,
  Send,
  Server,
  Settings,
  Shield,
  ShieldAlert,
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
import { CodeEditor } from '../../../components/ui/CodeEditor';
import { useMutationConfirmStore, type MutationConfirmRequest } from '../../../state/mutation_confirm_store';
import { toast } from '../../../state/notifications_store';
import { useClusterStore } from '../../../state/cluster_store';
import { currentAgentScope } from '../navigation';
import { useAiStore } from '../store';
import { desktopAiAvailable } from '../transport';
import { MODE_LABELS, PHASE_LABELS, type AgentMode, type AgentPhase, type AgentScope, type ChatMessage, type Conversation } from '../types';
import { AgentSettings, type AgentSettingsHandle } from './AgentSettings';
import { getToolIntent } from '../tool_intents';
import { getClusterTone } from '../../../core/cluster_color';
import { stringify } from 'yaml';
import '../ai.css';

function getSavedModel(providerId: string, fallbackDefault?: string | null): string {
  if (!providerId) return '';
  try {
    const saved = localStorage.getItem(`kubiki.ai.model.${providerId}`);
    if (saved) return saved;
  } catch {}
  return fallbackDefault ?? '';
}

function formatManifestOrDiff(rawDiff: string, appliedYaml?: string): { code: string; language: 'yaml' | 'json' } {
  if (appliedYaml && appliedYaml.trim()) {
    return { code: appliedYaml.trim(), language: 'yaml' };
  }
  let text = (rawDiff || '').trim();
  if (text.startsWith('CREATE object:\n')) {
    text = text.slice('CREATE object:\n'.length).trim();
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      return { code: stringify(parsed).trim(), language: 'yaml' };
    } catch {
      // keep text
    }
  }
  return { code: text, language: 'yaml' };
}

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

function ClusterPill({ context, label, title, className = '' }: { context?: string | null; label?: string; title?: string; className?: string }) {
  const tone = getClusterTone(context);
  const isSpecial = !context || context === 'general' || context === '*';
  const displayLabel = label ?? (context === '*' ? 'All clusters' : context || 'No cluster connected');

  return (
    <span
      className={`ai-cluster-pill ${context === '*' ? 'is-all' : !context || context === 'general' ? 'is-general' : 'is-cluster'} ${className}`}
      style={!isSpecial ? {
        color: tone.color,
        backgroundColor: tone.bg,
        borderColor: tone.border,
      } : undefined}
      title={title}
    >
      <span
        className="ai-cluster-status-dot"
        style={{ backgroundColor: isSpecial ? (context === '*' ? 'var(--accent)' : 'var(--text-muted)') : tone.dot }}
        aria-hidden="true"
      />
      <Server size={12} style={!isSpecial ? { color: tone.color } : undefined} className="shrink-0" aria-hidden="true" />
      <span className="truncate max-w-[170px]">{displayLabel}</span>
    </span>
  );
}

function ClusterCircleButton({
  context,
  disabled = false,
  onSelect,
  contexts,
  currentContext,
}: {
  context?: string | null;
  disabled?: boolean;
  onSelect: (ctx: string) => void;
  contexts: { name: string }[];
  currentContext?: string | null;
}) {
  const tone = getClusterTone(context);
  const isSpecial = !context || context === 'general' || context === '*';
  const label = context === '*' ? 'All clusters' : context || 'General chat · No cluster';

  return (
    <div
      className={`ai-cluster-circle-wrapper ${disabled ? 'opacity-80' : ''}`}
      title={`Cluster: ${label}${disabled ? ' (pinned for this conversation)' : ' · Click to switch'}`}
    >
      <div
        className="ai-cluster-circle-btn"
        style={!isSpecial ? {
          color: tone.color,
          backgroundColor: tone.bg,
          borderColor: tone.border,
        } : undefined}
      >
        <span
          className="ai-cluster-circle-dot"
          style={{ backgroundColor: isSpecial ? (context === '*' ? 'var(--accent)' : 'var(--text-muted)') : tone.dot }}
          aria-hidden="true"
        />
        <Server size={13} style={!isSpecial ? { color: tone.color } : undefined} className="shrink-0" aria-hidden="true" />
      </div>
      <Select
        className="ai-circle-select-overlay"
        aria-label="AI conversation cluster"
        disabled={disabled}
        value={context === '*' ? '*' : context || 'general'}
        onChange={e => onSelect(e.target.value)}
      >
        <option value="*">All clusters</option>
        {contexts.map(ctx => <option key={ctx.name} value={ctx.name}>Cluster: {ctx.name}</option>)}
        {currentContext && !contexts.some(c => c.name === currentContext) && (
          <option value={currentContext}>Cluster: {currentContext}</option>
        )}
        <option value="general">General chat · no cluster</option>
      </Select>
    </div>
  );
}

function ProviderModelCapsule({
  providerId,
  model,
  providers,
  models,
  modelsLoading = false,
  disabled = false,
  onProviderChange,
  onModelChange,
  onRefreshModels,
}: {
  providerId: string;
  model: string;
  providers: { id: string; name: string }[];
  models?: { id: string; name: string }[];
  modelsLoading?: boolean;
  disabled?: boolean;
  onProviderChange: (id: string) => void;
  onModelChange: (model: string) => void;
  onRefreshModels?: () => void;
}) {
  const currentProvider = providers.find(p => p.id === providerId);
  const currentModel = models?.find(m => m.id === model);
  const providerLabel = currentProvider?.name || (providers.length === 0 ? 'No provider' : 'Select provider');
  const modelLabel = currentModel?.name ? (currentModel.name === currentModel.id ? currentModel.id : `${currentModel.name}`) : model || (modelsLoading ? 'Loading…' : 'Select model');

  return (
    <div className={`ai-provider-model-capsule ${disabled ? 'opacity-80' : ''}`} title="AI Provider and Model selection">
      {/* Provider half (Left) */}
      <div className="ai-capsule-half-wrapper is-provider" title={`Provider: ${providerLabel}${disabled ? ' (pinned)' : ' · Click to switch'}`}>
        <div className="ai-capsule-half-content">
          <Zap size={11} className="text-amber-400 shrink-0" aria-hidden="true" />
          <span className="truncate max-w-[100px] font-medium">{providerLabel}</span>
          <ChevronDown size={10} className="text-[var(--text-muted)] shrink-0" aria-hidden="true" />
        </div>
        <Select
          className="ai-capsule-select-overlay"
          aria-label="Conversation AI provider"
          disabled={disabled}
          value={providerId}
          onChange={e => onProviderChange(e.target.value)}
        >
          <option value="">Configure provider</option>
          {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>

      <span className="ai-capsule-divider" aria-hidden="true" />

      {/* Model half (Right) */}
      <div className="ai-capsule-half-wrapper is-model" title={`Model: ${modelLabel}${disabled ? ' (pinned)' : ' · Click to switch'}`}>
        <div className="ai-capsule-half-content">
          <Sparkles size={11} className="text-sky-400 shrink-0" aria-hidden="true" />
          <span className="truncate max-w-[130px] font-medium">{modelLabel}</span>
          <ChevronDown size={10} className="text-[var(--text-muted)] shrink-0" aria-hidden="true" />
        </div>
        <Select
          className="ai-capsule-select-overlay"
          aria-label="Conversation AI model"
          disabled={disabled}
          value={model}
          onChange={e => onModelChange(e.target.value)}
          onPointerDown={() => { if (onRefreshModels && !modelsLoading) onRefreshModels(); }}
          onFocus={() => { if (onRefreshModels && !modelsLoading) onRefreshModels(); }}
        >
          <option value="">{modelsLoading ? 'Loading models…' : 'Select model'}</option>
          {model && !models?.some(m => m.id === model) && <option value={model}>{model} (refresh to verify)</option>}
          {models?.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}
        </Select>
      </div>
    </div>
  );
}

function AgentHome({ onSettings }: { onSettings: () => void }) {
  const currentContext = useClusterStore(s => s.currentContext);
  const contexts = useClusterStore(s => s.contexts);
  const [selectedCluster, setSelectedCluster] = useState<string>(currentContext || '*');
  const [clusterUserChanged, setClusterUserChanged] = useState(false);
  const settings = useAiStore(s => s.settings);
  const [providerId, setProviderId] = useState(settings.defaultProvider ?? settings.providers[0]?.id ?? '');
  const [model, setModel] = useState(() => getSavedModel(settings.defaultProvider ?? settings.providers[0]?.id ?? '', settings.defaultModel));
  const [phase, setPhase] = useState<AgentPhase>('plan');
  const [mode, setMode] = useState<AgentMode>('read_only');
  const draft = useAiStore(s => s.homeDraft);
  const setDraft = useAiStore(s => s.setHomeDraft);
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
      if (!model) setModel(getSavedModel(pid, pid === settings.defaultProvider ? settings.defaultModel : ''));
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

  useEffect(() => {
    if (models && models.length > 0 && providerId) {
      if (!model || !models.some(m => m.id === model)) {
        const preferred = getSavedModel(providerId, providerId === settings.defaultProvider ? settings.defaultModel : '');
        if (preferred && models.some(m => m.id === preferred)) {
          setModel(preferred);
        } else if (!model && models[0]) {
          const autoModel = models[0].id;
          setModel(autoModel);
          try { localStorage.setItem(`kubiki.ai.model.${providerId}`, autoModel); } catch {}
          void useAiStore.getState().saveDefaults(providerId, autoModel);
        }
      }
    }
  }, [models, model, providerId, settings]);

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
      const chosenModel = model || getSavedModel(providerId, settings.defaultModel);
      useAiStore.setState({ homeDraft: '' });
      const id = useAiStore.getState().create(scope, draft, undefined, providerId, chosenModel, phase, mode);
      await useAiStore.getState().send(id);
    } finally {
      setSending(false);
    }
  }

  const selectedModel = models?.find(m => m.id === model);

  return (
    <div className="ai-home ai-transcript kubiki-scrollbar">
      <div className="ai-home-hero">
        <div className="ai-home-brand-logo flex items-center justify-center select-none">
          <img
            src="/brand/kubiki-logo-color-dark.svg"
            alt="kubiki"
            width={360}
            height={128}
            draggable={false}
            className="h-10 sm:h-12 w-auto shrink-0 select-none drop-shadow-md"
          />
        </div>
      </div>

      <div className="ai-composer-card">
        {/* Top Controls: Cluster, Provider & Model buttons ON TOP OF input */}
        <div className="ai-composer-card-top">
          <div className="ai-composer-card-controls">
            <ClusterCircleButton
              context={selectedCluster}
              onSelect={val => {
                setSelectedCluster(val);
                setClusterUserChanged(true);
              }}
              contexts={contexts}
              currentContext={currentContext}
            />

            <ProviderModelCapsule
              providerId={providerId}
              model={model}
              providers={settings.providers}
              models={models}
              modelsLoading={modelsLoading}
              onProviderChange={pid => {
                setProviderId(pid);
                const preferred = getSavedModel(pid, pid === settings.defaultProvider ? settings.defaultModel : '');
                setModel(preferred);
                void useAiStore.getState().saveDefaults(pid, preferred || null);
              }}
              onModelChange={nextModel => {
                setModel(nextModel);
                if (providerId) {
                  try { localStorage.setItem(`kubiki.ai.model.${providerId}`, nextModel); } catch {}
                  void useAiStore.getState().saveDefaults(providerId, nextModel);
                }
              }}
              onRefreshModels={() => { if (providerId && desktopAiAvailable() && !modelsLoading) void refresh(providerId); }}
            />
          </div>

          <div className="ai-composer-card-axes">
            <div role="group" aria-label="AI execution phase" className="ai-phases">
              {['plan', 'tooling'].map(key => {
                const label = PHASE_LABELS[key] ?? key;
                const isTooling = key === 'tooling';
                const isSelected = isTooling ? (phase === 'tooling' || phase === 'action') : phase === 'plan';
                const disabled = (isTooling && mode === 'read_only');
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={isSelected}
                    disabled={disabled}
                    title={isTooling && mode === 'read_only' ? 'Tooling is forbidden in Read only mode; switch to Ask or Accept first' : undefined}
                    onClick={() => setPhase(key as AgentPhase)}
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
          </div>
        </div>

        {/* Fixed-size textarea */}
        <textarea
          ref={input}
          aria-label="Message AI agent"
          className="ai-composer-card-textarea kubiki-scrollbar"
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

        {/* Bottom bar with circular send button */}
        <div className="ai-composer-card-bottom">
          <div className="ai-composer-card-meta" />

          <div className="ai-composer-card-actions">
            <button
              type="button"
              className="ai-send-round-btn is-send"
              disabled={!desktopAiAvailable() || !draft.trim() || !providerId || !model || sending}
              onClick={() => void handleStart()}
              title="Send message (Enter)"
              aria-label="Send"
            >
              <span className="sr-only">Send</span>
              <ArrowUp size={15} strokeWidth={2.5} aria-hidden="true" />
            </button>
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
  const mutationPending = useMutationConfirmStore(s => s.pending);
  const resolveMutation = useMutationConfirmStore(s => s.resolve);
  const transcript = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const lastScrollTop = useRef(0);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const [modePending, setModePending] = useState(false);

  const AT_BOTTOM_THRESHOLD = 30;

  const scrollToBottom = (smooth = false) => {
    userScrolledUp.current = false;
    setShowScrollBottom(false);
    if (transcript.current) {
      if (smooth) {
        transcript.current.scrollTo({ top: transcript.current.scrollHeight, behavior: 'smooth' });
      } else {
        transcript.current.scrollTop = transcript.current.scrollHeight;
      }
      lastScrollTop.current = transcript.current.scrollTop;
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      // User is scrolling up with mousewheel/trackpad: instantly decouple auto-scroll
      userScrolledUp.current = true;
      setShowScrollBottom(true);
    } else if (e.deltaY > 0 && transcript.current) {
      const el = transcript.current;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distFromBottom <= AT_BOTTOM_THRESHOLD) {
        // User scrolled all the way to the bottom
        userScrolledUp.current = false;
        setShowScrollBottom(false);
      }
    }
  };

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const currentScrollTop = el.scrollTop;
    const isScrollingUp = currentScrollTop < lastScrollTop.current;
    lastScrollTop.current = currentScrollTop;

    const distFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight;

    if (isScrollingUp) {
      // Any upward movement decouples auto-scroll immediately
      userScrolledUp.current = true;
      setShowScrollBottom(true);
    } else if (distFromBottom <= AT_BOTTOM_THRESHOLD) {
      // Reached bottom moving downwards or stationary at bottom
      userScrolledUp.current = false;
      setShowScrollBottom(false);
    } else if (distFromBottom > AT_BOTTOM_THRESHOLD + 10) {
      userScrolledUp.current = true;
      setShowScrollBottom(true);
    }
  };

  useEffect(() => { if (c.providerId && !models && desktopAiAvailable() && !loading && !modelError) void refresh(c.providerId); }, [c.providerId, models, loading, modelError, refresh]);
  useEffect(() => {
    if (visible && !userScrolledUp.current && transcript.current) {
      transcript.current.scrollTop = c.messages.length ? transcript.current.scrollHeight : 0;
      lastScrollTop.current = transcript.current.scrollTop;
    }
  }, [c.messages, c.status, visible]);
  useEffect(() => {
    userScrolledUp.current = false;
    setShowScrollBottom(false);
    if (visible) {
      if (transcript.current) {
        transcript.current.scrollTop = transcript.current.scrollHeight;
        lastScrollTop.current = transcript.current.scrollTop;
      }
      input.current?.focus();
    }
  }, [c.id, visible]);

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

  const sendCurrent = () => {
    scrollToBottom(false);
    void useAiStore.getState().send(c.id);
  };

  const handleStartNew = () => {
    const validProvider = settings.providers.some(p => p.id === c.providerId) ? c.providerId : undefined;
    useAiStore.getState().create(
      c.scope,
      c.draft,
      c.title,
      validProvider,
      c.model,
      c.phase,
      c.mode
    );
  };

  const selectedModel = models?.find(m => m.id === c.model);
  const DEFAULT_CONTEXT_WINDOW = 262144; // 256k default when provider provides no contextWindow
  const maxContextTokens = settings.options.contextTokens || selectedModel?.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const currentContext = c.currentContextTokens || (c.inputTokens > 0 ? c.inputTokens : 0);
  const contextPercent = maxContextTokens && currentContext > 0
    ? Math.min(100, Math.round((currentContext / maxContextTokens) * 100))
    : 0;
  useEffect(() => { if (selectedModel && c.model) void useAiStore.getState().inspectModel(c.providerId, c.model); }, [c.providerId, c.model, selectedModel]);

  return <>
    <header className="ai-chat-header">
      <div className="ai-scope">
        <ClusterPill
          context={c.scope.context}
          label={c.scope.context === '*' ? 'All clusters' : c.scope.context || 'General'}
          title="Pinned cluster context for this conversation"
        />
        <span className="text-[var(--text-secondary)]">
          {c.scope.allNamespaces ? 'All namespaces' : c.scope.namespaces.join(', ') || 'No namespaces'}
        </span>
      </div>
      <span className="ai-grow" />
      <Button size="sm" variant="ghost" onClick={onSettings}><Settings size={13} aria-hidden="true" />Permissions</Button>
    </header>

    <div className="ai-transcript-container">
      <div
        ref={transcript}
        className="ai-transcript kubiki-scrollbar"
        role="log"
        aria-label="AI conversation messages"
        aria-live="off"
        onWheel={handleWheel}
        onScroll={handleScroll}
      >
        {!c.messages.length && <div className="ai-empty-chat"><h2>{c.title === 'New conversation' ? 'What would you like to investigate?' : c.title}</h2>
          <p>Ask about Kubernetes, describe a deployment, or request evidence from this conversation's cluster.</p>
          <div className="ai-suggestions">{['Why are my Pods failing?', 'Create a Nexus deployment with persistent storage', 'Explain my workload configuration'].map(text => <button type="button" key={text} onClick={() => { update(c.id, { draft: text }); input.current?.focus(); }}>{text}</button>)}</div>
        </div>}
        {c.messages.map((message, idx) => {
          // If this user message directly answered the preceding ask_user tool,
          // it is already formatted inside that QuestionCard!
          const isAnswerToQuestion = message.role === 'user' && idx > 0 && c.messages[idx - 1]?.role === 'tool' && c.messages[idx - 1]?.call?.name === 'ask_user';
          if (isAnswerToQuestion) return null;
          return <Message key={message.id} message={message} conversation={c} />;
        })}
        {c.status === 'awaiting_approval' && mutationPending && !c.messages.some(m => m.role === 'tool' && !m.result) ? (
          <ActionApprovalCard
            request={mutationPending}
            onResolve={approved => void resolveMutation(approved)}
          />
        ) : c.busy && (!c.messages.length || c.messages[c.messages.length - 1]?.role !== 'assistant') ? (
          <LiveStatusIndicator status={c.status} />
        ) : null}
      </div>
      {showScrollBottom && (
        <button
          type="button"
          className="ai-scroll-bottom-btn"
          onClick={() => scrollToBottom(true)}
          aria-label="Scroll to bottom"
        >
          <ArrowDown size={13} aria-hidden="true" />
          <span>Latest messages</span>
        </button>
      )}
    </div>

    <footer className="ai-composer">
      <div className="ai-composer-alerts">
        {modelError && <p role="alert" className="ai-error">{modelError}</p>}
        {selectedModel?.tools === false && <p className="ai-notice">This model advertises no tool support. Choose a tool-capable model for cluster operations.</p>}
        {c.error && !c.invalidated && <p role="alert" className="ai-error">{c.error}</p>}
        {!settings.providers.length && <p className="ai-help">Add a cloud or local connection in <button className="ai-text-button" type="button" onClick={onSettings}>AI settings</button> to begin.</p>}
      </div>

      {c.invalidated ? (
        <div
          className="ai-composer-card ai-composer-invalidated-card"
          onClick={handleStartNew}
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleStartNew();
            }
          }}
          aria-label="Settings changed. Start a new conversation to use updated permissions and provider"
        >
          <div className="ai-invalidated-content">
            <div className="ai-invalidated-icon-wrapper">
              <RefreshCw size={20} aria-hidden="true" />
            </div>
            <div className="ai-invalidated-text">
              <div className="ai-invalidated-title">
                Settings changed
              </div>
              <div className="ai-invalidated-description">
                {c.error || 'Settings changed. Start a new conversation to use the updated permissions and provider.'}
              </div>
              {c.draft.trim() && (
                <div className="ai-invalidated-draft">
                  Draft &ldquo;{c.draft.length > 60 ? c.draft.slice(0, 57) + '...' : c.draft}&rdquo; will be transferred.
                </div>
              )}
            </div>
            <div className="ai-invalidated-action">
              <Button
                variant="primary"
                size="md"
                onClick={e => {
                  e.stopPropagation();
                  handleStartNew();
                }}
                className="ai-invalidated-btn"
              >
                <Plus size={15} aria-hidden="true" />
                <span>Start a new conversation</span>
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="ai-composer-card">
        {/* Top Controls: Cluster, Provider & Model buttons ON TOP OF input */}
        <div className="ai-composer-card-top">
          <div className="ai-composer-card-controls">
            <ClusterCircleButton
              context={c.scope.context}
              disabled={!!c.sessionId || c.busy}
              contexts={contexts}
              onSelect={val => {
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
            />

            <ProviderModelCapsule
              providerId={c.providerId}
              model={c.model}
              disabled={!!c.sessionId || c.busy}
              providers={settings.providers}
              models={models}
              modelsLoading={loading}
              onProviderChange={pid => {
                const preferred = getSavedModel(pid, pid === settings.defaultProvider ? settings.defaultModel : '');
                update(c.id, { providerId: pid, model: preferred });
                void useAiStore.getState().saveDefaults(pid, preferred || null);
              }}
              onModelChange={nextModel => {
                update(c.id, { model: nextModel });
                if (c.providerId) {
                  try { localStorage.setItem(`kubiki.ai.model.${c.providerId}`, nextModel); } catch {}
                  void useAiStore.getState().saveDefaults(c.providerId, nextModel);
                }
              }}
              onRefreshModels={() => { if (c.providerId && desktopAiAvailable() && !loading) void refresh(c.providerId); }}
            />
          </div>

          <div className="ai-composer-card-axes">
            <div role="group" aria-label="AI execution phase" className="ai-phases">
              {['plan', 'tooling'].map(key => {
                const label = PHASE_LABELS[key] ?? key;
                const isTooling = key === 'tooling';
                const isSelected = isTooling ? (c.phase === 'tooling' || c.phase === 'action') : c.phase === 'plan';
                const disabled = (isTooling && c.mode === 'read_only') || modePending || c.invalidated;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={isSelected}
                    disabled={disabled}
                    title={isTooling && c.mode === 'read_only' ? 'Tooling is forbidden in Read only mode; switch to Ask or Accept first' : undefined}
                    onClick={() => void phase(key as AgentPhase)}
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

        {/* Fixed-size textarea */}
        <label className="sr-only" htmlFor={`ai-message-${c.id}`}>Message AI agent</label>
        <textarea
          ref={input}
          id={`ai-message-${c.id}`}
          aria-label="Message AI agent"
          className="ai-composer-card-textarea kubiki-scrollbar"
          value={c.draft}
          maxLength={24000}
          rows={3}
          placeholder="Ask a question or describe what you want to create…"
          onChange={e => update(c.id, { draft: e.target.value })}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!c.busy && !c.invalidated && desktopAiAvailable()) sendCurrent();
            }
          }}
        />

        {/* Bottom bar with status and circular send button */}
        <div className="ai-composer-card-bottom">
          <div className="ai-run-status flex items-center gap-1.5 flex-wrap" role="status">
            <span>{statusLabels[c.status] ?? c.status}</span>
            {c.inputTokens + c.outputTokens > 0 && (
              <span>· {c.inputTokens.toLocaleString()} in / {c.outputTokens.toLocaleString()} out</span>
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
            ) : null}
          </div>

          <div className="ai-composer-card-actions">
            {c.busy ? (
              <Button
                size="sm"
                variant="danger"
                className="ai-send-round-btn is-stop"
                onClick={() => void useAiStore.getState().stop(c.id)}
                title="Stop response"
                aria-label="Stop"
              >
                <Square size={12} fill="currentColor" aria-hidden="true" />
                <span className="sr-only">Stop</span>
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                className="ai-send-round-btn is-send"
                disabled={!desktopAiAvailable() || !c.draft.trim() || !c.providerId || !c.model || modePending || c.invalidated}
                onClick={() => sendCurrent()}
                title="Send message (Enter)"
                aria-label="Send"
              >
                <ArrowUp size={15} strokeWidth={2.5} aria-hidden="true" />
                <span className="sr-only">Send</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    )}
  </footer>
  </>;
}

function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString();
}

function copy(text: string) { void navigator.clipboard.writeText(text).then(() => toast.success('Copied')).catch(() => toast.error('Clipboard unavailable')); }

function ActionApprovalCard({
  request,
  onResolve,
}: {
  request: MutationConfirmRequest;
  onResolve: (approved: boolean) => void;
}) {
  const { resource, details, review, simple } = request;
  const yaml = details?.kind === 'yaml';
  const deleting = simple?.destructive ?? details?.steps.some(step => step.operation === 'DELETE') ?? false;
  const title = simple?.title ?? (yaml ? 'Review and Approve YAML Mutation' : deleting ? 'Approve Resource Deletion' : 'Action Approval Required');
  const summary = simple ? review : details?.kind === 'batch' ? `Perform ${details.steps.length} operations on the selected resources.` : details?.steps[0]?.summary ?? review;
  const diffContent = yaml && details.steps[0]?.diff ? details.steps[0].diff : '';
  const formatted = formatManifestOrDiff(diffContent);

  return (
    <div className="ai-action-approval-card my-3 p-4 rounded-lg border-2 border-amber-500/40 bg-[var(--bg-secondary)] shadow-lg animate-fade-in max-w-[900px] mx-auto">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded bg-amber-500/10 text-amber-400">
            <ShieldAlert size={16} aria-hidden="true" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-[var(--text-primary)]">{title}</h4>
            <p className="text-[10.5px] text-[var(--text-secondary)] font-mono">
              {resource.kind} <span className="text-[var(--text-primary)] font-semibold">{resource.name}</span>
              {resource.namespace ? ` · ns: ${resource.namespace}` : ''} · cluster: {resource.context}
            </p>
          </div>
        </div>
        <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
          Awaiting confirmation
        </span>
      </div>

      <p className="text-xs text-[var(--text-secondary)] mb-3 leading-relaxed">
        {summary}
      </p>

      {formatted.code ? (
        <div className="mb-3 rounded border border-[var(--border-default)] overflow-hidden">
          <CodeEditor
            ariaLabel="YAML Mutation Diff"
            value={formatted.code}
            language={formatted.language}
            readOnly={true}
            height="min(38vh, 300px)"
            copyable={true}
            variant="field"
          />
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-[var(--border-subtle)]">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onResolve(false)}
        >
          Decline
        </Button>
        <Button
          size="sm"
          variant={deleting ? 'danger' : 'primary'}
          onClick={() => onResolve(true)}
        >
          {deleting ? 'Confirm & Delete' : 'Approve & Apply'}
        </Button>
      </div>
    </div>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  let language = 'yaml';
  let rawText = '';
  if (isValidElement(children)) {
    const className = (children.props as { className?: string })?.className || '';
    const match = /language-(\w+)/.exec(className);
    if (match) language = match[1];
    rawText = String((children.props as { children?: ReactNode })?.children ?? '');
  } else {
    rawText = String(children ?? '');
  }

  const isMultiline = rawText.includes('\n');
  const normalizedLang = language.toLowerCase();
  if (isMultiline && ['yaml', 'yml', 'json', 'bash', 'sh', 'shell', 'dockerfile'].includes(normalizedLang)) {
    const lang = (normalizedLang === 'yml' ? 'yaml' : normalizedLang === 'shell' ? 'bash' : normalizedLang) as any;
    const lineCount = rawText.split('\n').length;
    const height = Math.min(360, Math.max(90, lineCount * 20 + 35));
    return (
      <div className="my-2.5 rounded border border-[var(--border-default)] overflow-hidden">
        <CodeEditor
          ariaLabel={`${lang} code snippet`}
          value={rawText.trimEnd()}
          language={lang}
          readOnly={true}
          height={height}
          copyable={true}
          variant="field"
        />
      </div>
    );
  }

  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="ai-code">
      <div className="ai-code-actions">
        <Button size="sm" variant="ghost" aria-label="Copy code" onClick={() => copy(ref.current?.textContent ?? '')}>
          <Copy size={12} aria-hidden="true" />Copy
        </Button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
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

function LiveStatusIndicator({ status }: { status: string }) {
  const [elapsed, setElapsed] = useState(1);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const label = status === 'connecting'
    ? 'Connecting to model…'
    : status === 'executing'
    ? 'Applying cluster changes…'
    : 'Waiting for model response…';

  return (
    <div className="ai-live-indicator" role="status" aria-live="polite">
      <RefreshCw size={13} className="ai-thinking-spinner text-indigo-400" aria-hidden="true" />
      <span className="font-medium text-[var(--text-primary)]">
        {label}
      </span>
      <span className="text-xs text-[var(--text-muted)] font-mono ml-auto">
        {elapsed}s
      </span>
    </div>
  );
}

function QuestionCard({ message: m, conversation: c }: { message: ChatMessage; conversation: Conversation }) {
  const [otherText, setOtherText] = useState('');
  const args = (m.call?.arguments || {}) as Record<string, any>;
  const result = m.result;
  const question = String(args.question || result?.question || 'What would you like to do next?');
  const options: string[] = Array.isArray(result?.options)
    ? result.options
    : Array.isArray(args.options)
    ? args.options
    : ['Yes', 'No'];
  const multiSelect = !!(result?.multi_select ?? args.multi_select);
  const allowOther = (result?.allow_other ?? args.allow_other) !== false;
  const [selectedMulti, setSelectedMulti] = useState<string[]>([]);

  const msgIndex = c.messages.findIndex(item => item.id === m.id);
  const answeredMsg = msgIndex >= 0 ? c.messages.slice(msgIndex + 1).find(item => item.role === 'user') : undefined;
  const isAnswered = !!answeredMsg;

  const handleSelect = (optionText: string) => {
    if (c.busy || isAnswered) return;
    useAiStore.getState().update(c.id, { draft: optionText });
    void useAiStore.getState().send(c.id);
  };

  const handleToggleOption = (optionText: string) => {
    if (c.busy || isAnswered) return;
    setSelectedMulti(prev =>
      prev.includes(optionText) ? prev.filter(x => x !== optionText) : [...prev, optionText]
    );
  };

  const handleMultiSubmit = () => {
    if (c.busy || isAnswered || selectedMulti.length === 0) return;
    const answer = selectedMulti.join(', ');
    useAiStore.getState().update(c.id, { draft: answer });
    void useAiStore.getState().send(c.id);
  };

  const handleOtherSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!otherText.trim() || c.busy || isAnswered) return;
    const text = otherText.trim();
    setOtherText('');
    useAiStore.getState().update(c.id, { draft: text });
    void useAiStore.getState().send(c.id);
  };

  return (
    <article
      className={`ai-question-card ${isAnswered ? 'is-answered' : ''}`}
      aria-label="AI tool ask_user"
    >
      <div className="ai-question-header">
        <div className="flex items-center gap-2 font-medium">
          <HelpCircle size={14} className={isAnswered ? 'text-emerald-400' : 'text-indigo-400'} aria-hidden="true" />
          <span>Agent Question</span>
          {multiSelect && !isAnswered && (
            <span className="text-[10px] text-[var(--text-muted)] font-mono">(Multi-choice)</span>
          )}
        </div>
        <span className={`ai-question-badge ${isAnswered ? 'is-answered' : ''}`}>
          {isAnswered ? 'Answered' : 'Awaiting input'}
        </span>
      </div>

      <p className="ai-question-text">{question}</p>

      {isAnswered ? (
        <div className="ai-question-answered-box">
          <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold mb-1">
            <CheckCircle2 size={13} aria-hidden="true" />
            <span>Your response:</span>
          </div>
          <p className="ai-question-answered-content">{answeredMsg.text}</p>
        </div>
      ) : (
        <>
          {options.length > 0 && (
            <div className="ai-question-options" role="group" aria-label="Suggested responses">
              {multiSelect ? (
                <>
                  {options.map((opt, idx) => {
                    const checked = selectedMulti.includes(opt);
                    return (
                      <label key={idx} className={`ai-question-checkbox-row ${checked ? 'is-checked' : ''}`}>
                        <input
                          type="checkbox"
                          className="ui-checkbox"
                          checked={checked}
                          disabled={c.busy}
                          onChange={() => handleToggleOption(opt)}
                        />
                        <span>{opt}</span>
                      </label>
                    );
                  })}
                  <div className="w-full ai-question-actions">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={c.busy || selectedMulti.length === 0}
                      onClick={handleMultiSubmit}
                    >
                      <Check size={12} aria-hidden="true" />
                      <span>Confirm selection ({selectedMulti.length})</span>
                    </Button>
                  </div>
                </>
              ) : (
                options.map((opt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="ai-question-option-btn"
                    disabled={c.busy}
                    onClick={() => handleSelect(opt)}
                  >
                    <span className="ai-question-choice-dot" aria-hidden="true" />
                    <span>{opt}</span>
                  </button>
                ))
              )}
            </div>
          )}

          {allowOther && (
            <form onSubmit={handleOtherSubmit} className="ai-question-other">
              <input
                type="text"
                className="ide-input ai-question-other-input"
                placeholder="Type custom response…"
                value={otherText}
                disabled={c.busy}
                onChange={e => setOtherText(e.target.value)}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!otherText.trim() || c.busy}
                type="submit"
              >
                <Send size={12} aria-hidden="true" />
                <span>Reply</span>
              </Button>
            </form>
          )}
        </>
      )}
    </article>
  );
}

function Message({ message: m, conversation: c }: { message: ChatMessage; conversation: Conversation }) {
  if (m.role === 'tool') {
    if (m.call?.name === 'ask_user') {
      return <QuestionCard message={m} conversation={c} />;
    }

    const mutationPending = useMutationConfirmStore(s => s.pending);
    const resolveMutation = useMutationConfirmStore(s => s.resolve);

    const result = m.result;
    const proposal = result?.proposal === true && typeof result.yaml === 'string';
    const error = typeof result?.error === 'string' ? result.error : undefined;
    const isAwaitingApproval = !result && c.status === 'awaiting_approval' && !!mutationPending;
    const isRunning = !result && c.busy && !isAwaitingApproval;
    const args = (m.call?.arguments || {}) as Record<string, any>;
    const targetSummary = args ? [args.namespace, args.kind, args.name].filter(Boolean).join('/') : '';
    const intent = getToolIntent(m.call?.name ?? '', args);

    return (
      <article className={`ai-tool ${error ? 'has-error' : ''} ${isRunning ? 'is-running' : ''} ${isAwaitingApproval ? 'is-awaiting-approval' : ''}`} aria-label={`AI tool ${m.call?.name}`}>
        <div className="ai-tool-header">
          <div className="flex items-center gap-2 font-mono">
            {isAwaitingApproval ? (
              <ShieldAlert size={12} className="text-amber-400 animate-pulse" aria-hidden="true" />
            ) : isRunning ? (
              <RefreshCw size={12} className="ai-thinking-spinner text-amber-400" aria-hidden="true" />
            ) : error ? (
              <AlertCircle size={12} className="text-[var(--status-danger)]" aria-hidden="true" />
            ) : proposal ? (
              <FileCode size={12} className="text-cyan-400" aria-hidden="true" />
            ) : (
              <Check size={12} className="text-emerald-400" aria-hidden="true" />
            )}
            <span className="ai-tooling-badge">TOOLING</span>
            <span className={`ai-tool-intent-badge is-${intent.color}`}>{intent.badge}</span>
            <span className="font-semibold">{m.call?.name}</span>
            {targetSummary && (
              <span className="ai-tool-badge font-mono truncate max-w-[200px]" title={targetSummary}>
                {targetSummary}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className={`ai-tool-status font-medium ${isAwaitingApproval ? 'text-amber-400 font-semibold' : ''}`}>
              {isAwaitingApproval
                ? 'Awaiting your approval'
                : isRunning
                ? 'Executing…'
                : error
                ? 'Denied or failed'
                : typeof result?.status === 'string'
                ? result.status
                : proposal
                ? 'Proposal · not executed'
                : 'Complete'}
            </span>
            {m.durationMs ? (
              <span className="text-[var(--text-muted)] font-mono">
                {(m.durationMs / 1000).toFixed(1)}s
              </span>
            ) : null}
          </div>
        </div>

        <div className="ai-tool-content">
          {/* Codex-Style Command Rationale Banner */}
          <div className={`ai-command-rationale ${intent.destructive || isAwaitingApproval ? 'is-destructive' : ''}`}>
            <div className="ai-command-rationale-header">
              <div className="flex items-center gap-1.5 font-medium">
                <ShieldAlert size={12} className={intent.destructive ? 'text-rose-400' : isAwaitingApproval ? 'text-amber-400' : 'text-sky-400'} aria-hidden="true" />
                <span>Command Intent & Rationale</span>
              </div>
              {isAwaitingApproval ? (
                <span className="ai-destructive-pill text-amber-300 bg-amber-500/20 border-amber-500/40">Action Confirmation Required</span>
              ) : intent.destructive ? (
                <span className="ai-destructive-pill">Destructive action</span>
              ) : null}
            </div>
            <p className="ai-command-rationale-title">{intent.title}</p>
            <p className="ai-command-rationale-desc">{intent.description}</p>
          </div>

          {/* Unified Execution / Approval Result */}
          {isAwaitingApproval && mutationPending ? (
            <div className="space-y-3 pt-1">
              {mutationPending.simple ? (
                <p className="text-xs text-[var(--text-secondary)]">{mutationPending.review}</p>
              ) : (
                (() => {
                  const appliedYaml = typeof m.call?.arguments?.yaml === 'string' ? m.call.arguments.yaml : undefined;
                  const diffRaw = mutationPending.details?.steps[0]?.diff || '';
                  const formatted = formatManifestOrDiff(diffRaw, appliedYaml);
                  const isDeleting = mutationPending.details?.steps.some(step => step.operation === 'DELETE') ?? false;

                  return (
                    <div className="space-y-2">
                      {formatted.code ? (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[11px] font-semibold text-[var(--text-secondary)]">
                            <span>{appliedYaml ? 'Proposed YAML manifest to apply:' : 'Resource change preview:'}</span>
                            <span className="font-mono text-[10px] text-[var(--text-muted)]">YAML</span>
                          </div>
                          <div className="rounded border border-[var(--border-default)] overflow-hidden">
                            <CodeEditor
                              ariaLabel="Cluster mutation preview"
                              value={formatted.code}
                              language={formatted.language}
                              readOnly={true}
                              height="min(38vh, 280px)"
                              copyable={true}
                              variant="field"
                            />
                          </div>
                        </div>
                      ) : null}

                      <div className="flex items-center justify-between pt-2.5 mt-2 border-t border-[var(--border-subtle)]">
                        <span className="text-xs text-[var(--text-secondary)] font-medium">
                          {isDeleting ? 'Confirm deletion of this resource?' : 'Approve applying this mutation to the cluster?'}
                        </span>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void resolveMutation(false)}
                          >
                            Decline
                          </Button>
                          <Button
                            size="sm"
                            variant={isDeleting ? 'danger' : 'primary'}
                            onClick={() => void resolveMutation(true)}
                          >
                            {isDeleting ? 'Confirm & Delete' : 'Approve & Apply'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })()
              )}
            </div>
          ) : isRunning ? (
            <div className="ai-tool-executing-banner">
              <RefreshCw size={13} className="ai-thinking-spinner text-amber-400" aria-hidden="true" />
              <span>Executing operation on Kubernetes cluster…</span>
            </div>
          ) : error ? (
            <p className="ai-error p-2">{error}</p>
          ) : proposal ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-[var(--text-primary)]">{String(result.title ?? 'Proposed Kubernetes Manifest')}</h4>
                <span className="text-[10px] text-[var(--text-muted)] font-mono">YAML</span>
              </div>
              <div className="rounded border border-[var(--border-default)] overflow-hidden">
                <CodeEditor
                  ariaLabel={`Proposed manifest: ${result.title ?? 'YAML'}`}
                  value={String(result.yaml)}
                  language="yaml"
                  readOnly={true}
                  height="min(45vh, 340px)"
                  copyable={true}
                  variant="field"
                />
              </div>
              {c.mode !== 'read_only' && !c.busy && (
                <div className="mt-2.5">
                  <Button size="sm" variant="primary" onClick={() => {
                    useAiStore.getState().update(c.id, { draft: `Apply the following YAML proposal using apply_manifest:\n\`\`\`yaml\n${String(result.yaml)}\n\`\`\`` });
                    void useAiStore.getState().send(c.id);
                  }}>
                    Ask agent to apply proposal
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {m.call?.name === 'apply_manifest' && m.call?.arguments?.yaml ? (
                <div className="space-y-1.5 my-2">
                  <div className="text-[11px] font-semibold text-[var(--text-secondary)]">Manifest to Apply:</div>
                  <div className="rounded border border-[var(--border-default)] overflow-hidden">
                    <CodeEditor
                      ariaLabel="Applied Manifest YAML"
                      value={String(m.call.arguments.yaml)}
                      language="yaml"
                      readOnly={true}
                      height="min(35vh, 260px)"
                      copyable={true}
                      variant="field"
                    />
                  </div>
                </div>
              ) : null}
              {result && (result.operationId || result.status) ? (
                <div className="ai-tool-receipt-box">
                  {result.operationId ? <span>Receipt ID: {String(result.operationId)}</span> : null}
                  {result.status ? <span>Status: {String(result.status)}</span> : null}
                </div>
              ) : null}
              <details>
                <summary className="text-xs text-[var(--text-muted)] cursor-pointer select-none py-0.5">
                  View raw parameters & output
                </summary>
                <pre className="ai-tool-result mt-1">{result ? JSON.stringify(result, null, 2) : JSON.stringify(m.call?.arguments, null, 2)}</pre>
              </details>
            </div>
          )}
        </div>
      </article>
    );
  }

  const isUser = m.role === 'user';
  const isPlan = !isUser && (m.phase === 'plan' || /^(#+ Plan|Proposed Plan|Plan:)/im.test(m.text));
  const isStreaming = c.busy && c.messages[c.messages.length - 1]?.id === m.id;
  const { thinking, isThinkingActive, content } = !isUser ? parseThinking(m.text, isStreaming) : { isThinkingActive: false, content: m.text };

  if (!isUser && !content.trim() && !thinking && !isThinkingActive && !isStreaming) {
    return null;
  }

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
              ) : (m.phase === 'tooling' || m.phase === 'action') ? (
                <span className="ai-tooling-badge" title="Tooling execution phase">
                  Tooling
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
