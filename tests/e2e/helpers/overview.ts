export async function overviewMetricsFixture(page: import('@playwright/test').Page, unavailable = false, delayed = false) {
  let sequence = 0;let release: (() => Promise<void>) | undefined;const requests: string[] = [];
  const base = Date.now() - 90000;
  await page.route('**/api/k8s/**', async route => {
    const url = new URL(route.request().url());const op = url.pathname.split('/').pop();const kind = url.searchParams.get('kind');
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['alpha', 'beta'] });
    if (op === 'metrics') {
      const namespace = url.searchParams.get('namespace');requests.push(namespace ?? 'all');sequence++;
      const timestamp = new Date(base + sequence * 15000).toISOString();
      const podMetric = (ns: string) => ({ name: `web-${ns}`, namespace: ns, timestamp, window: '30s', containers: [{ name: 'app', cpu: ns === 'alpha' ? '500m' : '250m', memory: '256Mi' }, { name: 'sidecar', cpu: '125m', memory: '64Mi' }] });
      const data = { context: 'test', namespace, pods: { items: namespace ? [podMetric(namespace)] : [podMetric('alpha'), podMetric('beta')], error: null }, nodes: { items: namespace ? null : [{ name: 'worker', timestamp, window: '30s', cpu: `${1500 + sequence * 100}m`, memory: '3Gi' }], error: null } };
      if (unavailable) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Metrics Server unavailable', status: 503, retryable: true } } });
      if (delayed && !namespace) { await new Promise<void>(resolve => { release = async () => { await route.fulfill({ json: data });resolve(); }; });return; }
      return route.fulfill({ json: data });
    }
    const metadata = (name: string, namespace?: string) => ({ name, namespace, uid: name, creationTimestamp: new Date(base - 3600000).toISOString() });
    const resources = { requests: { cpu: '500m', memory: '256Mi' }, limits: { cpu: '2', memory: '1Gi' } };
    const items = kind === 'Pod' ? ['alpha', 'beta'].map(namespace => ({ apiVersion: 'v1', kind, metadata: metadata(`web-${namespace}`, namespace), spec: { containers: [{ name: 'app', resources }, { name: 'sidecar', resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '1', memory: '512Mi' } } }] }, status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }, { name: 'sidecar', ready: true, state: { running: {} } }] } }))
      : kind === 'Node' ? [{ apiVersion: 'v1', kind, metadata: metadata('worker'), status: { capacity: { cpu: '4', memory: '8Gi' }, allocatable: { cpu: '3500m', memory: '7Gi' }, conditions: [{ type: 'Ready', status: 'True' }] } }]
      : kind === 'Namespace' ? ['alpha', 'beta'].map(name => ({ apiVersion: 'v1', kind, metadata: metadata(name) })) : [];
    const namespace = url.searchParams.get('namespace');
    return route.fulfill({ json: { items: namespace ? items.filter(item => !item.metadata.namespace || item.metadata.namespace === namespace) : items } });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();await page.getByRole('button', { name: 'Open Overview', exact: true }).click();return { telemetry: page.getByRole('region', { name: 'CPU and RAM telemetry' }), requests, release: async () => { await release?.(); } };
}
