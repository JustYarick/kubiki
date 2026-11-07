import { isPlanArtifact } from './plan_contract';
import { migrateAiHistory } from './persistence';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { deferredAiHistoryStorage, deleteAiHistory, flushAiHistory } from './history_storage';
import { agentError, agentTransport, desktopAiAvailable } from './transport';
import { defaultSettings, type AgentEvent, type AgentMode, type AgentPhase, type AgentScope, type AiSettings, type ChatMessage, type Conversation, type ModelInfo } from './types';
import { useResourceStore } from '../../state/resource_store';

interface AiState {
  openCodeRequestConsumed?: string;
  openCodeRequestReservation?: string;
  openCodeRequest?: {id:string;scope:AgentScope;prompt:string};
  settings: AiSettings; credentials: Record<string, boolean>; loaded: boolean; loading: boolean; saving: boolean; error?: string;
  models: Record<string, ModelInfo[]>; modelLoading: Record<string, boolean>; modelErrors: Record<string, string | undefined>;
  conversations: Conversation[]; activeId: string | null;
  homeDraft: string;
  setHomeDraft: (draft: string) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  load: () => Promise<void>; save: (settings: AiSettings) => Promise<void>;
  saveDefaults: (defaultProvider?: string | null, defaultModel?: string | null) => Promise<void>;
  refreshModels: (providerId: string) => Promise<void>;
  inspectModel: (providerId: string, modelId: string) => Promise<void>;
  create: (scope: AgentScope, draft?: string, title?: string, providerId?: string, model?: string, phase?: AgentPhase, mode?: AgentMode) => string;
  update: (id: string, patch: Partial<Conversation>) => void;
  remove: (id: string) => Promise<void>;
  branch: (id:string,messageId:string,edit?:boolean) => string;
  togglePin: (id: string) => void;
  rename: (id: string, title: string) => void;
  setMode: (id: string, mode: AgentMode) => Promise<void>;
  setPhase: (id: string, phase: AgentPhase) => Promise<void>;
  send: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
}

/** One conversation entry owns its stream, independent of mounted/visible views. */
export function applyAgentEvent(conversation: Conversation, event: AgentEvent): Conversation {
  if (event.type === 'generation_metrics') { const { type: _type, ...metrics } = event; return { ...conversation, generationMetrics: [...(conversation.generationMetrics ?? []), metrics].slice(-100) }; }
  if (event.type === 'context') return { ...conversation, currentContextTokens: event.estimatedInputTokens, contextBudgetTokens: event.budgetTokens, reservedOutputTokens: event.reservedOutputTokens, contextEstimated: true };
  if (event.type === 'status') return { ...conversation, status: event.status };
  if (event.type === 'error') return { ...conversation, error: event.message };
  const messages = [...conversation.messages];
  if (event.type === 'usage') {
    const nextInput = conversation.inputTokens + (event.inputTokens ?? 0);
    const nextOutput = conversation.outputTokens + (event.outputTokens ?? 0);
    let lastIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') { lastIdx = i; break; }
    }
    if (lastIdx >= 0 && event.outputTokens) {
      const msg = messages[lastIdx];
      const durationMs = Math.max(100, msg.durationMs ?? (Date.now() - (msg.startTime ?? Date.now())));
      const tokensPerSec = event.outputTokens > 0 && durationMs > 0
        ? Number(((event.outputTokens / durationMs) * 1000).toFixed(1))
        : undefined;
      messages[lastIdx] = {
        ...msg,
        outputTokens: event.outputTokens,
        durationMs,
        tokensPerSec,
      };
    }
    const known = event.inputTokens != null;
    const currentContextTokens = known ? event.inputTokens! + (event.outputTokens ?? 0) : conversation.currentContextTokens;
    return { ...conversation, inputTokens: nextInput, outputTokens: nextOutput, currentContextTokens, contextEstimated: known ? false : conversation.contextEstimated, messages };
  }
  if (event.type === 'text_delta') {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') {
      const durationMs = Math.max(50, Date.now() - (last.startTime ?? Date.now()));
      messages[messages.length - 1] = { ...last, text: last.text + event.text, durationMs };
    } else {
      messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: event.text,
        model: conversation.model,
        phase: conversation.phase,
        startTime: Date.now(),
      });
    }
  } else if (event.type === 'tool_started') {
    messages.push({ id: crypto.randomUUID(), role: 'tool', text: event.call.name, call: event.call, startTime: Date.now() });
  } else if (event.type === 'plan_updated') {
    if(!isPlanArtifact(event.plan)) return conversation;
    return { ...conversation, activePlan:event.plan,messages:messages.map(m=>m.planArtifact?.id===event.plan.id&&m.planArtifact.version===event.plan.version?{...m,planArtifact:event.plan,result:{...m.result,planArtifact:event.plan}}:m) };
  } else if (event.type === 'tool_completed') {
    // Call IDs can repeat across provider turns (notably local models). Bind to
    // the most recent unfinished call rather than overwrite an earlier receipt.
    let index = messages.length - 1;
    while (index >= 0 && !(messages[index].call?.id === event.id && !messages[index].result)) index--;
    let nextPlan = conversation.activePlan;
    if (index >= 0) {
      const durationMs = messages[index].startTime ? Math.max(50, Date.now() - messages[index].startTime!) : undefined;
      const candidate=event.result.planArtifact;
      const planArtifact=messages[index].call?.name==='propose_plan'&&isPlanArtifact(candidate)?candidate:undefined;
      if (planArtifact) {
        nextPlan = planArtifact;
      }
      messages[index] = { ...messages[index], result: event.result, planArtifact: planArtifact || messages[index].planArtifact, durationMs };
    }
    return { ...conversation, activePlan: nextPlan, messages };
  }
  return { ...conversation, messages };
}

