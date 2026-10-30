import { create } from 'zustand';
import { agentError, agentTransport, desktopAiAvailable } from './transport';
import { defaultSettings, type AgentEvent, type AgentMode, type AgentPhase, type AgentScope, type AiSettings, type ChatMessage, type Conversation, type ModelInfo } from './types';

interface AiState {
  settings: AiSettings; credentials: Record<string, boolean>; loaded: boolean; loading: boolean; saving: boolean; error?: string;
  models: Record<string, ModelInfo[]>; modelLoading: Record<string, boolean>; modelErrors: Record<string, string | undefined>;
  conversations: Conversation[]; activeId: string | null;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  load: () => Promise<void>; save: (settings: AiSettings) => Promise<void>;
  refreshModels: (providerId: string) => Promise<void>;
  inspectModel: (providerId: string, modelId: string) => Promise<void>;
  create: (scope: AgentScope, draft?: string, title?: string, providerId?: string, model?: string, phase?: AgentPhase, mode?: AgentMode) => string;
  update: (id: string, patch: Partial<Conversation>) => void;
  remove: (id: string) => Promise<void>;
  setMode: (id: string, mode: AgentMode) => Promise<void>;
  setPhase: (id: string, phase: AgentPhase) => Promise<void>;
  send: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
}

/** One conversation entry owns its stream, independent of mounted/visible views. */
export function applyAgentEvent(conversation: Conversation, event: AgentEvent): Conversation {
  if (event.type === 'status') return { ...conversation, status: event.status };
  if (event.type === 'error') return { ...conversation, error: event.message };
  if (event.type === 'usage') return { ...conversation, inputTokens: conversation.inputTokens + (event.inputTokens ?? 0), outputTokens: conversation.outputTokens + (event.outputTokens ?? 0) };
  const messages = [...conversation.messages];
  if (event.type === 'text_delta') {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') messages[messages.length - 1] = { ...last, text: last.text + event.text };
    else messages.push({ id: crypto.randomUUID(), role: 'assistant', text: event.text });
  } else if (event.type === 'tool_started') {
    messages.push({ id: crypto.randomUUID(), role: 'tool', text: event.call.name, call: event.call });
  } else {
    // Call IDs can repeat across provider turns (notably local models). Bind to
    // the most recent unfinished call rather than overwrite an earlier receipt.
    let index = messages.length - 1;
    while (index >= 0 && !(messages[index].call?.id === event.id && !messages[index].result)) index--;
    if (index >= 0) messages[index] = { ...messages[index], result: event.result };
  }
  return { ...conversation, messages };
}

