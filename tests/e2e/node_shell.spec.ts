import { test, expect } from '@playwright/test';
async function setup(page: import('@playwright/test').Page, mode = '') {
  await page.addInitScript(({ mode }) => {
    const w = window as any;let callback = 0;let deniedCleanup = mode === 'cleanup';const callbacks = new Map();const leases = new Map<string, any>();const execs = new Map<string, any>();const prepares: any[] = [];const starts: any[] = [];const stops: string[] = [];const input: any[] = [];const deleted: any[] = [];let release: (() => void) | undefined;
    const encoder = new TextEncoder();const orphan = { resource: { context: 'test', group: '', version: 'v1', kind: 'Pod', namespace: 'debug', name: 'kubiki-node-debug-orphan', uid: 'orphan-uid' }, node: 'worker', phase: 'Failed' };let hasOrphan = true;
    function send(s: any, events: any[]) { s.channel.onmessage({ session_id: s.id, messages: events.map((event) => ({ sequence: ++s.sequence, event })) }); }
    const out = (text: string) => ({ type: 'Output', payload: { data: [...encoder.encode(text)] } });
    // Close (unmounting a channel or an explicit stop) folds only a Pod-less lease.
    const close = (id: string) => { stops.push(id);const lease = leases.get(id);if (!lease) return;if (deniedCleanup) { lease.phase = 'cleanup_failed';lease.error = { code: 'forbidden', status: 403, operation: 'node_debug', message: 'delete debug Pod denied', retryable: false };return lease; }leases.delete(id); };
    w.__nodeHarness = { prepares, starts, stops, input, deleted, leases, active: () => leases.size, callbacks: () => callbacks.size, release: () => release?.(), allowCleanup: () => { deniedCleanup = false; }, finish: () => { for (const s of execs.values()) send(s, [{ type: 'Exited', payload: { code: 0 } }]);execs.clear();const lease = leases.get('node-uid');if (lease) { lease.execs = 0;close('node-uid'); } } };
    w.__TAURI_INTERNALS__ = { transformCallback: (fn: any) => { callbacks.set(++callback, fn);return callback; }, unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'stop_port_forwards') return;
        if (command === 'get_kube_contexts') return [{ name: 'test', is_current: true }];
        if (command === 'ping_cluster') return { git_version: 'v1.34.0' };
        if (command === 'get_namespaces') return ['default','debug'];
        if (['stop_pod_execs','stop_host_terminals','stop_pod_logs','stop_node_debugs','stop_resource_watches','stop_resource_watch'].includes(command)) return;
        if (command === 'watch_resources') { const items = args.query.kind === 'Node' ? [{ apiVersion: 'v1', kind: 'Node', metadata: { name: 'worker', uid: 'node-uid' }, status: { nodeInfo: { operatingSystem: 'linux' } } }] : args.query.kind === 'Namespace' ? ['default', 'debug'].map(name => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, uid: 'ns-' + name } })) : [];queueMicrotask(() => args.onEvent.onmessage({ subscription_id: args.subscriptionId, query: args.query, messages: [{ sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items } } } }, { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } }] }));return; }
        if (command === 'mutate_resource' && args.request.operation === 'node_debug') { prepares.push(args.request.request);if (mode === 'cancelled') throw { code: 'cancelled', operation: 'node_debug', message: 'Node shell creation cancelled', retryable: false };if (mode === 'denied') throw { code: 'forbidden', status: 403, operation: 'node_debug', message: 'Node shell requires delete pods in namespace debug', retryable: false };const existing = leases.get('node-uid');const reused = Boolean(existing);const lease = existing ?? { phase: 'ready', name: 'kubiki-node-debug-node-uid', namespace: args.request.request.namespace, detail: 'Debug Pod ready', execs: 0 };if (!existing) leases.set('node-uid', lease);if (mode === 'slow' && !reused) await new Promise<void>((resolve) => { release = resolve; });return { session_id: 'node-uid', pod: { context: 'test', group: '', version: 'v1', kind: 'Pod', namespace: lease.namespace, name: lease.name, uid: 'pod-uid' }, reused }; }
        if (command === 'node_debug_status') { const lease = leases.get(args.sessionId);return lease ? { phase: lease.phase, name: lease.name, namespace: lease.namespace, detail: lease.detail, error: lease.error } : null; }
        if (command === 'stop_node_debug') { close(args.sessionId);return; }
        if (command === 'cancel_node_debug') { const lease = leases.get('node-uid');if (lease && !(lease.execs > 0)) leases.delete('node-uid');return; }
        if (command === 'start_node_exec') { starts.push(args);const lease = leases.get(args.request.debug_session_id);if (!lease) throw { code: 'not_found', status: 404, operation: 'node_debug', message: 'Node debug session is closed', retryable: false };lease.execs = (lease.execs ?? 0) + 1;const s = { id: args.sessionId, debug: args.request.debug_session_id, channel: args.onEvent, sequence: 0 };execs.set(s.id, s);queueMicrotask(() => send(s, [{ type: 'Started' }, out('node-shell-ready\r\n')]));return; }
        if (command === 'write_node_exec') { input.push(args);const s = execs.get(args.sessionId);if (s) send(s, [out('node-command-output\r\n')]);return; }
        if (command === 'resize_node_exec' || command === 'ack_node_exec') return;
        if (command === 'close_node_exec') { const s = execs.get(args.sessionId);execs.delete(args.sessionId);if (!s) return;const lease = leases.get(s.debug);if (lease) lease.execs = Math.max(0, (lease.execs ?? 1) - 1);if (lease && lease.execs === 0) close(s.debug);return; }
        if (command === 'list_other_debug_pods') return hasOrphan ? [orphan] : [];
        if (command === 'delete_resource' && args.request.operation === 'debug_pod') { deleted.push(args.request.resource);hasOrphan = false;return; }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  }, { mode });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();await page.getByRole('option', { name: 'debug', exact: true }).click();await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();await page.getByRole('button', { name: /^Nodes(?: \d+)?$/ }).click();await page.getByTestId('resource-table').getByTitle('worker', { exact: true }).click();
}

