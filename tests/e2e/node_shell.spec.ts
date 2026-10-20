import { test, expect } from '@playwright/test';
async function setup(page: import('@playwright/test').Page, mode = '') {
  await page.addInitScript(({ mode }) => {
    const w = window as any;let callback = 0;let deniedCleanup = mode === 'cleanup';const callbacks = new Map();const leases = new Map<string, any>();const execs = new Map<string, any>();const prepares: any[] = [];const starts: any[] = [];const stops: string[] = [];const input: any[] = [];const deleted: any[] = [];let release: (() => void) | undefined;
    const encoder = new TextEncoder();const orphan = { resource: { context: 'test', group: '', version: 'v1', kind: 'Pod', namespace: 'debug', name: 'kubiki-node-debug-orphan', uid: 'orphan-uid' }, node: 'worker', phase: 'Failed' };let hasOrphan = true;
    function send(s: any, events: any[]) { s.channel.onmessage({ session_id: s.id, messages: events.map((event) => ({ sequence: ++s.sequence, event })) }); }
    const out = (text: string) => ({ type: 'Output', payload: { data: [...encoder.encode(text)] } });
    const close = (id: string) => { stops.push(id);const lease = leases.get(id);if (!lease) return;if (deniedCleanup) { lease.phase = 'cleanup_failed';lease.error = { code: 'forbidden', status: 403, operation: 'node_debug', message: 'delete debug Pod denied', retryable: false };throw lease.error; }leases.delete(id); };
    w.__nodeHarness = { prepares, starts, stops, input, deleted, active: () => leases.size, callbacks: () => callbacks.size, release: () => release?.(), allowCleanup: () => { deniedCleanup = false; }, finish: () => { for (const s of execs.values()) send(s, [{ type: 'Exited', payload: { code: 0 } }]); } };
    w.__TAURI_INTERNALS__ = { transformCallback: (fn: any) => { callbacks.set(++callback, fn);return callback; }, unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'stop_port_forwards') return;
        if (command === 'get_kube_contexts') return [{ name: 'test', is_current: true }];
        if (command === 'ping_cluster') return { git_version: 'v1.34.0' };
        if (command === 'get_namespaces') return ['default','debug'];
        if (['stop_pod_execs','stop_host_terminals','stop_pod_logs','stop_node_debugs','stop_resource_watches','stop_resource_watch'].includes(command)) return;
        if (command === 'watch_resources') { const items = args.query.kind === 'Node' ? [{ apiVersion: 'v1', kind: 'Node', metadata: { name: 'worker', uid: 'node-uid' }, status: { nodeInfo: { operatingSystem: 'linux' } } }] : [];queueMicrotask(() => args.onEvent.onmessage({ subscription_id: args.subscriptionId, query: args.query, messages: [{ sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items } } } }, { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } }] }));return; }
        if (command === 'prepare_node_debug') { prepares.push(args);if (mode === 'denied') throw { code: 'forbidden', status: 403, operation: 'node_debug', message: 'Node shell requires delete pods in namespace debug', retryable: false };const resource = { context: 'test', group: '', version: 'v1', kind: 'Pod', namespace: args.request.namespace, name: `kubiki-node-debug-${args.sessionId}`, uid: `pod-${args.sessionId}` };leases.set(args.sessionId, { phase: 'ready', name: resource.name, namespace: resource.namespace, detail: 'Debug Pod ready' });if (mode === 'slow') await new Promise<void>((resolve) => { release = resolve; });return resource; }
        if (command === 'node_debug_status') return leases.get(args.sessionId) ?? null;
        if (command === 'stop_node_debug') { close(args.sessionId);return; }
        if (command === 'start_node_exec') { starts.push(args);const s = { id: args.sessionId, debug: args.request.debug_session_id, channel: args.onEvent, sequence: 0 };execs.set(s.id, s);queueMicrotask(() => send(s, [{ type: 'Started' }, out('node-shell-ready\r\n')]));return; }
        if (command === 'write_node_exec') { input.push(args);const s = execs.get(args.sessionId);if (s) send(s, [out('node-command-output\r\n')]);return; }
        if (command === 'resize_node_exec' || command === 'ack_node_exec') return;
        if (command === 'close_node_exec') { execs.delete(args.sessionId);close(args.debugSessionId);return; }
        if (command === 'list_other_debug_pods') return hasOrphan ? [orphan] : [];
        if (command === 'remove_other_debug_pod') { deleted.push(args.resource);hasOrphan = false;return; }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  }, { mode });
  await page.goto('/');await page.getByRole('button', { name: /^Nodes(?: \d+)?$/ }).click();await page.getByTestId('resource-table').getByTitle('worker', { exact: true }).click();await page.getByTestId('resource-details').getByRole('button', { name: 'Node shell', exact: true }).click();
  await page.getByTestId('node-shell').getByRole('textbox', { name: 'Debug Pod namespace', exact: true }).fill('debug');
}
test('Node shell prepares only on Start, passes UID/scope, carries terminal input and deletes helper on exit', async ({ page }) => {
  await setup(page);const node = page.getByTestId('node-shell');expect(await page.evaluate(() => (window as any).__nodeHarness.prepares.length)).toBe(0);
  await node.getByRole('button', { name: 'Start node shell', exact: true }).click();const terminal = node.getByTestId('live-terminal');await expect(terminal.getByRole('status')).toHaveText('Connected');
  expect(await page.evaluate(() => (window as any).__nodeHarness.prepares[0].request)).toMatchObject({ resource: { context: 'test', kind: 'Node', namespace: null, name: 'worker', uid: 'node-uid' }, namespace: 'debug', image: 'docker.io/library/ubuntu:24.04' });
  await terminal.locator('.xterm').getByRole('textbox', { name: 'Terminal input' }).focus();await page.keyboard.type('hostname');await page.keyboard.press('Enter');await expect(terminal.locator('.xterm-rows')).toContainText('node-command-output');
  await page.keyboard.press('Control+j');await page.keyboard.press('Control+j');expect(await page.evaluate(() => (window as any).__nodeHarness.prepares.length)).toBe(1);
  await page.evaluate(() => (window as any).__nodeHarness.finish());await expect(terminal.getByRole('status')).toHaveText('Exited (0)');await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.active())).toBe(0);
  await terminal.getByRole('button', { name: 'Reconnect shell', exact: true }).click();await expect(node.getByTestId('live-terminal').getByRole('status')).toHaveText('Connected');expect(await page.evaluate(() => (window as any).__nodeHarness.prepares.length)).toBe(2);
  await page.setViewportSize({ width: 900, height: 900 });await page.screenshot({ path: 'test-results/node-shell.png' });
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.active())).toBe(0);await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.callbacks())).toBe(0);
});
test('Node cleanup failure stays visible, retry works and other helpers delete with a UID', async ({ page }) => {
  await setup(page, 'cleanup');const node = page.getByTestId('node-shell');await node.getByRole('button', { name: 'Start node shell', exact: true }).click();await expect(node.getByTestId('live-terminal').getByRole('status')).toHaveText('Connected');
  await page.evaluate(() => (window as any).__nodeHarness.finish());await expect(node.getByRole('alert')).toContainText('delete debug Pod denied');await page.evaluate(() => (window as any).__nodeHarness.allowCleanup());await node.getByRole('button', { name: 'Retry cleanup', exact: true }).click();await expect(node.getByRole('alert')).toHaveCount(0);
  await node.getByRole('button', { name: 'Other debug Pods', exact: true }).click();await node.getByRole('button', { name: 'Delete debug Pod kubiki-node-debug-orphan', exact: true }).click();expect(await page.evaluate(() => (window as any).__nodeHarness.deleted[0])).toMatchObject({ uid: 'orphan-uid', namespace: 'debug', name: 'kubiki-node-debug-orphan' });
});
test('Node shell surfaces missing permissions before opening a terminal', async ({ page }) => {
  await setup(page, 'denied');let node = page.getByTestId('node-shell');await node.getByRole('button', { name: 'Start node shell', exact: true }).click();await expect(node.getByRole('alert')).toContainText('requires delete pods');expect(await page.evaluate(() => (window as any).__nodeHarness.starts.length)).toBe(0);
});
test('cancelling Node preparation never opens a terminal when readiness arrives late', async ({ page }) => {
  await setup(page, 'slow');const node = page.getByTestId('node-shell');await node.getByRole('button', { name: 'Start node shell', exact: true }).click();await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.prepares.length)).toBe(1);await node.getByRole('button', { name: 'Cancel preparation', exact: true }).click();await page.evaluate(() => (window as any).__nodeHarness.release());
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.active())).toBe(0);await expect(node.getByTestId('live-terminal')).toHaveCount(0);await expect(node.getByRole('alert')).toHaveCount(0);expect(await page.evaluate(() => (window as any).__nodeHarness.starts.length)).toBe(0);
});
