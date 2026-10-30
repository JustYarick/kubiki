import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type AgentEvent } from '../../src/domains/ai/types';

vi.mock('../../src/domains/ai/transport', () => ({
  desktopAiAvailable: () => true,
  agentError: (error: unknown) => String(error),
  agentTransport: { settings: vi.fn(), save: vi.fn(), credential: vi.fn(), models: vi.fn(), create: vi.fn(), mode: vi.fn(), stop: vi.fn(), send: vi.fn() },
}));
import { agentTransport } from '../../src/domains/ai/transport';
import { applyAgentEvent, useAiStore } from '../../src/domains/ai/store';
import { openAiChat } from '../../src/domains/ai/navigation';
import { useClusterStore } from '../../src/state/cluster_store';

const scope = { context: 'prod', namespaces: ['apps'], allNamespaces: false };
function settings() {
  return { ...defaultSettings(), providers: [{ id: 'provider', name: 'Local', protocol: 'ollama' as const, baseUrl: 'http://localhost:11434' }], defaultProvider: 'provider', defaultModel: 'dynamic:latest' };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks();
  useAiStore.setState({ settings: settings(), credentials: {}, loaded: true, loading: false, saving: false, error: undefined, models: {}, modelLoading: {}, modelErrors: {}, conversations: [], activeId: null });
  vi.mocked(agentTransport.create).mockResolvedValue({ id: 'native', scope, mode: 'read_only', policy: settings().policy });
  vi.mocked(agentTransport.mode).mockResolvedValue();
  vi.mocked(agentTransport.stop).mockResolvedValue();
  vi.mocked(agentTransport.send).mockResolvedValue();
  vi.mocked(agentTransport.save).mockImplementation(async updated => { vi.mocked(agentTransport.settings).mockResolvedValue({ settings: updated, credentials: {} }); });
});

describe('AI domain conversations', () => {
  it('always creates read-only conversations and applies an explicit mode after native creation', async () => {
    const id = useAiStore.getState().create(scope, 'Scale my workload');
    expect(useAiStore.getState().conversations[0].mode).toBe('read_only');
    await useAiStore.getState().setMode(id, 'ask');
    await useAiStore.getState().send(id);
    expect(agentTransport.mode).toHaveBeenCalledWith('native', 'ask');
    expect(vi.mocked(agentTransport.mode).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(agentTransport.send).mock.invocationCallOrder[0]);
    expect(useAiStore.getState().conversations[0].draft).toBe('');
  });

  it('Stop during connection creation prevents the deferred message from being sent', async () => {
    const pending = deferred<Awaited<ReturnType<typeof agentTransport.create>>>();
    vi.mocked(agentTransport.create).mockReturnValue(pending.promise);
    const id = useAiStore.getState().create(scope, 'Create something');
    const send = useAiStore.getState().send(id);
    await useAiStore.getState().stop(id);
    pending.resolve({ id: 'late', scope, mode: 'read_only', policy: settings().policy });
    await send;
    expect(agentTransport.send).not.toHaveBeenCalled();
    expect(agentTransport.stop).toHaveBeenCalledWith('late', true);
    expect(useAiStore.getState().conversations[0].busy).toBe(false);
    expect(useAiStore.getState().conversations[0].draft).toBe('Create something');
  });

  it('routes stream events to the owning conversation even when another one is selected', async () => {
    const first = useAiStore.getState().create(scope, 'First');
    const second = useAiStore.getState().create({ ...scope, context: 'dev' }, 'Second');
    const callbacks: Array<(event: AgentEvent) => void> = [];
    vi.mocked(agentTransport.send).mockImplementation(async (_session, _message, receive) => { callbacks.push(receive); });
    await useAiStore.getState().send(first); await useAiStore.getState().send(second);
    callbacks[0]({ type: 'text_delta', text: 'Answer for prod' });
    callbacks[1]({ type: 'text_delta', text: 'Answer for dev' });
    expect(useAiStore.getState().conversations[0].messages.at(-1)?.text).toBe('Answer for prod');
    expect(useAiStore.getState().conversations[1].messages.at(-1)?.text).toBe('Answer for dev');
  });

  it('preserves earlier tool receipts when a provider repeats call IDs', () => {
    const id = useAiStore.getState().create(scope);
    let c = useAiStore.getState().conversations.find(c => c.id === id)!;
    c = applyAgentEvent(c, { type: 'tool_started', call: { id: 'same', name: 'scale_workload', arguments: {} } });
    c = applyAgentEvent(c, { type: 'tool_completed', id: 'same', result: { status: 'accepted', operationId: 'original' } });
    c = applyAgentEvent(c, { type: 'tool_started', call: { id: 'same', name: 'get_resource', arguments: {} } });
    c = applyAgentEvent(c, { type: 'tool_completed', id: 'same', result: { resource: 'current' } });
    expect(c.messages[0].result?.operationId).toBe('original');
    expect(c.messages[1].result?.resource).toBe('current');
  });

  it('revokes existing conversations when access policy changes, while default model changes do not', async () => {
    const id = useAiStore.getState().create(scope, 'Hello'); await useAiStore.getState().send(id);
    await useAiStore.getState().save({ ...settings(), defaultModel: 'another-dynamic-model' });
    expect(useAiStore.getState().conversations[0].invalidated).not.toBe(true);
    const next = { ...useAiStore.getState().settings, policy: { ...settings().policy, resources: false } };
    await useAiStore.getState().save(next);
    expect(useAiStore.getState().conversations[0].invalidated).toBe(true);
    useAiStore.getState().update(id, { draft: 'Read old data' });
    await useAiStore.getState().send(id);
    expect(agentTransport.send).toHaveBeenCalledTimes(1);
  });

  it('resource actions attach identity only and pin the action namespace', () => {
    useClusterStore.setState({ currentContext: 'prod', selectedNamespace: 'all' });
    openAiChat({ resource: { apiVersion: 'v1', kind: 'Secret', name: 'app', namespace: 'apps', uid: 'original', raw: { data: { password: 'private-source-value' }, metadata: { annotations: { private: 'annotation-source-value' } } } } });
    const c = useAiStore.getState().conversations[0];
    expect(c.scope).toEqual(scope);
    expect(c.draft).toContain('UID original');
    expect(JSON.stringify(c)).not.toContain('private-source-value');
    expect(JSON.stringify(c)).not.toContain('annotation-source-value');
  });

  it('model discovery discards stale responses after provider settings change', async () => {
    const pending = deferred<Awaited<ReturnType<typeof agentTransport.models>>>();
    vi.mocked(agentTransport.models).mockReturnValue(pending.promise);
    const refresh = useAiStore.getState().refreshModels('provider');
    await useAiStore.getState().save({ ...settings(), providers: [{ ...settings().providers[0], baseUrl: 'http://localhost:1234' }] });
    pending.resolve([{ id: 'stale', name: 'Stale', contextWindow: null, maxOutputTokens: null, tools: null }]);
    await refresh;
    expect(useAiStore.getState().models.provider).toBeUndefined();
  });
});
