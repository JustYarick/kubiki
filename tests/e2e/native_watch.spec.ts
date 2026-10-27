import { selectDiagramNamespaces } from './helpers/topology';
import { OVERVIEW_KINDS } from '../../src/core/resources/resource_demand';
import { test, expect, type Page } from '@playwright/test';

async function delayTopologyBuilds(page: Page) {
  await page.addInitScript(() => {
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: any, options?: StructuredSerializeOptions | Transferable[]) {
      const send = () => postMessage.call(this, message, Array.isArray(options) ? { transfer: options } : options);
      if (message?.resources && message?.scope) setTimeout(send, 200);
      else send();
    };
  });
}

// Exercises the desktop adapter with the real JS Channel SDK. Rust HTTP runtime is tested separately.
async function nativeApi(page: Page, holdPod = false, restricted = false, initialPhase = 'Running') {
  await page.addInitScript(({ holdPod, restricted, initialPhase }: { holdPod: boolean; restricted: boolean; initialPhase: string }) => {
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
      update: (phase: string) => { for (const s of subscriptions.values()) if (s.query.kind === 'Pod') for (const namespace of s.query.namespace === null ? ['backend', 'other'] : [s.query.namespace]) emit(s, [{ type: 'Delta', payload: { type: 'Applied', payload: { data: pod(phase, namespace) } } }]); },
      reconnect: () => { for (const s of subscriptions.values()) if (s.query.kind === 'Pod') emit(s, [{ type: 'Status', payload: { phase: 'reconnecting', error: { code: 'unavailable', status: 503, message: 'Connection lost', operation: 'watch' } } }]); },
      empty: () => { for (const s of subscriptions.values()) if (s.query.kind === 'Pod') emit(s, [{ type: 'Delta', payload: { type: 'Restarted', payload: { items: [] } } }, { type: 'Status', payload: { phase: 'live', error: null } }]); },
      late: () => { for (const s of old) emit(s, [{ type: 'Delta', payload: { type: 'Restarted', payload: { items: [{ ...pod(), metadata: { ...pod().metadata, uid: 'stale', name: 'stale-web' } }] } } }]); },
      active: () => subscriptions.size,
      callbacks: () => callbacks.size,
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => callbacks.delete(id) };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: unknown) => { callbacks.set(++callbackId, callback); return callbackId; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'plugin:event|listen') return args.handler;
        if (command === 'plugin:event|unlisten') return;
        if (command === 'stop_port_forwards') return;
        if (command === 'stop_pod_execs' || command === 'stop_pod_logs') return;
        if (command === 'stop_host_terminals' || command === 'stop_node_debugs') return;
        if (command === 'get_kube_contexts') return [{ name: 'native-test', is_current: true }, { name: 'native-other', is_current: false }];
        if (command === 'ping_cluster') return { git_version: 'v1.34.0' };
        if (command === 'get_namespaces') { if (restricted) throw { code: 'forbidden', status: 403, message: 'namespaces list forbidden', retryable: false }; return ['backend', 'other']; }
        if (command === 'get_resources') {
          stats.snapshots++;
          if (args.kind === 'Pod') {
            if (restricted && args.namespace === null) throw { code: 'forbidden', status: 403, message: 'All-namespaces listing forbidden', retryable: false };
            return { items: args.namespace === null ? [pod(initialPhase, 'backend'), pod(initialPhase, 'other')] : [pod(initialPhase, args.namespace)] };
          }
          return { items: [] };
        }
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
          const items = s.query.kind === 'Pod'
            ? (s.query.namespace === null ? [pod(initialPhase, 'backend'), pod(initialPhase, 'other')] : [pod(initialPhase, s.query.namespace)])
            : s.query.kind === 'Namespace' ? ['backend', 'other'].map((name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { uid: `ns-${name}`, name } })) : [];
          const initial = () => emit(s, [{ type: 'Status', payload: { phase: 'syncing', error: null } }, { type: 'Delta', payload: { type: 'Restarted', payload: { items } } }, { type: 'Status', payload: { phase: 'live', error: null } }]);
          if (s.query.kind === 'Pod' && (holdPod || s.query.namespace === heldNamespace)) held.push(initial); else queueMicrotask(initial);
          return;
        }
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
  }, { holdPod, restricted, initialPhase });
}

