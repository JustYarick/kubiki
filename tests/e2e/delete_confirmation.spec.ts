import { test, expect } from '@playwright/test';

test('delete enters the single backend confirmation gateway without a renderer prompt', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'web-frontend',
        namespace: 'team',
        uid: 'dep-uid-100',
        resourceVersion: '42',
        creationTimestamp: '2026-10-21T18:00:00Z',
        labels: { app: 'web-frontend', env: 'production' },
      },
      spec: { replicas: 3 },
      status: { readyReplicas: 3 },
    };
    const crd = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: {
        name: 'buckets.source.toolkit.fluxcd.io',
        uid: 'crd-uid-100',
        resourceVersion: '12',
        creationTimestamp: '2026-10-20T12:00:00Z',
      },
      spec: {
        group: 'source.toolkit.fluxcd.io',
        names: { kind: 'Bucket', plural: 'buckets' },
        scope: 'Namespaced',
      },
    };

    w.__deleted = [];
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (command === 'get_kube_contexts') return [{ name: 'prod', is_current: true }];
        if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
        if (command === 'get_namespaces') return ['team'];
        if (command === 'get_api_resources') {
          return 'deployments deploy apps/v1 true Deployment get,list\ncustomresourcedefinitions crd,crds apiextensions.k8s.io/v1 false CustomResourceDefinition get,list';
        }
        if (command === 'get_custom_resources') return [crd];
        if (command === 'get_resources') {
          if (args.kind === 'Deployment') return { items: [deployment] };
          if (args.kind === 'CustomResourceDefinition') return { items: [crd] };
          return { items: [] };
        }
        if (command === 'delete_resource') {
          w.__deleted.push(args.request);
          return { deleted: true };
        }
        if (command.startsWith('stop_')) return;
        return {};
      },
    };
  });

  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Deployments(?: \d+)?$/ }).click();
  const depRow = page.getByTestId('resource-table').getByTitle('web-frontend', { exact: true });
  await depRow.click({ button: 'right' });
  await page.getByRole('group', { name: 'Actions', exact: true }).getByRole('button', { name: /Delete…/ }).click();

  // The renderer must not open its own confirmation: the native backend review is the only prompt.
  await expect.poll(() => page.evaluate(() => (window as any).__deleted.length)).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const intent = await page.evaluate(() => (window as any).__deleted[0]);
  expect(intent).toEqual({
    operation: 'resource',
    resource: { context: 'prod', group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'team', name: 'web-frontend', uid: 'dep-uid-100' },
    resource_version: '42',
  });
  expect(JSON.stringify(intent)).not.toMatch(/confirmed|approved/);

  // One click is one delete request; there is no confirm-then-commit chain.
  await depRow.click({ button: 'right' });
  await page.getByRole('group', { name: 'Actions', exact: true }).getByRole('button', { name: /Delete…/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__deleted.length)).toBe(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
