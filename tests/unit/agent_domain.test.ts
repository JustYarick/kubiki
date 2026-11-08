import { defaultPolicy } from '../../src/domains/ai/types';
import { persistedMessage, migrateAiHistory } from '../../src/domains/ai/persistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type AgentEvent } from '../../src/domains/ai/types';

vi.mock('../../src/domains/ai/transport', () => ({
  desktopAiAvailable: () => true,
  agentError: (error: unknown) => String(error),
  agentTransport: { settings: vi.fn(), save: vi.fn(), credential: vi.fn(), models: vi.fn(), create: vi.fn(), mode: vi.fn(), phase: vi.fn(), stop: vi.fn(), send: vi.fn() },
}));
import { agentTransport } from '../../src/domains/ai/transport';
import { applyAgentEvent, useAiStore } from '../../src/domains/ai/store';
import { openAiChat } from '../../src/domains/ai/navigation';
import { getToolIntent, getToolCallSummary, isPlanMessage } from '../../src/domains/ai/tool_intents';
import { useClusterStore } from '../../src/state/cluster_store';

const scope = { context: 'prod', namespaces: ['apps'], allNamespaces: false };
function settings() {
  return { ...defaultSettings(), providers: [{ id: 'provider', name: 'Local', protocol: 'ollama' as const, baseUrl: 'http://localhost:11434' }], defaultProvider: 'provider', defaultModel: 'dynamic:latest' };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks();
  useAiStore.setState({ settings: settings(), credentials: {}, loaded: true, loading: false, saving: false, error: undefined, models: {}, modelLoading: {}, modelErrors: {}, conversations: [], activeId: null });
  vi.mocked(agentTransport.create).mockResolvedValue({ id: 'native', scope, mode: 'read_only', phase: 'plan', policy: settings().policy });
  vi.mocked(agentTransport.mode).mockImplementation(async (_s, mode) => ({ id: 'native', scope, mode, phase: mode === 'read_only' ? 'plan' : 'plan', policy: settings().policy }));
  vi.mocked(agentTransport.phase).mockImplementation(async (_s, phase) => ({ id: 'native', scope, mode: 'ask', phase, policy: settings().policy }));
  vi.mocked(agentTransport.stop).mockResolvedValue();
  vi.mocked(agentTransport.send).mockResolvedValue();
  vi.mocked(agentTransport.save).mockImplementation(async updated => { vi.mocked(agentTransport.settings).mockResolvedValue({ settings: updated, credentials: {} }); });
});

