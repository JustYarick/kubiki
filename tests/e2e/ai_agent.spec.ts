import { expect, test, type Page } from '@playwright/test';
import { captureScreenshot } from './helpers/screenshots';

async function setup(page: Page) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any;
    const policy = { resources: true, events: true, logs: false, metrics: true, clusterResources: false, secrets: 'none', configMaps: 'metadata', workloadConfiguration: false, annotations: false, customResources: 'metadata', contexts: ['*'], namespaces: ['*'], writes: [], maxReplicas: 10, rules: [], deniedPaths: [] };
    let settings = { providers: [{ id: 'local', name: 'Local Ollama', protocol: 'ollama', baseUrl: 'http://localhost:11434' }], defaultProvider: 'local', defaultModel: 'model-from-endpoint', options: {}, policy, instructions: '' };
    const keys = new Map<string, string>(); const sessions = new Map<string, any>();
    const callbacks = new Map<number, unknown>(); let sequence = 0;
    const commands: Array<{ command: string; args: any }> = []; const sends: any[] = []; const modes: any[] = []; const stops: any[] = [];
    w.__aiHarness = { commands, sends, modes, stops, hold: false, models: [{ id: 'model-from-endpoint', name: 'Endpoint model', contextWindow: 32768, maxOutputTokens: 8192, tools: true }], settings: () => settings, key: (id: string) => keys.get(id) };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: unknown) => { callbacks.set(++sequence, callback); return sequence; }, unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command.startsWith('ai_')) commands.push({ command, args: { ...args, onEvent: undefined } });
        if (command === 'plugin:event|listen') return ++sequence;
        if (command === 'plugin:event|unlisten' || command.startsWith('stop_')) return;
        if (command === 'ai_get_settings') return { settings: { ...structuredClone(settings), providers: settings.providers.map(({ id, name, protocol, baseUrl }) => ({ id, name, protocol, baseUrl })) }, credentials: Object.fromEntries([...keys.keys()].map(id => [id, true])) };
        if (command === 'ai_save_settings') { settings = structuredClone(args.settings); return; }
        if (command === 'ai_set_credential') { if (args.apiKey) keys.set(args.providerId, args.apiKey); else keys.delete(args.providerId); return; }
        if (command === 'ai_list_models') return structuredClone(w.__aiHarness.models);
        if (command === 'ai_create_session') { const id = `native-${++sequence}`; const session = { ...args.request, id, mode: 'read_only', phase: 'plan', policy }; sessions.set(id, session); return session; }
        if (command === 'ai_set_mode') {
          modes.push(args);
          const s = sessions.get(args.sessionId);
          if (s) {
            s.mode = args.mode;
            if (args.mode === 'read_only') s.phase = 'plan';
            return { id: args.sessionId, scope: s.scope, mode: s.mode, phase: s.phase, policy: s.policy };
          }
          return { id: args.sessionId, scope: { context: '', namespaces: [], allNamespaces: false }, mode: args.mode, phase: 'plan', policy };
        }
        if (command === 'ai_set_phase') {
          const s = sessions.get(args.sessionId);
          if (s) {
            s.phase = args.phase;
            return { id: args.sessionId, scope: s.scope, mode: s.mode, phase: s.phase, policy: s.policy };
          }
          return { id: args.sessionId, scope: { context: '', namespaces: [], allNamespaces: false }, mode: 'read_only', phase: args.phase, policy };
        }
        if (command === 'ai_stop') { stops.push(args); const s = sessions.get(args.sessionId); s?.finish?.(); if (args.close) sessions.delete(args.sessionId); return; }
        if (command === 'ai_send_message') {
          sends.push(args); const emit = (event: object) => args.onEvent.onmessage(event);
          emit({ type: 'status', status: 'running' });
          if (w.__aiHarness.hold) {
            emit({ type: 'text_delta', text: 'Collecting permitted evidence…' });
            await new Promise<void>(resolve => { sessions.get(args.sessionId).finish = () => { emit({ type: 'status', status: 'cancelled' }); resolve(); }; });
            return;
          }
          if (/create|nexus/i.test(args.message)) {
            emit({ type: 'text_delta', text: 'Here is a proposed manifest. It has not been applied.\n' });
            emit({ type: 'tool_started', call: { id: 'proposal-1', name: 'propose_manifests', arguments: { title: 'Nexus resources' } } });
            emit({ type: 'tool_completed', id: 'proposal-1', result: { proposal: true, executed: false, title: 'Nexus resources', yaml: 'apiVersion: v1\nkind: Service\nmetadata:\n  name: nexus\n  namespace: backend\nspec:\n  selector:\n    app: nexus\n  ports:\n    - port: 8081\n' } });
          } else {
            emit({ type: 'text_delta', text: '**Evidence**\n\n| Resource | State |\n| --- | --- |\n| Pod | Pending |\n\n' });
            emit({ type: 'text_delta', text: '![tracking](https://tracking.invalid/secret)\n<script>window.__unsafeAi = true</script>\n\nCheck scheduling Events.' });
          }
          emit({ type: 'usage', inputTokens: 42, outputTokens: 21 });
          emit({ type: 'status', status: 'completed' }); return;
        }
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
  });
  await page.goto('/?demo=1');
  return errors;
}
async function openAgent(page: Page) {
  await page.getByRole('button', { name: 'AI Agent', exact: true }).click();
  return page.getByRole('region', { name: 'AI Agent workspace', exact: true });
}