test('connection starts with minimal sidebar watches and loads Overview or table sources on demand without full cluster dumps', async ({ page }) => {
  await nativeApi(page, false, false, 'Failed'); await page.goto('/');
  await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__watchHarness.stats.snapshots)).toBe(0);
  expect(await page.evaluate(() => (window as any).__watchHarness.active())).toBe(2);
  await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
  const overview = page.getByTestId('cluster-overview');
  await expect(overview.getByRole('region', { name: 'Pod phases', exact: true }).getByText('Failed', { exact: true }).locator('..')).toHaveText('Failed2100%');
  await expect(overview.getByRole('region', { name: 'Detected issues', exact: true })).toContainText('live-web');
  expect(await page.evaluate(() => (window as any).__watchHarness.subscriptions().some((query: any) => query.kind === 'Secret'))).toBe(false);
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.subscriptions().map((query: any) => query.kind).sort())).toEqual(['CustomResourceDefinition', 'Namespace', 'Pod']);
});

test('native watch updates the table/inspector, retains stale data, then recovers with an authoritative empty list', async ({ page }) => {
  await nativeApi(page); await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  const table = page.getByTestId('resource-table');
  await table.getByText('live-web', { exact: true }).click();
  await page.evaluate(() => (window as any).__watchHarness.update('Pending'));
  await expect(table.getByText('Pending', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('resource-details').getByRole('img', { name: 'Container · app · Pending · 0 restarts', exact: true })).toBeVisible();
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
  await nativeApi(page); await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await expect(page.getByTitle('Auto-refresh interval')).toHaveCount(0);
  await page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.stats.starts)).toBe(6);
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.stats.stops)).toBe(3);
  await page.evaluate(() => (window as any).__watchHarness.late());
  await expect(page.getByTestId('resource-table').getByText('live-web', { exact: true })).toBeVisible();
  await expect(page.getByTestId('resource-table').getByText('stale-web', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__watchHarness.stats.snapshots)).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.active())).toBe(0);
  expect(await page.evaluate(() => (window as any).__watchHarness.callbacks())).toBe(0);
});

test('status updates preserve manual graph positions and viewport without another layout worker', async ({ page }) => {
  await delayTopologyBuilds(page);
  const workers: string[] = []; page.on('worker', (worker) => { if (worker.url().includes('layout_worker')) workers.push(worker.url()); });
  await nativeApi(page); await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await selectDiagramNamespaces(page, ['backend']);
  const node = page.locator('.react-flow__node-resource'); await expect(node).toHaveCount(1);
  // The initial indicator can disappear before the namespace menu closes.
  // This scenario verifies retained positions after updates, not spinner timing.
  await expect(page.getByText('Updating topology relationships…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Arranging topology…', { exact: true })).toHaveCount(0);
  const canvas = await page.locator('.topology-canvas').boundingBox();
  const before = await node.getAttribute('style'); const bounds = (await node.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 15, bounds.y + bounds.height / 2 + 10, { steps: 5 }); await page.mouse.up();
  await expect(node).not.toHaveAttribute('style', before!);
  const dragged = await node.getAttribute('style'); const viewport = page.locator('.react-flow__viewport');
  const pan = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(pan.x + 40, pan.y + 60); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(pan.x + 100, pan.y + 100, { steps: 5 }); await page.mouse.up({ button: 'middle' });
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(250);
  const transform = await viewport.getAttribute('style'); const count = workers.length;
  await page.evaluate(() => (window as any).__watchHarness.update('Pending'));
  await expect(page.getByText('Updating topology relationships…', { exact: true })).toHaveCount(0);
  expect(await page.locator('.topology-canvas').boundingBox()).toEqual(canvas);
  await expect(node.getByText('Pending', { exact: true })).toBeVisible();
  // A resize-triggered fit used to reset the viewport 100 ms after the response.
  await page.waitForTimeout(300);
  await expect(node).toHaveAttribute('style', dragged!); await expect(viewport).toHaveAttribute('style', transform!);
  expect(workers.length).toBe(count);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  await expect(viewport).toHaveAttribute('style', transform!);
});

