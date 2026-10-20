import { test, expect, type Page } from '@playwright/test';

// Exercises the desktop adapter with the real JS Channel SDK. Rust HTTP runtime is tested separately.
async function nativeApi(page: Page, holdPod = false) {
  await page.addInitScript((holdPod: boolean) => {
    const w = window as any;
    const callbacks = new Map<number, unknown>(); let callbackId = 0;
    const subscriptions = new Map<string, any>(); const old: any[] = [];
    const stats = { starts: 0, stops: 0, snapshots: 0 };
    const pod = (phase = 'Running') => ({ apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'pod', name: 'live-web', namespace: 'backend' }, spec: { containers: [{ name: 'app', image: 'nginx' }] }, status: { phase } });
    const emit = (subscription: any, events: any[]) => subscription.channel.onmessage({ subscription_id: subscription.id, query: subscription.query, messages: events.map((event) => ({ sequence: ++subscription.sequence, event })) });
    w.__watchHarness = {
      stats, pod,
      update: (phase: string) => { for (const s of subscriptions.values()) if (s.query.kind === 'Pod') emit(s, [{ type: 'Delta', payload: { type: 'Applied', payload: { data: pod(phase) } } }]); },
      reconnect: () => { for (const s of subscriptions.values()) if (s.query.kind === 'Pod') emit(s, [{ type: 'Status', payload: { phase: 'reconnecting', error: { code: 'unavailable', status: 503, message: 'Connection lost', operation: 'watch' } } }]); },
      empty: () => { for (const s of subscriptions.values()) if (s.query.kind === 'Pod') emit(s, [{ type: 'Delta', payload: { type: 'Restarted', payload: { items: [] } } }, { type: 'Status', payload: { phase: 'live', error: null } }]); },
      late: () => { for (const s of old) emit(s, [{ type: 'Delta', payload: { type: 'Restarted', payload: { items: [{ ...pod(), metadata: { ...pod().metadata, uid: 'stale', name: 'stale-web' } }] } } }]); },
      active: () => subscriptions.size,
      callbacks: () => callbacks.size,
    };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: unknown) => { callbacks.set(++callbackId, callback); return callbackId; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'get_kube_contexts') return [{ name: 'native-test', is_current: true }, { name: 'native-other', is_current: false }];
        if (command === 'ping_cluster') return { git_version: 'v1.34.0' };
        if (command === 'get_namespaces') return ['backend'];
        if (command === 'get_resources') { stats.snapshots++; return { items: [] }; }
        if (command === 'stop_resource_watches') { old.push(...subscriptions.values()); subscriptions.clear(); return; }
        if (command === 'stop_resource_watch') { const s = subscriptions.get(args.subscriptionId); if (s) { old.push(s); subscriptions.delete(args.subscriptionId); stats.stops++; } return; }
        if (command === 'watch_resources') {
          stats.starts++;
          const s = { id: args.subscriptionId, query: args.query, channel: args.onEvent, sequence: 0 };
          subscriptions.set(s.id, s);
          const items = s.query.kind === 'Pod' ? [pod()] : s.query.kind === 'Namespace' ? [{ apiVersion: 'v1', kind: 'Namespace', metadata: { uid: 'ns', name: 'backend' } }] : [];
          const initial = () => emit(s, [{ type: 'Status', payload: { phase: 'syncing', error: null } }, { type: 'Delta', payload: { type: 'Restarted', payload: { items } } }, { type: 'Status', payload: { phase: 'live', error: null } }]);
          if (holdPod && s.query.kind === 'Pod') w.__watchHarness.release = initial; else queueMicrotask(initial);
          return;
        }
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
  }, holdPod);
}

