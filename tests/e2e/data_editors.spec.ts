import { expect, test, type Locator, type Page } from '@playwright/test';
import { captureScreenshot } from './helpers/screenshots';

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = []; browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(({ page }) => { expect(browserErrors.get(page)).toEqual([]); });

async function setup(page: Page, withFlux = false) {
  await page.addInitScript(withFlux => {
    const w = window as any;
    const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'editor-secret', uid: 'secret-uid', namespace: 'apps', resourceVersion: '1' }, type: 'Opaque', data: { 'config.json': btoa('{"token":"private-token","count":2}'), password: btoa('old-password\n'), binary: '/wAB', empty: '' } };
    const config = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'editor-config', uid: 'config-uid', namespace: 'apps', resourceVersion: '1', annotations: { 'app/config': '{"enabled":true,"nested":{"count":2}}' } }, data: { 'values.yaml': '# keep this comment\nreplicas: 2\nservice:\n  port: 8080\n', 'app.json': '{"enabled":true}' } };
    const definition = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { uid: 'helm-crd', name: 'helmreleases.helm.toolkit.fluxcd.io' }, spec: { group: 'helm.toolkit.fluxcd.io', names: { kind: 'HelmRelease', plural: 'helmreleases' }, scope: 'Namespaced', versions: [{ name: 'v2', served: true, storage: true }] } };
    const flux = { apiVersion: 'helm.toolkit.fluxcd.io/v2', kind: 'HelmRelease', metadata: { name: 'flux-owner', namespace: 'apps', uid: 'flux-uid', resourceVersion: '5', generation: 2 }, spec: { releaseName: 'web' }, status: { conditions: [{ type: 'Stalled', status: 'True', reason: 'RetriesExceeded', observedGeneration: 2 }] } };
    const itemsFor = (kind: string) => kind === 'Secret' ? [secret] : kind === 'ConfigMap' ? [config] : kind === 'CustomResourceDefinition' && withFlux ? [definition] : kind === 'Namespace' ? [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'apps', uid: 'apps' } }] : [];
    w.__dataIntents = []; w.__copied = []; w.__cancelMutation = false;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { w.__copied.push(value); } } });
    let callback = 0;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (command === 'plugin:event|listen') return ++callback;
        if (command === 'plugin:event|unlisten' || command.startsWith('stop_') || ['ack_resources', 'cancel_read_task'].includes(command)) return;
        if (command === 'watch_resources') {
          const items = itemsFor(args.query.kind);
          queueMicrotask(() => args.onEvent.onmessage({ subscription_id: args.subscriptionId, query: args.query, messages: [
            { sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items } } } },
            { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } },
          ] }));
          return;
        }
        if (command === 'get_kube_contexts') return [{ name: 'test', is_current: true }];
        if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
        if (command === 'get_namespaces') return ['apps'];
        if (command === 'get_api_resources') return '';
        if (command === 'get_resources') return { items: itemsFor(args.kind) };
        if (command === 'get_custom_resources') return { items: withFlux ? [flux] : [] };
        if (command === 'get_helm_inventory') return [{ name: 'web', namespace: 'apps', revision: '2', updated: '', status: 'deployed', chart: 'web-1', app_version: '1' }];
        if (command === 'get_helm_content') return '# retained comment\nreplicas: 2\nservice:\n  port: 8080\n';
        if (command === 'get_helm_history' || command === 'list_helm_repositories') return [];
        if (command === 'delete_resource') {
          w.__dataIntents.push(args.request);
          return new Promise(resolve => { w.__finishDeletion = () => resolve({ kind: 'Status', status: 'Success' }); });
        }
        if (command === 'mutate_resource') {
          const intent = args.request; w.__dataIntents.push(intent);
          if (w.__cancelMutation) throw { code: 'cancelled', message: 'Operation cancelled', retryable: false };
          if (intent.operation === 'secret') { secret.data = intent.request.data; secret.metadata.resourceVersion = '2'; return secret; }
          if (intent.operation === 'action') { if (intent.action.type === 'flux_retry') return flux; config.data = intent.action.data; return config; }
          if (intent.operation === 'manifest') return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'new-editor-config', uid: 'new-uid', namespace: 'apps' }, data: { key: 'new value' } };
          return {};
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  }, withFlux);
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
}

async function openResource(page: Page, kind: string, name: string) {
  await page.getByTestId('explorer-panel').locator(`[data-resource-type="${kind}"]`).click();
  await page.getByTestId('resource-table').getByText(name, { exact: true }).click();
  return page.getByTestId('inspector-panel').getByTestId('resource-details');
}