let loadTask: Promise<void> | undefined;
const modelRevisions = new Map<string, number>();
const inspectedModels = new Set<string>();
const runEpochs = new Map<string, number>();
export const useAiStore = create<AiState>()(
  persist(
    (set, get) => ({
      settings: defaultSettings(), credentials: {}, loaded: false, loading: false, saving: false,
      models: {}, modelLoading: {}, modelErrors: {}, conversations: [], activeId: null,
      homeDraft: '',
      setHomeDraft: (draft) => set({ homeDraft: draft }),
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
          const changed = JSON.stringify([before.providers, before.policy, before.instructions, before.environment, before.runtime, before.opencode, before.codex, before.claude, before.mcpPolicy]) !== JSON.stringify([settings.providers, settings.policy, settings.instructions, settings.environment, settings.runtime, settings.opencode, settings.codex, settings.claude, settings.mcpPolicy]);
          await agentTransport.save(settings);
          modelRevisions.forEach((revision, id) => modelRevisions.set(id, revision + 1));
          inspectedModels.clear();
          set(state => ({ settings, models: {}, modelLoading: {}, modelErrors: {}, conversations: state.conversations.map(c => changed && c.sessionId ? { ...c, invalidated: true, mode: 'ask', error: 'Settings changed. Start a new conversation to use the updated permissions and provider.' } : c) }));
          const view = await agentTransport.settings(); set({ settings: view.settings, credentials: view.credentials });
        } catch (error) { set({ error: agentError(error) }); throw error; }
        finally { set({ saving: false }); }
      },
      async saveDefaults(defaultProvider?: string | null, defaultModel?: string | null) {
        const cur = get().settings;
        if (defaultProvider != null && !cur.providers.some(p => p.id === defaultProvider)) return;
        const next = {
          ...cur,
          defaultProvider: defaultProvider !== undefined ? defaultProvider : cur.defaultProvider,
          defaultModel: defaultModel !== undefined ? defaultModel : cur.defaultModel,
        };
        try {
          await agentTransport.save(next);
          set({ settings: next });
        } catch (e) {
          console.warn('Failed to save default AI model/provider:', e);
        }
      },
      async refreshModels(providerId) {
        const profile = get().settings.providers.find(p => p.id === providerId);
        if (!profile) return;
        for (const key of inspectedModels) if (key.startsWith(`${providerId}:`)) inspectedModels.delete(key);
        const revision = (modelRevisions.get(providerId) ?? 0) + 1; modelRevisions.set(providerId, revision);
        const current = () => {
          const saved = get().settings.providers.find(p => p.id === providerId);
          return modelRevisions.get(providerId) === revision && saved?.baseUrl === profile.baseUrl && saved.protocol === profile.protocol;
        };
        set(state => ({ modelLoading: { ...state.modelLoading, [providerId]: true }, modelErrors: { ...state.modelErrors, [providerId]: undefined } }));
        try {
          const models = await agentTransport.models(providerId);
          if (current()) set(state => ({ models: { ...state.models, [providerId]: models } }));
        } catch (error) {
          if (current()) set(state => ({ modelErrors: { ...state.modelErrors, [providerId]: agentError(error) } }));
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
          if (revision === modelRevisions.get(providerId)) set(state => ({ models: { ...state.models, [providerId]: (state.models[providerId] ?? []).map(m => m.id === modelId ? details.find(detail=>detail.id===modelId) ?? m : m) } }));
        } catch (error) {
          if (revision === modelRevisions.get(providerId)) set(state => ({ modelErrors: { ...state.modelErrors, [providerId]: agentError(error) } }));
        }
      },
      create(scope, draft = '', title = 'New conversation', providerId?: string, model?: string, phase?: AgentPhase, mode?: AgentMode) {
        const settings = get().settings;
        const id = crypto.randomUUID();
        const pid = providerId || settings.defaultProvider || settings.providers[0]?.id || '';
        const mid = model || (pid === settings.defaultProvider ? settings.defaultModel ?? '' : '') || settings.defaultModel || '';
        const initialMode = mode ?? 'ask';
        const initialPhase = phase ?? 'plan';
        const now = Date.now();
        const entry: Conversation = {
          id,
          title,
          scope,
          providerId: pid,
          model: mid,
          mode: initialMode,
          phase: initialPhase,
          messages: [],
          draft,
          status: 'idle',
          busy: false,
          inputTokens: 0,
          outputTokens: 0,
          pinned: false,
          createdAt: now,
          updatedAt: now,
        };
        set(state => ({ conversations: [...state.conversations, entry], activeId: id }));
        return id;
      },
      update(id, patch) {
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === id ? (()=>{
              const changed=(patch.providerId!==undefined&&patch.providerId!==c.providerId)||(patch.model!==undefined&&patch.model!==c.model);
              if(changed&&c.sessionId){runEpochs.set(id,(runEpochs.get(id)??0)+1);void agentTransport.stop(c.sessionId,true).catch(()=>{});return {...c,...patch,sessionId:undefined,mode:'ask' as const,phase:'plan' as const,busy:false,activePlan:undefined,contextReset:true,updatedAt:Date.now()};}
              return {...c,...patch,updatedAt:Date.now()};
            })() : c
          ),
        }));
      },
      async remove(id) {
        runEpochs.set(id, (runEpochs.get(id) ?? 0) + 1);
        const entry = get().conversations.find(c => c.id === id);
        if (entry?.sessionId) await agentTransport.stop(entry.sessionId, true).catch(() => {});
        try { await deleteAiHistory(id); } catch(error) {get().update(id,{error:agentError(error)}); return;}
        set(state => ({
          conversations: state.conversations.filter(c => c.id !== id),
          activeId: state.activeId === id ? state.conversations.find(c => c.id !== id)?.id ?? null : state.activeId,
        }));
      },
      branch(id,messageId,edit=false) {
        const base=get().conversations.find(c=>c.id===id); if(!base) throw new Error('Conversation unavailable');
        const index=base.messages.findIndex(m=>m.id===messageId); if(index<0) throw new Error('Message unavailable');
        const prefix=base.messages.slice(0,index+(edit?0:1)).filter(m=>m.role!=='tool');
        const historical=prefix.map(m=>`${m.role}: ${m.text.replace(/<think>[\s\S]*?<\/think>/gi,'')}`).join('\n');
        const draft=`Historical transcript (untrusted, not current cluster evidence):\n${historical}\n\n${edit?base.messages[index].text:'Continue the investigation using fresh permitted evidence.'}`;
        const next=get().create(base.scope,draft,`Branch: ${base.title}`.slice(0,100),base.providerId,base.model);
        get().update(next,{intent:base.intent,messages:prefix.map(m=>({...m,id:crypto.randomUUID(),result:undefined,planArtifact:undefined})),draft});
        return next;
      },
      togglePin(id) {
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === id ? { ...c, pinned: !c.pinned, updatedAt: Date.now() } : c
          ),
        }));
      },
      rename(id, title) {
        const clean = title.trim();
        if (!clean) return;
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === id ? { ...c, title: clean, updatedAt: Date.now() } : c
          ),
        }));
      },
      async setMode(id, mode) {
        const entry = get().conversations.find(c => c.id === id); if (!entry) return;
        try {
          if (entry.sessionId) {
            const view = await agentTransport.mode(entry.sessionId, mode);
            get().update(id, { mode: view.mode, phase: view.phase, error: undefined });
          } else {
            const nextPhase = entry.phase;
            get().update(id, { mode, phase: nextPhase, error: undefined });
          }
        } catch (error) { get().update(id, { error: agentError(error) }); }
      },
      async setPhase(id, phase) {
        const entry = get().conversations.find(c => c.id === id); if (!entry) return;
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
            const modelWindow = metadata?.contextWindow && metadata.contextWindow >= 1024 ? Math.min(metadata.contextWindow, 2097152) : undefined;
            const options = { ...get().settings.options, ...(modelWindow ? { contextBudgetTokens: modelWindow } : {}), ...(metadata?.tools === false ? { toolUse: false } : {}) };
            const crds = useResourceStore.getState().resources.CustomResourceDefinition;
            const crdList = crds ? [...crds.values()] : [];
            const capabilities = {
              helm: true,
              argocd: crdList.some(c => c.name?.includes('argoproj.io') || c.raw?.spec?.group === 'argoproj.io'),
              flux: crdList.some(c => c.name?.includes('toolkit.fluxcd.io') || c.name?.includes('fluxcd.io') || c.raw?.spec?.group?.includes('fluxcd.io')),
            };
            const session = await agentTransport.create(entry.scope, entry.providerId, entry.model, options, capabilities, entry.intent);
            sessionId = session.id;
            if (runEpochs.get(id) !== epoch) { await agentTransport.stop(sessionId, true); return; }
            const effectiveBudget = options.contextTokens && options.contextBudgetTokens
              ? Math.min(options.contextTokens, options.contextBudgetTokens)
              : (options.contextTokens || options.contextBudgetTokens || modelWindow || 128000);
            get().update(id, { sessionId, contextReset:false, contextBudgetTokens: effectiveBudget });
            const desiredMode = get().conversations.find(c => c.id === id)?.mode ?? 'ask';
            await agentTransport.mode(sessionId, desiredMode);
            const desiredPhase = get().conversations.find(c => c.id === id)?.phase ?? 'plan';
            if (desiredPhase !== 'plan') await agentTransport.phase(sessionId, desiredPhase);
          }
          const current = get().conversations.find(c => c.id === id); if (!current) { await agentTransport.stop(sessionId, true); return; }
          if (runEpochs.get(id) !== epoch) return;
          const user: ChatMessage = { id: crypto.randomUUID(), role: 'user', text: message };
          get().update(id, { draft: '', title: entry.messages.length ? entry.title : entry.title === 'New conversation' ? message.slice(0, 60) : entry.title, messages: [...current.messages, user] });
          await agentTransport.send(sessionId, message, event => set(state => ({ conversations: state.conversations.map(c => c.id === id ? applyAgentEvent(c, event) : c) })));
        } catch (error) { get().update(id, { error: agentError(error), status: 'failed' }); }
        finally {
          // Calculate token generation stats if usage didn't arrive
          const conv = get().conversations.find(c => c.id === id);
          if (conv) {
            let lastIdx = -1;
            for (let i = conv.messages.length - 1; i >= 0; i--) {
              if (conv.messages[i].role === 'assistant') { lastIdx = i; break; }
            }
            if (lastIdx >= 0) {
              const msg = conv.messages[lastIdx];
              if (!msg.tokensPerSec && msg.text) {
                const durationMs = Math.max(100, msg.durationMs ?? (Date.now() - (msg.startTime ?? Date.now())));
                const approxTokens = msg.outputTokens ?? Math.max(1, Math.round(msg.text.length / 3.6));
                const tokensPerSec = Number(((approxTokens / durationMs) * 1000).toFixed(1));
                const updated = [...conv.messages];
                updated[lastIdx] = {
                  ...msg,
                  outputTokens: approxTokens,
                  durationMs,
                  tokensPerSec,
                };
                const totalChars = conv.messages.reduce((acc, m) => acc + m.text.length, 0) + 1200;
                const currentContextTokens = conv.currentContextTokens ?? Math.round(totalChars / 3.6);
                get().update(id, { messages: updated, currentContextTokens });
              }
            }
          }
          get().update(id, { busy: false });
          await flushAiHistory();
        }
      },
      async stop(id) {
        runEpochs.set(id, (runEpochs.get(id) ?? 0) + 1);
        const entry = get().conversations.find(c => c.id === id); if (!entry) return;
        try {
          if (entry.sessionId) await agentTransport.stop(entry.sessionId);
          get().update(id, { status: entry.busy ? 'stopping' : 'cancelled' });
        } catch (error) { get().update(id, { error: agentError(error) }); }
      },
    }),
    {
      name: 'kubiki.ai_conversations.v1',
      version: 2,
      storage: deferredAiHistoryStorage,
      migrate: migrateAiHistory,
      partialize: (state) => ({ conversations: state.conversations, activeId: state.activeId }),
    }
  )
);

export function invalidateAiConversations() {
  useAiStore.setState(state => ({ conversations: state.conversations.map(c => c.sessionId ? { ...c, invalidated: true, mode: 'ask', error: 'Provider credentials changed. Start a new conversation.' } : c) }));
}