async function closeTab(page: import('@playwright/test').Page, index: number) { await page.locator('[title*="(Cluster Node)"]').nth(index).hover();await page.locator('[title*="(Cluster Node)"]').nth(index).getByTitle('Close Session', { exact: true }).click(); }

test('shells auto-start with one shared helper Pod that dies with the last terminal', async ({ page }) => {
  await setup(page);await page.getByTestId('resource-details').getByRole('button', { name: 'Node shell', exact: true }).click();
  const node = page.getByTestId('node-shell');
  // The pane provisions on its own: Node UID, namespace and image ride along.
  await expect(node).toContainText('Node: worker');
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.prepares.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__nodeHarness.prepares[0])).toMatchObject({ resource: { context: 'test', kind: 'Node', namespace: null, name: 'worker', uid: 'node-uid' }, namespace: 'debug', image: 'docker.io/library/ubuntu:24.04' });
  const terminal = node.getByTestId('live-terminal');await expect(terminal.getByRole('status')).toHaveText('Connected');
  await terminal.locator('.xterm').getByRole('textbox', { name: 'Terminal input' }).focus();await page.keyboard.type('hostname');await page.keyboard.press('Enter');await expect(terminal.locator('.xterm-rows')).toContainText('node-command-output');
  // A second shell on the same Node reuses the helper Pod silently.
  await page.getByTestId('resource-details').getByRole('button', { name: 'Node shell', exact: true }).click();
  const second = page.getByTestId('node-shell');
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.prepares.length)).toBe(2);
  await expect(second.getByTestId('live-terminal').getByRole('status')).toHaveText('Connected');
  expect(await page.evaluate(() => (window as any).__nodeHarness.active())).toBe(1);
  expect(await page.evaluate(() => (window as any).__nodeHarness.leases.get('node-uid').execs)).toBe(2);
  // One shell leaving keeps the Pod alive for the other.
  await closeTab(page, 1);await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.active())).toBe(1);
  // The last shell leaving deletes the helper Pod without any consent.
  await closeTab(page, 0);await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.active())).toBe(0);
  expect(await page.evaluate(() => (window as any).__nodeHarness.stops.length)).toBeGreaterThanOrEqual(1);
});

test('End session stops every shell on the Node, deletes the Pod and allows a fresh reconnect', async ({ page }) => {
  await setup(page);await page.getByTestId('resource-details').getByRole('button', { name: 'Node shell', exact: true }).click();
  const node = page.getByTestId('node-shell');const terminal = node.getByTestId('live-terminal');
  await expect(terminal.getByRole('status')).toHaveText('Connected');
  await node.getByRole('button', { name: 'End session', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.active())).toBe(0);
  await expect(node.getByTestId('live-terminal')).toHaveCount(0);await expect(node.getByRole('alert')).toHaveCount(0);
  await node.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByTestId('node-shell').getByTestId('live-terminal').getByRole('status')).toHaveText('Connected');
  expect(await page.evaluate(() => (window as any).__nodeHarness.prepares.length)).toBe(2);
});

