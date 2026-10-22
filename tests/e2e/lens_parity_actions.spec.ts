import { test, expect } from '@playwright/test';

test('Lens parity menu items and PV details route correctly', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'my-deploy', namespace: 'team', uid: 'dep-uid-1', resourceVersion: '1' },
      spec: { replicas: 2, template: { spec: { containers: [{ name: 'app', image: 'nginx' }] } } },
      status: { readyReplicas: 2 },
    };
    const node = {
      apiVersion: 'v1',
      kind: 'Node',
      metadata: { name: 'node-worker-1', uid: 'node-uid-1', resourceVersion: '1' },
      spec: { unschedulable: false },
      status: { capacity: { cpu: '4', memory: '8Gi' } },
    };
    const cronjob = {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: { name: 'daily-backup', namespace: 'team', uid: 'cj-uid-1', resourceVersion: '1' },
      spec: { schedule: '0 0 * * *', suspend: false, jobTemplate: { spec: { template: { spec: { containers: [{ name: 'backup', image: 'busybox' }] } } } } },
    };
    const replicaset = {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: { name: 'my-rs', namespace: 'team', uid: 'rs-uid-1', resourceVersion: '1' },
      spec: { replicas: 2, template: { spec: { containers: [{ name: 'app', image: 'nginx' }] } } },
    };
    const pv = {
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: { name: 'pv-data-1', uid: 'pv-uid-1', resourceVersion: '1' },
      spec: {
        capacity: { storage: '50Gi' },
        accessModes: ['ReadWriteOnce'],
        persistentVolumeReclaimPolicy: 'Retain',
        storageClassName: 'fast',
      },
      status: { phase: 'Bound' },
    };

    w.__mutations = [];
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (command === 'get_kube_contexts') return [{ name: 'prod', is_current: true }];
        if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
        if (command === 'get_namespaces') return ['team'];
        if (command === 'get_api_resources') return 'deployments deploy apps/v1 true Deployment get,list\nnodes no v1 false Node get,list\ncronjobs cj batch/v1 true CronJob get,list\nreplicasets rs apps/v1 true ReplicaSet get,list\npersistentvolumes pv v1 false PersistentVolume get,list';
        if (command === 'get_resources') {
          if (args.kind === 'Deployment') return { items: [deployment] };
          if (args.kind === 'Node') return { items: [node] };
          if (args.kind === 'CronJob') return { items: [cronjob] };
          if (args.kind === 'ReplicaSet') return { items: [replicaset] };
          if (args.kind === 'PersistentVolume') return { items: [pv] };
          return { items: [] };
        }
        if (command === 'mutate_resource') {
          w.__mutations.push(args.request);
          return { steps: [], succeeded: 0, failed: 0, stopped: false };
        }
        if (command.startsWith('stop_')) return;
        return {};
      },
    };
  });

  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();

  // 1. Check Deployments row context menu (right-click)
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Deployments(?: \d+)?$/ }).click();
  const depRow = page.getByTestId('resource-table').getByTitle('my-deploy', { exact: true });
  await depRow.click({ button: 'right' });
  const depMenu = page.getByRole('group', { name: 'Actions', exact: true });
  await expect(depMenu.getByRole('button', { name: 'Stream Logs in Bottom Drawer' })).toBeVisible();
  await expect(depMenu.getByRole('button', { name: 'Logs in Full Tab' })).toBeVisible();
  await expect(depMenu.getByRole('button', { name: 'Scale replicas…' })).toBeVisible();
  await expect(depMenu.getByRole('button', { name: 'Restart rollout' })).toBeVisible();
  await page.keyboard.press('Escape');

  // 2. Check Node row context menu (Cordon, Drain)
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Nodes(?: \d+)?$/ }).click();
  const nodeRow = page.getByTestId('resource-table').getByTitle('node-worker-1', { exact: true });
  await nodeRow.click({ button: 'right' });
  const nodeMenu = page.getByRole('group', { name: 'Actions', exact: true });
  await expect(nodeMenu.getByRole('button', { name: 'Cordon Node' })).toBeVisible();
  await expect(nodeMenu.getByRole('button', { name: 'Drain Node…' })).toBeVisible();
  await nodeMenu.getByRole('button', { name: 'Drain Node…' }).click();

  // Drain is one batch intent, so the native backend can show one confirmation for the whole operation.
  await expect.poll(() => page.evaluate(() => (window as any).__mutations.length)).toBe(1);
  const drain = await page.evaluate(() => (window as any).__mutations[0]);
  expect(drain).toMatchObject({
    operation: 'batch',
    primary: { kind: 'Node', name: 'node-worker-1' },
    steps: [{ operation: 'drain', resource: { kind: 'Node', name: 'node-worker-1' }, resource_version: '1' }],
  });
  expect(drain.steps).toHaveLength(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // 3. Check CronJob row context menu (Run Now, Suspend)
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^CronJobs(?: \d+)?$/ }).click();
  const cjRow = page.getByTestId('resource-table').getByTitle('daily-backup', { exact: true });
  await cjRow.click({ button: 'right' });
  const cjMenu = page.getByRole('group', { name: 'Actions', exact: true });
  await expect(cjMenu.getByRole('button', { name: 'Trigger (Run Now)' })).toBeVisible();
  await expect(cjMenu.getByRole('button', { name: 'Suspend CronJob' })).toBeVisible();
  await page.keyboard.press('Escape');

  // 4. Check PersistentVolume details routing (PvDetails vs PvcDetails)
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Persistent Volumes(?: \d+)?$/ }).click();
  const pvRow = page.getByTestId('resource-table').getByTitle('pv-data-1', { exact: true });
  await pvRow.click();
  const pvDetails = page.getByTestId('resource-details');
  await expect(pvDetails.getByText('Persistent Volume & Capacity')).toBeVisible();
  await expect(pvDetails.getByText('50 GiB')).toBeVisible();
  await expect(pvDetails.getByText('Storage Claim & Capacity')).toHaveCount(0);
});