describe('AI domain conversations', () => {
  it('creates Ask conversations in plan phase and applies explicit mode and phase', async () => {
    const id = useAiStore.getState().create(scope, 'Scale my workload');
    expect(useAiStore.getState().conversations[0].mode).toBe('ask');
    expect(useAiStore.getState().conversations[0].phase).toBe('plan');
    await useAiStore.getState().setMode(id, 'ask');
    await useAiStore.getState().setPhase(id, 'action');
    expect(useAiStore.getState().conversations[0].mode).toBe('ask');
    expect(useAiStore.getState().conversations[0].phase).toBe('action');
    await useAiStore.getState().send(id);
    expect(agentTransport.mode).toHaveBeenCalledWith('native', 'ask');
    expect(agentTransport.phase).toHaveBeenCalledWith('native', 'action');
    expect(useAiStore.getState().conversations[0].draft).toBe('');
  });

  it('keeps phase independent from confirmation mode', async () => {
    const id = useAiStore.getState().create(scope, 'Explore');
    await useAiStore.getState().setPhase(id, 'action');
    expect(useAiStore.getState().conversations[0].phase).toBe('action');
    await useAiStore.getState().setMode(id, 'accept');
    expect(useAiStore.getState().conversations[0].phase).toBe('action');
    await useAiStore.getState().setMode(id, 'ask');
    expect(useAiStore.getState().conversations[0].phase).toBe('action');
    await useAiStore.getState().setPhase(id, 'plan');
    expect(useAiStore.getState().conversations[0].mode).toBe('ask');
  });

  it('Stop during connection creation prevents the deferred message from being sent', async () => {
    const pending = deferred<Awaited<ReturnType<typeof agentTransport.create>>>();
    vi.mocked(agentTransport.create).mockReturnValue(pending.promise);
    const id = useAiStore.getState().create(scope, 'Create something');
    const send = useAiStore.getState().send(id);
    await useAiStore.getState().stop(id);
    pending.resolve({ id: 'late', scope, mode: 'read_only', phase: 'plan', policy: settings().policy });
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
    const pending = deferred<void>();
    vi.mocked(agentTransport.send).mockImplementation(async (_session, _message, receive) => { callbacks.push(receive); await pending.promise; });
    const firstRun = useAiStore.getState().send(first); const secondRun = useAiStore.getState().send(second);
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    callbacks[0]({ type: 'text_delta', text: 'Answer for prod' });
    callbacks[1]({ type: 'text_delta', text: 'Answer for dev' });
    expect(useAiStore.getState().conversations[0].messages.at(-1)?.text).toBe('Answer for prod');
    expect(useAiStore.getState().conversations[1].messages.at(-1)?.text).toBe('Answer for dev');
    pending.resolve(); await Promise.all([firstRun, secondRun]);
  });

  it('ignores old session events and completion after a model change starts another run', async () => {
    const oldRun = deferred<void>(); const nextRun = deferred<void>();
    const callbacks: Array<(event: AgentEvent) => void> = [];
    vi.mocked(agentTransport.create).mockResolvedValueOnce({ id: 'old', scope, mode: 'ask', phase: 'plan', policy: settings().policy })
      .mockResolvedValueOnce({ id: 'next', scope, mode: 'ask', phase: 'plan', policy: settings().policy });
    vi.mocked(agentTransport.send).mockImplementation(async (session, _message, receive) => {
      callbacks.push(receive); await (session === 'old' ? oldRun.promise : nextRun.promise);
    });
    const id = useAiStore.getState().create(scope, 'First');
    const first = useAiStore.getState().send(id);
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    useAiStore.getState().update(id, { model: 'new-model', draft: 'Second' });
    const second = useAiStore.getState().send(id);
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    callbacks[0]({ type: 'text_delta', text: 'stale answer' });
    callbacks[0]({ type: 'error', message: 'stale error' });
    oldRun.resolve(); await first;
    expect(useAiStore.getState().conversations[0]).toMatchObject({ sessionId: 'next', busy: true, error: undefined });
    expect(useAiStore.getState().conversations[0].messages.some(m => m.text.includes('stale'))).toBe(false);
    callbacks[1]({ type: 'text_delta', text: 'new answer' });
    nextRun.resolve(); await second;
    expect(useAiStore.getState().conversations[0]).toMatchObject({ busy: false });
    expect(useAiStore.getState().conversations[0].messages.at(-1)?.text).toBe('new answer');
  });

  it('retains dispatched write receipts while Stop drains the active run', async () => {
    const pending = deferred<void>(); let receive!: (event: AgentEvent) => void;
    vi.mocked(agentTransport.send).mockImplementation(async (_session, _message, callback) => { receive = callback; await pending.promise; });
    const id = useAiStore.getState().create(scope, 'Change workload');
    const run = useAiStore.getState().send(id);
    await vi.waitFor(() => expect(receive).toBeDefined());
    receive({ type: 'tool_started', call: { id: 'write', name: 'scale_workload', arguments: {} } });
    await useAiStore.getState().stop(id);
    receive({ type: 'tool_completed', id: 'write', result: { status: 'accepted', operationId: 'receipt' } });
    pending.resolve(); await run;
    expect(useAiStore.getState().conversations[0].messages.at(-1)?.result?.operationId).toBe('receipt');
    expect(useAiStore.getState().conversations[0].busy).toBe(false);
  });

  it('a pending Stop cannot overwrite the status of a replacement session', async () => {
    const stopping = deferred<void>();
    vi.mocked(agentTransport.stop).mockReturnValue(stopping.promise);
    const id = useAiStore.getState().create(scope);
    useAiStore.getState().update(id, { sessionId: 'old', busy: true });
    const stop = useAiStore.getState().stop(id);
    useAiStore.getState().update(id, { model: 'replacement' });
    useAiStore.getState().update(id, { sessionId: 'next', busy: true, status: 'running' });
    stopping.resolve(); await stop;
    expect(useAiStore.getState().conversations[0]).toMatchObject({ sessionId: 'next', busy: true, status: 'running' });
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

  it('updates access without replacing the native session, while endpoint changes invalidate it', async () => {
    const id = useAiStore.getState().create(scope, 'Hello'); await useAiStore.getState().send(id);
    await useAiStore.getState().save({ ...settings(), defaultModel: 'another-dynamic-model' });
    expect(useAiStore.getState().conversations[0].invalidated).not.toBe(true);
    const next = { ...useAiStore.getState().settings, policy: { ...settings().policy, resources: false } };
    await useAiStore.getState().save(next);
    expect(useAiStore.getState().conversations[0].invalidated).not.toBe(true);
    expect(useAiStore.getState().conversations[0].contextReset).toBe(true);
    useAiStore.getState().update(id, { draft: 'Read with new permissions' });
    await useAiStore.getState().send(id);
    expect(agentTransport.send).toHaveBeenCalledTimes(2);
    expect(agentTransport.create).toHaveBeenCalledTimes(1);
    await useAiStore.getState().save({ ...next, providers: next.providers.map(p => ({ ...p, baseUrl: 'http://localhost:11435' })) });
    expect(useAiStore.getState().conversations[0].invalidated).toBe(true);
  });

  it('resource actions attach identity only, pin the action namespace, and select default provider and model', () => {
    useClusterStore.setState({ currentContext: 'prod', selectedNamespace: 'all' });
    openAiChat({ resource: { apiVersion: 'v1', kind: 'Secret', name: 'app', namespace: 'apps', uid: 'original', raw: { data: { password: 'private-source-value' }, metadata: { annotations: { private: 'annotation-source-value' } } } } });
    const c = useAiStore.getState().conversations[0];
    expect(c.scope).toEqual(scope);
    expect(c.providerId).toBe('provider');
    expect(c.model).toBe('dynamic:latest');
    expect(c.phase).toBe('plan');
    expect(c.mode).toBe('ask');
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

  it('maps tool intents with clear Codex-style rationale and descriptions', () => {
    const scaleIntent = getToolIntent('scale_workload', { kind: 'Deployment', name: 'web', namespace: 'prod', replicas: 3 });
    expect(scaleIntent.title).toContain('Scale Deployment "web" in namespace "prod" to 3 replicas');
    expect(scaleIntent.description).toContain('spec.replicas');
    expect(scaleIntent.badge).toBe('SCALE');

    const deleteIntent = getToolIntent('delete_resource', { kind: 'Service', name: 'legacy-api', namespace: 'default' });
    expect(deleteIntent.title).toContain('Delete Service "legacy-api"');
    expect(deleteIntent.destructive).toBe(true);
    expect(deleteIntent.color).toBe('rose');

    const questionIntent = getToolIntent('ask_user', { question: 'Which namespace to target?' });
    expect(questionIntent.title).toBe('Which namespace to target?');
    expect(questionIntent.badge).toBe('QUESTION');

    const unknownIntent = getToolIntent('custom_action');
    expect(unknownIntent.title).toContain('custom_action');
    expect(unknownIntent.badge).toBe('CUSTOM_ACT');
  });

  it('handles ask_user tool events with options and status in conversation store', () => {
    const id = useAiStore.getState().create(scope);
    let c = useAiStore.getState().conversations.find(c => c.id === id)!;
    c = applyAgentEvent(c, {
      type: 'tool_started',
      call: {
        id: 'ask-1',
        name: 'ask_user',
        arguments: { question: 'Apply change?', options: ['Yes', 'No'] },
      },
    });
    c = applyAgentEvent(c, {
      type: 'tool_completed',
      id: 'ask-1',
      result: {
        question: 'Apply change?',
        options: ['Yes', 'No'],
        allow_other: true,
        status: 'awaiting_user_selection',
      },
    });
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0].call?.name).toBe('ask_user');
    expect(c.messages[0].result?.status).toBe('awaiting_user_selection');
  });

  it('supports tooling phase and multi_select questions', async () => {
    const id = useAiStore.getState().create(scope);
    await useAiStore.getState().setMode(id, 'ask');
    await useAiStore.getState().setPhase(id, 'tooling');
    expect(useAiStore.getState().conversations[0].phase).toBe('tooling');

    let c = useAiStore.getState().conversations.find(c => c.id === id)!;
    c = applyAgentEvent(c, {
      type: 'tool_started',
      call: {
        id: 'ask-multi',
        name: 'ask_user',
        arguments: { question: 'Pick namespaces', options: ['default', 'apps', 'kube-system'], multi_select: true },
      },
    });
    c = applyAgentEvent(c, {
      type: 'tool_completed',
      id: 'ask-multi',
      result: {
        question: 'Pick namespaces',
        options: ['default', 'apps', 'kube-system'],
        multi_select: true,
        allow_other: true,
        status: 'awaiting_user_selection',
      },
    });
    expect(c.messages[0].result?.multi_select).toBe(true);
  });

  it('maps deep diagnostics tool intents (pod, workload, events_timeline)', () => {
    const podIntent = getToolIntent('get_pod_diagnostics', { name: 'crash-pod', namespace: 'default' });
    expect(podIntent.badge).toBe('POD DIAG');
    expect(podIntent.title).toContain('crash-pod');

    const workloadIntent = getToolIntent('get_workload_diagnostics', { kind: 'Deployment', name: 'web', namespace: 'prod' });
    expect(workloadIntent.badge).toBe('WORKLOAD');
    expect(workloadIntent.title).toContain('Deployment "web"');

    const timelineIntent = getToolIntent('get_events_timeline', { name: 'web-pod', namespace: 'prod' });
    expect(timelineIntent.badge).toBe('TIMELINE');
    expect(timelineIntent.title).toContain('web-pod');
  });

  it('maps GitOps and Helm tool intents and sets default policies', () => {
    const policy = defaultSettings().policy;
    expect(policy.helm).toBe('auto');
    expect(policy.argocd).toBe('auto');
    expect(policy.flux).toBe('auto');

    const helmList = getToolIntent('list_helm_releases', { namespace: 'kube-system' });
    expect(helmList.badge).toBe('HELM');
    expect(helmList.title).toContain('List Helm releases in namespace "kube-system"');

    const argoSync = getToolIntent('sync_argocd_app', { name: 'frontend', namespace: 'argocd', hard: true });
    expect(argoSync.badge).toBe('ARGO SYNC');
    expect(argoSync.title).toContain('Sync / Refresh Argo CD Application "frontend"');
    expect(argoSync.destructive).toBe(false);

    const fluxReconcile = getToolIntent('reconcile_flux_resource', { kind: 'Kustomization', name: 'apps', namespace: 'flux-system' });
    expect(fluxReconcile.badge).toBe('RECONCILE');
    expect(fluxReconcile.title).toContain('Reconcile Flux Kustomization "apps"');
    expect(fluxReconcile.destructive).toBe(false);
  });

  it('generates concise, high-signal summaries for compact tool messages', () => {
    // Running state
    expect(getToolCallSummary('list_helm_releases', { namespace: 'kube-system' })).toBe('Executing…');

    // Error state
    expect(getToolCallSummary('list_helm_releases', {}, { error: 'Access denied by RBAC' })).toBe('Failed: Access denied by RBAC');

    // Helm releases list
    const helmResult = {
      releases: [
        { name: 'traefik', status: 'deployed' },
        { name: 'cert-manager', status: 'deployed' },
      ],
    };
    expect(getToolCallSummary('list_helm_releases', { namespace: 'kube-system' }, helmResult)).toBe('2 releases inspected · 2 observed deployed · 0 reported failed/pending');

    const helmFailed = {
      releases: [
        { name: 'traefik', status: 'deployed' },
        { name: 'bad-release', status: 'failed' },
      ],
    };
    expect(getToolCallSummary('list_helm_releases', { namespace: 'kube-system' }, helmFailed)).toBe('2 releases inspected · 1 observed deployed · 1 reported failed/pending');

    // Kubernetes resources list (pods, deployments, nodes)
    const podsResult = {
      items: new Array(150).fill({ kind: 'Pod' }),
      hasMore: false,
    };
    expect(getToolCallSummary('list_resources', { kind: 'pod', namespace: 'production' }, podsResult)).toBe('150 pods inspected');

    // Namespaces discovery
    expect(getToolCallSummary('list_namespaces', {}, { namespaces: ['default', 'kube-system', 'monitoring'] })).toBe('3 namespaces discovered');

    // Diagnostics
    expect(getToolCallSummary('get_pod_diagnostics', { name: 'web' }, { issuesSummary: [] })).toBe('No issues found in available evidence · health unverified');
    expect(getToolCallSummary('get_pod_diagnostics', { name: 'web' }, { issuesSummary: ['CrashLoopBackOff', 'OOMKilled'] })).toBe('Diagnostics partial · 2 issue(s) detected');
  });

  it('supports pinning and renaming conversations', () => {
    const id = useAiStore.getState().create(scope, '', 'Initial title');
    const conv = useAiStore.getState().conversations.find(c => c.id === id);
    expect(conv?.title).toBe('Initial title');
    expect(conv?.pinned).toBe(false);

    useAiStore.getState().togglePin(id);
    expect(useAiStore.getState().conversations.find(c => c.id === id)?.pinned).toBe(true);

    useAiStore.getState().rename(id, 'Incident #104: Payment crash');
    expect(useAiStore.getState().conversations.find(c => c.id === id)?.title).toBe('Incident #104: Payment crash');

    useAiStore.getState().togglePin(id);
    expect(useAiStore.getState().conversations.find(c => c.id === id)?.pinned).toBe(false);
  });

  it('accurately detects plan messages in English and Russian across formats', () => {
    // English plan headings
    expect(isPlanMessage('## Plan: Fix CrashLoopBackOff\n1. Check debugfs tracepoint')).toBe(true);
    expect(isPlanMessage('### Action Plan: Scale Deployment\n1. Run scale')).toBe(true);
    expect(isPlanMessage('# Proposed Plan\n- Step 1')).toBe(true);

    // Russian plan headings
    expect(isPlanMessage('## План действий: устранение CrashLoopBackOff\n1. Проверить tracepoint')).toBe(true);
    expect(isPlanMessage('# План решения\n1. Проверить debugfs')).toBe(true);
    expect(isPlanMessage('### Шаги по устранению проблемы\n1. Смонтировать /sys/kernel/debug')).toBe(true);

    // Bold / plain labels
    expect(isPlanMessage('**План:**\n1. Шаг 1')).toBe(true);
    expect(isPlanMessage('**Action Plan:**\n1. Step 1')).toBe(true);
    expect(isPlanMessage('План действий:\n1. Шаг 1')).toBe(true);

    // Contextual: user asked for a plan, assistant replied with numbered/bulleted steps
    expect(isPlanMessage('1. Шаг первый\n2. Шаг второй', 'Составь план как починить падающий под')).toBe(true);
    expect(isPlanMessage('- Сделать проверку прав\n- Перезапустить контейнер', 'сделай план')).toBe(true);
    expect(isPlanMessage('1. Apply manifest\n2. Verify rollout', '/plan rollout')).toBe(true);

    // Negative tests: diagnostic reports and explanations must NOT be tagged as plans
    expect(isPlanMessage('Incident Report: Pod CrashLoopBackOff\nRestart count: 523\nFacts & Evidence...', 'Analyze Pod caretta')).toBe(false);
    expect(isPlanMessage('Под падает из-за отсутствия tracepoint в debugfs. Код выхода 1.', 'В чем причина падения?')).toBe(false);
    expect(isPlanMessage('This workload has 0/3 replicas ready.', 'Check deployment status')).toBe(false);
  });
});

describe('AI history evidence retention', () => {
  it('omits tool data and manifest arguments while keeping operation receipts', () => {
    const message = persistedMessage({ id: '1', role: 'tool', text: 'secret text', call: { id: 'c', name: 'apply_manifest', arguments: { namespace: 'apps', yaml: 'secret manifest' } }, result: { operationId: 'op1', status: 'accepted', values: 'private' } });
    expect(message.result?.operationId).toBe('op1');
    expect(message.call?.arguments).toEqual({ namespace: 'apps' });
    expect(JSON.stringify(message)).not.toContain('secret');
    expect(JSON.stringify(message)).not.toContain('private');
  });
  it('migrates legacy tool outputs without restoring execution authority', () => {
    const history = migrateAiHistory({ conversations: [{ id: 'c', sessionId: 'old', mode: 'accept', phase: 'tooling', busy: true, messages: [{ id: 'm', role: 'tool', text: 'get_logs', result: { logs: 'private' } }] }], activeId: 'c' });
    expect(history.conversations[0].sessionId).toBeUndefined();
    expect(history.conversations[0].mode).toBe('ask');
    expect(history.conversations[0].phase).toBe('plan');
    expect(JSON.stringify(history)).not.toContain('private');
  });
});

it('keeps frontend default write grants disabled like the native policy', () => {
  expect(defaultPolicy().writes).toEqual([]);
});

it('distinguishes API acceptance, uncertainty and historical payloads from verified success', () => {
  expect(getToolCallSummary('apply_manifest', {}, { status: 'accepted', operationId: 'op1' })).toContain('verify outcome');
  expect(getToolCallSummary('apply_manifest', {}, { status: 'uncertain', operationId: 'op1' })).toContain('uncertain');
  expect(getToolCallSummary('get_resource', {}, { payloadOmitted: true })).toContain('Historical');
  expect(getToolCallSummary('get_workload_diagnostics', {}, {})).toContain('unknown');
  expect(getToolCallSummary('list_helm_releases', {}, { releases: [{}] })).not.toContain('all deployed');
});

it('retains the backend context estimate when a provider omits token usage', () => {
  const id=useAiStore.getState().create(scope);
  let conversation=useAiStore.getState().conversations.find(c=>c.id===id)!;
  conversation=applyAgentEvent(conversation,{type:'context',estimatedInputTokens:1200,budgetTokens:8192,reservedOutputTokens:1024});
  conversation=applyAgentEvent(conversation,{type:'usage',inputTokens:null,outputTokens:null});
  expect(conversation.currentContextTokens).toBe(1200);
  expect(conversation.contextEstimated).toBe(true);
  expect(conversation.contextBudgetTokens).toBe(8192);
});

it('handles plan_updated and propose_plan events, preserving PlanArtifact in active conversation', () => {
  const id = useAiStore.getState().create(scope);
  let conversation = useAiStore.getState().conversations.find(c => c.id === id)!;
  const artifact = { schemaVersion:1 as const, sessionId:'native', scope, kind:'remediation' as const, diagnosis:'Readiness failure',uncertainty:'Cause not established',steps:[{id:'s1',title:'Inspect',action:'inspect' as const,reason:'Find cause',risk:'Read only',verification:'Observe conditions'}],
    id: 'plan-123',
    version: 1,
    title: 'Payment Service Investigation Plan',
    bodyMarkdown: '# Plan\n1. Check Service endpoints\n2. Inspect Pod readiness',
    targetScope: 'backend/payments',
    evidenceIds: ['ev-1', 'ev-2'],
    proposedActions: ['verify_endpoints'],
    status: 'draft' as const,
    createdAt: new Date().toISOString(),
  };

  conversation = applyAgentEvent(conversation, { type: 'plan_updated', plan: artifact });
  expect(conversation.activePlan).toBeDefined();
  expect(conversation.activePlan?.id).toBe('plan-123');
  expect(conversation.activePlan?.version).toBe(1);
  expect(conversation.activePlan?.title).toBe('Payment Service Investigation Plan');

  // Also verify tool_completed with planArtifact
  conversation = applyAgentEvent(conversation, {
    type: 'tool_started',
    call: { id: 'call-plan', name: 'propose_plan', arguments: { title: 'Updated Plan' } },
  });
  conversation = applyAgentEvent(conversation, {
    type: 'tool_completed',
    id: 'call-plan',
    result: { planArtifact: { ...artifact, version: 2, title: 'Updated Plan' } },
  });
  expect(conversation.activePlan?.version).toBe(2);
  expect(conversation.activePlan?.title).toBe('Updated Plan');
  expect(conversation.messages[conversation.messages.length - 1].planArtifact?.version).toBe(2);
});

it('omits copied plan bodies from persistent history and legacy migration', () => {
  const planArtifact={schemaVersion:1 as const,sessionId:'native',kind:'remediation' as const,diagnosis:'Unknown',uncertainty:'Need evidence',steps:[],id:'plan',version:1,title:'Plan',bodyMarkdown:'private-plan-body',scope,status:'draft' as const,createdAt:'1'};
  const message={id:'plan-message',role:'tool' as const,text:'propose_plan',call:{id:'plan-call',name:'propose_plan',arguments:{bodyMarkdown:'private-plan-body'}},result:{planArtifact},planArtifact};
  expect(JSON.stringify(persistedMessage(message))).not.toContain('private-plan-body');
  const migrated=migrateAiHistory({conversations:[{id:'legacy',scope,messages:[message],activePlan:planArtifact}]});
  expect(JSON.stringify(migrated)).not.toContain('private-plan-body');
});

it('resource investigations explicitly request a remediation artifact and retain identity-only context', () => {
  useClusterStore.setState({ currentContext:'prod',selectedNamespace:'apps' });
  openAiChat({resource:{apiVersion:'apps/v1',kind:'Deployment',name:'api',namespace:'apps',uid:'d1'} as any});
  const c=useAiStore.getState().conversations.at(-1)!;
  expect(c.intent).toBe('investigate');expect(c.draft).toContain('structured remediation plan');expect(c.draft).toContain('verification');
});
it('changing a live provider/model creates a fresh read-only context without sending old evidence',async()=>{
  const id=useAiStore.getState().create(scope,'Question');await useAiStore.getState().send(id);
  useAiStore.getState().update(id,{model:'new-model'});const c=useAiStore.getState().conversations.find(c=>c.id===id)!;
  expect(c.sessionId).toBeUndefined();expect(c.mode).toBe('ask');expect(c.phase).toBe('plan');expect(c.contextReset).toBe(true);
  expect(agentTransport.stop).toHaveBeenCalledWith('native',true);
});

it('permission presets preserve allowed scope and require explicit grants for changes',async()=>{
  const {permissionProfile}=await import('../../src/domains/ai/permission_profiles');
  const base={...defaultPolicy(),contexts:['prod'],namespaces:['apps']};
  for(const name of ['workloads','network','storage'] as const){const policy=permissionProfile(base,name);expect(policy.contexts).toEqual(['prod']);expect(policy.namespaces).toEqual(['apps']);expect(policy.writes).toEqual([]);expect(policy.rules.at(-1)?.read).toBe('none');}
  expect(permissionProfile(base,'network').clusterResources).toBe(false);expect(permissionProfile(base,'limited actions').writes).toEqual(['scale','restart']);
});

it('changing rule semantics then applying a preset never lets its catch-all deny override its own grants',async()=>{
  const {permissionProfile}=await import('../../src/domains/ai/permission_profiles');
  const profile=permissionProfile({...defaultPolicy(),schemaVersion:2,ruleResolution:'deny_overrides'},'network');
  expect(profile.schemaVersion).toBe(1);expect(profile.ruleResolution).toBe('first_match');expect(profile.rules.some(r=>r.kind==='Service'&&r.read==='content')).toBe(true);
});

it('model detail lookup cannot replace a requested model identity with an unrelated returned record',async()=>{
  const id='detail-identity-check';
  useAiStore.setState({models:{provider:[{id,name:'Expected model',contextWindow:8192,maxOutputTokens:null,tools:true}]}});
  vi.mocked(agentTransport.models).mockResolvedValue([{id:'unrelated-model',name:'Wrong record',contextWindow:32768,maxOutputTokens:null,tools:true}]);
  await useAiStore.getState().inspectModel('provider',id);
  expect(useAiStore.getState().models.provider[0].id).toBe(id);
});


it('removed providers cannot start model discovery or write stale defaults', async () => {
  await useAiStore.getState().refreshModels('removed-provider');
  await useAiStore.getState().saveDefaults('removed-provider', 'old-model');
  expect(agentTransport.models).not.toHaveBeenCalled();
  expect(agentTransport.save).not.toHaveBeenCalled();
  expect(useAiStore.getState().settings.defaultProvider).toBe('provider');
});

it('model discovery ignores a response after settings reload removes the provider', async () => {
  const pending = deferred<Awaited<ReturnType<typeof agentTransport.models>>>();
  vi.mocked(agentTransport.models).mockReturnValue(pending.promise);
  const refresh = useAiStore.getState().refreshModels('provider');
  vi.mocked(agentTransport.settings).mockResolvedValue({settings: {...settings(), providers: [], defaultProvider: null, defaultModel: null}, credentials: {}});
  await useAiStore.getState().load();
  pending.resolve([{id: 'old-model', name: 'Old model', tools: true, contextWindow: null, maxOutputTokens: null}]);
  await refresh;
  expect(useAiStore.getState().models.provider).toBeUndefined();
});

it('model discovery ignores an old 401 after settings reload changes the endpoint', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(agentTransport.models).mockReturnValue(new Promise((_resolve, fail) => {reject = fail;}));
  const refresh = useAiStore.getState().refreshModels('provider');
  vi.mocked(agentTransport.settings).mockResolvedValue({settings: {...settings(), providers: [{...settings().providers[0], baseUrl: 'http://127.0.0.1:8085'}]}, credentials: {}});
  await useAiStore.getState().load();
  reject(new Error('Old endpoint returned HTTP 401'));
  await refresh;
  expect(useAiStore.getState().modelErrors.provider).toBeUndefined();
});

it('formats tool intents and summaries for diagnostic bundles, neighborhoods and filtered logs', async () => {
  const { getToolIntent, getToolCallSummary } = await import('../../src/domains/ai/tool_intents');
  const diagIntent = getToolIntent('diagnose_resource', { kind: 'Deployment', name: 'api', namespace: 'apps' });
  expect(diagIntent.title).toContain('Diagnose Deployment "api"');
  expect(diagIntent.badge).toBe('DIAGNOSE');

  const diagSummary = getToolCallSummary(
    'diagnose_resource',
    { kind: 'Deployment', name: 'api' },
    { crashCauses: [{ container: 'api', reason: 'OOMKilled' }], diagnostic: { issuesSummary: ['OOM'] } },
  );
  expect(diagSummary).toBe('Diagnostic bundle collected · 1 crash cause(s) identified');

  const neighborhoodSummary = getToolCallSummary(
    'get_neighborhood',
    { kind: 'Pod', name: 'api-1' },
    { nodes: [{}, {}], edges: [{}], truncated: true },
  );
  expect(neighborhoodSummary).toBe('2 nodes, 1 edge mapped (bounded)');

  const logsSummary = getToolCallSummary(
    'get_logs',
    { name: 'api-1' },
    { logs: 'line1\nline2', filtered: true, matchedErrorLines: 4, totalLines: 120 },
  );
  expect(logsSummary).toBe('Filtered 4 error/warning line(s) from 120 total');
});

it('correctly calculates live active MCP tools and synchronizes read-only mode and categories', async () => {
  const {
    defaultMcpPolicy,
    normalizeMcpPolicy,
    isToolActiveInPolicy,
    toggleReadOnlyMcpPolicy,
    patchToolInPolicy,
    MCP_TOOL_CATALOG,
  } = await import('../../src/domains/ai/types');

  expect(defaultMcpPolicy().writes).toEqual([]);
  const base = { ...defaultMcpPolicy(), logs: true, clusterResources: true, writes: ['create', 'update', 'delete', 'scale', 'restart'] as import('../../src/domains/ai/types').WriteOperation[] };
  const activeAll = MCP_TOOL_CATALOG.filter(t => isToolActiveInPolicy(t.id, base));
  expect(activeAll.length).toBe(31);

  // Toggling to readOnly blocks all 4 write tools, leaving exactly 27 active read tools
  const readOnlyPolicy = toggleReadOnlyMcpPolicy(true, base);
  const activeReadOnly = MCP_TOOL_CATALOG.filter(t => isToolActiveInPolicy(t.id, readOnlyPolicy));
  expect(activeReadOnly.length).toBe(27);
  expect(isToolActiveInPolicy('apply_manifest', readOnlyPolicy)).toBe(false);
  expect(isToolActiveInPolicy('scale_workload', readOnlyPolicy)).toBe(false);
  expect(isToolActiveInPolicy('restart_workload', readOnlyPolicy)).toBe(false);
  expect(isToolActiveInPolicy('delete_resource', readOnlyPolicy)).toBe(false);
  expect(isToolActiveInPolicy('diagnose_resource', readOnlyPolicy)).toBe(true);
  expect(isToolActiveInPolicy('get_logs', readOnlyPolicy)).toBe(true);

  // Explicit denials must never be mistaken for missing configuration.
  const legacyPolicy = normalizeMcpPolicy({ ...defaultPolicy(), readOnly: false, writes: [] });
  expect(legacyPolicy.writes).toEqual([]);
  expect(legacyPolicy.logs).toBe(false);
  expect(legacyPolicy.clusterResources).toBe(false);
  expect(toggleReadOnlyMcpPolicy(false, { ...legacyPolicy, readOnly: true }).writes).toEqual([]);

  // Enabling a tool like get_logs when logs: false enables policy.logs
  const noLogs = { ...base, logs: false };
  expect(isToolActiveInPolicy('get_logs', noLogs)).toBe(false);
  const patchedLogs = patchToolInPolicy('get_logs', true, noLogs);
  expect(patchedLogs.logs).toBe(true);
  expect(isToolActiveInPolicy('get_logs', patchedLogs)).toBe(true);

  // Enabling apply_manifest when in readOnly mode switches to write mode and adds write operations
  const patchedWrite = patchToolInPolicy('apply_manifest', true, readOnlyPolicy);
  expect(patchedWrite.readOnly).toBe(false);
  expect(patchedWrite.writes).toContain('create');
  expect(patchedWrite.writes).toContain('update');
  expect(isToolActiveInPolicy('apply_manifest', patchedWrite)).toBe(true);

  // Plan phase specifically blocks mutation tools even if policy allows writes
  expect(isToolActiveInPolicy('apply_manifest', base, 'plan')).toBe(false);
  expect(isToolActiveInPolicy('scale_workload', base, 'plan')).toBe(false);
  expect(isToolActiveInPolicy('diagnose_resource', base, 'plan')).toBe(true);

  // Phase-specific disabling via planDisabledTools / actionDisabledTools
  const planDisabledPolicy = patchToolInPolicy('get_logs', false, base, 'plan');
  expect(planDisabledPolicy.planDisabledTools).toContain('get_logs');
  expect(isToolActiveInPolicy('get_logs', planDisabledPolicy, 'plan')).toBe(false);
  expect(isToolActiveInPolicy('get_logs', planDisabledPolicy, 'action')).toBe(true);

  const actionDisabledPolicy = patchToolInPolicy('scale_workload', false, base, 'action');
  expect(actionDisabledPolicy.actionDisabledTools).toContain('scale_workload');
  expect(isToolActiveInPolicy('scale_workload', actionDisabledPolicy, 'action')).toBe(false);
  expect(isToolActiveInPolicy('scale_workload', actionDisabledPolicy, 'tooling')).toBe(false);
  expect(patchToolInPolicy('get_logs', false, base, 'tooling').actionDisabledTools).toContain('get_logs');
  expect(isToolActiveInPolicy('apply_manifest', actionDisabledPolicy, 'action')).toBe(true);

  // Explicit empty writes (e.g. unchecking all 5 write ops) is preserved when already configured
  const configuredNoWrites = normalizeMcpPolicy({ ...base, readOnly: false, writes: [] });
  expect(configuredNoWrites.writes).toEqual([]);
  expect(isToolActiveInPolicy('apply_manifest', configuredNoWrites)).toBe(false);
  expect(isToolActiveInPolicy('scale_workload', configuredNoWrites)).toBe(false);
  expect(MCP_TOOL_CATALOG.filter(t => isToolActiveInPolicy(t.id, configuredNoWrites)).length).toBe(27);

  // Enabling a tool on the Global tab (phase === undefined) clears phase-specific disable lists for that tool
  const reenabledGlobal = patchToolInPolicy('scale_workload', true, actionDisabledPolicy);
  expect(reenabledGlobal.actionDisabledTools).not.toContain('scale_workload');
  expect(isToolActiveInPolicy('scale_workload', reenabledGlobal, 'action')).toBe(true);

  // syncSharedPolicyFields synchronizes MCP access fields while preserving alwaysAsk
  const { syncSharedPolicyFields } = await import('../../src/domains/ai/types');
  const nativeTarget = { ...defaultPolicy(), alwaysAsk: ['delete_resource'] };
  const synced = syncSharedPolicyFields(readOnlyPolicy, nativeTarget);
  expect(synced.readOnly).toBe(true);
  expect(synced.logs).toBe(true);
  expect(synced.alwaysAsk).toEqual(['delete_resource']);
});
