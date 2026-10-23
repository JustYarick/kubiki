import { test, expect } from '@playwright/test';

test('restart consumers sends all workloads as one batch confirmation', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'app-config', namespace: 'team', uid: 'cm-uid-1', resourceVersion: '5' },
      data: { LOG_LEVEL: 'info' },
    };
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', namespace: 'team', uid: 'dep-uid-1', resourceVersion: '7' },
      spec: {
        replicas: 1,
        template: {
          metadata: { labels: { app: 'web' } },
          spec: {
            containers: [{ name: 'app', image: 'nginx', volumeMounts: [{ name: 'config', mountPath: '/etc/config' }] }],
            volumes: [{ name: 'config', configMap: { name: 'app-config' } }],
          },
        },
      },
      status: { readyReplicas: 1 },
    };

    w.__mutations = [];
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (command === 'get_kube_contexts') return [{ name: 'prod', is_current: true }];
        if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
        if (command === 'get_namespaces') return ['team'];
        if (command === 'get_api_resources') {
          return 'configmaps cm v1 true ConfigMap get,list\ndeployments deploy apps/v1 true Deployment get,list';
        }
        if (command === 'get_resources') {
          if (args.kind === 'ConfigMap') return { items: [configMap] };
          if (args.kind === 'Deployment') return { items: [deployment] };
          return { items: [] };
        }
        if (command === 'mutate_resource') {
          w.__mutations.push(args.request);
          return {
            steps: args.request.steps.map(() => ({ action: 'APPLY', kind: 'Deployment', name: 'web', namespace: 'team', ok: true })),
            succeeded: args.request.steps.length,
            failed: 0,
            stopped: false,
          };
        }
        if (command.startsWith('stop_')) return;
        return {};
      },
    };
  });

  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();

  // Load the consuming Deployment first so the relationship graph has both sides in memory.
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Deployments(?: \d+)?$/ }).click();
  await expect(page.getByTestId('resource-table').getByTitle('web', { exact: true })).toBeVisible();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^ConfigMaps(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByTitle('app-config', { exact: true }).click();

  const restart = page.getByRole('button', { name: 'Restart consumers', exact: true });
  await expect(restart).toBeVisible();
  await restart.click();

  // All consumers travel in one batch; the user sees one native confirmation, not N prompts.
  await expect.poll(() => page.evaluate(() => (window as any).__mutations.length)).toBe(1);
  const batch = await page.evaluate(() => (window as any).__mutations[0]);
  expect(batch).toMatchObject({
    operation: 'batch',
    primary: { kind: 'ConfigMap', name: 'app-config', namespace: 'team' },
  });
  expect(batch.steps).toHaveLength(1);
  expect(batch.steps[0]).toMatchObject({
    operation: 'action',
    resource: { kind: 'Deployment', name: 'web', namespace: 'team', context: 'prod' },
    resource_version: '7',
    action: { type: 'restart' },
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