function editor(scope: Locator, label: string) { return scope.getByRole('group', { name: `${label} editor`, exact: true }); }

async function replaceAll(page: Page, container: Locator, text: string) {
  await expect(container.locator('.monaco-editor')).toBeVisible();
  await container.getByRole('textbox', { name: /./ }).first().focus();
  await page.keyboard.press('Control+a');
  // Bulk text is a paste, not one synthetic typing event (which invokes auto-indent/quotes).
  await container.getByRole('textbox', { name: /./ }).first().evaluate((element, value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

test('Secret editors keep hidden data out of the editor, preserve encoding and save the latest draft through the backend', async ({ page }) => {
  await setup(page);
  const details = await openResource(page, 'Secret', 'editor-secret');
  const data = details.getByRole('region', { name: 'Secret data', exact: true });
  await expect(data.locator('.monaco-editor')).toHaveCount(0);
  await expect(data).not.toContainText('private-token');
  await data.getByRole('button', { name: 'Reveal values', exact: true }).click();
  await expect(editor(data, 'Value for config.json').locator('.view-lines')).toContainText('private-token');
  await expect(editor(data, 'Value for config.json')).toHaveAttribute('data-language', 'json');
  await data.getByRole('button', { name: 'Hide values', exact: true }).click();
  await expect(data.locator('.monaco-editor')).toHaveCount(0);
  await expect(data).not.toContainText('private-token');
  await data.getByRole('button', { name: 'Edit data', exact: true }).click();
  const first = editor(data, 'Value 1');
  await replaceAll(page, first, '{"token":"updated-token","count":3}');
  await first.getByRole('button', { name: 'Format Value 1', exact: true }).click();
  await expect(first.locator('.view-lines')).toContainText('updated-token');
  await expect(first).toContainText('5 lines');
  const password = editor(data, 'Value 2');
  await replaceAll(page, password, 'new-password\n');
  await page.keyboard.insertText('latest');
  await data.getByRole('button', { name: 'Base64', exact: true }).click();
  await data.getByRole('button', { name: 'Copy value for password', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__copied.at(-1))).toBe(btoa('new-password\nlatest'));
  await data.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(password.locator('.view-lines')).toContainText('latest');
  await expect(first.locator('.view-lines')).toContainText('updated-token');
  await captureScreenshot(page, { path: 'test-results/secret-code-editors.png' });
  await page.evaluate(() => { (window as any).__cancelMutation = true; });
  await data.getByRole('button', { name: 'Save data', exact: true }).click();
  await expect(data.getByRole('alert')).toContainText('Operation cancelled');
  await expect(page.locator('[data-toast-type="success"]').filter({ hasText: 'Secret data saved' })).toHaveCount(0);
  await expect(password.locator('.view-lines')).toContainText('latest');
  await page.evaluate(() => { (window as any).__cancelMutation = false; });
  await data.getByRole('button', { name: 'Save data', exact: true }).click();
  await expect(data.getByRole('status').filter({ hasText: /^Secret data saved$/ })).toBeVisible();
  await expect(page.locator('[data-toast-type="success"]').filter({ hasText: 'Secret data saved' })).toHaveCount(1);
  await expect(data.locator('.monaco-editor')).toHaveCount(0);
  const intents = await page.evaluate(() => (window as any).__dataIntents);
  expect(intents).toHaveLength(2);
  expect(intents[1].request.resource).toMatchObject({ context: 'test', kind: 'Secret', name: 'editor-secret', uid: 'secret-uid' });
  expect(intents[1].request.data.password).toBe(btoa('new-password\nlatest'));
  expect(JSON.parse(atob(intents[1].request.data['config.json']))).toEqual({ token: 'updated-token', count: 3 });
  expect(intents[1].request.data.binary).toBe('/wAB');
  expect(intents[1].request.data.empty).toBe('');
});

test('ConfigMap has independent editors with find, replace, undo, formatting and original annotation source', async ({ page }) => {
  await setup(page);
  const details = await openResource(page, 'ConfigMap', 'editor-config');
  const data = details.getByRole('region', { name: 'Configuration data', exact: true });
  const read = editor(data, 'Value for values.yaml');
  await expect(read.locator('.view-lines')).toContainText('replicas: 2');
  await read.getByRole('button', { name: 'Find in Value for values.yaml', exact: true }).click();
  await page.keyboard.type('replicas');
  await expect(read.locator('.find-widget')).toBeVisible();
  await expect(read.locator('.find-widget')).toContainText('1 of 1');
  await page.keyboard.press('Escape');
  await page.keyboard.insertText('SHOULD NOT CHANGE');
  await expect(read.locator('.view-lines')).not.toContainText('SHOULD NOT CHANGE');
  await data.getByRole('button', { name: 'Edit data', exact: true }).click();
  const yaml = editor(data, 'Value 1');
  await replaceAll(page, yaml, '# keep comment\nreplicas: 5\n');
  const json = editor(data, 'Value 2');
  await replaceAll(page, json, '{"enabled":false,"size":3}');
  await json.getByRole('button', { name: 'Format Value 2', exact: true }).click();
  await expect(json).toContainText('5 lines');
  await page.keyboard.press('Control+z');
  await expect(json).toContainText('1 line');
  await expect(yaml.locator('.view-lines')).toContainText('replicas: 5');
  await yaml.getByRole('button', { name: 'Replace in Value 1', exact: true }).click();
  await yaml.getByRole('textbox', { name: 'Find', exact: true }).fill('replicas: 5');
  await yaml.getByRole('textbox', { name: 'Replace', exact: true }).fill('replicas: 6');
  await yaml.getByRole('button', { name: /^Replace All/ }).click();
  await expect(yaml.locator('.view-lines')).toContainText('replicas: 6');
  await page.keyboard.press('Escape');
  await json.getByRole('button', { name: 'Copy Value 2', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__copied.at(-1))).toBe('{"enabled":false,"size":3}');
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
  await json.getByRole('button', { name: 'Copy Value 2', exact: true }).click();
  await expect(page.getByText('Clipboard unavailable', { exact: true })).toBeVisible();
  await data.getByRole('button', { name: 'Save ConfigMap', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__dataIntents.length)).toBe(1);
  await expect(page.locator('[data-toast-type="success"]').filter({ hasText: 'ConfigMap data saved' })).toHaveCount(1);
  const intent = await page.evaluate(() => (window as any).__dataIntents[0]);
  expect(intent).toMatchObject({ operation: 'action', resource: { context: 'test', kind: 'ConfigMap', name: 'editor-config' }, action: { type: 'config_map_data', data: { 'values.yaml': '# keep comment\nreplicas: 6\n', 'app.json': '{"enabled":false,"size":3}' } } });
  await details.getByText('Metadata & Object Spec', { exact: true }).click();
  const annotation = details.getByRole('article', { name: 'app/config', exact: true });
  await annotation.getByText('Original value', { exact: true }).click();
  await expect(editor(annotation, 'Original annotation app/config').locator('.view-lines')).toContainText('nested');
});

test('new resource manifest uses the code editor and stays in sync with identity fields', async ({ page }) => {
  await setup(page);
  await openResource(page, 'ConfigMap', 'editor-config');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New ConfigMap', exact: true });
  const manifest = editor(dialog, 'Manifest · YAML');
  await expect(manifest.locator('.view-lines')).toContainText('kind: ConfigMap');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('new-editor-config');
  await expect(manifest.locator('.view-lines')).toContainText('name: new-editor-config');
  await replaceAll(page, manifest, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: from-editor\n  namespace: apps\ndata:\n  key: new value\n');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('from-editor');
  await manifest.getByRole('button', { name: 'Find in Manifest · YAML', exact: true }).click();
  await page.keyboard.type('new value'); await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('new-editor-config');
  await dialog.getByRole('button', { name: 'Review & create', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__dataIntents.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__dataIntents[0])).toMatchObject({ operation: 'manifest', context: 'test', manifest: expect.stringContaining('name: new-editor-config') });
  await expect(page.locator('[data-toast-type="success"]').filter({ hasText: 'Resource created' })).toHaveCount(1);
});

test('Helm values viewer is searchable and upgrade values keep comments and edits', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Open Helm Releases', exact: true }).click();
  const row = page.getByRole('row', { name: 'Inspect Helm release web in apps', exact: true });
  await row.click();
  const details = page.getByTestId('inspector-panel').getByTestId('resource-details');
  await details.getByRole('tab', { name: 'Values', exact: true }).click();
  const values = editor(details, 'Helm values revision 2');
  await expect(values.locator('.line-numbers').first()).toBeVisible();
  await values.getByRole('button', { name: 'Find in Helm values revision 2', exact: true }).click();
  await page.keyboard.type('replicas');
  await expect(values.locator('.find-widget')).toContainText('1 of 1');
  await page.keyboard.press('Escape');
  await row.click({ button: 'right' });
  await page.getByRole('button', { name: 'Upgrade…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Upgrade Helm release', exact: true });
  const edit = editor(dialog, 'Helm values YAML');
  await expect(edit.locator('.view-lines')).toContainText('# retained comment');
  await replaceAll(page, edit, '# retained comment\nreplicas: 4\n');
  await edit.getByRole('button', { name: 'Format Helm values YAML', exact: true }).click();
  await expect(edit.locator('.view-lines')).toContainText('# retained comment');
  await dialog.getByRole('textbox', { name: 'Helm chart reference', exact: true }).fill('local/web');
  await captureScreenshot(page, { path: 'test-results/helm-values-code-editor.png' });
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__dataIntents.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__dataIntents[0])).toMatchObject({ operation: 'helm', request: { operation: 'upgrade', values: '# retained comment\nreplicas: 4\n', chart: 'local/web' } });
  await expect(page.locator('[data-toast-type="success"]').filter({ hasText: 'Helm release upgraded' })).toHaveCount(1);
});

test('data editing remains available when the advanced editor cannot load', async ({ page }) => {
  await page.route('**/*monaco_setup*', route => route.abort());
  await setup(page);
  const details = await openResource(page, 'Secret', 'editor-secret');
  const data = details.getByRole('region', { name: 'Secret data', exact: true });
  await data.getByRole('button', { name: 'Edit data', exact: true }).click();
  const value = editor(data, 'Value 2');
  await expect(value.getByRole('status')).toContainText('Editor unavailable');
  await value.getByRole('textbox', { name: 'Value 2', exact: true }).fill('fallback password');
  await data.getByRole('button', { name: 'Save data', exact: true }).click();
  await expect(data.getByRole('status').filter({ hasText: /^Secret data saved$/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__dataIntents[0].request.data.password)).toBe(btoa('fallback password'));
});

test('About identifies the author and supports finding the attribution in settings', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Settings categories', exact: true }).getByRole('button', { name: 'About', exact: true }).click();
  const about = page.getByRole('region', { name: 'Settings: About', exact: true });
  await expect(about).toContainText('Author:');
  await expect(about.getByRole('link', { name: 'JustYarick', exact: true })).toHaveAttribute('href', 'https://github.com/JustYarick');
  await page.getByRole('textbox', { name: 'Search settings', exact: true }).fill('JustYarick');
  await expect(page.getByRole('link', { name: 'JustYarick', exact: true })).toBeVisible();
});

test('RetriesExceeded resets Flux through the backend from both Helm ownership and custom resource details', async ({ page }) => {
  await setup(page, true);
  await page.getByRole('button', { name: 'Open Helm Releases', exact: true }).click();
  await page.getByRole('row', { name: 'Inspect Helm release web in apps', exact: true }).click();
  const details = page.getByTestId('inspector-panel').getByTestId('resource-details');
  const retry = details.getByRole('button', { name: 'Retry Helm release', exact: true });
  await expect(retry).toBeEnabled();
  await page.evaluate(() => { (window as any).__cancelMutation = true; });
  await retry.click();
  await expect(retry).toBeEnabled();
  await expect(page.locator('[data-toast-type="success"]')).toHaveCount(0);
  await details.getByRole('button', { name: 'apps/flux-owner', exact: true }).click();
  await expect(details).toContainText('RetriesExceeded');
  await expect(retry).toBeEnabled();
  await page.evaluate(() => { (window as any).__cancelMutation = false; });
  await retry.click();
  await expect(page.locator('[data-toast-type="success"]')).toContainText('Flux Helm retry requested');
  await expect(details.getByRole('button', { name: 'Retry requested', exact: true })).toBeDisabled();
  const intents = await page.evaluate(() => (window as any).__dataIntents);
  expect(intents).toHaveLength(2);
  expect(intents[1]).toEqual({ operation: 'action', resource: { context: 'test', group: 'helm.toolkit.fluxcd.io', version: 'v2', kind: 'HelmRelease', namespace: 'apps', name: 'flux-owner', uid: 'flux-uid' }, resource_version: '5', action: { type: 'flux_retry' } });
});

test('deleting from the table reports one receipt only after backend execution, with resource and context', async ({ page }) => {
  await setup(page);
  await openResource(page, 'ConfigMap', 'editor-config');
  await page.getByTestId('resource-table').getByText('editor-config', { exact: true }).click({ button: 'right' });
  await page.getByRole('group', { name: 'Actions', exact: true }).getByRole('button', { name: /Delete…/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__dataIntents.length)).toBe(1);
  await expect(page.locator('[data-toast-type="success"]')).toHaveCount(0);
  await page.evaluate(() => (window as any).__finishDeletion());
  const receipt = page.locator('[data-toast-type="success"]');
  await expect(receipt).toHaveCount(1);
  await expect(receipt).toContainText('Resource deletion accepted');
  await expect(receipt).toContainText('ConfigMap apps/editor-config');
  await expect(receipt).toContainText('Cluster: test');
});
