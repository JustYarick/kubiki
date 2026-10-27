import { captureScreenshot } from './helpers/screenshots';
import { test, expect, type Page } from '@playwright/test';

// Independent API fixture: mismatched group, version, scope or an extra collection returns an error.
const api = [
  ['Pod','pods','',true], ['Deployment','deployments','apps',true], ['DaemonSet','daemonsets','apps',true], ['StatefulSet','statefulsets','apps',true], ['ReplicaSet','replicasets','apps',true], ['ReplicationController','replicationcontrollers','',true], ['Job','jobs','batch',true], ['CronJob','cronjobs','batch',true],
  ['ConfigMap','configmaps','',true], ['Secret','secrets','',true], ['ResourceQuota','resourcequotas','',true], ['LimitRange','limitranges','',true], ['HorizontalPodAutoscaler','horizontalpodautoscalers','autoscaling',true], ['PodDisruptionBudget','poddisruptionbudgets','policy',true], ['PriorityClass','priorityclasses','scheduling.k8s.io',false], ['RuntimeClass','runtimeclasses','node.k8s.io',false], ['Lease','leases','coordination.k8s.io',true], ['MutatingWebhookConfiguration','mutatingwebhookconfigurations','admissionregistration.k8s.io',false], ['ValidatingWebhookConfiguration','validatingwebhookconfigurations','admissionregistration.k8s.io',false],
  ['ValidatingAdmissionPolicy','validatingadmissionpolicies','admissionregistration.k8s.io',false], ['ValidatingAdmissionPolicyBinding','validatingadmissionpolicybindings','admissionregistration.k8s.io',false], ['MutatingAdmissionPolicy','mutatingadmissionpolicies','admissionregistration.k8s.io',false], ['MutatingAdmissionPolicyBinding','mutatingadmissionpolicybindings','admissionregistration.k8s.io',false],
  ['Service','services','',true], ['Endpoints','endpoints','',true], ['EndpointSlice','endpointslices','discovery.k8s.io',true], ['Ingress','ingresses','networking.k8s.io',true], ['IngressClass','ingressclasses','networking.k8s.io',false], ['NetworkPolicy','networkpolicies','networking.k8s.io',true],
  ['PersistentVolumeClaim','persistentvolumeclaims','',true], ['PersistentVolume','persistentvolumes','',false], ['StorageClass','storageclasses','storage.k8s.io',false],
  ['ResourceClaim','resourceclaims','resource.k8s.io',true], ['ResourceClaimTemplate','resourceclaimtemplates','resource.k8s.io',true], ['DeviceClass','deviceclasses','resource.k8s.io',false], ['ResourceSlice','resourceslices','resource.k8s.io',false],
  ['ServiceAccount','serviceaccounts','',true], ['Role','roles','rbac.authorization.k8s.io',true], ['ClusterRole','clusterroles','rbac.authorization.k8s.io',false], ['RoleBinding','rolebindings','rbac.authorization.k8s.io',true], ['ClusterRoleBinding','clusterrolebindings','rbac.authorization.k8s.io',false],
  ['Node','nodes','',false], ['Namespace','namespaces','',false], ['Event','events','',true], ['CustomResourceDefinition','customresourcedefinitions','apiextensions.k8s.io',false],
] as const;
const gateways = ['Gateway','GatewayClass','HTTPRoute','GRPCRoute','TCPRoute','UDPRoute','TLSRoute','ListenerSet','ReferenceGrant','BackendTLSPolicy'];
const custom = [{ kind: 'VerticalPodAutoscaler', group: 'autoscaling.k8s.io', plural: 'verticalpodautoscalers' }, ...gateways.map(kind => ({ kind, group: 'gateway.networking.k8s.io', plural: ({ GatewayClass: 'gatewayclasses', BackendTLSPolicy: 'backendtlspolicies' } as Record<string, string>)[kind] ?? kind.toLowerCase() + 's' }))];
const ns = 'team';
const resourceName = (kind: string) => `sample-${kind.toLowerCase()}`;
function raw(kind: string, group: string, namespaced: boolean, version = 'v1') {
  const target = { apiVersion: 'apps/v1', kind: 'Deployment', name: resourceName('Deployment') };
  return { apiVersion: group ? `${group}/${version}` : version, kind, metadata: { uid: `${group}-${kind}`, name: kind === 'Namespace' ? ns : resourceName(kind), ...(namespaced ? { namespace: ns } : {}) }, spec: kind === 'Pod' ? { containers: [{ name: 'app', image: 'nginx' }] } : kind === 'HorizontalPodAutoscaler' ? { scaleTargetRef: target, minReplicas: 1, maxReplicas: 5 } : kind === 'VerticalPodAutoscaler' ? { targetRef: target, updatePolicy: { updateMode: 'Auto' } } : kind === 'Gateway' ? { gatewayClassName: resourceName('GatewayClass') } : kind.endsWith('Route') ? { parentRefs: [{ name: resourceName('Gateway') }], rules: [{ backendRefs: [{ name: resourceName('Service') }] }] } : { replicas: 1 }, status: kind === 'Pod' ? { phase: 'Running' } : {}, ...(kind === 'Secret' ? { data: {}, type: 'Opaque' } : {}) };
}
async function fixture(page: Page, withCustom = true) {
  const waits = new Map<string, Promise<void>>(); const failures = new Set<string>(); const requests: URL[] = []; const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/k8s/**', async route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/').pop()!; requests.push(url);
    const kind = url.searchParams.get('kind') ?? '';
    if (waits.has(kind || op)) await waits.get(kind || op);
    if (failures.has(kind || op)) return route.fulfill({ status: 403, json: { error: { code: 'forbidden', status: 403, message: 'Resource access denied by RBAC', operation: op } } });
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'lens-catalog', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: [ns] });
    if (op === 'api-resources') return route.fulfill({ json: api.map(([kind, plural, group, namespaced]) => `${plural} ${group ? group + '/' : ''}v1 ${namespaced} ${kind} [get list watch]`).join('\n') });
    if (op === 'inventory') return route.fulfill({ json: [] });
    if (op === 'custom-resources') {
      const type = custom.find(type => `${type.plural}.${type.group}` === url.searchParams.get('name'));
      if (!type) return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Unknown custom API' } } });
      return route.fulfill({ json: { items: [raw(type.kind, type.group, type.kind !== 'GatewayClass', 'v1beta1')] } });
    }
    if (op === 'resources') {
      const type = api.find(type => type[0] === kind);
      if (!type || url.searchParams.get('group') !== type[2] || url.searchParams.get('version') !== 'v1' || !type[3] && url.searchParams.has('namespace')) return route.fulfill({ status: 400, json: { error: { code: 'invalid_request', message: `Invalid collection query: ${url.search}` } } });
      const definitions = withCustom ? custom.map(type => ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { uid: type.plural, name: `${type.plural}.${type.group}` }, spec: { group: type.group, names: { kind: type.kind, plural: type.plural }, scope: type.kind === 'GatewayClass' ? 'Cluster' : 'Namespaced', versions: [{ name: 'v2', served: false, storage: false }, { name: 'v1beta1', served: true, storage: true }] } })) : [];
      return route.fulfill({ json: { items: kind === 'CustomResourceDefinition' ? definitions : [raw(type[0], type[2], type[3])] } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  const hold = (key: string) => { let release!: () => void; waits.set(key, new Promise<void>(resolve => { release = resolve; })); return () => { waits.delete(key); release(); }; };
  return { requests, errors, hold, fail: (key: string) => failures.add(key) };
}
async function open(page: Page, type: string) { await page.getByTestId('explorer-panel').locator(`[data-resource-type="${type}"]`).first().click(); return page.getByTestId('resource-table'); }

test('all 45 Lens builtin collections use valid API queries and open their details', async ({ page }) => {
  test.setTimeout(120000); const state = await fixture(page);
  await page.goto('/'); const explorer = page.getByTestId('explorer-panel'); await explorer.getByRole('button', { name: 'Expand All', exact: true }).click();
  for (const [kind] of api) {
    let table;
    if (['Node','Namespace','Event'].includes(kind)) { await explorer.getByRole('button', { name: new RegExp(`^${kind === 'Namespace' ? 'Namespaces' : kind + 's'}(?: \\d+)?$`) }).click(); table = page.getByTestId('resource-table'); }
    else table = await open(page, kind);
    const name = kind === 'CustomResourceDefinition' ? 'verticalpodautoscalers.autoscaling.k8s.io' : kind === 'Namespace' ? ns : resourceName(kind);
    if (kind === 'CustomResourceDefinition') await table.locator('tbody tr').filter({ hasText: name }).locator('td').first().click();
    else await table.getByText(name, { exact: true }).click();
    const details = page.getByTestId('resource-details'); await expect(details.locator('.details-title')).toHaveText(name);
    if (kind !== 'Event') {
      await expect(details.getByRole('tab', { name: 'Related', exact: true })).toBeVisible();
      await details.getByRole('tab', { name: 'Related', exact: true }).click();
      await expect(details.getByRole('region', { name: 'Resource relationships', exact: true })).toBeVisible();
      await expect(details.getByRole('tab', { name: 'Related', exact: true })).toBeVisible();
      await details.getByRole('tab', { name: 'Overview', exact: true }).click();
    }
  }
  expect(new Set(state.requests.filter(url => url.pathname.endsWith('/resources')).map(url => url.searchParams.get('kind'))).size).toBe(45);
  for (const removed of ['PodTemplate','ControllerRevision','FlowSchema','CSIDriver','ComponentStatus','PodGroup']) await expect(explorer.locator(`[data-resource-type="${removed}"]`)).toHaveCount(0);
  await expect(explorer.getByRole('button', { name: /^Scheduling(?: \d+)?$/ })).toHaveCount(0);
  await expect(explorer.getByRole('button', { name: /^Cluster APIs(?: \d+)?$/ })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test('VPA and all ten Gateway kinds have dedicated tree locations and resolve navigation to their dependencies', async ({ page }) => {
  const state = await fixture(page); await page.goto('/'); const explorer = page.getByTestId('explorer-panel'); await explorer.getByRole('button', { name: 'Expand All', exact: true }).click();
  await expect(explorer.locator('#sidebar-category-config').getByRole('button', { name: 'Vertical Pod Autoscalers', exact: true })).toBeVisible();
  await expect(explorer.locator('#sidebar-category-gateway').locator('[data-resource-type]')).toHaveCount(10);
  await expect(explorer.locator('#sidebar-category-crd').getByRole('button', { name: 'gateway.networking.k8s.io', exact: true })).toHaveCount(1);
  const details = page.getByTestId('resource-details');
  for (const type of custom) {
    const table = await open(page, `custom:${type.group}/${type.kind}`); await table.getByText(resourceName(type.kind), { exact: true }).click();
    await expect(details.locator('.details-title')).toHaveText(resourceName(type.kind));
  }
  let table = await open(page, 'custom:gateway.networking.k8s.io/Gateway'); await table.getByText(resourceName('Gateway'), { exact: true }).click();
  await details.getByRole('region', { name: 'Referenced resources', exact: true }).getByRole('button', { name: `GatewayClass/${resourceName('GatewayClass')}`, exact: true }).click();
  await expect(details.locator('.details-title')).toHaveText(resourceName('GatewayClass'));
  table = await open(page, 'custom:gateway.networking.k8s.io/HTTPRoute'); await table.getByText(resourceName('HTTPRoute'), { exact: true }).click();
  await details.getByRole('region', { name: 'Referenced resources', exact: true }).getByRole('button', { name: `Service/${resourceName('Service')} · team`, exact: true }).click();
  await expect(details.locator('.details-title')).toHaveText(resourceName('Service'));
  table = await open(page, 'custom:autoscaling.k8s.io/VerticalPodAutoscaler'); await table.getByText(resourceName('VerticalPodAutoscaler'), { exact: true }).click();
  await details.getByRole('region', { name: 'Referenced resources', exact: true }).getByRole('button', { name: `Deployment/${resourceName('Deployment')} · team`, exact: true }).click();
  await expect(details.locator('.details-title')).toHaveText(resourceName('Deployment'));
  expect(state.errors).toEqual([]);
});

test('slow Kubernetes responses show animated loading, retain rows on refresh, respect reduced motion, and resolve empty lists', async ({ page }) => {
  const state = await fixture(page, false); const release = state.hold('Pod');
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  let table = await open(page, 'Pod'); const loading = table.getByTestId('resource-loading');
  await expect(table).toHaveAttribute('aria-busy', 'true'); await expect(loading).toContainText('Loading Pod resources');
  await expect(table.getByText('No pods found', { exact: true })).toHaveCount(0);
  expect(await loading.locator('.resource-loading-progress > span').evaluate(el => getComputedStyle(el).animationName)).toBe('resource-loading-slide');
  await page.emulateMedia({ reducedMotion: 'reduce' }); expect(await loading.locator('.resource-loading-progress > span').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.setViewportSize({ width: 500, height: 700 }); expect(await loading.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await captureScreenshot(page, { path: 'test-results/resource-loading-reduced.png' });
  release(); await expect(table.getByText(resourceName('Pod'), { exact: true })).toBeVisible(); await expect(table).toHaveAttribute('aria-busy', 'false');
  await page.setViewportSize({ width: 1440, height: 900 });
  const before = await table.locator('table').boundingBox(); const refresh = state.hold('Pod');
  await page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(loading).toContainText('Refreshing Pod resources'); await expect(table.getByText(resourceName('Pod'), { exact: true })).toBeVisible();
  const during = await table.locator('table').boundingBox(); expect(during?.y).toBeCloseTo(before!.y, 0);
  refresh(); await expect(table).toHaveAttribute('aria-busy', 'false');
  table = await open(page, 'CustomResourceDefinition'); await expect(table.getByText('No customresourcedefinitions found', { exact: true })).toBeVisible();
  await expect(table.getByTestId('resource-loading')).toHaveCount(0);
  expect(state.errors).toEqual([]);
});


test('custom resource and Helm requests use the shared animated loading surface', async ({ page }) => {
  const state = await fixture(page); const releaseCustom = state.hold('custom-resources'); const releaseHelm = state.hold('inventory');
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  const table = await open(page, 'custom:autoscaling.k8s.io/VerticalPodAutoscaler');
  await expect(table.getByTestId('resource-loading')).toContainText('Loading VerticalPodAutoscaler resources');
  await expect(table).toHaveAttribute('aria-busy', 'true');
  releaseCustom(); await expect(table.getByText(resourceName('VerticalPodAutoscaler'), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Helm Releases', exact: true }).click();
  const helm = page.getByTestId('helm-releases'); await expect(helm.getByTestId('resource-loading')).toContainText('Loading releases');
  releaseHelm(); await expect(helm.getByTestId('resource-loading')).toHaveCount(0);
  await expect(helm).toContainText('No Helm releases in this scope');
  expect(state.errors).toEqual([]);
});

test('a failed Kubernetes response replaces loading with an explicit error', async ({ page }) => {
  const state = await fixture(page, false); const release = state.hold('Pod'); state.fail('Pod');
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  const table = await open(page, 'Pod'); await expect(table.getByTestId('resource-loading')).toBeVisible();
  release(); await expect(table.getByRole('alert')).toContainText('Resource access denied by RBAC');
  await expect(table.getByTestId('resource-loading')).toHaveCount(0); await expect(table).toHaveAttribute('aria-busy', 'false');
  await expect(table.getByText('No pods found', { exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});
