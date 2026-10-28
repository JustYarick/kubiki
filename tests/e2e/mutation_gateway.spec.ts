import { test, expect } from '@playwright/test';

test('cancelled backend review preserves YAML draft and resource row; saves and deletes share exact identity', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'team', uid: 'original', resourceVersion: '10' }, spec: { replicas: 1 } };
    w.__mutationIntents = [];
    w.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      if (command === 'get_kube_contexts') return [{ name: 'prod', is_current: true }];
      if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
      if (command === 'get_namespaces') return ['team'];
      if (command === 'get_api_resources') return 'deployments deploy apps/v1 true Deployment get,list';
      if (command === 'get_resources') return { items: args.kind === 'Deployment' ? [deployment] : [] };
      if (command.startsWith('stop_')) return;
      if (command === 'mutate_resource' || command === 'delete_resource') {
        w.__mutationIntents.push({ command, request: args.request });
        throw { code: 'cancelled', message: 'Operation cancelled. Nothing was changed', retryable: false };
      }
      throw new Error(`Unexpected command ${command}`);
    } };
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Deployments(?: \d+)?$/ }).click();
  const row = page.getByTestId('resource-table').getByTitle('web', { exact: true }); await row.click();
  const details = page.getByTestId('resource-details');
  await details.getByRole('tab', { name: 'YAML', exact: true }).click();
  const editor = details.getByTestId('yaml-editor'); await expect(editor.locator('.monaco-editor')).toBeVisible();
  await editor.getByRole('button', { name: 'Find', exact: true }).click(); await page.keyboard.type('replicas: 1'); await page.keyboard.press('Escape'); await page.keyboard.insertText('replicas: 3');
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await expect(editor.locator('.view-lines')).toContainText('replicas: 3');
  await expect.poll(() => page.evaluate(() => (window as any).__mutationIntents.length)).toBe(1);
  await row.click({ button: 'right' }); await page.getByRole('group', { name: 'Actions', exact: true }).getByRole('button', { name: /Delete…/ }).click();
  // No renderer dialog: the backend review is the only confirmation.
  await expect.poll(() => page.evaluate(() => (window as any).__mutationIntents.length)).toBe(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row).toBeVisible();
  const intents = await page.evaluate(() => (window as any).__mutationIntents);
  const resource = { context: 'prod', group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'team', name: 'web', uid: 'original' };
  expect(intents[0]).toMatchObject({ command: 'mutate_resource', request: { operation: 'manifest', context: 'prod', target: { resource, resource_version: '10' } } });
  expect(intents[0].request.manifest).toContain('replicas: 3');
  expect(intents[1]).toEqual({ command: 'delete_resource', request: { operation: 'resource', resource, resource_version: '10' } });
  expect(JSON.stringify(intents)).not.toMatch(/confirmed|approved/);
});
