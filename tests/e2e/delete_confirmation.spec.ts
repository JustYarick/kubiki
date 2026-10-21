import { test, expect } from '@playwright/test';

test('single in-app delete confirmation shows cascading deletion warnings and metadata without secondary prompt', async ({ page }) => {
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

  // 1. Delete Deployment: verify styled dialog, garbage collection warning, and metadata
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Deployments(?: \d+)?$/ }).click();
  const depRow = page.getByTestId('resource-table').getByTitle('web-frontend', { exact: true });
  await depRow.click({ button: 'right' });
  await page.getByRole('group', { name: 'Actions', exact: true }).getByRole('button', { name: /Delete…/ }).click();

  const depDialog = page.getByRole('dialog', { name: 'Delete deployment', exact: true });
  await expect(depDialog).toBeVisible();
  // Check garbage collection warning
  await expect(depDialog.getByText('Background Garbage Collection', { exact: true })).toBeVisible();
  await expect(depDialog.getByText(/dependent Pods and ReplicaSets/)).toBeVisible();
  // Check metadata RV and labels
  await expect(depDialog.getByText('RV: 42')).toBeVisible();
  await expect(depDialog.getByText('app=web-frontend')).toBeVisible();

  // Cancel first: must close without deleting
  await depDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(depDialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__deleted.length)).toBe(0);

  // Re-open and confirm: single click deletes immediately without second dialog
  await depRow.click({ button: 'right' });
  await page.getByRole('group', { name: 'Actions', exact: true }).getByRole('button', { name: /Delete…/ }).click();
  await page.getByRole('dialog', { name: 'Delete deployment', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__deleted.length)).toBe(1);
  const deletedDep = await page.evaluate(() => (window as any).__deleted[0]);
  expect(deletedDep.resource.name).toBe('web-frontend');
  expect(deletedDep.resource.uid).toBe('dep-uid-100');

  // 2. Delete CRD: verify cascading CRD deletion warning
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Definitions(?: \d+)?$/ }).click();
  const crdRow = page.getByTestId('resource-table').getByTitle('buckets.source.toolkit.fluxcd.io', { exact: true });
  await crdRow.click({ button: 'right' });
  await page.getByRole('group', { name: 'Actions', exact: true }).getByRole('button', { name: /Delete…/ }).click();

  const crdDialog = page.getByRole('dialog', { name: 'Delete customresourcedefinition', exact: true });
  await expect(crdDialog).toBeVisible();
  await expect(crdDialog.getByText('Cascading CRD Deletion', { exact: true })).toBeVisible();
  await expect(crdDialog.getByText(/all custom resources.*across all namespaces/)).toBeVisible();
  await crdDialog.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect.poll(() => page.evaluate(() => (window as any).__deleted.length)).toBe(2);
  const deletedCrd = await page.evaluate(() => (window as any).__deleted[1]);
  expect(deletedCrd.resource.name).toBe('buckets.source.toolkit.fluxcd.io');
});
