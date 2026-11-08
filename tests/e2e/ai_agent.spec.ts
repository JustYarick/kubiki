import { expect, test, type Page } from '@playwright/test';
import { captureScreenshot } from './helpers/screenshots';

async function setup(page: Page) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any;
    const policy = { resources: true, events: true, logs: false, metrics: true, clusterResources: false, secrets: 'none', configMaps: 'metadata', workloadConfiguration: false, annotations: false, customResources: 'metadata', contexts: ['*'], namespaces: ['*'], writes: [], maxReplicas: 10, rules: [], deniedPaths: [] };
    let settings = { providers: [{ id: 'local', name: 'Local Ollama', protocol: 'ollama', baseUrl: 'http://localhost:11434' }], defaultProvider: 'local', defaultModel: 'model-from-endpoint', options: {}, policy, instructions: '' };
    const history=new Map<string,any>();let historyPrefs={enabled:true,retentionDays:30,allowExport:true};const plans=new Map<string,any>();const reviews=new Map<string,any>();
    const keys = new Map<string, string>(); const sessions = new Map<string, any>();
    const callbacks = new Map<number, unknown>(); let sequence = 0;
    const commands: Array<{ command: string; args: any }> = []; const sends: any[] = []; const modes: any[] = []; const stops: any[] = [];
    w.__aiHarness = { commands, sends, modes, stops, hold: false, openCodeStarts: [], openCodeCloses: [], openCodeCompletions: 0, openCodeWrites: [], openCodeSizes: [], models: [{ id: 'model-from-endpoint', name: 'Endpoint model', contextWindow: 32768, maxOutputTokens: 8192, tools: true }], settings: () => settings, key: (id: string) => keys.get(id) };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: unknown) => { callbacks.set(++sequence, callback); return sequence; }, unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command.startsWith('ai_')) commands.push({ command, args: { ...args, onEvent: undefined } });
        if (command === 'start_opencode') {
          w.__aiHarness.openCodeStarts.push(structuredClone(args.request));
          if(w.__aiHarness.openCodeFailure) throw w.__aiHarness.openCodeFailure;
          if(w.__aiHarness.deferOpenCode) await new Promise<void>(resolve=>{w.__aiHarness.releaseOpenCode=resolve;});
          args.onEvent.onmessage({session_id:args.sessionId,messages:[{sequence:1,event:{type:'Started'}}]});
          if (w.__aiHarness.negotiateTerminal) {
            const parsed = new Promise<void>(resolve => { w.__aiHarness.queryParsed = resolve; });
            args.onEvent.onmessage({session_id:args.sessionId,messages:[{sequence:2,event:{type:'Output',payload:{data:[...new TextEncoder().encode('\x1b[6n\x1b]11;?\x1b\\')]}}}]});
            await parsed;
          }
          w.__aiHarness.openCodeCompletions++;return;
        }
        if (command === 'close_host_terminal') {w.__aiHarness.openCodeCloses.push(args.sessionId);return;}
        if (command === 'write_host_terminal') { w.__aiHarness.openCodeWrites.push(args.data); return; }
        if (command === 'resize_host_terminal') { w.__aiHarness.openCodeSizes.push({cols:args.cols,rows:args.rows}); return; }
        if (command === 'ack_host_terminal') { if(args.sequence===2)w.__aiHarness.queryParsed?.(); return; }

        if (command === 'plugin:event|listen') { if(args.event === 'mutation-confirm-request') w.__aiHarness.confirm = (payload: any) => (callbacks.get(args.handler) as ((event: any) => void) | undefined)?.({event: args.event, payload}); return ++sequence; }
        if (command === 'resolve_mutation_confirm') { w.__aiHarness.decision = args.approved; w.__aiHarness.resolveApproval?.(); return true; }
        if (command === 'plugin:event|unlisten' || command.startsWith('stop_')) return;
        if(command==='ai_history_load')return{conversations:[...history.values()],preferences:historyPrefs,migrated:true};
        if(command==='ai_history_sync'){for(const id of args.deleted)history.delete(id);if(historyPrefs.enabled)for(const c of args.documents)history.set(c.id,structuredClone(c));return;}
        if(command==='ai_history_preferences'){historyPrefs=args.preferences;if(!historyPrefs.enabled)history.clear();return;}
        if(command==='ai_preview_policy')return{explanation:{allowed:false,explanation:'Plan forbids writes',dataAccess:'content',writeAllowed:false},issues:[]};
        if(command==='ai_get_evidence')return{data:{capturedAt:Date.now(),completeness:'partial',resource:{metadata:{name:'web'}}},warning:'Historical evidence; refresh before verification'};
        if(command==='ai_review_plan'){const plan=plans.get(args.request.planId);const reviewToken=`review-${++sequence}`;const ready={...plan,status:'ready'};reviews.set(reviewToken,ready);return{reviewToken,plan:ready,steps:ready.steps.map((step:any)=>({stepId:step.id,target:step.target,operation:'scale',call:{name:'scale_workload',arguments:{replicas:3}}}))};}
        if(command==='ai_execute_plan'){const plan=reviews.get(args.request.reviewToken);if(!plan)throw new Error('Consumed review');reviews.delete(args.request.reviewToken);const completed={...plan,status:'completed'};args.onEvent.onmessage({type:'plan_updated',plan:completed});args.onEvent.onmessage({type:'status',status:'completed'});return{plan:completed,receipts:[]};}
        if (command === 'ai_get_settings') return { settings: { ...structuredClone(settings), providers: settings.providers.map(({ id, name, protocol, baseUrl }) => ({ id, name, protocol, baseUrl })) }, credentials: Object.fromEntries([...keys.keys()].map(id => [id, true])) };
        if (command === 'ai_save_settings') { settings = structuredClone(args.settings); return; }
        if (command === 'ai_set_credential') { if (args.apiKey) keys.set(args.providerId, args.apiKey); else keys.delete(args.providerId); return; }
        if (command === 'ai_list_skills') return w.__aiHarness.skills ?? [{name:'cluster-debug',description:'Investigate a cluster using permitted evidence',directory:'/home/user/.agents/skills/cluster-debug'}];
        if (command === 'ai_test_provider') { if(args.profile.baseUrl.includes('broken')) throw new Error('Provider connection failed'); return structuredClone(w.__aiHarness.models); }
        if (command === 'ai_test_external_agent') return {executable:`/usr/local/bin/${args.runtime}`,version:args.runtime === 'codex' ? 'codex-cli 0.166.0' : '2.1.299 (Claude Code)'};
        if (command === 'ai_test_opencode') return {executable:'/usr/local/bin/opencode',version:'opencode v2.0.27'};
        if (command === 'ai_list_models') {
          if (!settings.providers.some(p => p.id === args.providerId)) throw new Error('Unknown AI provider');
          if (w.__aiHarness.failedProviders?.includes(args.providerId)) throw new Error('AI endpoint returned HTTP 401');
          return structuredClone(w.__aiHarness.models);
        }
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
          w.__aiHarness.emit = emit;
          emit({ type: 'status', status: 'running' });
          if (w.__aiHarness.readApproval) {
            emit({type:'tool_started',call:{id:'read',name:'get_logs',arguments:{namespace:'apps',name:'web'}}});
            emit({type:'status',status:'awaiting_approval'});
            await new Promise<void>(resolve => {
              w.__aiHarness.resolveApproval = resolve;
              w.__aiHarness.confirm({id:'approval',resource:{context:'prod',kind:'Pod',name:'web',namespace:'apps'},review:'Run get_logs? Results are shared with the selected model.\n{"namespace":"apps","name":"web"}',simple:{title:'Allow agent tool?',confirm_label:'Allow once',destructive:false}});
            });
            emit({type:'tool_completed',id:'read',result:{message:w.__aiHarness.decision ? 'Read completed' : 'Read declined'}});
            emit({type:'status',status:'completed'}); return;
          }
          if (w.__aiHarness.hold) {
            emit({ type: 'text_delta', text: 'Collecting permitted evidence…' });
            await new Promise<void>(resolve => { sessions.get(args.sessionId).finish = () => { emit({ type: 'status', status: 'cancelled' }); resolve(); }; });
            return;
          }
          if(w.__aiHarness.planMode){
            emit({type:'text_delta',text:'<think>## Plan\nFirst I should investigate the resource.</think>Observed a workload readiness issue. Review the remediation steps below.'});
            emit({type:'tool_started',call:{id:'evidence',name:'get_resource',arguments:{kind:'Deployment',namespace:'apps',name:'web'}}});emit({type:'tool_completed',id:'evidence',result:{evidenceId:'e1',resource:{metadata:{name:'web'}}}});
            const plan={schemaVersion:1,sessionId:args.sessionId,id:'typed-plan',version:1,title:'Restore workload capacity',kind:'remediation',diagnosis:'Ready capacity is below desired',uncertainty:'Application health is not established',bodyMarkdown:'## Remediation\nReview the concrete change. ![remote](https://example.invalid/plan-tracker)',scope:sessions.get(args.sessionId).scope,evidenceIds:['e1'],status:'draft',policyRevision:0,createdAt:new Date().toISOString(),steps:[{id:'scale',title:'Scale web to three replicas',action:'scale',target:{group:'apps',version:'v1',kind:'Deployment',namespace:'apps',name:'web'},replicas:3,reason:'Restore intended capacity',risk:'May increase resource usage',verification:'Controller observed generation and readyReplicas=3',dependsOn:[],dependsOnAccepted:[]}]};plans.set(plan.id,plan);
            emit({type:'tool_started',call:{id:'plan',name:'propose_plan',arguments:{title:plan.title}}});emit({type:'plan_updated',plan});emit({type:'tool_completed',id:'plan',result:{planArtifact:plan,executed:false}});
          } else if (/create|nexus/i.test(args.message)) {
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

test('integrated chat discovers models, streams safe Markdown, changes modes and starts new chats in Plan and Ask', async ({ page }) => {
  const errors = await setup(page); let trackingRequests = 0;
  await page.route('https://tracking.invalid/**', route => { trackingRequests++; return route.abort(); });
  const agent = await openAgent(page);
  await expect(agent.getByRole('button', { name: 'Ask', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(agent.getByRole('button', { name: 'Plan', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(agent.getByRole('button', { name: /^(?:Tooling|Action)$/ })).toBeEnabled();
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
  await expect(agent.getByRole('button', { name: /^(?:Tooling|Action)$/ })).toBeEnabled();
  await agent.getByRole('button', { name: /^(?:Tooling|Action)$/ }).click();
  await expect(agent.getByRole('button', { name: /^(?:Tooling|Action)$/ })).toHaveAttribute('aria-pressed', 'true');
  await agent.getByRole('button', { name: 'Auto accept', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.modes.at(-1)?.mode)).toBe('accept');
  await agent.getByRole('button', { name: 'New AI conversation', exact: true }).click();
  await expect(agent.getByRole('button', { name: 'Ask', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(agent.getByRole('button', { name: 'Plan', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(agent.getByRole('button', { name: /^(?:Tooling|Action)$/ })).toBeEnabled();
  await expect(agent.getByRole('combobox', { name: 'AI conversation cluster' })).toHaveValue('kubiki-demo');
  await agent.getByRole('combobox', { name: 'AI conversation cluster' }).selectOption('general');
  await agent.getByRole('textbox', { name: 'Message AI agent' }).fill('Explain Kubernetes architecture');
  await agent.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.commands.filter((c: any) => c.command === 'ai_create_session').at(-1)?.args.request.scope.context)).toBe('');
  await expect(agent.getByRole('complementary', { name: 'AI conversations', exact: true }).getByText('General').first()).toBeVisible();
  await expect(agent.getByRole('tab', { name: /All/ })).toBeVisible();
  await agent.getByRole('button', { name: 'New AI conversation', exact: true }).click();
  await page.evaluate(() => { (window as any).__aiHarness.models = [{ id: 'newly-installed-local-model', name: 'New local model', contextWindow: 8192, maxOutputTokens: null, tools: false }]; });
  await agent.getByRole('combobox', { name: 'Conversation AI model' }).click();
  await expect(agent.getByRole('combobox', { name: 'Conversation AI model' }).locator('option[value="newly-installed-local-model"]')).toHaveCount(1);
  await agent.getByRole('combobox', { name: 'Conversation AI model' }).selectOption('newly-installed-local-model');
  await expect(agent).toContainText('does not support tools');
  expect(errors).toEqual([]);
});

test('provider credentials stay out of rendered settings and access rules persist through the native boundary', async ({ page }) => {
  const errors = await setup(page); const agent = await openAgent(page);
  await agent.getByTestId('ai-conversations-panel').getByRole('button', { name: 'AI settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI Agent settings', exact: true });
  await dialog.getByRole('button', { name: 'Data access', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Secret access', exact: true })).toHaveValue('none');
  await expect(dialog.getByRole('combobox', { name: 'ConfigMap access', exact: true })).toHaveValue('metadata');
  await expect(dialog.getByRole('checkbox', { name: 'Read Pod logs', exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Connections & models', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add connection', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'AI connection name' }).fill('My cloud connection');
  await dialog.getByRole('textbox', { name: 'AI API URL' }).fill('https://my-provider.example/v1');
  await dialog.getByLabel('AI API key', { exact: true }).fill('test-only-provider-credential');
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(dialog.getByLabel('AI API key', { exact: true })).toHaveValue('');
  await expect(dialog).toContainText('stored in OS credential store');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-only-provider-credential');
  await dialog.getByRole('combobox', { name: 'Default AI model', exact: true }).selectOption('model-from-endpoint');
  await dialog.getByRole('button', { name: 'Use as default', exact: true }).click();
  await dialog.getByRole('button', { name: 'Data access', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Secret access', exact: true }).selectOption('metadata');
  await dialog.getByRole('checkbox', { name: 'Read Pod logs', exact: true }).check();
  await dialog.getByRole('group', { name: 'Allowed AI changes', exact: true }).getByRole('checkbox', { name: 'Create', exact: true }).check();
  await dialog.getByRole('button', { name: 'Scope & rules', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add resource rule', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Rule 1 kind', exact: true }).fill('Secret');
  await dialog.getByRole('textbox', { name: 'Rule 1 namespace', exact: true }).fill('backend');
  await dialog.getByRole('textbox', { name: 'Rule 1 name', exact: true }).fill('nexus-credentials');
  await dialog.getByRole('combobox', { name: 'Rule 1 read access', exact: true }).selectOption('content');
  await dialog.getByRole('textbox', { name: 'Excluded AI field paths', exact: true }).fill('/data/private.conf');
  await dialog.getByRole('button', { name: 'Confirmations', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Ask permission for reads', exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'Ask permission for reads', exact: true }).uncheck();
  await dialog.getByText('Always ask', { exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Delete resource', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save agent permissions', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.settings().policy.rules[0]?.name)).toBe('nexus-credentials');
  const policy = await page.evaluate(() => (window as any).__aiHarness.settings().policy);
  expect(policy.confirmReads).toBe(false);
  expect(policy.alwaysAsk).toEqual(['delete_resource']);
  expect(policy.secrets).toBe('metadata'); expect(policy.logs).toBe(true); expect(policy.writes).toEqual(['create']);
  expect(policy.deniedPaths).toEqual(['/data/private.conf']); expect(policy.rules[0].read).toBe('content');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await agent.getByTestId('ai-conversations-panel').getByRole('button', { name: 'AI settings', exact: true }).click();
  await dialog.getByRole('button', { name: 'Scope & rules', exact: true }).click();
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
  await expect(agent.getByRole('textbox', { name: 'Message AI agent' })).toHaveValue(/Analyze Pod backend\/payment-worker/);
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
  await expect(agent.getByRole('button', { name: 'Ask', exact: true })).toHaveAttribute('aria-pressed', 'true');
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

test('reasoning never gains a Plan badge and typed remediation prepares native review and executes from one apply action',async({page})=>{
  const errors=await setup(page);const agent=await openAgent(page);let trackers=0;
  await page.route('https://example.invalid/**',route=>{trackers++;return route.abort();});
  await page.evaluate(()=>{(window as any).__aiHarness.planMode=true;});
  await agent.getByRole('textbox',{name:'Message AI agent'}).fill('Investigate readiness and propose remediation');await agent.getByRole('button',{name:'Send',exact:true}).click();
  const plan=agent.getByRole('article',{name:'Remediation plan: Restore workload capacity'});await expect(plan).toBeVisible();
  await expect(agent.locator('.ai-message .ai-plan-badge')).toHaveCount(0);await expect(plan.locator('img')).toHaveCount(0);expect(trackers).toBe(0);
  await expect(plan.getByRole('button',{name:'Apply selected steps'})).toBeDisabled();
  await plan.getByRole('button',{name:'#e1',exact:true}).click();await expect(plan.getByText('Historical evidence; refresh before verification')).toBeVisible();
  await agent.getByRole('button',{name:'Ask',exact:true}).click();await agent.getByRole('button',{name:'Action',exact:true}).click();
  await plan.getByRole('button',{name:'Apply selected steps'}).click();await expect(plan.getByText('COMPLETED',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__aiHarness.commands.find((c:any)=>c.command==='ai_execute_plan').args.request)).toEqual(expect.objectContaining({reviewToken:expect.stringMatching(/^review-/)}));
  await page.evaluate(()=>{(window as any).__aiHarness.models.push({id:'another-model',name:'Another model',contextWindow:32768,maxOutputTokens:8192,tools:true});});
  await agent.getByRole('combobox',{name:'Conversation AI model'}).click();
  await agent.getByRole('combobox',{name:'Conversation AI model'}).selectOption('another-model');
  await expect(agent.getByRole('button',{name:'Ask',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(agent.getByText(/The agent cannot see earlier messages/)).toBeVisible();
  await expect(plan.getByRole('button',{name:'#e1',exact:true})).toBeDisabled();
  await expect(plan.getByRole('button',{name:'Apply selected steps'})).toBeDisabled();
  await expect.poll(()=>page.evaluate(()=>(window as any).__aiHarness.stops.at(-1)?.close)).toBe(true);
  expect(errors).toEqual([]);
});


test('read tools have a compact working confirmation in Plan', async ({ page }) => {
  const errors = await setup(page); const agent = await openAgent(page);
  await expect(agent.getByRole('button', { name: 'Read only', exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__aiHarness.readApproval = true; });
  await agent.getByRole('textbox', { name: 'Message AI agent' }).fill('Read pod logs');
  await agent.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(agent.getByText('Allow agent tool?', { exact: true })).toBeVisible();
  await expect(agent.getByText('Tool arguments', { exact: true })).toBeVisible();
  await agent.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.decision)).toBe(true);
  await expect(agent.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});


test('global AI settings have subsections and find confirmations through search', async ({ page }) => {
  const errors = await setup(page);
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'AI assistant', exact: true }).click();
  const sections = dialog.getByLabel('AI settings subsections');
  await sections.getByRole('button', { name: 'Confirmations', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Ask permission for reads', exact: true })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Secret access', exact: true })).not.toBeVisible();
  await sections.getByRole('button', { name: 'Data access', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Secret access', exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Search settings', exact: true }).fill('confirmations');
  await expect(dialog.getByRole('checkbox', { name: 'Ask permission for reads', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});


test('provider can be tested before saving and skill completion works in both composers', async ({ page }) => {
  const errors = await setup(page); const agent = await openAgent(page);
  await agent.getByRole('button', {name:'AI settings',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'AI Agent settings',exact:true});
  await dialog.getByRole('button',{name:'Connections & models',exact:true}).click();
  await dialog.getByRole('button',{name:'Add connection',exact:true}).click();
  await dialog.getByRole('textbox',{name:'AI API URL'}).fill('https://unsaved.example/v1');
  await dialog.getByLabel('AI API key',{exact:true}).fill('temporary-test-key');
  const savedBefore=await page.evaluate(()=>(window as any).__aiHarness.commands.filter((c:any)=>c.command==='ai_save_settings').length);
  await dialog.getByRole('button',{name:'Test connection',exact:true}).click();
  await expect(dialog.getByText('Connected. 1 models available.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__aiHarness.commands.filter((c:any)=>c.command==='ai_save_settings').length)).toBe(savedBefore);
  await dialog.getByRole('textbox',{name:'AI API URL'}).fill('https://broken.example/v1');
  await dialog.getByRole('button',{name:'Test connection',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('Provider connection failed');
  await dialog.getByRole('button',{name:'Done',exact:true}).click();
  const composer=agent.getByRole('textbox',{name:'Message AI agent'});
  await composer.fill('Use $cl');
  const option=agent.getByRole('option',{name:/cluster-debug/}); await expect(option).toBeVisible();
  await captureScreenshot(page, {path:'test-results/ai-skill-completion.png'});
  await composer.press('Enter');
  await expect(composer).toHaveValue('Use $cluster-debug ');
  expect(await page.evaluate(()=>(window as any).__aiHarness.sends.length)).toBe(0);
  await composer.press('Enter');
  await expect.poll(()=>page.evaluate(()=>(window as any).__aiHarness.sends.length)).toBe(1);
  await composer.fill('$cl'); await expect(agent.getByRole('listbox',{name:'Installed skills'})).toBeVisible();
  await composer.press('Escape'); await expect(agent.getByRole('listbox',{name:'Installed skills'})).toHaveCount(0);
  await composer.fill('$cluster'); await composer.press('Tab'); await expect(composer).toHaveValue('$cluster-debug ');
  expect(errors).toEqual([]);
});

test('agent selection is in settings and OpenCode only exposes effective settings', async ({ page }) => {
  const errors=await setup(page);const agent=await openAgent(page);
  await agent.getByRole('button',{name:'AI settings',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'AI Agent settings',exact:true});
  await expect(dialog.getByRole('combobox',{name:'AI agent',exact:true})).toHaveValue('kubiki');
  await dialog.getByRole('combobox',{name:'AI agent',exact:true}).selectOption('open_code');
  await expect(page.getByTestId('opencode-pane')).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Search conversations',exact:true})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:'Connections & models',exact:true})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:'Confirmations',exact:true})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:'Skills',exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Check installation',exact:true}).click();
  await expect(dialog.getByRole('status')).toContainText('opencode v2.0.27');
  await dialog.getByRole('button',{name:'Cluster tools (MCP)',exact:true}).click();
  await expect(dialog.getByRole('checkbox',{name:'Logs',exact:true})).not.toBeChecked();
  await expect.poll(()=>page.evaluate(()=>(window as any).__aiHarness.settings().policy.logs)).toBe(false);
  await dialog.getByRole('checkbox',{name:'Logs',exact:true}).check();
  await dialog.getByRole('button',{name:'Save cluster access',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__aiHarness.settings().mcpPolicy?.logs)).toBe(true);
  expect(await page.evaluate(()=>(window as any).__aiHarness.settings().policy.logs)).toBe(true);
  await captureScreenshot(page,{path:'test-results/opencode-cluster-settings.png'});
  await page.setViewportSize({width:375,height:812});
  expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
  await captureScreenshot(page,{path:'test-results/opencode-cluster-settings-narrow.png'});
  await page.setViewportSize({width:1440,height:900});
  await dialog.getByRole('button',{name:'Agent',exact:true}).click();
  await dialog.getByRole('combobox',{name:'AI agent',exact:true}).selectOption('kubiki');
  await expect(page.getByTestId('opencode-pane')).toHaveCount(0);
  await dialog.getByRole('button',{name:'Connections & models',exact:true}).click();
  await expect(dialog.getByRole('combobox',{name:'Saved AI connection',exact:true})).toHaveValue('local');
  expect(await page.evaluate(()=>(window as any).__aiHarness.settings().policy.logs)).toBe(true);
  expect(errors).toEqual([]);
});

test('external MCP phase changes live without restarting the terminal', async ({ page }) => {
  const errors = await setup(page); const agent = await openAgent(page);
  await agent.getByRole('button', { name:'AI settings', exact:true }).click();
  const dialog = page.getByRole('dialog', { name:'AI Agent settings', exact:true });
  await dialog.getByRole('combobox', { name:'AI agent', exact:true }).selectOption('open_code');
  await page.keyboard.press('Escape');
  const pane = page.getByTestId('opencode-pane');
  await expect(pane).toContainText('Connected');
  const starts = await page.evaluate(() => (window as any).__aiHarness.openCodeStarts.length);
  const phase = pane.getByRole('combobox', { name:'MCP server phase', exact:true });
  await expect(phase).toHaveValue('plan');
  await phase.selectOption('action');
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.settings().mcpPhase)).toBe('action');
  await expect(phase).toBeEnabled();
  await phase.selectOption('plan');
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.settings().mcpPhase)).toBe('plan');
  expect(await page.evaluate(() => (window as any).__aiHarness.openCodeStarts.length)).toBe(starts);
  await expect(pane).toContainText('Connected');
  expect(errors).toEqual([]);
});

test('changing tool permissions keeps an integrated conversation usable', async ({ page }) => {
  const errors = await setup(page); const agent = await openAgent(page);
  await agent.getByRole('textbox', { name:'Message AI agent', exact:true }).fill('First question');
  await agent.getByRole('button', { name:'Send', exact:true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.sends.length)).toBe(1);
  const firstSession = await page.evaluate(() => (window as any).__aiHarness.sends[0].sessionId);
  await agent.getByRole('button', { name:/^MCP Tools/ }).click();
  const dialog = page.getByRole('dialog', { name:'AI Agent settings', exact:true });
  await dialog.getByRole('checkbox', { name:'Logs', exact:true }).check();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.settings().policy.logs)).toBe(true);
  await page.keyboard.press('Escape');
  const composer = agent.getByRole('textbox', { name:'Message AI agent', exact:true });
  await composer.fill('Continue with updated permissions');
  await agent.getByRole('button', { name:'Send', exact:true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.sends.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__aiHarness.sends[1].sessionId)).toBe(firstSession);
  expect(errors).toEqual([]);
});

test('skill keyboard navigation scrolls the full catalog and highlights selected references', async ({ page }) => {
  const errors=await setup(page); const agent=await openAgent(page);
  await page.evaluate(()=>{(window as any).__aiHarness.skills=Array.from({length:24},(_,index)=>({name:`skill-${String(index).padStart(2,'0')}`,description:'A skill with a description',directory:'/skills'}));});
  const composer=agent.getByRole('textbox',{name:'Message AI agent'});
  await composer.fill('$skill-');
  const list=agent.getByRole('listbox',{name:'Installed skills'});
  await expect(list.getByRole('option')).toHaveCount(24);
  const pageTop=await page.evaluate(()=>document.scrollingElement?.scrollTop);
  for(let index=0;index<23;index++)await composer.press('ArrowDown');
  const last=list.getByRole('option',{selected:true}); await expect(last).toContainText('$skill-23');
  const visible=await last.evaluate(node=>{const list=node.parentElement!;const item=node.getBoundingClientRect();const bounds=list.getBoundingClientRect();return item.top>=bounds.top&&item.bottom<=bounds.bottom;});
  expect(visible).toBe(true); expect(await list.evaluate(node=>node.scrollTop)).toBeGreaterThan(0);
  await expect(composer).toBeFocused(); expect(await page.evaluate(()=>document.scrollingElement?.scrollTop)).toBe(pageTop);
  await composer.press('Enter'); await expect(composer).toHaveValue('$skill-23 ');
  await expect(agent.locator('.ai-skill-token')).toHaveText('$skill-23');
  await captureScreenshot(page,{path:'test-results/ai-skill-input-highlight.png'});
  await composer.press('Enter');
  await expect(agent.getByRole('article',{name:'Your message'}).locator('.ai-skill-reference')).toContainText('$skill-23');
  await composer.fill('$skill-'); await expect(list).toBeVisible(); await composer.press('ArrowUp');
  await expect(list.getByRole('option',{selected:true})).toContainText('$skill-23');
  await captureScreenshot(page,{path:'test-results/ai-skills-scrolled.png'});
  expect(errors).toEqual([]);
});

test('AI settings sections fit desktop and narrow dialogs without horizontal overflow', async ({ page }) => {
  const errors=await setup(page); const agent=await openAgent(page);
  await agent.getByRole('button',{name:'AI settings',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'AI Agent settings',exact:true});
  for(const section of ['Connections & models','Confirmations','Data access','Scope & rules','Integrations','Environment','Instructions','History']) {
    await dialog.getByRole('navigation',{name:'AI settings sections'}).getByRole('button',{name:section,exact:true}).click();
    expect(await dialog.locator('.ai-settings-content').evaluate(node=>node.scrollWidth<=node.clientWidth+1),section).toBe(true);
  }
  await dialog.getByRole('button',{name:'Environment',exact:true}).click();
  await captureScreenshot(page,{path:'test-results/ai-settings-desktop.png'});
  await page.setViewportSize({width:375,height:812}); await page.emulateMedia({reducedMotion:'reduce'});
  for(const section of ['Confirmations','Data access','Scope & rules','Integrations','Environment']) {
    await dialog.getByRole('navigation',{name:'AI settings sections'}).getByRole('button',{name:section,exact:true}).click();
    expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1),section).toBe(true);
    expect(await dialog.locator('.ai-settings-content').evaluate(node=>node.scrollWidth<=node.clientWidth+1),section).toBe(true);
  }
  await captureScreenshot(page,{path:'test-results/ai-settings-narrow.png'});
  await dialog.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('banner').getByRole('button',{name:'Settings',exact:true}).click();
  const global=page.getByRole('dialog',{name:'Settings',exact:true});
  await global.getByRole('combobox',{name:'Settings category',exact:true}).selectOption('ai');
  await global.getByRole('combobox',{name:'AI settings section',exact:true}).selectOption('environment');
  await expect(global.getByRole('heading',{name:'Skills',exact:true})).toBeVisible();
  expect(await global.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
  await captureScreenshot(page,{path:'test-results/global-settings-narrow.png'});
  expect(errors).toEqual([]);
});

async function selectOpenCode(page:Page) {
  const agent=await openAgent(page);
  await agent.getByRole('button',{name:'AI settings',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'AI Agent settings',exact:true});
  await dialog.getByRole('combobox',{name:'AI agent',exact:true}).selectOption('open_code');
  await dialog.getByRole('button',{name:'Done',exact:true}).click();
  return page.getByTestId('opencode-pane');
}

test('Stop aborts pending OpenCode startup and late completion cannot reconnect it',async({page})=>{
  const errors=await setup(page);
  await page.evaluate(()=>{(window as any).__aiHarness.deferOpenCode=true;});
  const pane=await selectOpenCode(page);
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).__aiHarness.releaseOpenCode)).toBe('function');
  await pane.getByRole('button',{name:'Stop',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__aiHarness.openCodeCloses.length)).toBeGreaterThan(0);
  await page.evaluate(()=>{(window as any).__aiHarness.releaseOpenCode();});
  await expect.poll(()=>page.evaluate(()=>(window as any).__aiHarness.openCodeCompletions)).toBe(1);
  await expect(pane).toContainText('Stopped');
  await page.evaluate(()=>{(window as any).__aiHarness.deferOpenCode=false;});
  await pane.getByRole('button',{name:'Restart',exact:true}).click();
  await expect(pane).toContainText('Connected');expect(errors).toEqual([]);
});

test('Stop before terminal fonts load prevents OpenCode from being launched',async({page})=>{
  const errors=await setup(page);
  await page.evaluate(()=>{
    const w=window as any;w.__releaseFonts=[];
    document.fonts.load=()=>new Promise<FontFace[]>(resolve=>{w.__releaseFonts.push(()=>resolve([]));});
  });
  const pane=await selectOpenCode(page);
  await expect.poll(()=>page.evaluate(()=>(window as any).__releaseFonts.length)).toBeGreaterThan(0);
  await pane.getByRole('button',{name:'Stop',exact:true}).click();
  await page.evaluate(async()=>{for(const release of (window as any).__releaseFonts)release();await document.fonts.ready;});
  await expect(pane).toContainText('Stopped');
  expect(await page.evaluate(()=>(window as any).__aiHarness.openCodeStarts)).toEqual([]);expect(errors).toEqual([]);
});

for(const guaranteedNotStarted of [true,false]) {
  test(`OpenCode retry ${guaranteedNotStarted?'retains undelivered':'does not replay ambiguous'} initial intent`,async({page})=>{
    const errors=await setup(page);
    await page.evaluate(async(known)=>{
      // @ts-expect-error Browser loads this source through Vite.
      const {useAiStore}=await import('/src/domains/ai/store.ts');
      // @ts-expect-error Browser loads this source through Vite.
      const {currentAgentScope}=await import('/src/domains/ai/navigation.ts');
      useAiStore.setState({openCodeRequest:{id:'retry-intent',scope:currentAgentScope(),prompt:'Analyze selected Deployment'}});
      (window as any).__aiHarness.openCodeFailure=known?{code:'opencode_start_failed',processStarted:false,message:'OpenCode was not found'}:'IPC connection lost';
    },guaranteedNotStarted);
    const pane=await selectOpenCode(page);
    await expect(pane).toContainText('Failed');
    await page.evaluate(()=>{(window as any).__aiHarness.openCodeFailure=null;});
    await pane.getByRole('button',{name:'Restart',exact:true}).click();
    await expect(pane).toContainText('Connected');
    const prompts=await page.evaluate(()=>(window as any).__aiHarness.openCodeStarts.map((r:any)=>r.prompt));
    expect(prompts).toEqual(['Analyze selected Deployment',guaranteedNotStarted?'Analyze selected Deployment':null]);
    await pane.getByRole('button',{name:'Restart',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).__aiHarness.openCodeStarts.length)).toBe(3);
    expect(await page.evaluate(()=>(window as any).__aiHarness.openCodeStarts[2].prompt)).toBeNull();
    await page.evaluate(()=>{(window as any).__aiHarness.openCodeFailure={code:'opencode_start_failed',processStarted:false,message:'Later restart failed'};});
    await pane.getByRole('button',{name:'Restart',exact:true}).click();await expect(pane).toContainText('Failed');
    await page.evaluate(()=>{(window as any).__aiHarness.openCodeFailure=null;});
    await pane.getByRole('button',{name:'Restart',exact:true}).click();await expect(pane).toContainText('Connected');
    expect(await page.evaluate(()=>(window as any).__aiHarness.openCodeStarts[4].prompt)).toBeNull();expect(errors).toEqual([]);
  });
}


test('OpenCode answers startup terminal queries and fits its screen after font and pane resize', async ({ page }) => {
  const errors = await setup(page);
  await page.evaluate(() => { (window as any).__aiHarness.negotiateTerminal = true; });
  const pane = await selectOpenCode(page);
  await expect(pane).toContainText('Connected');
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.openCodeWrites.join(''))).toContain('\x1b[1;1R');
  expect(await page.evaluate(() => (window as any).__aiHarness.openCodeWrites.join(''))).toContain('rgb:');
  for (const width of [1000, 1440]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(async () => {
      const { useUiStore } = await import(/* @vite-ignore */ '/src/state/ui_store.ts' as string);
      useUiStore.getState().setTerminalFontSize(18);
      useUiStore.getState().setTerminalLineHeight(1.4);
    });
    await expect.poll(() => pane.locator('.xterm-screen').evaluate(screen => {
      const bounds = screen.getBoundingClientRect(); const host = screen.closest('.terminal-surface')!.getBoundingClientRect();
      return bounds.right <= host.right + 1 && bounds.bottom <= host.bottom + 1 && bounds.width > host.width * .9;
    })).toBe(true);
  }
  expect(await page.evaluate(() => (window as any).__aiHarness.openCodeStarts.length)).toBe(1);
  expect(errors).toEqual([]);
});


for (const removeOld of [true, false]) {
  test(`adding llama.cpp ${removeOld ? 'after removing the old provider' : 'as the new default'} loads its models on the existing home screen`, async ({ page }) => {
    const errors = await setup(page);
    await page.evaluate(() => { (window as any).__aiHarness.failedProviders = ['local']; });
    const agent = await openAgent(page);
    await expect(agent).toContainText('HTTP 401');
    await agent.getByTestId('ai-conversations-panel').getByRole('button', { name: 'AI settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'AI Agent settings', exact: true });
    await dialog.getByRole('button', { name: 'Connections & models', exact: true }).click();
    if (removeOld) await dialog.getByRole('button', { name: 'Remove connection', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add connection', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'AI connection preset' }).selectOption('Custom / vLLM / llama.cpp');
    await dialog.getByRole('textbox', { name: 'AI API URL' }).fill('http://127.0.0.1:8085/v1');
    await page.evaluate(() => { (window as any).__aiHarness.models = [{ id: 'llama-model', name: 'Local llama model', tools: true }]; });
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Default AI model' }).getByRole('option', { name: 'Local llama model · llama-model' })).toHaveCount(1);
    const localId = await page.evaluate(() => (window as any).__aiHarness.settings().providers.find((p: any) => p.baseUrl === 'http://127.0.0.1:8085/v1').id);
    await dialog.getByRole('combobox', { name: 'Default AI model' }).selectOption('llama-model');
    await dialog.getByRole('button', { name: 'Use as default', exact: true }).click();
    await expect(dialog.getByText('Default model and options saved.', {exact: true})).toBeVisible();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(agent.getByRole('combobox', { name: 'Conversation AI connection' })).toHaveValue(localId);
    await expect(agent.getByRole('combobox', { name: 'Conversation AI model' })).toHaveValue('llama-model');
    await expect(agent).not.toContainText('Unknown AI provider');
    await expect(agent).not.toContainText('HTTP 401');
    expect(errors).toEqual([]);
  });
}

test('rule matching help follows the selected policy and persists its semantics', async ({page}) => {
  const errors = await setup(page);
  const agent = await openAgent(page);
  await agent.getByRole('button', {name: 'AI settings', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'AI Agent settings', exact: true});
  await dialog.getByRole('button', {name: 'Scope & rules', exact: true}).click();
  const matching = dialog.getByRole('combobox', {name: 'AI rule matching'});
  await expect(dialog.getByText('The first matching rule applies.', {exact: false})).toBeVisible();
  await matching.selectOption('deny_overrides');
  await expect(dialog.getByText('Rules that deny both reading and changes', {exact: false})).toBeVisible();
  await expect(dialog.getByText('The first matching rule applies.', {exact: false})).toHaveCount(0);
  await dialog.getByRole('button', {name: 'Save agent permissions'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiHarness.settings().policy)).toMatchObject({schemaVersion: 2, ruleResolution: 'deny_overrides'});
  await matching.selectOption('first_match');
  await expect(dialog.getByText('Rules that deny both reading and changes', {exact: false})).toHaveCount(0);
  await expect(dialog.getByText('The first matching rule applies.', {exact: false})).toBeVisible();
  expect(errors).toEqual([]);
});

test('integration detection is shown only for discovered APIs in Auto', async ({page}) => {
  const errors = await setup(page);
  await page.evaluate(() => Object.assign((window as any).__aiHarness.settings().policy, {helm: 'auto', argocd: 'auto', flux: 'auto'}));
  const agent = await openAgent(page);
  await agent.getByRole('button', {name: 'AI settings', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'AI Agent settings', exact: true});
  await dialog.getByRole('button', {name: 'Integrations', exact: true}).click();
  const rows = dialog.locator('.ai-integration-row');
  const helm = rows.filter({has: page.getByText('Helm', {exact: true})});
  await expect(helm.locator('.ai-integration-status')).toHaveCount(0);
  const argo = rows.filter({has: page.getByText('Argo CD', {exact: true})});
  await expect(argo.locator('.ai-integration-status')).toHaveText('Detected');
  await argo.getByRole('button', {name: 'Disabled', exact: true}).click();
  await expect(argo.locator('.ai-integration-status')).toHaveCount(0);
  await argo.getByRole('button', {name: 'Auto', exact: true}).click();
  await expect(argo.locator('.ai-integration-status')).toHaveText('Detected');
  await expect(dialog).not.toContainText('list_helm_releases');
  expect(errors).toEqual([]);
});

for (const [runtime, label, version] of [['codex', 'Codex', 'codex-cli'], ['claude', 'Claude Code', 'Claude Code']] as const) {
  test(`${label} settings and terminal lifecycle preserve the selected agent`, async ({page}) => {
    const errors = await setup(page); const agent = await openAgent(page);
    await agent.getByRole('button', {name:'AI settings',exact:true}).click();
    const dialog = page.getByRole('dialog', {name:'AI Agent settings',exact:true});
    await dialog.getByRole('combobox', {name:'AI agent',exact:true}).selectOption(runtime);
    await dialog.getByRole('button', {name:'Check installation',exact:true}).click();
    await expect(dialog.getByRole('status')).toContainText(version);
    await dialog.getByRole('textbox', {name:`${label} executable`,exact:true}).fill(`/opt/bin/${runtime}`);
    await dialog.getByRole('button', {name:`Save ${label} settings`,exact:true}).click();
    await expect.poll(()=>page.evaluate(key=>(window as any).__aiHarness.settings()[key]?.executable,runtime)).toBe(`/opt/bin/${runtime}`);
    await expect(page.getByTestId('opencode-pane')).toContainText(label);
    await expect(dialog.getByRole('button', {name:'Connections & models',exact:true})).toHaveCount(0);
    await dialog.getByRole('combobox', {name:'AI agent',exact:true}).selectOption('kubiki');
    await expect(page.getByTestId('opencode-pane')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}


test('chat follows streaming at the bottom and releases until the reader returns', async ({ page }) => {
  const errors = await setup(page);
  const agent = await openAgent(page);
  await page.evaluate(() => { (window as any).__aiHarness.hold = true; });
  const composer = agent.getByRole('textbox', { name: 'Message AI agent' });
  await composer.fill('Explain the cluster');
  await composer.press('Enter');
  const log = agent.getByRole('log', { name: 'AI conversation messages' });
  const latest = agent.getByRole('button', { name: 'Scroll to bottom' });
  const distance = () => log.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  const append = async (text: string) => {
    await page.evaluate(text => (window as any).__aiHarness.emit({ type: 'text_delta', text }), text);
    await expect(log).toContainText(text.trim());
  };
  await expect.poll(() => page.evaluate(() => typeof (window as any).__aiHarness.emit)).toBe('function');
  await append('\n\n' + 'Paragraph of a long streaming response.\n\n'.repeat(60));
  await expect.poll(distance).toBeLessThan(2);
  // A shorter viewport must keep the latest line visible even without new tokens.
  await page.setViewportSize({ width: 1440, height: 700 });
  await expect.poll(distance).toBeLessThan(2);
  await log.hover();
  await page.mouse.wheel(0, -450);
  await expect(latest).toBeVisible();
  const readingTop = await log.evaluate(el => el.scrollTop);
  await append('More streamed text.\n\n'.repeat(20));
  await expect(log).toContainText('More streamed text.');
  await expect.poll(() => log.evaluate(el => el.scrollTop)).toBeCloseTo(readingTop, 0);
  await page.getByRole('button', { name: 'Cluster Explorer', exact: true }).click();
  await page.evaluate(() => (window as any).__aiHarness.emit({ type: 'text_delta', text: 'Tokens while the tab is hidden.\n\n'.repeat(10) }));
  await page.getByRole('button', { name: 'AI Agent', exact: true }).click();
  await expect(log).toContainText('Tokens while the tab is hidden.');
  await expect.poll(() => log.evaluate(el => el.scrollTop)).toBeCloseTo(readingTop, 0);
  await latest.click();
  await expect.poll(distance).toBeLessThan(2);
  await append('Following again.\n\n'.repeat(10));
  await expect.poll(distance).toBeLessThan(2);
  // Returning with the wheel also reattaches, without a timer/cooldown.
  await log.hover();
  await page.mouse.wheel(0, -250);
  await expect(latest).toBeVisible();
  await page.mouse.wheel(0, 100000);
  await expect.poll(distance).toBeLessThan(2);
  await append('Following after manual return.\n\n'.repeat(10));
  await expect.poll(distance).toBeLessThan(2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(distance).toBeLessThan(2);
  await log.focus();
  await log.press('Home');
  await expect(latest).toBeVisible();
  await append('Tokens while reading with the keyboard.\n\n'.repeat(5));
  await expect.poll(() => log.evaluate(el => el.scrollTop)).toBe(0);
  await log.press('End');
  await expect.poll(distance).toBeLessThan(2);
  await append('Final mobile tokens.\n\n'.repeat(5));
  await expect.poll(distance).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test('streaming Markdown preserves code editor nodes and reading position', async ({ page }) => {
  const errors = await setup(page);
  const agent = await openAgent(page);
  await page.evaluate(() => { (window as any).__aiHarness.hold = true; });
  await agent.getByRole('textbox', { name: 'Message AI agent' }).fill('Explain this YAML');
  await agent.getByRole('button', { name: 'Send', exact: true }).click();
  const log = agent.getByRole('log', { name: 'AI conversation messages' });
  await expect.poll(() => page.evaluate(() => typeof (window as any).__aiHarness.emit)).toBe('function');
  await page.evaluate(() => (window as any).__aiHarness.emit({ type: 'text_delta', text: '\n\n```yaml\napiVersion: v1\nkind: Pod\nmetadata:\n  name: example\n```\n\n' + 'Long explanation.\n\n'.repeat(60) }));
  const editor = log.locator('.monaco-editor').first();
  await expect(editor).toBeVisible();
  await editor.evaluate(el => { (window as any).__streamingEditor = el; });
  await log.hover();
  await page.mouse.wheel(0, -400);
  await expect(agent.getByRole('button', { name: 'Scroll to bottom' })).toBeVisible();
  const top = await log.evaluate(el => el.scrollTop);
  await page.evaluate(() => (window as any).__aiHarness.emit({ type: 'text_delta', text: 'Next token.' }));
  await expect(log).toContainText('Next token.');
  expect(await editor.evaluate(el => el === (window as any).__streamingEditor)).toBe(true);
  await expect.poll(() => log.evaluate(el => el.scrollTop)).toBeCloseTo(top, 0);
  expect(errors).toEqual([]);
});