test('topology publishes completed builds while same-scope watch updates keep arriving', async ({ page }) => {
  await delayTopologyBuilds(page);
  await nativeApi(page);
  await page.goto('/');
  await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await selectDiagramNamespaces(page, ['backend']);
  const node = page.locator('.react-flow__node-resource');
  await expect(node.getByText('Running', { exact: true })).toBeVisible();
  const updates = await page.evaluateHandle(() => setInterval(() => (window as any).__watchHarness.update('Pending'), 70));
  try {
    await expect(node.getByText('Pending', { exact: true })).toBeVisible({ timeout: 2000 });
    await expect(page.getByText('Updating topology relationships…', { exact: true })).toHaveCount(0);
  } finally {
    await page.evaluate(timer => clearInterval(timer), updates);
    await updates.dispose();
  }
  await expect(page.getByText('Updating topology relationships…', { exact: true })).toHaveCount(0);
});

test('a completed build from an earlier scope is ignored while the new scope waits', async ({ page }) => {
  await page.addInitScript(() => {
    const postMessage = Worker.prototype.postMessage;
    const queued: Array<() => void> = [];
    const scopes: string[] = [];
    (window as any).__topologyBuildHarness = { scopes, release: () => queued.shift()?.() };
    Worker.prototype.postMessage = function(message: any, options?: StructuredSerializeOptions | Transferable[]) {
      const send = () => postMessage.call(this, message, Array.isArray(options) ? { transfer: options } : options);
      if (message?.resources && message?.scope) {
        scopes.push(message.scope);
        queued.push(send);
      } else send();
    };
  });
  await nativeApi(page);
  await page.goto('/');
  await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await selectDiagramNamespaces(page, ['backend']);
  await expect.poll(() => page.evaluate(() => (window as any).__topologyBuildHarness.scopes.length)).toBe(1);
  await expect(page.getByText('Updating topology relationships…', { exact: true })).toBeVisible();
  await selectDiagramNamespaces(page, ['other']);
  await page.evaluate(() => (window as any).__topologyBuildHarness.release());
  await expect.poll(() => page.evaluate(() => (window as any).__topologyBuildHarness.scopes.length)).toBe(2);
  await expect(page.locator('.react-flow__node-resource')).toHaveCount(0);
  await expect(page.getByText('Updating topology relationships…', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__topologyBuildHarness.release());
  const node = page.locator('.react-flow__node-resource');
  await expect(node).toHaveCount(1);
  await expect(node).toContainText('other-web');
  await expect(page.getByText('Updating topology relationships…', { exact: true })).toHaveCount(0);
});

test('context A → B → A isolates old subscriptions, including late callbacks', async ({ page }) => {
  await nativeApi(page); await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  for (const context of ['native-other', 'native-test']) {
    await page.getByTitle('Switch Kubernetes Cluster Context', { exact: true }).click();
    await page.getByText(context, { exact: true }).click();
    await expect(page.getByTitle('Switch Kubernetes Cluster Context', { exact: true })).toContainText(context);
    await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).__watchHarness.late());
    await expect(page.getByTestId('resource-table').getByText('live-web', { exact: true })).toBeVisible();
    await expect(page.getByTestId('resource-table').getByText('stale-web', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__watchHarness.active())).toBe(3);
    expect(await page.evaluate(() => (window as any).__watchHarness.callbacks())).toBe(4);
  }
});

