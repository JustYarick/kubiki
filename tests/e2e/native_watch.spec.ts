import { test, expect, type Page } from '@playwright/test';

// Exercises the desktop adapter with the real JS Channel SDK. Rust HTTP runtime is tested separately.
async function nativeApi(page: Page, holdPod = false, restricted = false) {
  await page.addInitScript(({ holdPod, restricted }: { holdPod: boolean; restricted: boolean }) => {
    const w = window as any;
    const callbacks = new Map<number, unknown>(); let callbackId = 0;
    const subscriptions = new Map<string, any>(); const old: any[] = [];
    const stats = { starts: 0, stops: 0, snapshots: 0 };
    let heldNamespace: string | undefined; const held: Array<() => void> = [];
    const pod = (phase = 'Running', namespace = 'backend') => ({ apiVersion: 'v1', kind: 'Pod', metadata: { uid: namespace === 'backend' ? 'pod' : `pod-${namespace}`, name: namespace === 'backend' ? 'live-web' : `${namespace}-web`, namespace }, spec: { containers: [{ name: 'app', image: 'nginx' }] }, status: { phase } });
    const emit = (subscription: any, events: any[]) => subscription.channel.onmessage({ subscription_id: subscription.id, query: subscription.query, messages: events.map((event) => ({ sequence: ++subscription.sequence, event })) });
    w.__watchHarness = {
      stats, pod,
      subscriptions: () => [...subscriptions.values()].map((s) => ({ id: s.id, ...s.query })),
      holdNamespace: (namespace: string) => { heldNamespace = namespace; },
      release: () => { heldNamespace = undefined; for (const initial of held.splice(0)) initial(); },
      update: (phase: string) => { for (const s of subscriptions.values()) if (s.query.kind === 'Pod') emit(s, [{ type: 'Delta', payload: { type: 'Applied', payload: { data: pod(phase, s.query.namespace ?? 'backend') } } }]); },
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
        if (command === 'stop_port_forwards') return;
        if (command === 'stop_pod_execs' || command === 'stop_pod_logs') return;
        if (command === 'stop_host_terminals' || command === 'stop_node_debugs') return;
        if (command === 'get_kube_contexts') return [{ name: 'native-test', is_current: true }, { name: 'native-other', is_current: false }];
        if (command === 'ping_cluster') return { git_version: 'v1.34.0' };
        if (command === 'get_namespaces') { if (restricted) throw { code: 'forbidden', status: 403, message: 'namespaces list forbidden', retryable: false }; return ['backend', 'other']; }
        if (command === 'get_resources') { stats.snapshots++; return { items: [] }; }
        if (command === 'stop_resource_watches') { old.push(...subscriptions.values()); subscriptions.clear(); return; }
        if (command === 'stop_resource_watch') { const s = subscriptions.get(args.subscriptionId); if (s) { old.push(s); subscriptions.delete(args.subscriptionId); stats.stops++; } return; }
        if (command === 'watch_resources') {
          stats.starts++;
          const s = { id: args.subscriptionId, query: args.query, channel: args.onEvent, sequence: 0 };
          subscriptions.set(s.id, s);
          if (restricted && (s.query.kind === 'Namespace' || s.query.namespace === null && !['Node', 'StorageClass', 'CustomResourceDefinition'].includes(s.query.kind))) {
            queueMicrotask(() => emit(s, [{ type: 'Status', payload: { phase: 'failed', error: { code: 'forbidden', status: 403, message: 'All-namespaces listing forbidden', retryable: false, operation: 'watch' } } }]));
            return;
          }
          const items = s.query.kind === 'Pod' ? [pod('Running', s.query.namespace ?? 'backend')] : s.query.kind === 'Namespace' ? ['backend', 'other'].map((name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { uid: `ns-${name}`, name } })) : [];
          const initial = () => emit(s, [{ type: 'Status', payload: { phase: 'syncing', error: null } }, { type: 'Delta', payload: { type: 'Restarted', payload: { items } } }, { type: 'Status', payload: { phase: 'live', error: null } }]);
          if (s.query.kind === 'Pod' && (holdPod || s.query.namespace === heldNamespace)) held.push(initial); else queueMicrotask(initial);
          return;
        }
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
  }, { holdPod, restricted });
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
  await expect(page.getByTitle('Auto-refresh interval')).toHaveCount(0);
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

async function namespace(page: Page, name: string) {
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose Namespace Scope' }).getByRole('option', { name, exact: true }).click();
}

test('namespace changes replace only scoped watches; pinned tabs stay available and ignore late snapshots', async ({ page }) => {
  await nativeApi(page); await page.goto('/'); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await namespace(page, 'backend'); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  const cluster = await page.evaluate(() => (window as any).__watchHarness.subscriptions().filter((s: any) => ['Node', 'Namespace', 'StorageClass', 'CustomResourceDefinition'].includes(s.kind)));
  await page.getByTestId('resource-table').getByText('live-web', { exact: true }).click();
  await page.getByTestId('resource-details').getByRole('button', { name: 'Open details in tab' }).click();
  await page.evaluate(() => (window as any).__watchHarness.holdNamespace('other'));
  await namespace(page, 'other');
  await expect(page.locator('main').getByText('Resource outside namespace scope', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByText('Resource Not Found', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.subscriptions().filter((s: any) => s.namespace !== null).every((s: any) => s.namespace === 'other'))).toBe(true);
  expect(await page.evaluate(() => (window as any).__watchHarness.subscriptions().filter((s: any) => ['Node', 'Namespace', 'StorageClass', 'CustomResourceDefinition'].includes(s.kind)))).toEqual(cluster);
  await page.evaluate(() => { (window as any).__watchHarness.late(); (window as any).__watchHarness.release(); });
  await page.getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await expect(page.getByTestId('resource-table').getByText('other-web', { exact: true })).toBeVisible();
  await expect(page.getByTestId('resource-table').getByText('live-web', { exact: true })).toHaveCount(0);
  await namespace(page, 'backend'); await expect(page.getByTestId('resource-table').getByText('live-web', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__watchHarness.late());
  await expect(page.getByTestId('resource-table').getByText('stale-web', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__watchHarness.callbacks())).toBe(18);
});

test('a restricted user can enter an unlisted namespace and recover namespaced reads after 403', async ({ page }) => {
  await nativeApi(page, false, true); await page.goto('/');
  await expect(page.getByTestId('resource-table').getByRole('alert')).toHaveAttribute('data-error-code', 'forbidden');
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose Namespace Scope' });
  await picker.getByRole('searchbox').fill('../other'); await expect(picker.getByRole('option')).toHaveCount(0);
  await picker.getByRole('searchbox').fill('backend');
  await picker.getByRole('option', { name: 'Use namespace: backend', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Namespace Scope', exact: true })).toHaveAttribute('data-value', 'backend');
  await expect(page.getByTestId('resource-table').getByText('live-web', { exact: true })).toBeVisible();
  await expect(page.getByTestId('resource-table').getByRole('alert')).toHaveCount(0);
  const subscriptions = await page.evaluate(() => (window as any).__watchHarness.subscriptions());
  expect(subscriptions.filter((s: any) => s.namespace !== null).every((s: any) => s.namespace === 'backend')).toBe(true);
  await page.getByTestId('resource-table').getByText('live-web', { exact: true }).click();
  await page.getByTestId('resource-details').getByRole('button', { name: 'Open details in tab' }).click();
  await namespace(page, 'All Namespaces');
  await expect(page.locator('main').getByRole('alert')).toHaveAttribute('data-error-code', 'forbidden');
  await expect(page.locator('main').getByText('Resource Not Found', { exact: true })).toHaveCount(0);
});

test('a diagram outside the selected namespace explains missing data and loads its scope explicitly', async ({ page }) => {
  await nativeApi(page); await page.goto('/'); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await namespace(page, 'backend'); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await page.getByRole('button', { name: 'Diagram scope', exact: true }).click();
  await page.getByRole('option', { name: 'Namespace: other (not loaded)', exact: true }).click();
  await expect(page.getByText('Load this namespace using the button above to build its diagram.', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node-resource')).toHaveCount(0);
  await page.getByRole('button', { name: 'Load namespace other', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Namespace Scope', exact: true })).toHaveAttribute('data-value', 'other');
  await expect(page.locator('.react-flow__node-resource').getByText('other-web', { exact: true })).toBeVisible();
});

test('Overview derives live phase/issue counts from existing watches without adding subscriptions', async ({ page }) => {
  await nativeApi(page);await page.goto('/');await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
  const overview = page.getByTestId('cluster-overview');const phases = overview.getByRole('region', { name: 'Pod phases', exact: true });
  await expect(overview.getByTestId('overview-count-Pod')).toHaveText('1');await expect(phases.getByText('Running', { exact: true }).locator('..')).toHaveText('Running1');
  expect(await page.evaluate(() => (window as any).__watchHarness.stats.starts)).toBe(18);
  await page.evaluate(() => (window as any).__watchHarness.update('Failed'));await expect(phases.getByText('Failed', { exact: true }).locator('..')).toHaveText('Failed1');await expect(overview.getByRole('region', { name: 'Detected issues', exact: true })).toContainText('live-web');
  await page.evaluate(() => (window as any).__watchHarness.reconnect());await expect(overview.getByText(/Partial or stale data/)).toBeVisible();await expect(overview.getByTestId('overview-count-Pod')).toHaveText('1');
  await page.evaluate(() => (window as any).__watchHarness.empty());await expect(overview.getByTestId('overview-count-Pod')).toHaveText('0');await expect(phases.getByText('Failed', { exact: true }).locator('..')).toHaveText('Failed0');
});
