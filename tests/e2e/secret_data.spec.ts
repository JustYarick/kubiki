import { test, expect } from '@playwright/test';
async function setup(page: import('@playwright/test').Page, mode = '') {
  let secret: any = { apiVersion: 'v1', kind: 'Secret', metadata: { uid: 'secret-uid', name: 'credentials', namespace: 'default', resourceVersion: '10' }, type: 'Opaque', immutable: mode === 'immutable', data: { password: 'c2VjcmV0', binary: '/wAB', empty: '' } };
  const writes: any[] = [];
  await page.route('**/api/k8s/**', async route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/').pop();
    let data: any = {};
    if (op === 'contexts') data = [{ name: 'test', cluster: 'test', user: 'tester', is_current: true }];
    if (op === 'ping') data = { version: { gitVersion: 'v1.35.0' } };
    if (op === 'namespaces') data = ['default'];
    if (op === 'resources') data = { items: url.searchParams.get('kind') === 'Secret' ? [secret] : [] };
    if (op === 'secrets') {
      writes.push({ url: url.toString(), body: route.request().postDataJSON() });
      if (mode === 'denied' || mode === 'conflict') return route.fulfill({ status: mode === 'denied' ? 403 : 409, json: { error: { code: mode === 'denied' ? 'forbidden' : 'conflict', message: mode === 'denied' ? 'Secret update forbidden' : 'Secret changed; reload before editing again', status: mode === 'denied' ? 403 : 409, retryable: false } } });
      secret = { ...secret, data: writes.at(-1).body.data, metadata: { ...secret.metadata, resourceVersion: '11' } }; data = secret;
    }
    await route.fulfill({ json: data });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Secrets(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByTitle('credentials', { exact: true }).click();
  return { editor: page.getByRole('region', { name: 'Secret data', exact: true }), writes, change: () => { secret = { ...secret, metadata: { ...secret.metadata, resourceVersion: '12' } }; } };
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
  await editor.getByLabel('Key 3', { exact: true }).fill('new.key');
  await editor.getByLabel('Value 3', { exact: true }).fill('new value');
  await editor.getByRole('button', { name: 'Save data', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('Secret data saved');
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({ resource: { uid: 'secret-uid', context: 'test', namespace: 'default', kind: 'Secret' }, resource_version: '10', data: { password: Buffer.from('Привет 🌍\nsecond line').toString('base64'), binary: '/wAB', 'new.key': 'bmV3IHZhbHVl' } });
  expect(writes[0].body.data).not.toHaveProperty('empty'); expect(writes[0].url).not.toContain('password');
  await expect(editor).not.toContainText('new value');
  await page.setViewportSize({ width: 900, height: 900 });await editor.getByRole('button', { name: 'Edit data' }).click();await page.screenshot({ path: 'test-results/secret-editor.png' });
});
for (const mode of ['denied', 'conflict']) test(`Secret ${mode} retains draft, and invalid keys never reach transport`, async ({ page }) => {
  const { editor, writes } = await setup(page, mode);await editor.getByRole('button', { name: 'Edit data' }).click();
  await editor.getByLabel('Key 1', { exact: true }).fill('bad/key');await editor.getByRole('button', { name: 'Save data' }).click();await expect(editor.getByRole('alert')).toContainText('Keys must');expect(writes).toHaveLength(0);
  await editor.getByLabel('Key 1', { exact: true }).fill('password');await editor.getByLabel('Value 1', { exact: true }).fill('my draft');await editor.getByRole('button', { name: 'Save data' }).click();await expect(editor.getByRole('alert')).toContainText(mode === 'denied' ? 'forbidden' : 'changed');await expect(editor.getByLabel('Value 1', { exact: true })).toHaveValue('my draft');await editor.getByRole('button', { name: 'Cancel', exact: true }).click();await expect(editor.getByRole('textbox')).toHaveCount(0);
});
test('immutable Secret can be revealed but cannot be edited', async ({ page }) => {
  const { editor } = await setup(page, 'immutable');await expect(editor.getByRole('button', { name: 'Edit data' })).toBeDisabled();await editor.getByRole('button', { name: 'Reveal values' }).click();await expect(editor.locator('pre').first()).toHaveText('secret');
});

test('watch/snapshot updates preserve the Secret draft and block stale saves', async ({ page }) => {
  const { editor, writes, change } = await setup(page);await editor.getByRole('button', { name: 'Edit data' }).click();await editor.getByLabel('Value 1', { exact: true }).fill('unsaved draft');
  change();await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();await expect(editor.getByRole('alert')).toContainText('changed while editing');await expect(editor.getByLabel('Value 1', { exact: true })).toHaveValue('unsaved draft');await expect(editor.getByRole('button', { name: 'Save data' })).toBeDisabled();expect(writes).toHaveLength(0);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();await editor.getByRole('button', { name: 'Edit data' }).click();await expect(editor.getByLabel('Value 1', { exact: true })).toHaveValue('secret');
});
