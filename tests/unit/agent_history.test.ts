import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => api);
vi.mock('../../src/domains/ai/transport', () => ({ desktopAiAvailable: () => true }));
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal('window', new EventTarget()); const map = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => map.delete(k) }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const scope = { context: 'prod', namespaces: ['apps'], allNamespaces: false };
const conversation = { id: 'c1', title: 'Incident', scope, messages: [{ id: 'm1', role: 'user', text: 'Explain PVC' }], updatedAt: Date.now() };
describe('native AI history adapter', () => {
  it('restores native history even if legacy migration is corrupt, preserving legacy bytes', async () => {
    localStorage.setItem('legacy', '{bad-json'); api.invoke.mockResolvedValue({ conversations: [conversation], preferences: { enabled: true, retentionDays: 30, allowExport: true }, migrated: false });
    const { aiHistoryStorage } = await import('../../src/domains/ai/history_storage');
    const saved = JSON.parse(String(await aiHistoryStorage.getItem('legacy')));
    expect(saved.state.conversations[0].id).toBe('c1'); expect(saved.state.conversations[0].mode).toBe('read_only'); expect(localStorage.getItem('legacy')).toBe('{bad-json');
  });
  it('awaits explicit deletion in native storage instead of relying on pagehide/debounce', async () => {
    api.invoke.mockResolvedValue({ conversations: [conversation], preferences: { enabled: true, retentionDays: 30, allowExport: true }, migrated: true });
    const { aiHistoryStorage, deleteAiHistory } = await import('../../src/domains/ai/history_storage'); await aiHistoryStorage.getItem('legacy');
    api.invoke.mockResolvedValue(undefined); await deleteAiHistory('c1');
    expect(api.invoke).toHaveBeenCalledWith('ai_history_sync', { documents: [], deleted: ['c1'], migration: false });
  });
  it('export opt-out is enforced before a download is created', async () => {
    const { historyPreferences } = await import('../../src/domains/ai/history_storage'); historyPreferences.allowExport = false;
    const { downloadMarkdown } = await import('../../src/domains/ai/chat_artifacts'); expect(() => downloadMarkdown('Incident', 'private')).toThrow('Export is disabled');
  });
});

it('a failed old flush never requeues a stale snapshot after a newer successful flush', async () => {
  api.invoke.mockResolvedValue({ conversations: [conversation], preferences: { enabled: true, retentionDays: 30, allowExport: true }, migrated: true });
  const { aiHistoryStorage, flushAiHistory } = await import('../../src/domains/ai/history_storage'); await aiHistoryStorage.getItem('legacy');
  let rejectOld!: (reason: Error) => void; let first = true;
  let markStarted!:()=>void; const started=new Promise<void>(resolve=>{markStarted=resolve;});
  api.invoke.mockImplementation(async (command: string) => { if (command === 'ai_history_sync' && first) { first = false; return new Promise((_resolve, reject) => { rejectOld = reject;markStarted(); }); } return undefined; });
  aiHistoryStorage.setItem('legacy', JSON.stringify({ version: 2, state: { conversations: [{ ...conversation, title: 'old snapshot' }], activeId: 'c1' } })); const old = flushAiHistory(); await started;
  const newer = { ...conversation, id: 'c2', title: 'newly saved conversation' };
  aiHistoryStorage.setItem('legacy', JSON.stringify({ version: 2, state: { conversations: [conversation, newer], activeId: 'c2' } })); const fresh = flushAiHistory();
  rejectOld(new Error('temporary IO error')); await Promise.all([old, fresh]); await flushAiHistory();
  const calls = api.invoke.mock.calls.filter(([name]) => name === 'ai_history_sync'); expect(calls.length).toBe(2); expect(calls.some(([, args]) => args?.deleted?.includes('c2'))).toBe(false);
});
