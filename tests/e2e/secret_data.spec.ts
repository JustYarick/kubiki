import { captureScreenshot } from './helpers/screenshots';
import { test, expect } from '@playwright/test';
async function setup(page: import('@playwright/test').Page, mode = '') {
  await page.addInitScript(({ mode }) => {
    const w = window as any;
    let secret: any = { apiVersion: 'v1', kind: 'Secret', metadata: { uid: 'secret-uid', name: 'credentials', namespace: 'default', resourceVersion: '10' }, type: 'Opaque', immutable: mode === 'immutable', data: { password: 'c2VjcmV0', binary: '/wAB', empty: '' } };
    w.__secretWrites = [];
    w.__changeSecret = () => { secret = { ...secret, metadata: { ...secret.metadata, resourceVersion: '12' } }; };
    w.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      if (command === 'get_kube_contexts') return [{ name: 'test', cluster: 'test', user: 'tester', is_current: true }];
      if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
      if (command === 'get_namespaces') return ['default'];
      if (command === 'get_api_resources') return 'secrets <none> v1 true Secret get,list';
      if (command === 'get_resources') return { items: args.kind === 'Secret' ? [secret] : [] };
      if (command.startsWith('stop_')) return;
      if (command === 'mutate_resource' && args.request.operation === 'secret') {
        const body = args.request.request; w.__secretWrites.push({ url: 'native:mutate_resource', body });
        if (mode === 'denied' || mode === 'conflict' || mode === 'cancelled') throw { code: mode === 'denied' ? 'forbidden' : mode === 'cancelled' ? 'cancelled' : 'conflict', message: mode === 'denied' ? 'Secret update forbidden' : mode === 'cancelled' ? 'Operation cancelled' : 'Secret changed; reload before editing again', status: mode === 'denied' ? 403 : 409, retryable: false };
        secret = { ...secret, data: body.data, metadata: { ...secret.metadata, resourceVersion: '11' } }; return secret;
      }
      throw new Error(`Unexpected command ${command}`);
    } };
  }, { mode });
  const writes = () => page.evaluate(() => (window as any).__secretWrites as any[]);
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByRole('button', { name: /^Secrets(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByTitle('credentials', { exact: true }).click();
  return { editor: page.getByRole('region', { name: 'Secret data', exact: true }), writes, change: () => page.evaluate(() => (window as any).__changeSecret()) };
}
test('Secret editor automatically encodes Unicode and preserves binary, adds and deletes separate rows', async ({ page }) => {
  const { editor, writes } = await setup(page);
  await expect(editor).not.toContainText('secret');
  await editor.getByRole('button', { name: 'Reveal values' }).click();
  await expect(editor.locator('pre').first()).toHaveText('secret');
  await editor.getByRole('button', { name: 'Base64', exact: true }).click();await expect(editor.locator('pre').first()).toHaveText('c2VjcmV0');
  await editor.getByRole('button', { name: 'Text', exact: true }).click();await expect(editor.locator('pre').first()).toHaveText('secret');
  await editor.getByRole('button', { name: 'Edit data' }).click();
  await expect(editor.getByLabel('Value 1', { exact: true })).toHaveValue('secret');
  await expect(editor.getByText('Binary · base64', { exact: true })).toBeVisible();
  await expect(editor.getByRole('combobox')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Base64', exact: true }).click();
  await expect(editor.getByLabel('Value 1', { exact: true })).toHaveValue('c2VjcmV0');
  await editor.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(editor.getByLabel('Value 1', { exact: true })).toHaveValue('secret');
  await editor.getByLabel('Value 1', { exact: true }).fill('Привет 🌍\nsecond line');
  await editor.getByRole('button', { name: 'Remove key 3', exact: true }).click();
  await editor.getByRole('button', { name: 'Add key', exact: true }).click();
  await expect(editor.getByLabel('Key 3', { exact: true })).toBeFocused();
  await editor.getByLabel('Key 3', { exact: true }).fill('new.key');
  await editor.getByLabel('Value 3', { exact: true }).fill('new value');
  await editor.getByRole('button', { name: 'Save data', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('Secret data saved');
  expect(await writes()).toHaveLength(1);
  expect((await writes())[0].body).toMatchObject({ resource: { uid: 'secret-uid', context: 'test', namespace: 'default', kind: 'Secret' }, resource_version: '10', data: { password: Buffer.from('Привет 🌍\nsecond line').toString('base64'), binary: '/wAB', 'new.key': 'bmV3IHZhbHVl' } });
  expect((await writes())[0].body.data).not.toHaveProperty('empty'); expect((await writes())[0].url).not.toContain('password');
  await expect(editor).not.toContainText('new value');
  await page.setViewportSize({ width: 900, height: 900 });await editor.getByRole('button', { name: 'Edit data' }).click();await captureScreenshot(page, { path: 'test-results/secret-editor.png' });
});
for (const mode of ['denied', 'conflict', 'cancelled']) test(`Secret ${mode} retains draft, and invalid keys never reach transport`, async ({ page }) => {
  const { editor, writes } = await setup(page, mode);await editor.getByRole('button', { name: 'Edit data' }).click();
  await editor.getByLabel('Key 1', { exact: true }).fill('bad/key');await editor.getByRole('button', { name: 'Save data' }).click();await expect(editor.getByRole('alert')).toContainText('Keys must');await expect(editor.getByLabel('Key 1', { exact: true })).toBeFocused();await expect(editor.getByLabel('Key 1', { exact: true })).toHaveAttribute('aria-invalid', 'true');expect(await writes()).toHaveLength(0);
  await editor.getByLabel('Key 1', { exact: true }).fill('password');await editor.getByLabel('Value 1', { exact: true }).fill('my draft');await editor.getByRole('button', { name: 'Save data' }).click();await expect(editor.getByRole('alert')).toContainText(mode === 'denied' ? 'forbidden' : mode === 'cancelled' ? 'cancelled' : 'changed');await expect(editor.getByLabel('Value 1', { exact: true })).toHaveValue('my draft');await editor.getByRole('button', { name: 'Cancel', exact: true }).click();await expect(editor.getByRole('textbox')).toHaveCount(0);
});
test('immutable Secret can be revealed but cannot be edited', async ({ page }) => {
  const { editor } = await setup(page, 'immutable');await expect(editor.getByRole('button', { name: 'Edit data' })).toBeDisabled();await editor.getByRole('button', { name: 'Reveal values' }).click();await expect(editor.locator('pre').first()).toHaveText('secret');
});

test('watch/snapshot updates preserve the Secret draft and block stale saves', async ({ page }) => {
  const { editor, writes, change } = await setup(page);await editor.getByRole('button', { name: 'Edit data' }).click();await editor.getByLabel('Value 1', { exact: true }).fill('unsaved draft');
  await change();await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();await expect(editor.getByRole('alert')).toContainText('changed while editing');await expect(editor.getByLabel('Value 1', { exact: true })).toHaveValue('unsaved draft');await expect(editor.getByRole('button', { name: 'Save data' })).toBeDisabled();expect(await writes()).toHaveLength(0);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();await editor.getByRole('button', { name: 'Edit data' }).click();await expect(editor.getByLabel('Value 1', { exact: true })).toHaveValue('secret');
});
