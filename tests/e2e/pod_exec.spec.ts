import { test, expect, type Page } from '@playwright/test';
const name = 'pod-with-init-container-and-a-long-name-for-responsive-toolbar';
async function setup(page: Page, denied = false) {
  await page.addInitScript(({ name, denied }) => {
    const w = window as any; const encoder = new TextEncoder(); const callbacks = new Map(); let callbackId = 0;
    const active = new Map<string, any>(); const closed: any[] = []; const starts: any[] = []; const input: string[] = []; const sizes: any[] = []; const acknowledgements: any[] = []; const logContainers: string[] = [];
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'pod-uid', name, namespace: 'backend' }, spec: { containers: [{ name: 'app', image: 'app' }, { name: 'proxy', image: 'proxy' }], initContainers: [{ name: 'setup', image: 'setup' }, { name: 'shipper', image: 'shipper', restartPolicy: 'Always' }], ephemeralContainers: [{ name: 'debug', image: 'debug' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }, { name: 'proxy', ready: false, restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } } }], initContainerStatuses: [{ name: 'setup', state: { terminated: { exitCode: 0, reason: 'Completed' } } }, { name: 'shipper', ready: true, state: { running: {} } }], ephemeralContainerStatuses: [{ name: 'debug', state: { running: {} } }] } };
    const logSessions = new Map<string, any>(); const oldLogs: any[] = []; const logRequests: any[] = []; const logAcks: any[] = [];
    function send(s: any, events: any[]) { s.channel.onmessage({ session_id: s.id, messages: events.map((event) => ({ sequence: ++s.sequence, event })) }); }
    const out = (data: string) => ({ type: 'Output', payload: { data: [...encoder.encode(data)] } });
    w.__execHarness = { starts, input, sizes, acknowledgements, logContainers, logRequests, logAcks,
      logsActive: () => logSessions.size,
      logs: (text: string) => { for (const s of logSessions.values()) send(s, [out(text)]); },
      logsUtf8: () => { for (const s of logSessions.values()) { const bytes = [...encoder.encode('2026-10-20T08:00:00Z привет 🌍\n')]; send(s, [{ type: 'Output', payload: { data: bytes.slice(0,23) } }, { type: 'Output', payload: { data: bytes.slice(23) } }]); } },
      logsFail: () => { for (const s of logSessions.values()) send(s, [{ type: 'Failed', payload: { error: { code: 'forbidden', status: 403, message: 'pods/log denied', operation: 'logs', retryable: false } } }]); },
      logsFinish: () => { for (const s of logSessions.values()) send(s, [{ type: 'Completed' }]); },
      logsLate: () => { for (const s of oldLogs) send(s, [out('STALE LOG OUTPUT\n')]); }, active: () => active.size, callbacks: () => callbacks.size,
      exit: (code: number) => { for (const s of active.values()) send(s, [out('last output\r\n'), { type: 'Exited', payload: { code } }]); },
      late: () => { for (const s of closed) send(s, [out('STALE OUTPUT')]); },
      utf8: () => { for (const s of active.values()) { const bytes = [...encoder.encode('привет 🌍\r\n')]; send(s, [{ type: 'Output', payload: { data: bytes.slice(0,3) } }, { type: 'Output', payload: { data: bytes.slice(3) } }]); } },
    };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: unknown) => { callbacks.set(++callbackId, callback); return callbackId; }, unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'stop_port_forwards') return;
        if (command === 'stop_host_terminals' || command === 'stop_node_debugs') return;
        if (command === 'get_kube_contexts') return [{ name: 'test', is_current: true }];
        if (command === 'ping_cluster') return { git_version: 'v1.34.0' };
        if (command === 'get_namespaces') return ['backend'];
        if (command === 'stop_resource_watches' || command === 'stop_resource_watch') return;
        if (command === 'watch_resources') { queueMicrotask(() => args.onEvent.onmessage({ subscription_id: args.subscriptionId, query: args.query, messages: [{ sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items: args.query.kind === 'Pod' ? [pod] : [] } } } }, { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } }] })); return; }
        if (command === 'stop_pod_logs') { logSessions.clear(); return; }
        if (command === 'start_pod_logs') {
          const s = { id: args.sessionId, channel: args.onEvent, sequence: 0 }; logSessions.set(s.id, s); logRequests.push(args.request); logContainers.push(args.request.container);
          queueMicrotask(() => send(s, [{ type: 'Started' }, out(`2026-10-20T00:00:00Z ${args.request.container} log output\n`), ...(args.request.previous ? [{ type: 'Completed' }] : [])])); return;
        }
        if (command === 'ack_pod_logs') { logAcks.push(args); return; }
        if (command === 'close_pod_logs') { const s = logSessions.get(args.sessionId); if (s) oldLogs.push(s); logSessions.delete(args.sessionId); return; }
        if (command === 'get_pod_logs') { logContainers.push(args.container); return `2026-10-20T00:00:00Z ${args.container} log output\n`; }
        if (command === 'stop_pod_execs') { active.clear(); return; }
        if (command === 'start_pod_exec') {
          starts.push(args.request); const s = { id: args.sessionId, channel: args.onEvent, sequence: 0 }; active.set(s.id, s);
          queueMicrotask(() => send(s, denied ? [{ type: 'Failed', payload: { error: { code: 'forbidden', status: 403, retryable: false, message: 'pods/exec is forbidden', operation: 'exec' } } }] : [{ type: 'Started' }, out(`${args.request.container}$ `)])); return;
        }
        if (command === 'write_pod_exec') { input.push(args.data); const s = active.get(args.sessionId); if (s) send(s, [out(args.data.includes('\r') ? '\r\nremote-command-output\r\n' : args.data)]); return; }
        if (command === 'resize_pod_exec') { sizes.push(args); return; }
        if (command === 'ack_pod_exec') { acknowledgements.push(args); return; }
        if (command === 'close_pod_exec') { const s = active.get(args.sessionId); if (s) closed.push(s); active.delete(args.sessionId); return; }
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  }, { name, denied });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText(name, { exact: true }).click();
}

