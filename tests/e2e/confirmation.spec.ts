import { expect, test } from '@playwright/test';

test('all resource confirmations are compact and have no expiry; only YAML shows a diff', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const w = window as any;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number>();
    let next = 0;
    w.__decisions = [];
    w.__emitConfirmation = (payload: unknown) => {
      const handler = listeners.get('mutation-confirm-request');
      if (!handler) throw new Error('Confirmation listener is not ready');
      callbacks.get(handler)!({ event: 'mutation-confirm-request', id: handler, payload });
    };
    w.__confirmationReady = () => listeners.has('mutation-confirm-request');
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++next, callback); return next; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return args.handler; }
        if (command === 'plugin:event|unlisten' || command.startsWith('stop_')) return;
        if (command === 'resolve_mutation_confirm') { w.__decisions.push(args); return true; }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
  await page.goto('/?demo=1');
  await expect.poll(() => page.evaluate(() => (window as any).__confirmationReady())).toBe(true);
  const resource = { context: 'testbed', group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'apps', name: 'web', uid: 'original' };
  const cases = [
    { id: 'delete', resource, review: 'Delete this Deployment and its dependent resources.', simple: { title: 'Delete resource?', confirm_label: 'Delete', destructive: true } },
    { id: 'action', resource, review: 'Old detailed review with resourceVersion and metadata', details: { kind: 'action', steps: [{ operation: 'SCALE', resource, summary: 'Scale from 3 to 0 replicas.', diff: 'Full object details must not be displayed' }], warnings: [] } },
    { id: 'batch', resource, review: 'Old list of all operation targets', details: { kind: 'batch', steps: [{ operation: 'DELETE', resource, summary: 'Delete resource', diff: 'Old object diff' }, { operation: 'RESTART', resource, summary: 'Restart workload' }], warnings: [] } },
  ];
  for (const request of cases) {
    await page.evaluate(request => (window as any).__emitConfirmation(request), request);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveCount(1);
    await expect(dialog).toContainText('testbed');
    await expect(dialog).toContainText('apps');
    await expect(dialog.locator('pre, ol')).toHaveCount(0);
    await expect(dialog).not.toContainText(/Review Changes|expires|resourceVersion|Old list|Full object/i);
    await page.clock.runFor(180000);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  const diff = '/spec/replicas: BEFORE 3 → AFTER 0';
  await page.evaluate(request => (window as any).__emitConfirmation(request), { id: 'yaml', resource, review: 'Edited manifest', details: { kind: 'yaml', steps: [{ operation: 'UPDATE', resource, summary: 'Apply YAML', diff }], warnings: [] } });
  const yaml = page.getByRole('dialog', { name: 'Apply YAML changes?', exact: true });
  await expect(yaml.getByLabel('YAML changes', { exact: true })).toHaveText(diff);
  await page.clock.runFor(180000);
  await expect(yaml).toBeVisible();
  await yaml.getByRole('button', { name: 'Apply YAML', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__decisions)).toEqual([
    { id: 'delete', approved: false }, { id: 'action', approved: false }, { id: 'batch', approved: false }, { id: 'yaml', approved: true },
  ]);
});
