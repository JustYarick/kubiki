import { test, expect, type Page } from '@playwright/test';

async function nativeCreation(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const definition = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'widgets.example.io', uid: 'crd-widget' }, spec: { group: 'example.io', names: { kind: 'Widget', plural: 'widgets' }, scope: 'Namespaced', versions: [{ name: 'v1beta1', served: true, storage: true }] } };
    const objects: any[] = [definition];
    const subscriptions = new Map<string, any>();
    w.__creation = { writes: [], outcome: 'success' };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    const emit = (s: any, events: any[]) => s.channel.onmessage({ subscription_id: s.id, query: s.query, messages: events.map(event => ({ sequence: ++s.sequence, event })) });
    w.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      if (command === 'get_kube_contexts') return [{ name: 'test-cluster', is_current: true }];
      if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
      if (command === 'get_namespaces') return ['default', 'team'];
      if (command === 'get_api_resources') return [];
      if (command === 'get_custom_resources') return { items: objects.filter(item => item.kind === 'Widget') };
      if (command === 'get_resources') return { items: objects.filter(item => item.kind === args.kind) };
      if (command === 'stop_resource_watch') { subscriptions.delete(args.subscriptionId);return; }
      if (command.startsWith('stop_') || command.startsWith('plugin:')) return;
      if (command === 'watch_resources') {
        const s = { id: args.subscriptionId, query: args.query, channel: args.onEvent, sequence: 0 };
        subscriptions.set(s.id, s);
        queueMicrotask(() => emit(s, [{ type: 'Delta', payload: { type: 'Restarted', payload: { items: objects.filter(item => item.kind === s.query.kind) } } }, { type: 'Status', payload: { phase: 'live', error: null } }]));
        return;
      }
      if (command === 'mutate_resource') {
        w.__creation.writes.push(args.request);
        if (w.__creation.outcome === 'cancelled') throw { code: 'cancelled', message: 'Cancelled', retryable: false };
        if (w.__creation.outcome === 'forbidden') throw { code: 'forbidden', message: 'Your account cannot create this resource', retryable: false };
        const manifest = args.request.manifest;
        const kind = /^kind: (.+)$/m.exec(manifest)?.[1];
        const name = /^  name: (.+)$/m.exec(manifest)?.[1];
        const namespace = /^  namespace: (.+)$/m.exec(manifest)?.[1];
        const item = { apiVersion: /^apiVersion: (.+)$/m.exec(manifest)?.[1], kind, metadata: { name, namespace, uid: `created-${name}`, resourceVersion: '1' }, spec: {} };
        objects.push(item);
        for (const s of subscriptions.values()) if (s.query.kind === kind) emit(s, [{ type: 'Delta', payload: { type: 'Applied', payload: { data: item } } }]);
        return item;
      }
      throw new Error(`Unexpected command ${command}`);
    } };
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
}

test('desktop creation preserves edited spec, reviews in the backend and refreshes the resource list', async ({ page }) => {
  await nativeCreation(page);
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Deployments(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Deployment', exact: true });
  const yaml = dialog.getByLabel('Manifest · YAML', { exact: true });
  await yaml.fill((await yaml.inputValue()).replace('replicas: 1', 'replicas: 4 # keep this change'));
  await dialog.getByLabel('Name', { exact: true }).fill('reviewed-web');
  await dialog.getByLabel('Namespace', { exact: true }).fill('team');
  await expect(yaml).toHaveValue(/replicas: 4 # keep this change/);
  await dialog.getByRole('button', { name: 'Review & create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('resource-table').getByTitle('reviewed-web', { exact: true })).toBeVisible();
  const writes = await page.evaluate(() => (window as any).__creation.writes);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ operation: 'manifest', context: 'test-cluster' });
  expect(writes[0].manifest).toContain('namespace: team');
  expect(writes[0].manifest).toContain('replicas: 4 # keep this change');
  expect(writes[0]).not.toHaveProperty('target');
  expect(JSON.stringify(writes)).not.toMatch(/approved|confirmed/);
});

test('cancellation and RBAC errors retain the creation draft; invalid YAML never reaches the backend', async ({ page }) => {
  await nativeCreation(page);
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^ConfigMaps(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New ConfigMap', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('draft-config');
  const yaml = dialog.getByLabel('Manifest · YAML', { exact: true });
  const draft = await yaml.inputValue();
  await yaml.fill('metadata: [');
  await expect(dialog.getByRole('button', { name: 'Review & create', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__creation.writes.length)).toBe(0);
  await yaml.fill(draft);
  for (const outcome of ['cancelled', 'forbidden']) {
    await page.evaluate(outcome => { (window as any).__creation.outcome = outcome; }, outcome);
    await dialog.getByRole('button', { name: 'Review & create', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Review & create', exact: true })).toBeEnabled();
    await expect(yaml).toHaveValue(draft);
  }
  await expect(dialog.getByRole('alert')).toContainText('cannot create');
  expect(await page.evaluate(() => (window as any).__creation.writes.length)).toBe(2);
});

test('cluster-scoped creation omits namespace and supports keyboard dismissal', async ({ page }) => {
  await nativeCreation(page);
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Namespaces(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Namespace', exact: true });
  await expect(dialog.getByLabel('Namespace', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Manifest · YAML', { exact: true })).not.toHaveValue(/namespace:/);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__creation.writes.length)).toBe(0);
});

test('demo creation stores the actual manifest and opens the YAML workspace', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^ConfigMaps(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New ConfigMap', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('demo-created-config');
  await dialog.getByRole('button', { name: 'Create (demo)', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('yaml-editor').locator('.view-lines')).toContainText('demo-created-config');
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^ConfigMaps(?: \d+)?$/ }).click();
  await page.getByPlaceholder('Filter configmaps…').fill('demo-created-config');
  await expect(page.getByTestId('resource-table').getByTitle('demo-created-config', { exact: true })).toBeVisible();
});


test('discovered custom resources create with their actual kind and served API version', async ({ page }) => {
  await nativeCreation(page);
  const explorer = page.getByTestId('explorer-panel');
  await explorer.getByRole('button', { name: /^Widget(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Widget', exact: true });
  const yaml = dialog.getByLabel('Manifest · YAML', { exact: true });
  await expect(yaml).toHaveValue(/apiVersion: example.io\/v1beta1/);
  await dialog.getByLabel('Name', { exact: true }).fill('new-widget');
  await dialog.getByRole('button', { name: 'Review & create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('resource-table').getByTitle('new-widget', { exact: true })).toBeVisible();
  const request = await page.evaluate(() => (window as any).__creation.writes[0]);
  expect(request.context).toBe('test-cluster');
  expect(request.manifest).toContain('kind: Widget');
  expect(request.manifest).toContain('apiVersion: example.io/v1beta1');
});