test('Pod shell carries real adapter input, resize, UTF-8 and exit; container switch closes the old connection', async ({ page }) => {
  await setup(page); await page.getByTestId('resource-details').getByRole('button', { name: 'Shell', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Open shell for app', exact: true }).click();
  const pane = page.getByTestId('live-terminal'); const terminal = pane.locator('.xterm');
  await expect(pane.getByRole('status')).toHaveText('Connected');
  expect(await page.evaluate(() => (window as any).__execHarness.starts[0])).toMatchObject({ resource: { context: 'test', namespace: 'backend', name, uid: 'pod-uid' }, container: 'app', shell: '/bin/sh' });
  await terminal.getByRole('textbox', { name: 'Terminal input' }).focus(); await page.keyboard.type('echo test'); await page.keyboard.press('Enter'); await page.keyboard.press('Control+c'); await page.keyboard.press('Control+w');
  await expect(terminal.locator('.xterm-rows')).toContainText('remote-command-output');
  expect((await page.evaluate(() => (window as any).__execHarness.input.join('')))).toContain('\u0003');
  expect((await page.evaluate(() => (window as any).__execHarness.input.join('')))).toContain('\u0017');
  await page.evaluate(() => (window as any).__execHarness.utf8()); await expect(terminal.locator('.xterm-rows')).toContainText('привет 🌍');
  await page.getByTestId('resource-details').getByRole('button', { name: 'Close details', exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.sizes.length)).toBeGreaterThan(0);
  await pane.getByRole('button', { name: 'Select Container' }).click();
  await expect(page.getByRole('option', { name: /setup/ })).toBeDisabled(); await expect(page.getByRole('option', { name: /proxy/ })).toBeDisabled();
  await page.getByRole('option', { name: /shipper/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.starts.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__execHarness.starts[1].container)).toBe('shipper');
  expect(await page.evaluate(() => (window as any).__execHarness.active())).toBe(1);
  await page.evaluate(() => (window as any).__execHarness.late()); await expect(terminal.locator('.xterm-rows')).not.toContainText('STALE OUTPUT');
  await page.evaluate(() => (window as any).__execHarness.exit(7)); await expect(pane.getByRole('status')).toHaveText('Exited (7)');
  await expect(terminal.locator('.xterm-rows')).toContainText('last output'); await expect(terminal.locator('.xterm-rows')).toContainText('Process exited with code 7');
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.active())).toBe(0);
  await pane.getByRole('button', { name: 'Reconnect shell' }).click(); await expect(pane.getByRole('status')).toHaveText('Connected');
  await pane.getByRole('button', { name: 'Disconnect shell' }).click(); await expect(pane.getByRole('status')).toHaveText('Disconnected');
  expect(await page.evaluate(() => (window as any).__execHarness.active())).toBe(0);
});