test('first sync is visibly pending and does not pretend the namespace is empty', async ({ page }) => {
  await nativeApi(page, true); await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  const table = page.getByTestId('resource-table');
  await expect(table.getByRole('status')).toContainText('Waiting for the first complete snapshot');
  await expect(table.getByText('No pods found', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).__watchHarness.release());
  await expect(table.getByText('live-web', { exact: true })).toBeVisible();
  await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
});

async function namespace(page: Page, name: string) {
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose Namespace Scope' }).getByRole('option', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
}

test('namespace changes replace scoped watches and pinned tabs explain resources outside the scope', async ({ page }) => {
  await nativeApi(page); await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await namespace(page, 'backend'); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  const cluster = await page.evaluate(() => (window as any).__watchHarness.subscriptions().filter((s: any) => ['Namespace', 'CustomResourceDefinition'].includes(s.kind)));
  await page.getByTestId('resource-table').getByText('live-web', { exact: true }).click();
  await page.getByTestId('resource-details').getByRole('button', { name: 'Open details in tab' }).click();
  await namespace(page, 'other');
  // A namespaced Pod view must not keep receiving other namespaces.
  await expect(page.locator('main').getByText('Resource outside namespace scope', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByText('Resource Not Found', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.subscriptions().filter((s: any) => s.namespace !== null).every((s: any) => s.namespace === 'other'))).toBe(true);
  expect(await page.evaluate(() => (window as any).__watchHarness.subscriptions().filter((s: any) => ['Namespace', 'CustomResourceDefinition'].includes(s.kind)))).toEqual(cluster);
  expect(await page.evaluate(() => (window as any).__watchHarness.subscriptions().filter((s: any) => s.kind === 'Pod'))).toHaveLength(1);
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await expect(page.getByTestId('resource-table').getByText('other-web', { exact: true })).toBeVisible();
  await expect(page.getByTestId('resource-table').getByText('live-web', { exact: true })).toHaveCount(0);
  await namespace(page, 'backend'); await expect(page.getByTestId('resource-table').getByText('live-web', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__watchHarness.late());
  await expect(page.getByTestId('resource-table').getByText('stale-web', { exact: true })).toHaveCount(0);
});

test('a restricted user can enter an unlisted namespace and recover namespaced reads after 403', async ({ page }) => {
  await nativeApi(page, false, true); await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await expect(page.getByTestId('resource-table').getByRole('alert')).toHaveAttribute('data-error-code', 'forbidden');
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose Namespace Scope' });
  await picker.getByRole('searchbox').fill('../other'); await expect(picker.getByRole('option')).toHaveCount(0);
  await picker.getByRole('searchbox').fill('backend');
  await picker.getByRole('option', { name: 'backend', exact: true }).click();
  await picker.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Namespace Scope', exact: true })).toHaveAttribute('data-value', 'backend');
  await expect(page.getByTestId('resource-table').getByText('live-web', { exact: true })).toBeVisible();
  await expect(page.getByTestId('resource-table').getByRole('alert')).toHaveCount(0);
  const subscriptions = await page.evaluate(() => (window as any).__watchHarness.subscriptions());
  expect(subscriptions.filter((s: any) => s.namespace !== null).every((s: any) => s.namespace === 'backend')).toBe(true);
  await page.getByTestId('resource-table').getByText('live-web', { exact: true }).click();
  await page.getByTestId('resource-details').getByRole('button', { name: 'Open details in tab' }).click();
  await namespace(page, 'All Namespaces');
  // All Namespaces must not turn this resource's namespace-local reads into
  // cluster-wide LIST requests that this account is forbidden from making.
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
  await expect(page.locator('main').getByTestId('resource-details')).toContainText('live-web');
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.subscriptions().filter((s: any) => s.namespace !== null).every((s: any) => s.namespace === 'backend'))).toBe(true);
  await expect(page.locator('main').getByText('Resource Not Found', { exact: true })).toHaveCount(0);
});

