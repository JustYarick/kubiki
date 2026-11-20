/**
 * End-to-End Resource Tabs, Detail Views, Virtualization, and Anti-N+1 Request-Budget Suite.
 *
 * WHY THIS SUITE EXISTS:
 * Unit tests verify isolated pure functions, while real regressions often emerge in the glue
 * between Sidebar navigation, ResourceWatchSession, table column rendering, virtualization,
 * detail inspectors, and on-demand hydration:
 * - Opening Secrets or ConfigMaps on a cluster with hundreds of objects accidentally fires N+1
 *   `get_resource` requests or downloads unrelated Pods/Deployments.
 * - A renamed mapper field silently renders a blank table column (e.g., CronJob `Schedule`).
 * - A broken virtualizer mounts 1,500 DOM rows and freezes the renderer.
 * - Opening one of the 20+ resource tabs or detail panels throws a React hook/runtime error.
 *
 * DO NOT WEAKEN THE REQUEST-BUDGET ASSERTIONS BELOW:
 * They exist specifically to catch O(N) per-row request explosions and unnecessary background
 * collection reads before they reach users on large clusters.
 */
import { test, expect, type Page } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';

interface RecordedRequests {
  lists: Array<{ kind: string; namespace: string | null }>;
  singleGets: Array<{ kind: string; name: string | null; namespace: string | null }>;
  helmInventory: number;
  helmHistory: number;
  helmContent: Array<{ name: string | null; document: string | null }>;
}

function captureErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Invalid hook|resolveDispatcher|Uncaught|Cannot read|TypeError|ReferenceError/.test(msg.text())) {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  return errors;
}

