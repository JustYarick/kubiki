import { test, expect, type Page } from '@playwright/test';

const metadata = (name: string, namespace?: string) => ({ name, namespace, uid: `${namespace ?? 'cluster'}/${name}` });
const lists: Record<string, object[]> = {
  Namespace: [{ metadata: metadata('backend') }],
  Deployment: [{ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { ...metadata('web', 'backend'), managedFields: [{ manager: 'kubectl' }] }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'app', image: 'nginx', envFrom: [{ secretRef: { name: 'settings' } }] }] } } }, status: { readyReplicas: 1 } }],
  Secret: [{ metadata: metadata('settings', 'backend'), data: {} }],
  Node: [{ metadata: metadata('worker'), status: { capacity: { memory: '4009156Ki', cpu: '4', pods: '110' }, allocatable: { memory: '3900000Ki', cpu: '3500m', pods: '110' } } }],
  Event: [{ metadata: metadata('notice', 'backend'), reason: 'Scheduled', message: 'Pod scheduled' }],
  CustomResourceDefinition: [{ metadata: metadata('widgets.example.com'), spec: { group: 'example.com', names: { kind: 'Widget', plural: 'widgets' }, scope: 'Namespaced' } }],
};
async function api(page: Page) {
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['backend'] });
    return route.fulfill({ json: { items: lists[url.searchParams.get('kind') ?? ''] ?? [] } });
  });
}
async function select(page: Page, kind: string, name: string) {
  await page.getByTestId('explorer-panel').getByRole('button', { name: new RegExp(`^${kind}(?: \\d+)?$`) }).click();
  await page.getByTestId('resource-table').getByText(name, { exact: true }).first().click();
}

test('Namespace and Secret show consumers; Node quantities are readable and Event has no Used by', async ({ page }) => {
  await api(page); await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await select(page, 'Namespaces', 'backend');
  const details = page.getByTestId('resource-details');
  const usedBy = details.getByRole('region', { name: 'Used by', exact: true });
  await expect(usedBy).toContainText('Used by (2 consumers)');
  await expect(usedBy.getByRole('button', { name: /Secret settings/ })).toBeVisible();
  await usedBy.getByRole('button', { name: /Secret settings/ }).click();
  await expect(usedBy.getByRole('button', { name: /Deployment web/ })).toBeVisible();
  await select(page, 'Nodes', 'worker');
  await expect(details.getByRole('region', { name: 'Node capacity and allocatable resources' })).toContainText('3.82 GiB');
  await expect(details).not.toContainText('4009156Ki');
  await expect(details.getByRole('region', { name: 'Pods on this node' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/node-readable-quantities.png' });
  await select(page, 'Events', 'notice');
  await expect(usedBy).toHaveCount(0);
});

test('CRD Used by loads real instances and reports permission errors with retry', async ({ page }) => {
  await api(page);
  let denied = true;
  await page.route('**/api/k8s/custom-resources?**', route => denied
    ? route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Widgets cannot be listed', status: 403 } } })
    : route.fulfill({ json: { items: [{ apiVersion: 'example.com/v1', kind: 'Widget', metadata: metadata('widget-one', 'backend') }] } }));
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await select(page, 'Definitions', 'widgets.example.com');
  const usedBy = page.getByTestId('resource-details').getByRole('region', { name: 'Used by', exact: true });
  await expect(usedBy.getByRole('alert')).toContainText('Widgets cannot be listed');
  await expect(usedBy).not.toContainText('No instances');
  denied = false; await usedBy.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(usedBy).toContainText('Used by (1 instance)');
  await expect(usedBy.getByText('widget-one', { exact: true })).toBeVisible();
});

test('YAML starts clean and view switches preserve edits without enabling Apply by themselves', async ({ page }) => {
  await api(page); await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await select(page, 'Deployments', 'web');
  const details = page.getByTestId('resource-details');
  await details.getByRole('tab', { name: 'YAML', exact: true }).click();
  const editor = details.getByTestId('yaml-editor');
  await expect(editor.locator('.monaco-editor')).toBeVisible();
  const fields = editor.getByRole('button', { name: 'Show server fields', exact: true });
  const apply = editor.getByRole('button', { name: 'Apply', exact: true });
  await expect(fields).toHaveAttribute('aria-pressed', 'false');
  await expect(editor.locator('.view-lines')).not.toContainText('managedFields');
  await expect(apply).toBeDisabled();
  await fields.click();
  await expect(editor.locator('.view-lines')).toContainText('managedFields');
  await expect(apply).toBeDisabled();
  await fields.click(); await expect(apply).toBeDisabled();
  await editor.getByRole('button', { name: 'Find', exact: true }).click();
  await page.keyboard.type('replicas: 1');
  await page.keyboard.press('Escape');
  await page.keyboard.insertText('replicas: 3');
  await expect(editor.getByText('Unsaved edits', { exact: true })).toBeVisible();
  await fields.click();
  await expect(editor.locator('.view-lines')).toContainText('replicas: 3');
  await expect(editor.locator('.view-lines')).toContainText('managedFields');
  await fields.click();
  await expect(editor.locator('.view-lines')).toContainText('replicas: 3');
  await expect(apply).toBeEnabled();
  await editor.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(apply).toBeDisabled();
  await expect(fields).toHaveAttribute('aria-pressed', 'false');
});

test('bottom panel can be resized beyond half the viewport', async ({ page }) => {
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+j');
  const handle = page.getByRole('separator', { name: 'Resize bottom panel', exact: true });
  await expect(handle).toBeVisible();
  const before = await handle.boundingBox();
  await handle.focus();
  for (let index = 0; index < 12; index++) await handle.press('Shift+ArrowUp');
  expect((await handle.boundingBox())!.y).toBeLessThan(900 / 2);
  expect((await handle.boundingBox())!.y).toBeLessThan(before!.y - 150);
});
