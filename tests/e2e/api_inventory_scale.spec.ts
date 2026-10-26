import { captureScreenshot } from './helpers/screenshots';
import { test, expect, type Page } from '@playwright/test';

const ns = 'backend';
const object = (kind: string, name: string, apiVersion = 'v1', extra: any = {}) => ({ apiVersion, kind, metadata: { uid: `${kind}-${name}`, name, namespace: ns, labels: { app: 'web' }, generation: 1 }, ...extra });
const definition = (group: string, kind: string, plural: string) => ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { uid: plural, name: `${plural}.${group}` }, spec: { group, names: { kind, plural }, scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true }] } });
const crds = [definition('source.toolkit.fluxcd.io', 'GitRepository', 'gitrepositories'), definition('kustomize.toolkit.fluxcd.io', 'Kustomization', 'kustomizations'), definition('helm.toolkit.fluxcd.io', 'HelmRelease', 'helmreleases'), definition('argoproj.io', 'Application', 'applications'), definition('argoproj.io', 'AppProject', 'appprojects'), definition('example.com', 'Widget', 'widgets')];
const discovery = `pods po v1 true Pod list\nconfigmaps cm v1 true ConfigMap list\nnamespaces ns v1 false Namespace list\ndeployments deploy apps/v1 true Deployment list\nservices svc v1 true Service list\nendpointslices discovery.k8s.io/v1 true EndpointSlice list\nhorizontalpodautoscalers hpa autoscaling/v2 true HorizontalPodAutoscaler list\ncustomresourcedefinitions crd apiextensions.k8s.io/v1 false CustomResourceDefinition list`;
async function fixture(page: Page, count = 1) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/').pop();
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'inventory-test', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: [ns, 'frontend'] });
    if (op === 'api-resources') return route.fulfill({ json: discovery });
    if (op === 'metrics') return route.fulfill({ json: { context: 'inventory-test', namespace: null, pods: { items: [], error: null }, nodes: { items: [], error: null } } });
    if (op === 'releases') return route.fulfill({ json: { context: 'inventory-test', namespace: null, items: [], offset: 0, limit: 100, has_more: false } });
    if (op === 'custom-resources') {
      const name = url.searchParams.get('name');
      const items = name?.startsWith('widgets.') ? Array.from({ length: count }, (_, index) => object('Widget', `widget-${String(index).padStart(4, '0')}`, 'example.com/v1', { spec: { nested: { enabled: true } }, status: { phase: 'Ready' } })) : name?.startsWith('gitrepositories.') ? [object('GitRepository', 'repo', 'source.toolkit.fluxcd.io/v1', { spec: { url: 'https://example.com/infra.git', interval: '1m' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } })]
        : name?.startsWith('kustomizations.') ? [object('Kustomization', 'delivery', 'kustomize.toolkit.fluxcd.io/v1', { spec: { sourceRef: { kind: 'GitRepository', name: 'repo' }, path: './prod', interval: '5m' }, status: { lastAppliedRevision: 'main@sha1:abc', inventory: { entries: [{ id: 'backend_web_apps_Deployment', v: 'v1' }] }, conditions: [{ type: 'Ready', status: 'False', reason: 'DependencyNotReady', message: 'Waiting for dependencies' }] } })]
        : name?.startsWith('helmreleases.') ? [object('HelmRelease', 'flux-chart', 'helm.toolkit.fluxcd.io/v1', { spec: { interval: '5m', suspend: true } })]
        : name?.startsWith('applications.') ? [object('Application', 'argo-web', 'argoproj.io/v1', { spec: { project: 'production', source: { repoURL: 'https://example.com/app.git', path: 'k8s', targetRevision: 'main' }, destination: { namespace: ns, server: 'https://kubernetes.default.svc' } }, status: { health: { status: 'Healthy' }, sync: { status: 'OutOfSync', revision: 'abcdef' }, resources: [{ kind: 'Deployment', name: 'web', namespace: ns, group: 'apps', version: 'v1' }] } })]
        : name?.startsWith('appprojects.') ? [object('AppProject', 'production', 'argoproj.io/v1', { spec: { description: 'Production apps', sourceRepos: ['https://example.com/*'] } })] : [];
      return route.fulfill({ json: { items } });
    }
    const kind = url.searchParams.get('kind');
    let items: any[] = kind === 'CustomResourceDefinition' ? crds
      : kind === 'Namespace' ? [ns, 'frontend'].map(name => ({ apiVersion: 'v1', kind, metadata: { name, uid: name } }))
      : kind === 'HorizontalPodAutoscaler' ? [object(kind, 'web-scaler', 'autoscaling/v2', { spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' }, minReplicas: 2, maxReplicas: 10, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 75 } } }] }, status: { currentReplicas: 3, desiredReplicas: 4, currentMetrics: [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: 90 } } }], conditions: [{ type: 'ScalingActive', status: 'True' }] } })]
      : kind === 'Deployment' ? [object(kind, 'web', 'apps/v1', { spec: { replicas: 3 }, status: { availableReplicas: 3 } })]
      : kind === 'Pod' ? Array.from({ length: count }, (_, index) => object(kind, `pod-${String(index).padStart(4, '0')}`, 'v1', { metadata: { uid: `pod-${index}`, name: `pod-${String(index).padStart(4, '0')}`, namespace: index % 2 ? 'frontend' : ns, labels: { app: 'web' } }, spec: { containers: [{ name: 'app', image: 'nginx' }] }, status: { phase: index % 3 ? 'Running' : 'Pending' } }))
      : kind === 'ConfigMap' ? Array.from({ length: count }, (_, index) => object(kind, `config-${String(index).padStart(4, '0')}`, 'v1', { data: { setting: 'value'.repeat(200) } }))
      : kind === 'Service' ? [object(kind, 'web-service', 'v1', { spec: { type: 'ClusterIP', clusterIP: '10.0.0.1', selector: { app: 'web' }, ports: [{ name: 'http', port: 80, targetPort: 8080 }, { name: 'admin', port: 9090, targetPort: 9090 }] } })]
      : kind === 'EndpointSlice' ? [object(kind, 'web-slice', 'discovery.k8s.io/v1', { metadata: { uid: 'slice', name: 'web-slice', namespace: ns, labels: { 'kubernetes.io/service-name': 'web-service' } }, addressType: 'IPv4', ports: [{ port: 8080, protocol: 'TCP' }], endpoints: [{ addresses: ['10.1.0.2'], conditions: { ready: false }, targetRef: { kind: 'Pod', name: 'pod-0000', uid: 'pod-0', namespace: ns } }] })] : [];
    const namespace = url.searchParams.get('namespace');
    if (namespace) items = items.filter(item => !item.metadata.namespace || item.metadata.namespace === namespace);
    return route.fulfill({ json: { items } });
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  return errors;
}
async function list(page: Page, label: string) {
  await page.getByTestId('explorer-panel').getByRole('button', { name: new RegExp(`^${label}(?: \\d+)?$`) }).first().click();
  return page.getByTestId('resource-table');
}

test('HPA metrics, EndpointSlices, selected service port and predictable Back', async ({ page }) => {
  const errors = await fixture(page);
  let table = await list(page, 'Horizontal Pod Autoscalers'); await table.getByText('web-scaler', { exact: true }).click();
  const details = page.getByTestId('resource-details');
  await expect(details.getByRole('region', { name: 'Metrics · current / target', exact: true })).toContainText('90%');
  await expect(details.getByRole('region', { name: 'Metrics · current / target', exact: true })).toContainText('75%');
  await details.getByRole('button', { name: 'Deployment/web', exact: true }).click();
  const back = details.getByRole('button', { name: 'Back to previous resource', exact: true });
  await expect(back).toHaveAttribute('aria-description', /HorizontalPodAutoscaler\/web-scaler/);
  await back.click(); await expect(details.getByRole('region', { name: 'Horizontal pod autoscaler summary', exact: true })).toBeVisible();
  table = await list(page, 'Services'); await table.getByText('web-service', { exact: true }).click();
  await expect(back).toHaveCount(0);
  await expect(details.getByRole('region', { name: 'Service endpoints', exact: true })).toContainText('0/1 ready');
  await expect(details.getByRole('region', { name: 'Target Pods and Selector', exact: true })).toContainText('pod-0000');
  const buttons = details.getByRole('region', { name: 'Service routing' }).getByRole('button', { name: 'Port-forward', exact: true });
  await buttons.nth(1).click();
  const dialog = page.getByRole('dialog', { name: 'Create port-forward', exact: true });
  await expect(dialog.getByLabel('Remote port', { exact: true })).toHaveValue('9090');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await details.getByRole('button', { name: 'web-slice', exact: true }).click();
  await expect(details.getByRole('region', { name: 'Endpoint slice summary', exact: true })).toContainText('web-service');
  await back.click(); await expect(details.getByRole('region', { name: 'Service summary', exact: true })).toBeVisible();
  await captureScreenshot(page, { path: 'test-results/service-expanded.png' });
  expect(errors).toEqual([]);
});

test('Flux and Argo CD have separate trees, useful details and links to loaded managed resources', async ({ page }) => {
  const errors = await fixture(page);
  const explorer = page.getByTestId('explorer-panel');
  await expect(explorer.getByRole('button', { name: 'Flux', exact: true })).toBeVisible();
  await expect(explorer.getByRole('button', { name: 'Argo CD', exact: true })).toBeVisible();
  await list(page, 'GitRepository');
  let table = await list(page, 'Kustomization'); await table.getByText('delivery', { exact: true }).click();
  const details = page.getByTestId('resource-details');
  await expect(details.getByRole('region', { name: 'Kustomization summary', exact: true })).toContainText('DependencyNotReady');
  await details.getByRole('region', { name: 'References', exact: true }).getByRole('button', { name: /GitRepository repo backend/ }).click();
  await expect(details.getByRole('region', { name: 'Git repository summary', exact: true })).toContainText('https://example.com/infra.git');
  await details.getByRole('button', { name: 'Back to previous resource', exact: true }).click();
  await details.getByRole('region', { name: 'Managed resources (1)', exact: true }).getByRole('button', { name: 'web', exact: true }).click();
  await expect(details.getByRole('button', { name: 'Back to previous resource', exact: true })).toHaveAttribute('aria-description', /Kustomization\/delivery/);
  await list(page, 'AppProject');
  table = await list(page, 'Application'); await table.getByText('argo-web', { exact: true }).click();
  await expect(details.getByRole('region', { name: 'Application summary', exact: true })).toContainText('OutOfSync');
  await details.getByRole('button', { name: /AppProject production backend/ }).click();
  await expect(details.getByRole('region', { name: 'App project summary', exact: true })).toContainText('Production apps');
  table = await list(page, 'HelmRelease'); await table.getByText('flux-chart', { exact: true }).click();
  await expect(details.getByRole('region', { name: 'Helm release summary', exact: true })).toContainText('Suspended');
  await expect(details.getByRole('button', { name: 'Upgrade', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('3500 Pods, 3500 ConfigMaps and 3500 custom resources remain usable through deep scroll, keyboard, filters and refresh', async ({ page }) => {
  test.setTimeout(60000);
  const errors = await fixture(page, 3500);
  let table = await list(page, 'Pods');
  await expect(table.locator('table')).toHaveAttribute('aria-rowcount', '3501');
  await expect.poll(() => table.locator('tbody tr[data-resource-uid]').count()).toBeGreaterThan(0);
  expect(await table.locator('tbody tr[data-resource-uid]').count()).toBeLessThan(100);
  await table.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(table.getByText('pod-3499', { exact: true })).toBeVisible();
  await table.focus(); await page.keyboard.press('Home'); await expect(table.getByText('pod-0000', { exact: true })).toBeVisible();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('resource-details')).toContainText('pod-3499');
  const search = page.getByPlaceholder('Filter pods…'); await search.fill('pod-2345');
  await expect(table.locator('tbody tr[data-resource-uid]')).toHaveCount(1);
  await expect(table.getByText('pod-2345', { exact: true })).toBeVisible();
  await search.fill('');
  await expect(table.locator('table')).toHaveAttribute('aria-rowcount', '3501');
  await table.getByRole('columnheader', { name: 'Status', exact: true }).press('Enter');
  await expect(table.locator('tr[data-resource-uid]').first()).toContainText('Running');
  await expect(table.locator('table')).toHaveAttribute('aria-rowcount', '3501');
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  let scope = page.getByRole('dialog', { name: 'Choose Namespace Scope', exact: true });
  await scope.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await scope.getByRole('option', { name: 'backend', exact: true }).click();
  await scope.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(table.locator('table')).toHaveAttribute('aria-rowcount', '1751');
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  scope = page.getByRole('dialog', { name: 'Choose Namespace Scope', exact: true });
  await scope.getByRole('option', { name: 'frontend', exact: true }).click();
  await scope.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(table.locator('table')).toHaveAttribute('aria-rowcount', '3501');
  await page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(table.locator('table')).toHaveAttribute('aria-rowcount', '3501');
  table = await list(page, 'ConfigMaps');
  await expect(table.locator('table')).toHaveAttribute('aria-rowcount', '3501');
  await table.focus(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('resource-details')).toContainText('config-3499');
  expect(await table.locator('tbody tr[data-resource-uid]').count()).toBeLessThan(100);
  table = await list(page, 'Widget');
  await expect(table.locator('table')).toHaveAttribute('aria-rowcount', '3501');
  await table.focus(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('resource-details')).toContainText('widget-3499');
  expect(await table.locator('tbody tr[data-resource-uid]').count()).toBeLessThan(100);
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Open Overview', exact: true }).click();
  await expect(page.getByTestId('overview-count-Pod')).toHaveText('3,500');
  await expect(page.getByTestId('overview-count-ConfigMap')).toHaveText('3,500');
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await page.getByRole('button', { name: 'All Namespaces', exact: true }).click();
  await page.getByRole('button', { name: 'Load all namespaces', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Automatic layout failed');
  table = await list(page, 'Pods');
  await expect(table.locator('table')).toHaveAttribute('aria-rowcount', '3501');
  expect(errors).toEqual([]);
});

test('desktop watch applies a 3500-object snapshot and a burst of 500 updates without losing rows', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any; let callback = 0; const callbacks = new Map(); const subscriptions = new Map<string, any>();
    const pod = (index: number, phase = 'Running') => ({ apiVersion: 'v1', kind: 'Pod', metadata: { uid: `live-${index}`, name: `live-${String(index).padStart(4, '0')}`, namespace: 'backend' }, spec: { containers: [{ name: 'app', image: 'nginx' }] }, status: { phase } });
    const emit = (s: any, events: any[]) => s.channel.onmessage({ subscription_id: s.id, query: s.query, messages: events.map(event => ({ sequence: ++s.sequence, event })) });
    w.__scaleWatch = { active: () => subscriptions.size, burst: () => {
      for (const s of subscriptions.values()) if (s.query.kind === 'Pod') emit(s, Array.from({ length: 500 }, (_, index) => ({ type: 'Delta', payload: { type: 'Applied', payload: { data: pod(3000 + index, 'Failed') } } })));
    }, empty: () => { for (const s of subscriptions.values()) if (s.query.kind === 'Pod') emit(s, [{ type: 'Delta', payload: { type: 'Restarted', payload: { items: [] } } }]); } };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (fn: any) => { callbacks.set(++callback, fn); return callback; }, unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'get_kube_contexts') return [{ name: 'native-scale', is_current: true }];
        if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
        if (command === 'get_namespaces') return ['backend'];
        if (command === 'get_api_resources') return 'pods po v1 true Pod get,list,watch\nnamespaces ns v1 false Namespace get,list,watch\nresourcequotas quota v1 true ResourceQuota get,list';
        if (command === 'get_resources') return { items: [{ apiVersion: 'v1', kind: 'ResourceQuota', metadata: { name: 'quota', namespace: 'backend' }, spec: { hard: { pods: '100' } } }] };
        if (command === 'watch_resources') {
          const s = { id: args.subscriptionId, query: args.query, channel: args.onEvent, sequence: 0 }; subscriptions.set(s.id, s);
          const items = s.query.kind === 'Pod' ? Array.from({ length: 3500 }, (_, index) => pod(index)) : [{ apiVersion: 'v1', kind: 'Namespace', metadata: { uid: 'backend', name: 'backend' } }];
          queueMicrotask(() => emit(s, [{ type: 'Delta', payload: { type: 'Restarted', payload: { items } } }, { type: 'Status', payload: { phase: 'live' } }])); return;
        }
        if (command === 'stop_resource_watch') { subscriptions.delete(args.subscriptionId); return; }
        if (command === 'stop_resource_watches') { subscriptions.clear(); return; }
        if (command.startsWith('stop_')) return;
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  const table = await list(page, 'Pods');
  await expect(table.locator('table')).toHaveAttribute('aria-rowcount', '3501');
  expect(await page.evaluate(() => (window as any).__scaleWatch.active())).toBe(2);
  await table.focus(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('resource-details')).toContainText('live-3499');
  await page.evaluate(() => (window as any).__scaleWatch.burst());
  await expect(table.locator('tr[data-resource-uid="live-3499"]')).toContainText('Failed');
  await expect(table.locator('table')).toHaveAttribute('aria-rowcount', '3501');
  expect(await table.locator('tbody tr[data-resource-uid]').count()).toBeLessThan(100);
  await page.getByPlaceholder('Filter pods…').fill('live-3200');
  await expect(table.locator('tbody tr[data-resource-uid]')).toHaveCount(1);
  await expect(table.locator('tbody tr[data-resource-uid]')).toContainText('Failed');
  await page.evaluate(() => (window as any).__scaleWatch.empty());
  await page.getByPlaceholder('Filter pods…').fill('');
  await expect(table.getByText('No pods found', { exact: true })).toBeVisible();
  const components = await list(page, 'Resource Quotas');
  await expect(components.getByText('quota', { exact: true })).toBeVisible();
  await expect(components).toContainText('snapshots only');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => page.evaluate(() => (window as any).__scaleWatch.active())).toBe(0);
  expect(errors).toEqual([]);
});