test('native watch updates the table/inspector, retains stale data, then recovers with an authoritative empty list', async ({ page }) => {
  await nativeApi(page); await page.goto('/');
  await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  const table = page.getByTestId('resource-table');
  await table.getByText('live-web', { exact: true }).click();
  await page.evaluate(() => (window as any).__watchHarness.update('Pending'));
  await expect(table.getByText('Pending', { exact: true })).toBeVisible();
  await expect(page.getByTestId('resource-details').getByText('Pending', { exact: true }).first()).toBeVisible();
  await page.evaluate(() => (window as any).__watchHarness.reconnect());
  await expect(page.getByText('Watch · 1 unavailable', { exact: true })).toBeVisible();
  await expect(table.getByRole('alert')).toContainText('Connection lost');
  await expect(table.getByText('live-web', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__watchHarness.empty());
  await expect(table.getByText('live-web', { exact: true })).toHaveCount(0);
  await expect(table.getByText('No pods found', { exact: true })).toBeVisible();
  await expect(table.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
});

test('Sync replaces subscriptions, ignores old messages, and pagehide releases callbacks and watches', async ({ page }) => {
  await nativeApi(page); await page.goto('/');
  await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.stats.starts)).toBe(36);
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.stats.stops)).toBe(18);
  await page.evaluate(() => (window as any).__watchHarness.late());
  await expect(page.getByTestId('resource-table').getByText('live-web', { exact: true })).toBeVisible();
  await expect(page.getByTestId('resource-table').getByText('stale-web', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__watchHarness.stats.snapshots)).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.active())).toBe(0);
  expect(await page.evaluate(() => (window as any).__watchHarness.callbacks())).toBe(0);
});

test('status updates preserve manual graph positions and viewport without another layout worker', async ({ page }) => {
  const workers: string[] = []; page.on('worker', (worker) => { if (worker.url().includes('layout_worker')) workers.push(worker.url()); });
  await nativeApi(page); await page.goto('/'); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await page.getByRole('button', { name: 'Diagram scope', exact: true }).click();
  await page.getByRole('option', { name: 'Namespace: backend (1)', exact: true }).click();
  const node = page.locator('.react-flow__node-resource'); await expect(node).toHaveCount(1);
  await expect(page.getByText('Arranging topology…', { exact: true })).toHaveCount(0);
  const before = await node.getAttribute('style'); const bounds = (await node.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 15, bounds.y + bounds.height / 2 + 10, { steps: 5 }); await page.mouse.up();
  await expect(node).not.toHaveAttribute('style', before!);
  const dragged = await node.getAttribute('style'); const viewport = page.locator('.react-flow__viewport');
  const pan = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(pan.x + 40, pan.y + 60); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(pan.x + 100, pan.y + 100, { steps: 5 }); await page.mouse.up({ button: 'middle' });
  const transform = await viewport.getAttribute('style'); const count = workers.length;
  await page.evaluate(() => (window as any).__watchHarness.update('Pending'));
  await expect(node.getByText('Pending', { exact: true })).toBeVisible();
  await expect(node).toHaveAttribute('style', dragged!); await expect(viewport).toHaveAttribute('style', transform!);
  expect(workers.length).toBe(count);
});

test('context A → B → A isolates old subscriptions, including late callbacks', async ({ page }) => {
  await nativeApi(page); await page.goto('/'); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  for (const context of ['native-other', 'native-test']) {
    await page.getByTitle('Switch Kubernetes Cluster Context', { exact: true }).click();
    await page.getByText(context, { exact: true }).click();
    await expect(page.getByTitle('Switch Kubernetes Cluster Context', { exact: true })).toContainText(context);
    await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).__watchHarness.late());
    await expect(page.getByTestId('resource-table').getByText('live-web', { exact: true })).toBeVisible();
    await expect(page.getByTestId('resource-table').getByText('stale-web', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__watchHarness.active())).toBe(18);
    expect(await page.evaluate(() => (window as any).__watchHarness.callbacks())).toBe(18);
  }
});

test('first sync is visibly pending and does not pretend the namespace is empty', async ({ page }) => {
  await nativeApi(page, true); await page.goto('/');
  const table = page.getByTestId('resource-table');
  await expect(table.getByRole('status')).toContainText('Waiting for the first complete snapshot');
  await expect(table.getByText('No pods found', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).__watchHarness.release());
  await expect(table.getByText('live-web', { exact: true })).toBeVisible();
  await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
});
