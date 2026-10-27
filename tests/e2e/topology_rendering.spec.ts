import { test, expect, type Page } from '@playwright/test';
import { openDiagramSettings, selectDiagramNamespaces } from './helpers/topology';
import { namespaceList } from './helpers/namespaces';

async function mockCluster(page: Page) {
  const calls: string[] = [];
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    calls.push(url.pathname);
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.34.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['backend'] });
    if (url.pathname.endsWith('/helm/inventory')) return route.fulfill({ json: [] });
    const kind = url.searchParams.get('kind');
    if (kind === 'Namespace') return route.fulfill({ json: namespaceList(['backend']) });
    const namespace = url.searchParams.get('namespace');
    const items = kind === 'Pod' ? [{
      metadata: { uid: 'pod', name: 'web', namespace: 'backend', ownerReferences: [{ uid: 'dep', name: 'web-owner', kind: 'Deployment' }] },
      spec: { containers: [] }, status: { phase: 'Running' },
    }] : kind === 'Deployment' ? [{ metadata: { uid: 'dep', name: 'web-owner', namespace: 'backend' } }] : [];
    return route.fulfill({ json: { items: items.filter(item => !namespace || item.metadata.namespace === namespace), has_more: false } });
  });
  return calls;
}

async function openTopologySettings(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Topology', exact: true }).click();
  return page.getByRole('region', { name: 'Settings: Topology', exact: true });
}

test('global rendering preferences persist and Performance removes expensive diagram effects without API reads', async ({ page }) => {
  const calls = await mockCluster(page);
  await page.goto('/');
  let settings = await openTopologySettings(page);
  await settings.getByLabel('Animate topology connections', { exact: true }).check();
  await settings.getByLabel('Topology connection labels', { exact: true }).check();
  await settings.getByLabel('Topology canvas minimap', { exact: true }).check();
  await settings.getByRole('button', { name: 'Performance', exact: true }).click();
  await expect(settings.getByLabel('Topology canvas minimap', { exact: true })).toBeDisabled();
  await expect(settings.getByLabel('Animate topology connections', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await selectDiagramNamespaces(page, ['backend']);
  const canvas = page.locator('.topology-canvas');
  await expect(canvas).toHaveAttribute('data-rendering-profile', 'performance');
  await expect(canvas.locator('.react-flow__node-resource')).toHaveCount(2);
  await expect(canvas.locator('.react-flow__edge')).toHaveCount(1);
  await expect(canvas.locator('.react-flow__minimap, .react-flow__background, .react-flow__edge-text, .react-flow__edge.animated, .topology-node-details')).toHaveCount(0);
  expect(await canvas.locator('.topology-node').first().evaluate(node => getComputedStyle(node).boxShadow)).toBe('none');
  const diagramSettings = await openDiagramSettings(page);
  await expect(diagramSettings.getByLabel('Rendering performance', { exact: true })).toHaveCount(0);
  await expect(diagramSettings.getByLabel('Canvas minimap', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Diagram settings', exact: true }).click();
  const reads = calls.length;
  settings = await openTopologySettings(page);
  await settings.getByRole('button', { name: 'Quality', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(canvas.locator('.react-flow__minimap')).toHaveCount(1);
  await expect(canvas.locator('.react-flow__edge.animated')).toHaveCount(1);
  await expect(canvas.locator('.react-flow__edge-text')).toHaveCount(1);
  expect(calls.length).toBe(reads);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(canvas.locator('.react-flow__edge.animated')).toHaveCount(0);
  await page.reload();
  settings = await openTopologySettings(page);
  await expect(settings.getByRole('button', { name: 'Quality', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(settings.getByLabel('Animate topology connections', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Reset topology defaults', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Balanced', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(settings.getByLabel('Animate topology connections', { exact: true })).not.toBeChecked();
});

test('rapid resource updates are coalesced before serialization and the latest snapshot reaches the worker', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('kubiki.settings.v3', JSON.stringify({ state: { topologyPerformanceMode: 'performance' }, version: 0 }));
    const posts: { at: number; status: string }[] = [];
    (window as any).__topologyPosts = posts;
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: any, options?: StructuredSerializeOptions | Transferable[]) {
      if (message?.resources && message?.scope) posts.push({ at: performance.now(), status: message.resources.Pod.values().next().value?.status });
      return send.call(this, message, Array.isArray(options) ? { transfer: options } : options);
    };
  });
  await mockCluster(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await selectDiagramNamespaces(page, ['backend']);
  await expect(page.locator('.react-flow__node-resource')).toHaveCount(2);
  await page.evaluate(async () => {
    const { useResourceStore } = await import(/* @vite-ignore */ '/src/state/resource_store.ts' as string);
    const initial = [...useResourceStore.getState().resources.Pod.values()];
    for (let i = 0; i < 20; i++) {
      useResourceStore.getState().setResourcesForKind('Pod', initial.map(item => ({ ...item, status: `Pending-${i}` })));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  });
  await expect.poll(() => page.evaluate(() => (window as any).__topologyPosts.at(-1)?.status)).toBe('Pending-19');
  const posts = await page.evaluate(() => (window as any).__topologyPosts as { at: number; status: string }[]);
  expect(posts.length).toBeLessThanOrEqual(3);
  for (let i = 1; i < posts.length; i++) expect(posts[i].at - posts[i - 1].at).toBeGreaterThanOrEqual(2995);
});

test('replacing an unfinished layout cancels its worker and ignores its late failure', async ({ page }) => {
  await page.addInitScript(() => {
    const send = Worker.prototype.postMessage;
    const terminate = Worker.prototype.terminate;
    const pending: { worker: Worker; message: any; receive: Worker['onmessage'] }[] = [];
    const stopped = new WeakSet<Worker>();
    (window as any).__layouts = {
      count: () => pending.length,
      failFirst: () => {
        const first = pending[0];
        first.receive?.call(first.worker, new MessageEvent('message', { data: { id: first.message.id, error: { message: 'superseded layout failed' } } }));
      },
      releaseLatest: () => {
        const current = pending.at(-1)!;
        send.call(current.worker, current.message);
      },
      latestStopped: () => stopped.has(pending.at(-1)!.worker),
      firstStopped: () => stopped.has(pending[0].worker),
    };
    Worker.prototype.postMessage = function(message: any, options?: StructuredSerializeOptions | Transferable[]) {
      if (message?.cmd === 'layout' && pending.length < 2) {
        pending.push({ worker: this, message, receive: this.onmessage });
        return;
      }
      return send.call(this, message, Array.isArray(options) ? { transfer: options } : options);
    };
    Worker.prototype.terminate = function() { stopped.add(this); return terminate.call(this); };
  });
  await mockCluster(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await selectDiagramNamespaces(page, ['backend']);
  await expect.poll(() => page.evaluate(() => (window as any).__layouts.count())).toBe(1);
  const settings = await openDiagramSettings(page);
  await settings.getByRole('combobox', { name: 'Diagram direction', exact: true }).selectOption('DOWN');
  await expect.poll(() => page.evaluate(() => (window as any).__layouts.count())).toBe(2);
  await page.evaluate(async () => {
    (window as any).__layouts.failFirst();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  expect(await page.evaluate(() => (window as any).__layouts.firstStopped())).toBe(true);
  expect(await page.evaluate(() => (window as any).__layouts.latestStopped())).toBe(false);
  await page.evaluate(() => (window as any).__layouts.releaseLatest());
  await expect(page.locator('.react-flow__node-resource')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