function buildLargeClusterFixtures() {
  // Sorted alphabetically so index-0 fixtures (`alpha`) appear at the top of virtualized tables.
  const namespaces = ['alpha', 'beta', 'gamma', 'prod'];
  const ts = '2026-11-20T09:00:00Z';

  const pods = Array.from({ length: 1500 }, (_, i) => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      uid: `pod-${i}`,
      name: `api-pod-${String(i).padStart(4, '0')}`,
      namespace: namespaces[i % namespaces.length],
      creationTimestamp: ts,
      labels: { app: `svc-${i % 20}` },
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: `rs-${i % 50}`, uid: `rs-${i % 50}` }],
    },
    spec: { nodeName: `worker-${i % 10}`, containers: [{ name: 'app', image: 'nginx:1.27' }] },
    status: { phase: 'Running', podIP: `10.244.${Math.floor(i / 250)}.${i % 250}`, containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }] },
  }));

  // Summary-projected Secrets (matches native Table/PartialObjectMetadata wire format with zero payload bytes on list).
  const secrets = Array.from({ length: 600 }, (_, i) => ({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      uid: `sec-${i}`,
      name: `app-secret-${String(i).padStart(4, '0')}`,
      namespace: namespaces[i % namespaces.length],
      resourceVersion: '10',
      creationTimestamp: ts,
    },
    type: i % 10 === 0 ? 'kubernetes.io/tls' : 'Opaque',
    _kubikiSummary: { dataKeys: 2 },
  }));

  const configMaps = Array.from({ length: 400 }, (_, i) => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      uid: `cm-${i}`,
      name: `app-config-${String(i).padStart(4, '0')}`,
      namespace: namespaces[i % namespaces.length],
      resourceVersion: '10',
      creationTimestamp: ts,
    },
    _kubikiSummary: { dataKeys: 3 },
  }));

  const deployments = Array.from({ length: 80 }, (_, i) => ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { uid: `dep-${i}`, name: `deploy-${String(i).padStart(3, '0')}`, namespace: namespaces[i % namespaces.length], creationTimestamp: ts },
    spec: { replicas: 3, selector: { matchLabels: { app: `svc-${i % 20}` } }, template: { spec: { containers: [{ name: 'app', image: 'nginx:1.27' }] } } },
    status: { readyReplicas: 3, availableReplicas: 3, conditions: [{ type: 'Available', status: 'True' }] },
  }));

  const replicaSets = Array.from({ length: 50 }, (_, i) => ({
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: { uid: `rs-${i}`, name: `rs-${i}`, namespace: namespaces[i % namespaces.length], creationTimestamp: ts, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: `deploy-${String(i).padStart(3, '0')}`, uid: `dep-${i}` }] },
    spec: { replicas: 3 },
    status: { readyReplicas: 3, replicas: 3 },
  }));

  const statefulSets = [{
    apiVersion: 'apps/v1', kind: 'StatefulSet',
    metadata: { uid: 'sts-0', name: 'postgres-primary', namespace: 'prod', creationTimestamp: ts },
    spec: { replicas: 1, serviceName: 'postgres', template: { spec: { containers: [{ name: 'db', image: 'postgres:16' }] } } },
    status: { readyReplicas: 1, replicas: 1 },
  }];

  const daemonSets = [{
    apiVersion: 'apps/v1', kind: 'DaemonSet',
    metadata: { uid: 'ds-0', name: 'node-exporter', namespace: 'infra', creationTimestamp: ts },
    spec: { template: { spec: { containers: [{ name: 'exporter', image: 'prom/node-exporter:v1.8' }] } } },
    status: { desiredNumberScheduled: 10, numberReady: 10 },
  }];

  const jobs = [{
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { uid: 'job-0', name: 'db-migrate-001', namespace: 'prod', creationTimestamp: ts },
    spec: { completions: 1 },
    status: { succeeded: 1, startTime: ts, completionTime: '2026-11-20T09:01:30Z' },
  }];

  const cronJobs = [{
    apiVersion: 'batch/v1', kind: 'CronJob',
    metadata: { uid: 'cj-0', name: 'nightly-compaction', namespace: 'prod', creationTimestamp: ts },
    spec: { schedule: '*/5 * * * *', suspend: false },
    status: { lastScheduleTime: ts },
  }];

  const services = Array.from({ length: 60 }, (_, i) => ({
    apiVersion: 'v1', kind: 'Service',
    metadata: { uid: `svc-${i}`, name: `service-${String(i).padStart(3, '0')}`, namespace: namespaces[i % namespaces.length], creationTimestamp: ts },
    spec: { type: 'ClusterIP', clusterIP: `10.96.0.${(i % 200) + 1}`, ports: [{ port: 80, protocol: 'TCP' }], selector: { app: `svc-${i % 20}` } },
  }));

  const ingresses = [{
    apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
    metadata: { uid: 'ing-0', name: 'public-gateway', namespace: 'prod', creationTimestamp: ts },
    spec: { ingressClassName: 'nginx', rules: [{ host: 'api.example.com' }] },
  }];

  const pvcs = [{
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { uid: 'pvc-0', name: 'pg-data-0', namespace: 'prod', creationTimestamp: ts },
    spec: { storageClassName: 'fast-ssd', volumeName: 'pv-0' },
    status: { phase: 'Bound', capacity: { storage: '50Gi' } },
  }];

  const pvs = [{
    apiVersion: 'v1', kind: 'PersistentVolume',
    metadata: { uid: 'pv-0', name: 'pv-0', creationTimestamp: ts },
    spec: { storageClassName: 'fast-ssd', persistentVolumeReclaimPolicy: 'Retain', capacity: { storage: '50Gi' } },
    status: { phase: 'Bound' },
  }];

  const storageClasses = [{
    apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass',
    metadata: { uid: 'sc-0', name: 'fast-ssd', creationTimestamp: ts },
    provisioner: 'ebs.csi.aws.com',
    reclaimPolicy: 'Retain',
  }];

  const nodes = Array.from({ length: 10 }, (_, i) => ({
    apiVersion: 'v1', kind: 'Node',
    metadata: { uid: `node-${i}`, name: `worker-${i}`, creationTimestamp: ts, labels: { 'node-role.kubernetes.io/worker': '' } },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      addresses: [{ type: 'InternalIP', address: `192.168.10.${i + 1}` }],
      capacity: { cpu: '8', memory: '32Gi', pods: '110' },
      allocatable: { cpu: '8', memory: '30Gi', pods: '110' },
      nodeInfo: { kubeletVersion: 'v1.34.1' },
    },
  }));

  const events = Array.from({ length: 200 }, (_, i) => ({
    apiVersion: 'v1', kind: 'Event',
    metadata: { uid: `ev-${i}`, name: `ev-${i}`, namespace: namespaces[i % namespaces.length], creationTimestamp: ts },
    type: i % 10 === 0 ? 'Warning' : 'Normal',
    reason: i % 10 === 0 ? 'BackOff' : 'Scheduled',
    message: `Sample event ${i}`,
    lastTimestamp: ts,
    involvedObject: { kind: 'Pod', name: `api-pod-${String(i).padStart(4, '0')}`, namespace: namespaces[i % namespaces.length], uid: `pod-${i}` },
  }));

  const serviceAccounts = [{ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { uid: 'sa-0', name: 'default', namespace: 'prod', creationTimestamp: ts } }];
  const roles = [{ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { uid: 'role-0', name: 'reader', namespace: 'prod', creationTimestamp: ts }, rules: [] }];
  const roleBindings = [{ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { uid: 'rb-0', name: 'reader-binding', namespace: 'prod', creationTimestamp: ts }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'reader' }, subjects: [] }];
  const clusterRoles = [{ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { uid: 'cr-0', name: 'cluster-viewer', creationTimestamp: ts }, rules: [] }];
  const clusterRoleBindings = [{ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { uid: 'crb-0', name: 'viewer-binding', creationTimestamp: ts }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-viewer' }, subjects: [] }];
  const crds = [{
    apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition',
    metadata: { uid: 'crd-0', name: 'widgets.example.io', creationTimestamp: ts },
    spec: { group: 'example.io', scope: 'Namespaced', names: { kind: 'Widget', plural: 'widgets' }, versions: [{ name: 'v1', served: true, storage: true }] },
  }];

  const helmReleases = Array.from({ length: 30 }, (_, i) => ({
    name: `release-${String(i).padStart(2, '0')}`,
    namespace: namespaces[i % namespaces.length],
    revision: '3',
    updated: '2026-11-20 09:00:00.000000 +0000 UTC',
    status: 'deployed',
    chart: `service-chart-1.${i}.0`,
    app_version: '2.0.0',
  }));

  const collections: Record<string, any[]> = {
    Namespace: namespaceList(namespaces).items,
    Pod: pods,
    Secret: secrets,
    ConfigMap: configMaps,
    Deployment: deployments,
    ReplicaSet: replicaSets,
    StatefulSet: statefulSets,
    DaemonSet: daemonSets,
    Job: jobs,
    CronJob: cronJobs,
    Service: services,
    Ingress: ingresses,
    PersistentVolumeClaim: pvcs,
    PersistentVolume: pvs,
    StorageClass: storageClasses,
    Node: nodes,
    Event: events,
    ServiceAccount: serviceAccounts,
    Role: roles,
    RoleBinding: roleBindings,
    ClusterRole: clusterRoles,
    ClusterRoleBinding: clusterRoleBindings,
    CustomResourceDefinition: crds,
  };

  return { namespaces, collections, helmReleases };
}

async function installClusterMock(page: Page): Promise<RecordedRequests> {
  const { namespaces, collections, helmReleases } = buildLargeClusterFixtures();
  const recorded: RecordedRequests = {
    lists: [],
    singleGets: [],
    helmInventory: 0,
    helmHistory: 0,
    helmContent: [],
  };

  await page.route('**/api/k8s/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'big-prod', is_current: true }] });
    if (path.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.34.1' } } });
    if (path.endsWith('/namespaces')) return route.fulfill({ json: namespaces });
    if (path.endsWith('/resource-counts')) {
      const counts: Record<string, number> = {};
      for (const [kind, items] of Object.entries(collections)) counts[kind] = items.length;
      return route.fulfill({ json: counts });
    }
    if (path.endsWith('/metrics')) return route.fulfill({ json: { context: 'big-prod', namespace: null, pods: { items: [], error: null }, nodes: { items: [], error: null } } });

    if (path.endsWith('/helm/inventory')) {
      recorded.helmInventory++;
      return route.fulfill({ json: helmReleases });
    }
    if (path.endsWith('/helm/history')) {
      recorded.helmHistory++;
      return route.fulfill({ json: [{ revision: 3, updated: '2026-11-20T09:00:00Z', status: 'deployed', chart: 'service-chart-1.0.0', app_version: '2.0.0', description: 'Upgrade complete' }] });
    }
    if (path.endsWith('/helm/content')) {
      const doc = url.searchParams.get('document');
      recorded.helmContent.push({ name: url.searchParams.get('name'), document: doc });
      if (doc === 'values') return route.fulfill({ json: 'replicaCount: 3\nimage:\n  tag: "2.0.0"\n' });
      if (doc === 'notes') return route.fulfill({ json: 'Release healthy.' });
      return route.fulfill({ json: '' });
    }
    if (path.endsWith('/helm/repositories')) return route.fulfill({ json: [] });

    if (path.endsWith('/resources')) {
      const kind = url.searchParams.get('kind') ?? '';
      const ns = url.searchParams.get('namespace');
      recorded.lists.push({ kind, namespace: ns });
      const items = (collections[kind] ?? []).filter((item) => !ns || ns === 'all' || !item.metadata?.namespace || item.metadata.namespace === ns);
      return route.fulfill({ json: { items } });
    }

    if (path.endsWith('/resource')) {
      const kind = url.searchParams.get('kind') ?? '';
      const name = url.searchParams.get('name');
      const ns = url.searchParams.get('namespace');
      recorded.singleGets.push({ kind, name, namespace: ns });
      if (kind === 'Secret') {
        return route.fulfill({
          json: {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { uid: 'sec-0', name: name ?? 'app-secret-0000', namespace: ns ?? 'prod', resourceVersion: '10' },
            type: 'Opaque',
            data: { API_KEY: Buffer.from('hydrated-secret-value').toString('base64') },
          },
        });
      }
      if (kind === 'ConfigMap') {
        return route.fulfill({
          json: {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { uid: 'cm-0', name: name ?? 'app-config-0000', namespace: ns ?? 'prod', resourceVersion: '10' },
            data: { 'app.toml': 'mode = "prod"\n' },
          },
        });
      }
      const existing = (collections[kind] ?? []).find((item) => item.metadata?.name === name);
      if (existing) return route.fulfill({ json: existing });
      return route.fulfill({ status: 404, json: { error: 'Not found' } });
    }

    return route.fulfill({ json: { items: [] } });
  });

  return recorded;
}

test('large-cluster Secrets & ConfigMaps obey strict anti-N+1 request budgets and virtualize cleanly', async ({ page }) => {
  const errors = captureErrors(page);
  const requests = await installClusterMock(page);

  await page.goto('/');
  const explorer = page.getByTestId('explorer-panel');
  await explorer.getByRole('button', { name: 'Expand All', exact: true }).click();

  // 1. Open Secrets (600 summary items).
  requests.lists.length = 0;
  requests.singleGets.length = 0;
  await explorer.locator('[data-resource-type="Secret"]').click();
  const table = page.getByTestId('resource-table');
  const firstSecretRow = table.locator('tbody tr').filter({ hasText: 'app-secret-0000' });
  await expect(firstSecretRow).toBeVisible();
  // INVARIANT: Summary-projected Secrets display their key count from `_kubikiSummary` without full data payloads.
  await expect(firstSecretRow).toContainText('2');

  // INVARIANT: Virtualization keeps mounted rows strictly bounded (never 600 DOM rows).
  const secretDomRows = await table.locator('tbody tr').count();
  expect(secretDomRows).toBeGreaterThan(0);
  expect(secretDomRows).toBeLessThan(80);

  // INVARIANT: Zero per-secret N+1 single-GETs on list view, and zero unrelated Pod/Deployment list requests.
  expect(requests.singleGets.filter((r) => r.kind === 'Secret')).toHaveLength(0);
  expect(requests.lists.filter((r) => r.kind === 'Pod' || r.kind === 'Deployment')).toHaveLength(0);

  // 2. Click ONE summary Secret -> triggers at most 1 single-GET for THAT Secret and reveals hydrated key.
  await firstSecretRow.click();
  const details = page.getByTestId('resource-details');
  await expect(details.getByText('API_KEY', { exact: true })).toBeVisible();
  expect(requests.singleGets.filter((r) => r.kind === 'Secret')).toHaveLength(1);
  expect(requests.singleGets.filter((r) => r.kind === 'Secret')[0].name).toBe('app-secret-0000');

  // 3. Open ConfigMaps (400 summary items) -> zero N+1 single-GETs on list view.
  await page.getByRole('button', { name: 'Toggle Details Panel', exact: true }).click();
  requests.singleGets.length = 0;
  await explorer.locator('[data-resource-type="ConfigMap"]').click();
  const firstCmRow = table.locator('tbody tr').filter({ hasText: 'app-config-0000' });
  await expect(firstCmRow).toBeVisible();
  await expect(firstCmRow).toContainText('3');
  expect(requests.singleGets.filter((r) => r.kind === 'ConfigMap')).toHaveLength(0);

  expect(errors).toEqual([]);
});

test('all core resource tabs and detail views open cleanly on a large cluster without errors', async ({ page }) => {
  const errors = captureErrors(page);
  const requests = await installClusterMock(page);

  await page.goto('/');
  const explorer = page.getByTestId('explorer-panel');
  await explorer.getByRole('button', { name: 'Expand All', exact: true }).click();
  const table = page.getByTestId('resource-table');

  // Tour EVERY major sidebar resource tab and verify expected sample item renders.
  const tabsToVerify: Array<{ kind: string; expectedRow: string; inspect?: boolean; extraCell?: string }> = [
    { kind: 'Pod', expectedRow: 'api-pod-0000', inspect: true },
    { kind: 'Deployment', expectedRow: 'deploy-000', inspect: true },
    { kind: 'DaemonSet', expectedRow: 'node-exporter' },
    { kind: 'StatefulSet', expectedRow: 'postgres-primary' },
    { kind: 'ReplicaSet', expectedRow: 'rs-0' },
    { kind: 'Job', expectedRow: 'db-migrate-001', inspect: true },
    { kind: 'CronJob', expectedRow: 'nightly-compaction', inspect: true, extraCell: '*/5 * * * *' },
    { kind: 'Service', expectedRow: 'service-000', inspect: true },
    { kind: 'Ingress', expectedRow: 'public-gateway', inspect: true },
    { kind: 'PersistentVolumeClaim', expectedRow: 'pg-data-0', inspect: true },
    { kind: 'PersistentVolume', expectedRow: 'pv-0' },
    { kind: 'StorageClass', expectedRow: 'fast-ssd' },
    { kind: 'Node', expectedRow: 'worker-0', inspect: true },
    { kind: 'Namespace', expectedRow: 'prod' },
    { kind: 'Event', expectedRow: 'ev-0' },
    { kind: 'ServiceAccount', expectedRow: 'default' },
    { kind: 'ClusterRole', expectedRow: 'cluster-viewer' },
    { kind: 'Role', expectedRow: 'reader' },
    { kind: 'ClusterRoleBinding', expectedRow: 'viewer-binding' },
    { kind: 'RoleBinding', expectedRow: 'reader-binding' },
    { kind: 'CustomResourceDefinition', expectedRow: 'widgets.example.io' },
  ];

  for (const entry of tabsToVerify) {
    await explorer.locator(`[data-resource-type="${entry.kind}"]`).click();
    await expect(table.getByText(entry.expectedRow, { exact: true }).first(), `${entry.kind} table should render ${entry.expectedRow}`).toBeVisible();

    if (entry.kind === 'Pod') {
      // INVARIANT: 1,500 Pods must stay virtualized (< 80 mounted DOM rows).
      const podRows = await table.locator('tbody tr').count();
      expect(podRows).toBeLessThan(80);
    }
    if (entry.extraCell) {
      // Regression guard: CronJob Schedule column must render the cron schedule expression, never blank.
      await expect(table.getByText(entry.extraCell, { exact: true }).first()).toBeVisible();
    }
    if (entry.inspect) {
      await table.getByText(entry.expectedRow, { exact: true }).first().click();
      await expect(page.getByTestId('resource-details')).toBeVisible();
    }
  }

  // Verify Helm Releases tab obeys lazy document loading (0 helm/content calls until document tab clicked).
  requests.helmContent.length = 0;
  requests.helmInventory = 0;
  await explorer.getByRole('button', { name: 'Open Helm Releases', exact: true }).click();
  await expect(table.getByText('release-00', { exact: true })).toBeVisible();
  expect(requests.helmInventory).toBeLessThanOrEqual(1);
  expect(requests.helmContent).toHaveLength(0);

  await table.getByText('release-00', { exact: true }).click();
  const details = page.getByTestId('resource-details');
  await expect(details).toBeVisible();
  // Deployed release overview must NOT auto-fetch manifest/values/hooks.
  expect(requests.helmContent).toHaveLength(0);

  // Clicking Values tab loads ONLY Values once.
  await details.getByRole('tab', { name: 'Values', exact: true }).click();
  await expect(details.getByText('replicaCount', { exact: false })).toBeVisible();
  expect(requests.helmContent).toEqual([{ name: 'release-00', document: 'values' }]);

  expect(errors).toEqual([]);
});