test('a diagram outside the selected namespace explains missing data and loads its scope explicitly', async ({ page }) => {
  await nativeApi(page); await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await namespace(page, 'backend'); await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await selectDiagramNamespaces(page, ['other']);
  await expect(page.getByText('Load this namespace using the button above to build its diagram.', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node-resource')).toHaveCount(0);
  await page.getByRole('button', { name: 'Load diagram namespaces', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Namespace Scope', exact: true })).toHaveAttribute('data-value', '["backend","other"]');
  await expect(page.locator('.react-flow__node-resource').getByText('other-web', { exact: true })).toBeVisible();
});

test('Overview updates summary sources while unrelated inventory stays cached', async ({ page }) => {
  await nativeApi(page);await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
  const overview = page.getByTestId('cluster-overview');const phases = overview.getByRole('region', { name: 'Pod phases', exact: true });
  await expect(overview.getByRole('button', { name: 'Pods: 2', exact: true })).toBeVisible();await expect(phases.getByText('Running', { exact: true }).locator('..')).toHaveText('Running2100%');
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.stats.starts)).toBe(OVERVIEW_KINDS.length + 1);
  await page.evaluate(() => (window as any).__watchHarness.update('Failed'));await expect(phases.getByText('Failed', { exact: true }).locator('..')).toHaveText('Failed2100%');await expect(overview.getByRole('region', { name: 'Detected issues', exact: true })).toContainText('live-web');
  await page.evaluate(() => (window as any).__watchHarness.reconnect());await expect(overview.getByText(/Partial or stale data/)).toBeVisible();await expect(overview.getByRole('button', { name: 'Pods: 2', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__watchHarness.empty());await expect(overview.getByRole('button', { name: 'Pods: 0', exact: true })).toBeVisible();await expect(phases.getByText('Failed', { exact: true }).locator('..')).toHaveText('Failed00%');
});


test('multiple selected namespaces use independent desktop watches and commit one complete combined snapshot', async ({ page }) => {
  await nativeApi(page);
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await expect(page.getByText('Watch · live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose Namespace Scope', exact: true });
  await picker.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await picker.getByRole('option', { name: 'backend', exact: true }).click();
  await picker.getByRole('option', { name: 'other', exact: true }).click();
  await picker.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  const table = page.getByTestId('resource-table');
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.subscriptions()
    .filter((subscription: any) => subscription.kind === 'Pod')
    .map((subscription: any) => subscription.namespace).sort())).toEqual(['backend', 'other']);
  const subscriptions = await page.evaluate(() => (window as any).__watchHarness.subscriptions());
  // Only the visible Pod collection uses one watch per selected namespace.
  expect(subscriptions.filter((subscription: any) => subscription.kind === 'Pod').map((subscription: any) => subscription.namespace).sort()).toEqual(['backend', 'other']);
  await expect(table.getByText('live-web', { exact: true })).toBeVisible();
  await expect(table.getByText('other-web', { exact: true })).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await page.evaluate(() => (window as any).__watchHarness.update('Pending'));
  await expect(table.getByText('Pending', { exact: true })).toHaveCount(2);
  await page.evaluate(() => (window as any).__watchHarness.reconnect());
  await expect(table.getByRole('alert')).toContainText('Connection lost');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await page.evaluate(() => (window as any).__watchHarness.empty());
  await expect(table.locator('tbody tr')).toHaveCount(0);
  await expect(table.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => (window as any).__watchHarness.update('Running'));
  await namespace(page, 'backend');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.getByText('other-web', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).__watchHarness.late());
  await expect(table.getByText('stale-web', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => page.evaluate(() => (window as any).__watchHarness.active())).toBe(0);
});