test('integrated chat discovers models, streams safe Markdown, changes modes and starts new chats read only', async ({ page }) => {
  const errors = await setup(page); let trackingRequests = 0;
  await page.route('https://tracking.invalid/**', route => { trackingRequests++; return route.abort(); });
  const agent = await openAgent(page);
  await expect(agent.getByRole('button', { name: 'Read only', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(agent.getByRole('button', { name: 'Plan', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(agent.getByRole('button', { name: 'Action', exact: true })).toBeDisabled();
  await expect(agent.getByRole('combobox', { name: 'Conversation AI model' })).toHaveValue('model-from-endpoint');
  await agent.getByRole('textbox', { name: 'Message AI agent' }).fill('Explain Pending Pods');
  await agent.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(agent.getByRole('article', { name: 'Agent response' })).toContainText('Check scheduling Events.');
  await expect(agent.locator('.ai-markdown table')).toHaveCount(1);
  await expect(agent.locator('.ai-markdown img, .ai-markdown script')).toHaveCount(0);
  expect(trackingRequests).toBe(0);
  expect(await page.evaluate(() => (window as any).__unsafeAi)).toBeUndefined();
  await captureScreenshot(page, { path: 'test-results/ai-agent-chat.png' });
  await agent.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.modes.at(-1)?.mode)).toBe('ask');
  await expect(agent.getByRole('button', { name: 'Action', exact: true })).toBeEnabled();
  await agent.getByRole('button', { name: 'Action', exact: true }).click();
  await expect(agent.getByRole('button', { name: 'Action', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await agent.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.modes.at(-1)?.mode)).toBe('accept');
  await agent.getByRole('button', { name: 'New AI conversation', exact: true }).click();
  await expect(agent.getByRole('button', { name: 'Read only', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(agent.getByRole('button', { name: 'Plan', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(agent.getByRole('button', { name: 'Action', exact: true })).toBeDisabled();
  await agent.getByRole('combobox', { name: 'AI conversation scope' }).selectOption('general');
  await agent.getByRole('textbox', { name: 'Message AI agent' }).fill('Explain Kubernetes architecture');
  await agent.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.commands.filter((c: any) => c.command === 'ai_create_session').at(-1)?.args.request.scope.context)).toBe('');
  await agent.getByRole('button', { name: 'New AI conversation', exact: true }).click();
  await page.evaluate(() => { (window as any).__aiHarness.models = [{ id: 'newly-installed-local-model', name: 'New local model', contextWindow: 8192, maxOutputTokens: null, tools: false }]; });
  await agent.getByRole('combobox', { name: 'Conversation AI model' }).click();
  await expect(agent.getByRole('combobox', { name: 'Conversation AI model' }).locator('option[value="newly-installed-local-model"]')).toHaveCount(1);
  await agent.getByRole('combobox', { name: 'Conversation AI model' }).selectOption('newly-installed-local-model');
  await expect(agent).toContainText('advertises no tool support');
  expect(errors).toEqual([]);
});

test('provider credentials stay out of rendered settings and access rules persist through the native boundary', async ({ page }) => {
  const errors = await setup(page); const agent = await openAgent(page);
  await agent.getByRole('button', { name: 'AI settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI Agent settings', exact: true });
  await expect(dialog.getByRole('combobox', { name: 'Secret access', exact: true })).toHaveValue('none');
  await expect(dialog.getByRole('combobox', { name: 'ConfigMap access', exact: true })).toHaveValue('metadata');
  await expect(dialog.getByRole('checkbox', { name: 'Read Pod logs', exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Add provider', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'AI connection name' }).fill('My cloud connection');
  await dialog.getByRole('textbox', { name: 'AI API root' }).fill('https://my-provider.example/v1');
  await dialog.getByLabel('AI API key', { exact: true }).fill('test-only-provider-credential');
  await dialog.getByRole('button', { name: 'Save provider', exact: true }).click();
  await expect(dialog.getByLabel('AI API key', { exact: true })).toHaveValue('');
  await expect(dialog).toContainText('stored in OS credential store');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-only-provider-credential');
  await dialog.getByRole('combobox', { name: 'Default AI model', exact: true }).selectOption('model-from-endpoint');
  await dialog.getByRole('button', { name: 'Use as default', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Secret access', exact: true }).selectOption('metadata');
  await dialog.getByRole('checkbox', { name: 'Read Pod logs', exact: true }).check();
  await dialog.getByRole('group', { name: 'Allowed AI changes', exact: true }).getByRole('checkbox', { name: 'Create', exact: true }).check();
  await dialog.getByRole('button', { name: 'Add resource rule', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Rule 1 kind', exact: true }).fill('Secret');
  await dialog.getByRole('textbox', { name: 'Rule 1 namespace', exact: true }).fill('backend');
  await dialog.getByRole('textbox', { name: 'Rule 1 name', exact: true }).fill('nexus-credentials');
  await dialog.getByRole('combobox', { name: 'Rule 1 read access', exact: true }).selectOption('content');
  await dialog.getByRole('textbox', { name: 'Excluded AI field paths', exact: true }).fill('/data/private.conf');
  await dialog.getByRole('button', { name: 'Save agent permissions', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.settings().policy.rules[0]?.name)).toBe('nexus-credentials');
  const policy = await page.evaluate(() => (window as any).__aiHarness.settings().policy);
  expect(policy.secrets).toBe('metadata'); expect(policy.logs).toBe(true); expect(policy.writes).toEqual(['create']);
  expect(policy.deniedPaths).toEqual(['/data/private.conf']); expect(policy.rules[0].read).toBe('content');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await agent.getByRole('button', { name: 'AI settings', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Rule 1 name', exact: true })).toHaveValue('nexus-credentials');
  await captureScreenshot(page, { path: 'test-results/ai-agent-settings.png', animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('resource entry points create conversations with pinned scope and YAML proposals', async ({ page }) => {
  const errors = await setup(page);
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-search-toolbar').getByRole('textbox').fill('payment-worker-67f98b984-pv4n8');
  await page.getByTestId('resource-table').getByText('payment-worker-67f98b984-pv4n8', { exact: true }).click();
  await page.getByRole('button', { name: 'Investigate with AI', exact: true }).click();
  const agent = page.getByRole('region', { name: 'AI Agent workspace', exact: true });
  await expect(agent.getByRole('textbox', { name: 'Message AI agent' })).toHaveValue(/Investigate Pod backend\/payment-worker/);
  await expect(agent.locator('.ai-scope')).toContainText('backend');
  await agent.getByRole('textbox', { name: 'Message AI agent' }).fill('Create a Nexus deployment with persistent storage');
  await agent.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(agent.getByRole('article', { name: 'AI tool propose_manifests' })).toContainText('name: nexus');
  await expect(agent).toContainText('Proposal · not executed');
  await captureScreenshot(page, { path: 'test-results/ai-agent-proposal.png' });
  await expect(agent.getByRole('button', { name: 'Ask agent to apply proposal' })).toHaveCount(0);
  await expect(page.getByTestId('explorer-panel')).not.toBeVisible();
  await expect(page.getByTestId('inspector-panel')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'AI Agent', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Cluster Explorer', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Services(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: 'Create with AI', exact: true }).click();
  await expect(agent.getByRole('textbox', { name: 'Message AI agent' })).toHaveValue(/Create a Service in Kubernetes/);
  await expect(agent.getByRole('button', { name: 'Read only', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('a running conversation survives section navigation, Stop interrupts it and the chat adapts to narrow workspaces', async ({ page }) => {
  const errors = await setup(page); const agent = await openAgent(page);
  await page.evaluate(() => { (window as any).__aiHarness.hold = true; });
  await agent.getByRole('textbox', { name: 'Message AI agent' }).fill('Investigate this cluster');
  await agent.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(agent).toContainText('Collecting permitted evidence');
  await page.getByRole('button', { name: 'Cluster Explorer', exact: true }).click();
  await expect(agent).not.toBeVisible();
  await expect(page.getByTestId('explorer-panel')).toBeVisible();
  await page.getByRole('button', { name: 'AI Agent', exact: true }).click();
  await expect(agent).toContainText('Collecting permitted evidence');
  expect(await page.evaluate(() => (window as any).__aiHarness.stops.length)).toBe(0);
  await agent.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(agent.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.stops.length)).toBe(1);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(agent.getByRole('complementary', { name: 'AI conversations', exact: true })).toBeVisible();
  expect(await agent.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 740, height: 800 });
  await expect(agent.getByRole('combobox', { name: 'Active AI conversation' })).toBeVisible();
  expect(await agent.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});
