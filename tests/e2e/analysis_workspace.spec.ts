import { test, expect, type Page } from '@playwright/test';

async function pods(page: Page) {
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
}

test('split view has a keyboard-accessible close button and keeps both tabs', async ({ page }) => {
  await page.goto('/?demo=1'); await pods(page);
  await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Split Editor', exact: true }).click();
  await expect(page.getByTestId('workspace-tab-panel')).toHaveCount(2);
  const close = page.getByRole('button', { name: 'Close split view', exact: true });
  await close.focus(); await close.press('Enter');
  await expect(page.getByTestId('workspace-tab-panel')).toHaveCount(1);
  await expect(page.getByRole('tablist', { name: 'Workspace tabs' }).getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: /^Overview/ })).toBeFocused();
});

test('local console stays in the bottom panel by default and can open another session in a workspace tab', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: 'Expand bottom panel', exact: true }).click();
  await page.getByRole('button', { name: /Open Local Terminal \(Host PC\)/ }).click();
  const tabs = page.getByRole('tablist', { name: 'Workspace tabs' });
  await expect(tabs.getByRole('tab', { name: /Terminal: Local Shell/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open terminal in tab', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open terminal in tab', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: /Terminal: Local Shell/ })).toHaveCount(1);
  await expect(page.getByTestId('workspace-tab-panel').locator('.xterm')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand bottom panel', exact: true })).toContainText('1 open tabs');
});

test('agent preference persists and Analyze passes a restricted diagnostic message into a new tab', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'AI assistant' }).click();
  await dialog.getByLabel('Analysis agent').selectOption('opencode');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload(); await pods(page);
  await page.getByTestId('resource-table').getByText('payment-worker-67f98b984-pv4n8', { exact: true }).click();
  const problems = page.getByTestId('problems-banner');
  await expect(problems).toContainText('OpenCode · analysis only');
  await problems.getByRole('button', { name: 'Analyze', exact: true }).click();
  const panel = page.getByTestId('workspace-tab-panel');
  await expect(panel).toContainText('OpenCode · Analysis only');
  await panel.getByText('Initial message', { exact: true }).click();
  await expect(panel.locator('pre')).toContainText('ANALYSIS ONLY');
  await expect(panel.locator('pre')).toContainText('Do not execute commands');
  await expect(panel.locator('pre')).toContainText('payment-worker-67f98b984-pv4n8');
  const saved = await page.evaluate(() => localStorage.getItem('kubiki.workspace.v3'));
  expect(saved).not.toContain('BEGIN UNTRUSTED');
  await page.screenshot({ path: 'test-results/analysis-message.png' });
  await page.getByRole('button', { name: 'Toggle Explorer', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('desktop analysis uses dedicated agent IPC and closes its process on tab close', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any; let callback = 0;
    w.__analysisCalls = [];
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'stuck', namespace: 'default', uid: 'stuck-uid' }, spec: { containers: [{ name: 'web', image: 'web:1' }] }, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient memory' }] } };
    w.__TAURI_INTERNALS__ = { transformCallback: () => ++callback, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      w.__analysisCalls.push({ command, args });
      if (command === 'get_kube_contexts') return [{ name: 'prod', is_current: true }];
      if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
      if (command === 'get_namespaces') return ['default'];
      if (command === 'get_api_resources') return 'pods po v1 true Pod list,watch';
      if (command === 'get_resources') return { items: args.kind === 'Pod' ? [pod] : [] };
      if (command === 'watch_resources') {
        queueMicrotask(() => args.onEvent.onmessage({ subscription_id: args.subscriptionId, query: args.query, messages: [{ sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items: args.query.kind === 'Pod' ? [pod] : [] } } } }, { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } }] })); return;
      }
      if (command === 'get_host_terminal_info') return { shells: ['/bin/sh'], default_shell: '/bin/sh', cwd: '/tmp' };
      if (command === 'start_ai_analysis') { queueMicrotask(() => args.onEvent.onmessage({ session_id: args.sessionId, messages: [{ sequence: 1, event: { type: 'Started' } }] })); return; }
      if (/^(stop_|close_|ack_|resize_|write_)/.test(command) || command.startsWith('plugin:')) return;
      throw new Error(`Unexpected IPC: ${command}`);
    } };
  });
  await page.goto('/'); await pods(page);
  await page.getByTestId('resource-table').getByText('stuck', { exact: true }).click();
  await page.getByTestId('problems-banner').getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByTestId('live-terminal').getByRole('status')).toHaveText('Connected');
  const request = await page.evaluate(() => (window as any).__analysisCalls.find((entry: any) => entry.command === 'start_ai_analysis').args.request);
  expect(request.agent).toBe('codex'); expect(request.prompt).toContain('Insufficient memory'); expect(request.prompt).toContain('or run experiments');
  expect(await page.evaluate(() => (window as any).__analysisCalls.some((entry: any) => entry.command === 'start_host_terminal'))).toBe(false);
  await page.getByRole('tab', { name: /^Analyze: stuck/ }).getByRole('button', { name: 'Close tab', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__analysisCalls.filter((entry: any) => entry.command === 'close_host_terminal').length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__analysisCalls.some((entry: any) => entry.command === 'mutate_resource'))).toBe(false);
});