test('container indicators and responsive logs toolbar include init/sidecar/ephemeral; switching preserves filters', async ({ page }) => {
  await setup(page);
  const row = page.getByTestId('resource-table').locator('tbody tr').filter({ hasText: name }); await expect(row.locator('[data-container-status]')).toHaveCount(5); await expect(row.locator('button')).toHaveCount(0);
  const details = page.getByTestId('resource-details'); await expect(details.getByRole('button', { name: 'Shell for setup', exact: true })).toBeDisabled();
  await details.getByRole('button', { name: 'Logs for setup', exact: true }).click();
  await expect(page.getByText('setup log output', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Close details', exact: true }).click();
  const toolbar = page.getByTestId('logs-toolbar'); const search = toolbar.getByPlaceholder('Filter log lines…'); await search.fill('log output');
  await toolbar.getByRole('button', { name: 'Select Container' }).click();
  await expect(page.getByRole('option', { name: /setup/ })).toContainText('Init'); await expect(page.getByRole('option', { name: /shipper/ })).toContainText('Sidecar'); await expect(page.getByRole('option', { name: /debug/ })).toContainText('Ephemeral');
  await page.getByRole('option', { name: /shipper/ }).click();
  await expect(page.getByText('shipper log output', { exact: true })).toBeVisible(); await expect(search).toHaveValue('log output');
  for (const width of [1440, 900]) { await page.setViewportSize({ width, height: 800 }); await expect.poll(() => toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true); }
  await toolbar.getByRole('button', { name: 'Select Container' }).click(); await page.getByRole('option', { name: /debug/ }).click();
  await expect(page.getByText('debug log output', { exact: true })).toBeVisible();
  expect((await toolbar.boundingBox())!.height).toBeLessThan(125);
  await toolbar.getByRole('button', { name: 'Log options', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: /Timestamps/ }).or(toolbar.getByRole('button', { name: 'Timestamps', exact: true }))).toBeVisible(); await page.keyboard.press('Escape');
  await page.screenshot({ path: 'test-results/containers-and-logs.png' });
});

test('exec 403 is actionable and closing the UI releases backend sessions and callbacks', async ({ page }) => {
  await setup(page, true); await page.getByTestId('resource-details').getByRole('button', { name: 'Shell', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Open shell for app', exact: true }).click();
  const pane = page.getByTestId('live-terminal'); await expect(pane.getByRole('alert')).toContainText('pods/exec is forbidden'); await expect(pane.getByRole('status')).toHaveText('Failed');
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.active())).toBe(0);
  await page.keyboard.press('Control+j'); await page.keyboard.press('Control+j'); expect(await page.evaluate(() => (window as any).__execHarness.starts.length)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await expect.poll(() => page.evaluate(() => (window as any).__execHarness.callbacks())).toBe(0);
});

test('full editor tabs keep their terminal session and container selection across navigation', async ({ page }) => {
  await setup(page);
  await page.getByTestId('resource-table').getByText(name, { exact: true }).click({ button: 'right' });
  await page.getByText('Terminal in Full Tab', { exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Open shell for app', exact: true }).click();
  const pane = page.locator('main').getByTestId('live-terminal'); await expect(pane.getByRole('status')).toHaveText('Connected');
  await pane.locator('.xterm').getByRole('textbox', { name: 'Terminal input' }).focus(); await page.keyboard.type('echo persist'); await page.keyboard.press('Enter');
  await expect(pane.locator('.xterm-rows')).toContainText('remote-command-output');
  await page.getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await expect(pane).not.toBeVisible(); expect(await page.evaluate(() => (window as any).__execHarness.active())).toBe(1);
  await page.getByText(`Terminal: ${name}`, { exact: true }).first().click();
  await expect(pane.locator('.xterm-rows')).toContainText('remote-command-output'); expect(await page.evaluate(() => (window as any).__execHarness.starts.length)).toBe(1);
  await page.getByRole('button', { name: 'Split Editor', exact: true }).click();
  await page.getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await expect(pane.getByRole('status')).toHaveText('Connected'); expect(await page.evaluate(() => (window as any).__execHarness.starts.length)).toBe(1);
  await page.getByRole('button', { name: 'Split Editor', exact: true }).click();
  await page.getByText(`Terminal: ${name}`, { exact: true }).first().click();
  await pane.getByRole('button', { name: 'Select Container' }).click(); await page.getByRole('option', { name: /debug/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.starts.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__execHarness.starts[1].container)).toBe('debug');
  await page.getByRole('button', { name: 'Close tab', exact: true }).last().click(); await expect.poll(() => page.evaluate(() => (window as any).__execHarness.active())).toBe(0);
  await page.getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText(name, { exact: true }).click({ button: 'right' }); await page.getByText('Stream Logs in Full Tab', { exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Open logs for app', exact: true }).click();
  const toolbar = page.locator('main').getByTestId('logs-toolbar'); await toolbar.getByRole('button', { name: 'Select Container' }).click(); await page.getByRole('option', { name: /setup/ }).click();
  await expect(page.locator('main').getByText('setup log output', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand bottom panel' })).toBeVisible();
});

test('live logs handle UTF-8, source options, stopped sessions, reconnect, errors and page cleanup', async ({ page }) => {
  await setup(page);await page.getByTestId('resource-details').getByRole('button', { name: 'Logs', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Open logs for app', exact: true }).click();
  const toolbar = page.getByTestId('logs-toolbar');
  await expect(page.getByText('app log output', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__execHarness.logRequests[0])).toMatchObject({ resource: { context: 'test', uid: 'pod-uid', namespace: 'backend', name }, container: 'app', follow: true, previous: false, tail_lines: 500 });
  await page.evaluate(() => (window as any).__execHarness.logsUtf8());await expect(page.getByText('привет 🌍', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.logAcks.length)).toBeGreaterThan(0);
  await toolbar.getByRole('button', { name: 'Pause', exact: true }).click();await expect.poll(() => page.evaluate(() => (window as any).__execHarness.logsActive())).toBe(0);
  await page.evaluate(() => (window as any).__execHarness.logsLate());await expect(page.getByText('STALE LOG OUTPUT', { exact: true })).toHaveCount(0);
  await toolbar.getByRole('button', { name: 'Pause', exact: true }).click();await expect.poll(() => page.evaluate(() => (window as any).__execHarness.logsActive())).toBe(1);
  await toolbar.getByRole('button', { name: 'Log options', exact: true }).click();
  await page.getByRole('combobox', { name: 'Initial log tail', exact: true }).selectOption('100');
  await page.getByRole('combobox', { name: 'Log time range', exact: true }).selectOption('300');
  await page.getByRole('checkbox', { name: 'Previous container instance', exact: true }).check();
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.logRequests.at(-1))).toMatchObject({ previous: true, follow: false, tail_lines: 100, since_seconds: 300 });
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.logsActive())).toBe(0);
  await page.getByRole('checkbox', { name: 'Previous container instance', exact: true }).uncheck();
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.logsActive())).toBe(1);
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).__execHarness.logsFail());await expect(page.getByRole('alert')).toContainText('pods/log denied');
  await expect(page.getByText('app log output', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.logsActive())).toBe(0);
  await toolbar.getByRole('button', { name: 'Log options', exact: true }).click();await page.getByRole('button', { name: 'Reconnect logs', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.logsActive())).toBe(1);
  await page.setViewportSize({ width: 900, height: 900 });
  await page.screenshot({ path: 'test-results/live-logs-options.png' });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.logsActive())).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as any).__execHarness.callbacks())).toBe(0);
});


test('multi-container launches wait for an explicit choice; Cancel creates no terminal or log transport', async ({ page }) => {
  await setup(page);
  const details = page.getByTestId('resource-details');
  await details.getByRole('button', { name: 'Shell', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose container · Shell' });
  await expect(dialog.getByRole('button', { name: 'Open shell for setup', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Open shell for proxy', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__execHarness.starts.length)).toBe(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__execHarness.starts.length)).toBe(0);
  await details.getByRole('button', { name: 'Logs', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__execHarness.logRequests.length)).toBe(0);
  await page.keyboard.press('Escape');
  await details.getByRole('button', { name: 'Shell', exact: true }).click();
  await dialog.getByRole('button', { name: 'Open shell for shipper', exact: true }).click();
  await expect(page.getByTestId('live-terminal').getByRole('status')).toHaveText('Connected');
  expect(await page.evaluate(() => (window as any).__execHarness.starts.map((request: any) => request.container))).toEqual(['shipper']);
});
