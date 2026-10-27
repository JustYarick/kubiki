import { test, expect, type Page } from '@playwright/test';

const ns = 'backend';
const meta = (kind: string, name: string, extra: any = {}) => ({
  apiVersion: 'v1', kind, metadata: { uid: `${kind}-${name}`, name, namespace: ns, ...extra },
});
const discovery = [
  'pods po v1 true Pod list',
  'deployments deploy apps/v1 true Deployment list',
  'services svc v1 true Service list',
  'horizontalpodautoscalers hpa autoscaling/v2 true HorizontalPodAutoscaler list',
  'poddisruptionbudgets pdb policy/v1 true PodDisruptionBudget list',
  'resourcequotas quota v1 true ResourceQuota list',
  'networkpolicies netpol networking.k8s.io/v1 true NetworkPolicy list',
  'endpointslices epi discovery.k8s.io/v1 true EndpointSlice list',
  'leases lease coordination.k8s.io/v1 true Lease list',
  'mutatingwebhookconfigurations mutating admissionregistration.k8s.io/v1 false MutatingWebhookConfiguration list',
  'deviceclasses device resource.k8s.io/v1 false DeviceClass list',
  'resourceclaims claim resource.k8s.io/v1 true ResourceClaim list',
].join('\n');

const objects: Record<string, any[]> = {
  Pod: [
    { ...meta('Pod', 'web-pod', { labels: { app: 'web' } }), spec: { containers: [{ name: 'app', image: 'nginx' }] }, status: { phase: 'Running' } },
    { ...meta('Pod', 'api-pod', { labels: { app: 'api' } }), spec: { containers: [{ name: 'app', image: 'nginx' }] }, status: { phase: 'Running' } },
  ],
  Deployment: [{ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { uid: 'web', name: 'web', namespace: ns }, spec: { replicas: 2 } }],
  Service: [{ ...meta('Service', 'web-service'), spec: { selector: { app: 'web' } } }],
  HorizontalPodAutoscaler: [{
    ...meta('HorizontalPodAutoscaler', 'web-scaler'),
    apiVersion: 'autoscaling/v2',
    spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' }, minReplicas: 2, maxReplicas: 10, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 75 } } }] },
    status: { currentReplicas: 3, desiredReplicas: 4, currentMetrics: [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: 90 } } }], conditions: [{ type: 'ScalingActive', status: 'True' }] },
  }],
  PodDisruptionBudget: [{
    ...meta('PodDisruptionBudget', 'web-pdb'),
    apiVersion: 'policy/v1',
    spec: { minAvailable: 1, selector: { matchLabels: { app: 'web' } } },
    status: { currentHealthy: 1, desiredHealthy: 1, disruptionsAllowed: 0, expectedPods: 1, conditions: [{ type: 'DisruptionAllowed', status: 'True' }] },
  }],
  ResourceQuota: [{
    ...meta('ResourceQuota', 'web-quota'),
    spec: { scopes: ['BestEffort'], hard: { cpu: '4', memory: '8Gi', pods: '10' } },
    status: { hard: { cpu: '4', memory: '8Gi', pods: '10' }, used: { cpu: '1', memory: '2Gi', pods: '3' } },
  }],
  NetworkPolicy: [{
    ...meta('NetworkPolicy', 'web-policy'),
    apiVersion: 'networking.k8s.io/v1',
    spec: { policyTypes: ['Ingress'], podSelector: { matchLabels: { app: 'web' } }, ingress: [{ from: [{ podSelector: { matchLabels: { app: 'api' } } }], ports: [{ protocol: 'TCP', port: 8080 }] }] },
  }],
  EndpointSlice: [{
    ...meta('EndpointSlice', 'web-slice'),
    apiVersion: 'discovery.k8s.io/v1',
    metadata: { uid: 'web-slice', name: 'web-slice', namespace: ns, labels: { 'kubernetes.io/service-name': 'web-service' } },
    addressType: 'IPv4',
    ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
    endpoints: [{ addresses: ['10.1.0.2'], conditions: { ready: true }, targetRef: { kind: 'Pod', name: 'web-pod', namespace: ns } }],
  }],
  Lease: [{ ...meta('Lease', 'web-lease'), apiVersion: 'coordination.k8s.io/v1', spec: { holderIdentity: 'web-0', leaseDurationSeconds: 40, acquireTime: '2026-10-22T09:00:00Z', renewTime: '2026-10-22T09:10:00Z', leaseTransitions: 2 } }],
  MutatingWebhookConfiguration: [{
    apiVersion: 'admissionregistration.k8s.io/v1', kind: 'MutatingWebhookConfiguration',
    metadata: { uid: 'hooks', name: 'hooks' },
    webhooks: [{ name: 'sidecar.example.com', clientConfig: { service: { name: 'sidecar', namespace: ns, path: '/mutate', port: 443 } }, rules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE'], resources: ['pods'] }], failurePolicy: 'Fail', sideEffects: 'None', timeoutSeconds: 5 }],
  }],
  DeviceClass: [{ apiVersion: 'resource.k8s.io/v1', kind: 'DeviceClass', metadata: { uid: 'gpu', name: 'gpu.example.com' }, spec: { selectors: [{ cell: { id: 'gpu', operator: 'In', values: ['gpu-1'] } }] } }],
  ResourceClaim: [{
    ...meta('ResourceClaim', 'web-claim'),
    apiVersion: 'resource.k8s.io/v1',
    spec: { devices: [{ deviceClassName: 'gpu.example.com', requests: { count: 1 } }] },
    status: { allocation: { controller: 'example.com/driver', nodeName: 'node-1', readyCount: 1, devices: [{ deviceName: 'gpu-1', driver: 'example.com/driver' }] } },
  }],
};

async function fixture(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    const op = url.pathname.split('/').pop();
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'parity', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: [ns] });
    if (op === 'api-resources') return route.fulfill({ json: discovery });
    if (op === 'metrics') return route.fulfill({ json: { context: 'parity', namespace: null, pods: { items: [], error: null }, nodes: { items: [], error: null } } });
    if (op === 'inventory') return route.fulfill({ json: [] });
    const kind = url.searchParams.get('kind') ?? '';
    return route.fulfill({ json: { items: objects[kind] ?? [] } });
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  return errors;
}

