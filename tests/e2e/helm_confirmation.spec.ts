import { expect, test } from '@playwright/test';
import { captureScreenshot } from './helpers/screenshots';

test('Helm uninstall opens one concise confirmation, can be cancelled, and remains usable after two minutes', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const w = window as any;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number>();
    let next = 0;
    let removed = false;
    let decide: ((approved: boolean) => void) | undefined;
    w.__helmMutationIntents = [];
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++next, callback); return next; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return args.handler; }
        if (command === 'plugin:event|unlisten') return;
        if (command === 'get_kube_contexts') return [{ name: 'production', is_current: true }];
        if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
        if (command === 'get_namespaces') return ['apps'];
        if (command === 'get_api_resources') return '';
        if (command === 'get_resources') return { items: [] };
        if (command === 'get_helm_inventory') return removed ? [] : [{ name: 'web', namespace: 'apps', revision: '2', updated: '', status: 'deployed', chart: 'web-1', app_version: '1' }];
        if (command === 'get_helm_history' || command === 'list_helm_repositories') return [];
        if (command === 'get_helm_content') return '{}\n';
        if (command.startsWith('stop_') || command === 'watch_resources' || command === 'ack_resources' || command === 'cancel_read_task') return;
        if (command === 'mutate_resource') {
          w.__helmMutationIntents.push(args.request);
          const request = args.request.request;
          return new Promise((resolve, reject) => {
            decide = approved => {
              if (approved) { removed = true; resolve({}); }
              else reject({ code: 'cancelled', message: 'Helm operation cancelled; nothing changed', retryable: false });
            };
            const handler = listeners.get('mutation-confirm-request');
            if (!handler) throw new Error('Confirmation listener is not registered');
            callbacks.get(handler)!({ event: 'mutation-confirm-request', id: handler, payload: {
              id: `helm-${w.__helmMutationIntents.length}`,
              resource: { context: request.context, group: 'helm.sh', version: 'v1', kind: 'HelmRelease', namespace: request.namespace, name: request.name, uid: null },
              review: `Uninstall release ${request.name} and remove its managed Kubernetes resources.`,
              simple: { title: 'Uninstall Helm release?', confirm_label: 'Uninstall', destructive: true },
            } });
          });
        }
        if (command === 'resolve_mutation_confirm') { decide?.(args.approved); return true; }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByRole('button', { name: 'Open Helm Releases', exact: true }).click();
  const row = page.getByRole('row', { name: 'Inspect Helm release web in apps', exact: true });
  await row.click({ button: 'right' });
  await page.getByRole('button', { name: 'Uninstall…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Uninstall Helm release?', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(dialog).toContainText('production');
  await expect(dialog).toContainText('apps');
  await expect(dialog.locator('pre')).toHaveCount(0);
  await expect(dialog).not.toContainText(/review|expires|2 minutes/i);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();

  await row.click({ button: 'right' });
  await page.getByRole('button', { name: 'Uninstall…', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.clock.runFor(180000);
  await expect(dialog).toBeVisible();
  await captureScreenshot(page, { path: 'test-results/helm-simple-confirmation.png' });
  await dialog.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  const intents = await page.evaluate(() => (window as any).__helmMutationIntents);
  expect(intents).toHaveLength(2);
  expect(intents[1]).toEqual({ operation: 'helm', request: { operation: 'uninstall', context: 'production', namespace: 'apps', name: 'web', keep_history: false, run_hooks: false } });
});