let loadTask: Promise<void> | undefined;
const modelRevisions = new Map<string, number>();
const inspectedModels = new Set<string>();
const runEpochs = new Map<string, number>();
export const useAiStore = create<AiState>((set, get) => ({
  settings: defaultSettings(), credentials: {}, loaded: false, loading: false, saving: false,
  models: {}, modelLoading: {}, modelErrors: {}, conversations: [], activeId: null,
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  async load() {
    if (loadTask) return loadTask;
    if (!desktopAiAvailable()) { set({ loaded: true }); return; }
    set({ loading: true, error: undefined });
    loadTask = (async () => {
      try { const view = await agentTransport.settings(); set({ settings: view.settings, credentials: view.credentials, loaded: true }); }
      catch (error) { set({ error: agentError(error) }); }
      finally { set({ loading: false }); loadTask = undefined; }
    })();
    return loadTask;
  },
  async save(settings) {
    set({ saving: true, error: undefined });
    try {
      const before = get().settings;
      const changed = JSON.stringify([before.providers, before.policy, before.instructions]) !== JSON.stringify([settings.providers, settings.policy, settings.instructions]);
      await agentTransport.save(settings);
      modelRevisions.forEach((revision, id) => modelRevisions.set(id, revision + 1));
      inspectedModels.clear();
      set(state => ({ settings, models: {}, modelLoading: {}, modelErrors: {}, conversations: state.conversations.map(c => changed && c.sessionId ? { ...c, invalidated: true, mode: 'read_only', error: 'Settings changed. Start a new conversation to use the updated permissions and provider.' } : c) }));
      const view = await agentTransport.settings(); set({ settings: view.settings, credentials: view.credentials });
    } catch (error) { set({ error: agentError(error) }); throw error; }
    finally { set({ saving: false }); }
  },
  async refreshModels(providerId) {
    for (const key of inspectedModels) if (key.startsWith(`${providerId}:`)) inspectedModels.delete(key);
    const revision = (modelRevisions.get(providerId) ?? 0) + 1; modelRevisions.set(providerId, revision);
    set(state => ({ modelLoading: { ...state.modelLoading, [providerId]: true }, modelErrors: { ...state.modelErrors, [providerId]: undefined } }));
    try {
      const models = await agentTransport.models(providerId);
      if (modelRevisions.get(providerId) === revision) set(state => ({ models: { ...state.models, [providerId]: models } }));
    } catch (error) {
      if (modelRevisions.get(providerId) === revision) set(state => ({ modelErrors: { ...state.modelErrors, [providerId]: agentError(error) } }));
    } finally {
      if (modelRevisions.get(providerId) === revision) set(state => ({ modelLoading: { ...state.modelLoading, [providerId]: false } }));
    }
  },
  async inspectModel(providerId, modelId) {
    const key = `${providerId}:${modelId}`;
    if (inspectedModels.has(key) || get().settings.providers.find(p => p.id === providerId)?.protocol !== 'ollama') return;
    inspectedModels.add(key);
    const revision = modelRevisions.get(providerId);
    try {
      const details = await agentTransport.models(providerId, modelId);
      if (revision === modelRevisions.get(providerId)) set(state => ({ models: { ...state.models, [providerId]: (state.models[providerId] ?? []).map(m => m.id === modelId ? details[0] ?? m : m) } }));
    } catch (error) {
      if (revision === modelRevisions.get(providerId)) set(state => ({ modelErrors: { ...state.modelErrors, [providerId]: agentError(error) } }));
    }
  },
  create(scope, draft = '', title = 'New conversation', providerId?: string, model?: string, phase?: AgentPhase, mode?: AgentMode) {
    const settings = get().settings;
    const id = crypto.randomUUID();
    const pid = providerId || settings.defaultProvider || settings.providers[0]?.id || '';
    const mid = model || (pid === settings.defaultProvider ? settings.defaultModel ?? '' : '') || settings.defaultModel || '';
    const initialMode = mode ?? 'read_only';
    const initialPhase = initialMode === 'read_only' ? 'plan' : (phase ?? 'plan');
    const entry: Conversation = { id, title, scope, providerId: pid, model: mid, mode: initialMode, phase: initialPhase, messages: [], draft, status: 'idle', busy: false, inputTokens: 0, outputTokens: 0 };
    set(state => ({ conversations: [...state.conversations, entry], activeId: id }));
    return id;
  },
  update(id, patch) { set(state => ({ conversations: state.conversations.map(c => c.id === id ? { ...c, ...patch } : c) })); },
  async remove(id) {
    runEpochs.set(id, (runEpochs.get(id) ?? 0) + 1);
    const entry = get().conversations.find(c => c.id === id);
    if (entry?.sessionId) await agentTransport.stop(entry.sessionId, true).catch(() => {});
    set(state => ({ conversations: state.conversations.filter(c => c.id !== id), activeId: state.activeId === id ? state.conversations.find(c => c.id !== id)?.id ?? null : state.activeId }));
  },
  async setMode(id, mode) {
    const entry = get().conversations.find(c => c.id === id); if (!entry) return;
    try {
      if (entry.sessionId) {
        const view = await agentTransport.mode(entry.sessionId, mode);
        get().update(id, { mode: view.mode, phase: view.phase, error: undefined });
      } else {
        const nextPhase = mode === 'read_only' ? 'plan' : entry.phase;
        get().update(id, { mode, phase: nextPhase, error: undefined });
      }
    } catch (error) { get().update(id, { error: agentError(error) }); }
  },
  async setPhase(id, phase) {
    const entry = get().conversations.find(c => c.id === id); if (!entry) return;
    if (phase === 'action' && entry.mode === 'read_only') {
      get().update(id, { error: 'Switch to Ask or Accept mode before entering Action phase' });
      return;
    }
    try {
      if (entry.sessionId) {
        const view = await agentTransport.phase(entry.sessionId, phase);
        get().update(id, { phase: view.phase, error: undefined });
      } else {
        get().update(id, { phase, error: undefined });
      }
    } catch (error) { get().update(id, { error: agentError(error) }); }
  },
  async send(id) {
    const entry = get().conversations.find(c => c.id === id);
    if (!entry || entry.busy || entry.invalidated || !entry.draft.trim()) return;
    const message = entry.draft.trim();
    const epoch = (runEpochs.get(id) ?? 0) + 1; runEpochs.set(id, epoch);
    if (!entry.providerId || !entry.model) { get().update(id, { error: 'Choose a provider and load its available models first.' }); return; }
    get().update(id, { busy: true, error: undefined, status: 'connecting' });
    try {
      let sessionId = entry.sessionId;
      if (!sessionId) {
        const metadata = get().models[entry.providerId]?.find(m => m.id === entry.model);
        const options = { ...get().settings.options, ...(metadata?.tools === false ? { toolUse: false } : {}) };
        const session = await agentTransport.create(entry.scope, entry.providerId, entry.model, options);
        sessionId = session.id;
        if (runEpochs.get(id) !== epoch) { await agentTransport.stop(sessionId, true); return; }
        get().update(id, { sessionId });
        const desiredMode = get().conversations.find(c => c.id === id)?.mode ?? 'read_only';
        if (desiredMode !== 'read_only') await agentTransport.mode(sessionId, desiredMode);
        const desiredPhase = get().conversations.find(c => c.id === id)?.phase ?? 'plan';
        if (desiredPhase !== 'plan') await agentTransport.phase(sessionId, desiredPhase);
      }
      const current = get().conversations.find(c => c.id === id); if (!current) { await agentTransport.stop(sessionId, true); return; }
      if (runEpochs.get(id) !== epoch) return;
      const user: ChatMessage = { id: crypto.randomUUID(), role: 'user', text: message };
      get().update(id, { draft: '', title: entry.messages.length ? entry.title : entry.title === 'New conversation' ? message.slice(0, 60) : entry.title, messages: [...current.messages, user] });
      await agentTransport.send(sessionId, message, event => set(state => ({ conversations: state.conversations.map(c => c.id === id ? applyAgentEvent(c, event) : c) })));
    } catch (error) { get().update(id, { error: agentError(error), status: 'failed' }); }
    finally { get().update(id, { busy: false }); }
  },
  async stop(id) {
    runEpochs.set(id, (runEpochs.get(id) ?? 0) + 1);
    const entry = get().conversations.find(c => c.id === id); if (!entry) return;
    try {
      if (entry.sessionId) await agentTransport.stop(entry.sessionId);
      get().update(id, { status: entry.busy ? 'stopping' : 'cancelled' });
    } catch (error) { get().update(id, { error: agentError(error) }); }
  },
}));

export function invalidateAiConversations() {
  useAiStore.setState(state => ({ conversations: state.conversations.map(c => c.sessionId ? { ...c, invalidated: true, mode: 'read_only', error: 'Provider credentials changed. Start a new conversation.' } : c) }));
}