async function open(page: Page, label: string, name: string) {
  await page.getByTestId('explorer-panel').getByRole('button', { name: new RegExp(`^${label}(?: \\d+)?$`) }).first().click();
  await page.getByTestId('resource-table').getByText(name, { exact: true }).click();
  return page.getByTestId('inspector-panel').getByTestId('resource-details');
}

test('new entity panels follow the shared summary, table and link design', async ({ page }) => {
  const errors = await fixture(page);

  // Autoscaling: headline numbers, metric table and a link to the scaled workload.
  let details = await open(page, 'Horizontal Pod Autoscalers', 'web-scaler');
  await expect(details.getByRole('region', { name: 'Horizontal pod autoscaler summary' })).toBeVisible();
  await expect(details.getByText('Min replicas', { exact: true })).toBeVisible();
  await expect(details.getByText('Current replicas', { exact: true })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Metrics · current / target' }).getByRole('cell', { name: '75%' })).toBeVisible();
  await details.getByRole('button', { name: 'Deployment/web', exact: true }).click();
  await expect(details.getByRole('region', { name: 'Replicas and Pod status' })).toBeVisible();

  // Disruption budget: tiles plus the selected pods.
  details = await open(page, 'Pod Disruption Budgets', 'web-pdb');
  await expect(details.getByRole('region', { name: 'Pod disruption budget summary' })).toBeVisible();
  await expect(details.getByText('Disruptions allowed', { exact: true })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Pods protected by this budget' }).getByRole('button', { name: 'web-pod' })).toBeVisible();

  // Quota: a resource table with hard limits and usage, not a raw spec dump.
  details = await open(page, 'Resource Quotas', 'web-quota');
  const quota = details.getByRole('region', { name: 'Resource quota summary' });
  const sections = await details.locator('.details-section').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  expect(sections[0]).toBe('Resource quota summary');
  expect(sections.at(-1)).toBe('Metadata');
  await expect(quota).toBeVisible();
  await expect(details.getByRole('region', { name: 'Resource limits' }).getByRole('cell', { name: 'cpu' })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Resource limits' }).getByRole('cell', { name: '4' })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Resource limits' }).getByRole('cell', { name: '1', exact: true })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Resource limits' }).getByRole('cell', { name: '25%' }).first()).toBeVisible();

  // Network policy: rule tables and the selected pods.
  details = await open(page, 'Network Policies', 'web-policy');
  await expect(details.getByRole('region', { name: 'Network policy summary' })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Ingress rules (1)' }).getByRole('cell', { name: 'TCP/8080' })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Pods selected by this policy' }).getByRole('button', { name: 'web-pod' })).toBeVisible();

  // Endpoint slice: ports and endpoints, linked to the owning service.
  details = await open(page, 'Endpoint Slices', 'web-slice');
  await expect(details.getByRole('region', { name: 'Endpoint slice summary' })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Ports (1)' }).getByRole('cell', { name: '8080' })).toBeVisible();
  await details.getByRole('button', { name: /Service\/web-service/ }).click();
  await expect(details.getByRole('region', { name: 'Service summary' })).toBeVisible();


  // Leases, webhook configurations and DRA resources.
  details = await open(page, 'Leases', 'web-lease');
  await expect(details.getByRole('region', { name: 'Lease summary' })).toBeVisible();
  await expect(details.getByText('Holder', { exact: true })).toBeVisible();

  details = await open(page, 'Mutating Webhook Configurations', 'hooks');
  await expect(details.getByRole('region', { name: 'Mutating webhook configuration summary' })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Webhooks (1)' }).getByRole('cell', { name: 'Service backend/sidecar/mutate' })).toBeVisible();

  details = await open(page, 'Device Classes', 'gpu.example.com');
  await expect(details.getByRole('region', { name: 'Device class summary' })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Device selectors (1)' }).getByRole('cell', { name: 'gpu', exact: true })).toBeVisible();

  details = await open(page, 'Resource Claims', 'web-claim');
  await expect(details.getByRole('region', { name: 'Resource claim summary' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'gpu.example.com' })).toBeVisible();

  expect(errors).toEqual([]);
});
