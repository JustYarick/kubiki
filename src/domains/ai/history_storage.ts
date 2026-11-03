import type { PersistStorage, StateStorage } from 'zustand/middleware';
import type { Conversation } from './types';
import { migrateAiHistory, persistedMessage } from './persistence';
import { desktopAiAvailable } from './transport';
export interface HistoryPreferences { enabled: boolean; retentionDays: number; allowExport: boolean }
export const historyPreferences: HistoryPreferences = { enabled: true, retentionDays: 30, allowExport: true };
let known = new Map<string, string>();
let pending: { state: { conversations: Conversation[]; activeId: string | null }; version: number } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let saving = Promise.resolve();
let error = '';
let latestGeneration = 0;
let pendingGeneration = 0;
let materialize: (() => void) | undefined;
export function historyStorageError() { return error; }
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core'); return invoke<T>(command, args);
}
function report(reason: unknown) { error = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'AI history could not be saved'; if (typeof window !== 'undefined') window.dispatchEvent(new Event('ai-history-state')); }
export async function flushAiHistory() {
  const prepare = materialize; materialize = undefined;
  prepare?.();
  if (timer) clearTimeout(timer); timer = undefined;
  const snapshot = pending; const generation = pendingGeneration; pending = undefined;
  if (!snapshot || typeof window === 'undefined' || !desktopAiAvailable()) return saving;
  saving = saving.catch(() => { }).then(async () => {
    const entries = snapshot.state.conversations;
    const ids = new Set(entries.map(c => c.id));
    const deleted = [...known.keys()].filter(id => !ids.has(id));
    const documents = entries.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 200).filter(c => known.get(c.id) !== JSON.stringify(c));
    for (let i = 0; i < deleted.length; i += 200) await invoke('ai_history_sync', { documents: [], deleted: deleted.slice(i, i + 200), migration: false });
    await invoke('ai_history_sync', { documents, deleted: [], migration: false });
    for (const id of deleted) known.delete(id);
    for (const doc of documents) known.set(doc.id, JSON.stringify(doc));
    error = ''; if (typeof window !== 'undefined') window.dispatchEvent(new Event('ai-history-state'));
  });
  try { await saving; } catch (reason) { if (!pending && generation === latestGeneration) { pending = snapshot; pendingGeneration = generation; } report(reason); }
}
export async function saveHistoryPreferences(preferences: HistoryPreferences) {
  if (desktopAiAvailable()) await invoke('ai_history_preferences', { preferences });
  Object.assign(historyPreferences, preferences);
  if (!preferences.enabled) { known.clear(); globalThis.localStorage?.removeItem('kubiki.ai_conversations.v1'); }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('ai-history-state'));
}
export const aiHistoryStorage: StateStorage = {
  async getItem(name) {
    if (!desktopAiAvailable()) return globalThis.localStorage?.getItem(name) ?? null;
    try {
      let result = await invoke<{ conversations: Conversation[]; preferences: HistoryPreferences; migrated: boolean }>('ai_history_load', { filter: { includeArchived: true } });
      if (!result || !Array.isArray(result.conversations)) throw new Error('Native AI history is unavailable');
      Object.assign(historyPreferences, result.preferences);
      const legacy = globalThis.localStorage?.getItem(name);
      let migrationFailed = false;
      if (!result.migrated && legacy) {
        try {
          const parsed = JSON.parse(legacy) as { state?: unknown };
          const migrated = migrateAiHistory(parsed.state);
          await invoke('ai_history_sync', { documents: migrated.conversations.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 200), deleted: [], migration: true });
          result = await invoke('ai_history_load', { filter: { includeArchived: true } });
        } catch (reason) { migrationFailed = true; report(reason); }
      }
      // Delete old storage only after the native transaction and read succeed.
      if (legacy && !migrationFailed) globalThis.localStorage?.removeItem(name);
      const safe = migrateAiHistory({ conversations: result.conversations, activeId: null });
      known = new Map(safe.conversations.map(c => [c.id, JSON.stringify(c)]));
      return JSON.stringify({ state: safe, version: 2 });
    } catch (reason) { report(reason); return null; }
  },
  setItem(name, value) {
    if (!desktopAiAvailable()) { if (historyPreferences.enabled) globalThis.localStorage?.setItem(name, value); return; }
    pending = JSON.parse(value); pendingGeneration = ++latestGeneration;
    if (!timer) timer = setTimeout(() => { void flushAiHistory(); }, 400);
  },
  async removeItem(name) {
    globalThis.localStorage?.removeItem(name);
    if (desktopAiAvailable()) { await invoke('ai_history_sync', { documents: [], deleted: [...known.keys()], migration: false }); known.clear(); }
  },
};
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { void flushAiHistory(); });

export async function deleteAiHistory(id: string) {
  await flushAiHistory();
  if (desktopAiAvailable()) await invoke('ai_history_sync', { documents: [], deleted: [id], migration: false });
  known.delete(id);
}
export async function searchAiHistory(filter: { text: string; context?: string; namespace?: string; after?: number; before?: number; includeArchived?: boolean }) {
  if (!desktopAiAvailable()) return undefined;
  const result = await invoke<{ conversations: Conversation[] }>('ai_history_load', { filter }); return result?.conversations;
}

// Keep immutable state references during streaming. Sanitize and serialize only
// when the debounce fires, never on every model delta.
type HistoryState = { conversations: Conversation[]; activeId: string | null };
const persisted = new WeakMap<Conversation, Conversation>();
function historyDocument(c: Conversation): Conversation {
  const cached = persisted.get(c); if (cached) return cached;
  const doc: Conversation = {
    id: c.id, title: c.title, scope: c.scope, intent: c.intent,
    providerId: c.providerId, model: c.model, mode: 'ask', phase: 'plan',
    messages: c.messages.map(persistedMessage), draft: '', status: 'idle', busy: false,
    pinned: !!c.pinned, archived: !!c.archived, createdAt: c.createdAt, updatedAt: c.updatedAt,
    inputTokens: c.inputTokens, outputTokens: c.outputTokens,
    currentContextTokens: c.currentContextTokens, contextBudgetTokens: c.contextBudgetTokens,
    contextEstimated: c.contextEstimated,
    generationMetrics: c.generationMetrics?.slice(-100),
  };
  persisted.set(c, doc); return doc;
}
export const deferredAiHistoryStorage: PersistStorage<HistoryState> = {
  async getItem(name) {
    const raw = await aiHistoryStorage.getItem(name);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return { ...value, state: migrateAiHistory(value.state) };
  },
  setItem(name, value) {
    materialize = () => { aiHistoryStorage.setItem(name, JSON.stringify({ ...value, state: { ...value.state, conversations: value.state.conversations.map(historyDocument) } })); };
    if (!timer) timer = setTimeout(() => { void flushAiHistory(); }, 400);
  },
  removeItem(name) { materialize = undefined; return aiHistoryStorage.removeItem(name); },
};
