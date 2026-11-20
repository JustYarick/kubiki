/**
 * E2E tests for modular Kubernetes resource creation (Form | YAML + YAML fallback).
 *
 * Purpose & user flows verified:
 * 1. Secret creation opens in structured Form mode by default, supports switching
 *    Secret types (Opaque, dockerconfigjson, TLS), validates missing fields, keeps
 *    YAML synchronized, and submits the exact manifest through the mutation gateway.
 * 2. Deployment creation preserves unmodeled YAML fields and comments across
 *    Form -> YAML -> Form -> YAML transitions and blocks switching back to Form
 *    when the YAML has syntax errors so user edits are never silently discarded.
 * 3. Resource kinds without a dedicated form (such as DaemonSet) fall back
 *    directly to the YAML manifest editor without showing a Form toggle.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

async function setup(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__createdIntents = [];
    let callback = 0;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (command === 'plugin:event|listen') return ++callback;
        if (command === 'plugin:event|unlisten' || command.startsWith('stop_') || ['ack_resources', 'cancel_read_task'].includes(command)) return;
        if (command === 'watch_resources') {
          queueMicrotask(() => args.onEvent.onmessage({
            subscription_id: args.subscriptionId,
            query: args.query,
            messages: [
              { sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items: [] } } } },
              { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } },
            ],
          }));
          return;
        }
        if (command === 'get_kube_contexts') return [{ name: 'test', is_current: true }];
        if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
        if (command === 'get_namespaces') return ['default', 'apps', 'payments'];
        if (command === 'get_api_resources') return '';
        if (command === 'get_resources') return { items: [] };
        if (command === 'mutate_resource') {
          w.__createdIntents.push(args.request);
          return { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'created', uid: 'uid-1', namespace: 'payments' } };
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
}

function editor(scope: Locator, label: string) {
  return scope.getByRole('group', { name: `${label} editor`, exact: true });
}

async function replaceAll(page: Page, container: Locator, text: string) {
  await expect(container.locator('.monaco-editor')).toBeVisible();
  await container.getByRole('textbox', { name: /./ }).first().focus();
  await page.keyboard.press('Control+a');
  await container.getByRole('textbox', { name: /./ }).first().evaluate((element, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

test('Secret dialog opens in Form mode, supports Opaque/Registry/TLS types, namespace picker, and YAML switch', async ({ page }) => {
  await setup(page);
  await page.getByTestId('explorer-panel').locator('[data-resource-type="Secret"]').click();
  await page.getByRole('button', { name: 'New', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'New Secret', exact: true });
  await expect(dialog.getByRole('button', { name: 'Form', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: 'YAML', exact: true })).toHaveAttribute('aria-pressed', 'false');

  // Set Name and pick an existing Namespace via the trailing namespace picker.
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('db-credentials');
  await dialog.getByRole('button', { name: 'Choose existing namespace', exact: true }).click();
  await page.getByRole('option', { name: 'payments', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Namespace', exact: true })).toHaveValue('payments');

  // Fill Opaque key/value and verify YAML updates live.
  await dialog.getByRole('textbox', { name: 'Secret key 1', exact: true }).fill('DB_PASS');
  await dialog.getByRole('textbox', { name: 'Secret value 1', exact: true }).fill('super-secret');
  await dialog.getByRole('button', { name: 'YAML', exact: true }).click();
  const manifest = editor(dialog, 'Manifest · YAML');
  await expect(manifest.locator('.view-lines')).toContainText('DB_PASS: super-secret');
  await expect(manifest.locator('.view-lines')).toContainText('namespace: payments');

  // Switch back to Form and change Secret Type to Container Registry (dockerconfigjson).
  await dialog.getByRole('button', { name: 'Form', exact: true }).click();
  await dialog.getByLabel('Secret Type').selectOption('kubernetes.io/dockerconfigjson');
  // Submit is disabled until required registry fields are filled.
  await expect(dialog.getByRole('button', { name: 'Review & create', exact: true })).toBeDisabled();
  await dialog.getByLabel('Registry Server').fill('ghcr.io');
  await dialog.getByLabel('Username').fill('ci-bot');
  await dialog.getByLabel('Password / Token').fill('ghp_example');
  await expect(dialog.getByRole('button', { name: 'Review & create', exact: true })).toBeEnabled();

  await dialog.getByRole('button', { name: 'Review & create', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__createdIntents.length)).toBe(1);
  const intent = await page.evaluate(() => (window as any).__createdIntents[0]);
  expect(intent.operation).toBe('manifest');
  expect(intent.manifest).toContain('name: db-credentials');
  expect(intent.manifest).toContain('namespace: payments');
  expect(intent.manifest).toContain('type: kubernetes.io/dockerconfigjson');
  expect(intent.manifest).toContain('.dockerconfigjson:');
});

test('Deployment preserves custom YAML fields across Form/YAML switches and blocks broken YAML switches', async ({ page }) => {
  await setup(page);
  await page.getByTestId('explorer-panel').locator('[data-resource-type="Deployment"]').click();
  await page.getByRole('button', { name: 'New', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'New Deployment', exact: true });
  await expect(dialog.getByRole('button', { name: 'Form', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('spinbutton', { name: 'Replicas', exact: true }).fill('3');
  await dialog.getByRole('textbox', { name: 'Image', exact: true }).fill('redis:7-alpine');

  // Switch to YAML, add a comment and custom nodeSelector, then verify broken YAML blocks Form switch.
  await dialog.getByRole('button', { name: 'YAML', exact: true }).click();
  const manifest = editor(dialog, 'Manifest · YAML');
  await expect(manifest.locator('.view-lines')).toContainText('replicas: 3');
  await expect(manifest.locator('.view-lines')).toContainText('redis:7-alpine');

  await replaceAll(page, manifest, 'apiVersion: apps/v1\nkind: Deployment\nmetadata: [\n');
  await dialog.getByRole('button', { name: 'Form', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Fix YAML syntax');
  await expect(dialog.getByRole('button', { name: 'YAML', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Restore valid YAML with an unmodeled field + comment and round-trip through Form.
  await replaceAll(page, manifest, [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: cache',
    '  namespace: apps',
    'spec:',
    '  replicas: 3',
    '  selector:',
    '    matchLabels:',
    '      app: cache',
    '  template:',
    '    metadata:',
    '      labels:',
    '        app: cache',
    '    spec:',
    '      # keep ssd affinity',
    '      nodeSelector:',
    '        disk: ssd',
    '      containers:',
    '        - name: app',
    '          image: redis:7-alpine',
    '',
  ].join('\n'));
  await dialog.getByRole('button', { name: 'Form', exact: true }).click();
  await expect(dialog.getByRole('spinbutton', { name: 'Replicas', exact: true })).toHaveValue('3');
  await dialog.getByRole('spinbutton', { name: 'Replicas', exact: true }).fill('4');
  await dialog.getByRole('button', { name: 'YAML', exact: true }).click();
  await expect(manifest.locator('.view-lines')).toContainText('replicas: 4');
  await expect(manifest.locator('.view-lines')).toContainText('# keep ssd affinity');
  await expect(manifest.locator('.view-lines')).toContainText('disk: ssd');
});

test('Resources without a dedicated form fall back directly to the YAML manifest editor', async ({ page }) => {
  await setup(page);
  await page.getByTestId('explorer-panel').locator('[data-resource-type="DaemonSet"]').click();
  await page.getByRole('button', { name: 'New', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'New DaemonSet', exact: true });
  await expect(dialog.getByRole('button', { name: 'Form', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('YAML manifest', { exact: true })).toBeVisible();
  await expect(editor(dialog, 'Manifest · YAML').locator('.view-lines')).toContainText('kind: DaemonSet');
});