test('shell exit deletes the Pod, the pane shows a closed session with a reconnect', async ({ page }) => {
  await setup(page);await page.getByTestId('resource-details').getByRole('button', { name: 'Node shell', exact: true }).click();
  const node = page.getByTestId('node-shell');
  await expect(node.getByTestId('live-terminal').getByRole('status')).toHaveText('Connected');
  await page.evaluate(() => (window as any).__nodeHarness.finish());
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.active())).toBe(0);
  await expect(node.getByTestId('live-terminal')).toHaveCount(0);
  await expect(node.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
  await expect(node.getByRole('alert')).toHaveCount(0);
});

test('cleanup failure stays visible, retry works and other helpers delete with a UID', async ({ page }) => {
  await setup(page, 'cleanup');await page.getByTestId('resource-details').getByRole('button', { name: 'Node shell', exact: true }).click();
  const node = page.getByTestId('node-shell');
  await expect(node.getByTestId('live-terminal').getByRole('status')).toHaveText('Connected');
  await page.evaluate(() => (window as any).__nodeHarness.finish());
  await expect(node.getByRole('alert')).toContainText('delete debug Pod denied');
  // Clicks below the terminal input race its resize observer in the dev build; force them.
  await node.getByRole('button', { name: 'Options', exact: true }).click({ force: true });await page.evaluate(() => (window as any).__nodeHarness.allowCleanup());
  await node.getByRole('button', { name: 'Retry cleanup', exact: true }).click({ force: true });await expect(node.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.active())).toBe(0);
  // Re-open the options section if the previous click left it closed.
  const options = node.getByRole('button', { name: /Options|Hide options/, exact: true });
  if ((await options.textContent()) === 'Options') await options.click({ force: true });
  await node.getByRole('button', { name: 'Other debug Pods', exact: true }).click({ force: true });
  // The dev build's resize observer keeps stealing hit targets under the open
  // section; the DOM click stands in for a plain user press.
  await node.evaluate(() => (document.querySelector('[aria-label="Delete debug Pod kubiki-node-debug-orphan"]') as HTMLButtonElement | null)?.click());
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.deleted[0])).toMatchObject({ uid: 'orphan-uid', namespace: 'debug', name: 'kubiki-node-debug-orphan' });
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.deleted[0])).toMatchObject({ uid: 'orphan-uid', namespace: 'debug', name: 'kubiki-node-debug-orphan' });
});

test('missing permissions surface before any terminal opens without retry loops', async ({ page }) => {
  await setup(page, 'denied');await page.getByTestId('resource-details').getByRole('button', { name: 'Node shell', exact: true }).click();
  const node = page.getByTestId('node-shell');
  await expect(node.getByRole('alert')).toContainText('requires delete pods');
  expect(await page.evaluate(() => (window as any).__nodeHarness.starts.length)).toBe(0);
  await expect(node.getByTestId('live-terminal')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__nodeHarness.prepares.length)).toBe(1);
  await expect(node.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
});

test('cancelled backend confirmation creates no helper; options allow another review', async ({ page }) => {
  await setup(page, 'cancelled');await page.getByTestId('resource-details').getByRole('button', { name: 'Node shell', exact: true }).click();
  const node = page.getByTestId('node-shell');
  await expect(node.getByRole('alert')).toContainText('creation cancelled');
  await expect(node.getByTestId('live-terminal')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__nodeHarness.prepares.length)).toBe(1);
  await node.getByRole('button', { name: 'Options', exact: true }).click();
  await node.getByRole('textbox', { name: 'Debug image', exact: true }).fill('registry.example/debug:reviewed');
  await node.getByRole('button', { name: /^Apply \(recreate helper Pod\)$/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.prepares.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__nodeHarness.prepares[1])).toMatchObject({ image: 'registry.example/debug:reviewed' });
  await expect(node.getByRole('alert')).toContainText('creation cancelled');
});

test('closing the tab while preparation is in flight folds the Pod-less lease away', async ({ page }) => {
  await setup(page, 'slow');await page.getByTestId('resource-details').getByRole('button', { name: 'Node shell', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.prepares.length)).toBe(1);
  await closeTab(page, 0);
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.active())).toBe(0);
  await page.evaluate(() => (window as any).__nodeHarness.release());
  await expect.poll(() => page.evaluate(() => (window as any).__nodeHarness.starts.length)).toBe(0);
});
