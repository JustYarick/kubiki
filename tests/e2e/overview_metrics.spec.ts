import { test, expect } from '@playwright/test';
async function fixture(page: import('@playwright/test').Page, unavailable = false, delayed = false) {
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
      : kind === 'Node' ? [{ apiVersion: 'v1', kind, metadata: metadata('worker'), status: { capacity: { cpu: '4', memory: '8Gi' }, allocatable: { cpu: '3500m', memory: '7Gi' }, conditions: [{ type: 'Ready', status: 'True' }] } }] : [];
    return route.fulfill({ json: { items } });
  });
  await page.goto('/');await page.getByRole('button', { name: 'Open Overview', exact: true }).click();return { telemetry: page.getByRole('region', { name: 'CPU and RAM telemetry' }), requests, release: async () => { await release?.(); } };
}
test('CPU/RAM dashboard shows usage, budgets, source history, sorting and container drilldown', async ({ page }) => {
  const { telemetry } = await fixture(page);
  await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('1.6 cores');await expect(telemetry.getByTestId('metric-memory-usage')).toHaveText('3 GiB');
  const cpu = telemetry.getByRole('region', { name: 'CPU usage', exact: true });await expect(cpu).toContainText('1.2 cores');await expect(cpu).toContainText('3.5 cores');await expect(cpu).toContainText('4 cores');await expect(cpu).toContainText('171.4% of allocatable');
  for (let index = 0; index < 2; index++) { await telemetry.getByRole('button', { name: 'Refresh metrics' }).click();await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText((1.7 + index * .1).toFixed(1) + ' cores'); }
  await expect(cpu.getByRole('img', { name: 'CPU usage history' })).toHaveAttribute('data-samples', '3');
  await cpu.getByRole('img', { name: 'CPU usage history' }).hover();await expect(cpu.locator('output')).toBeVisible();
  await telemetry.getByRole('group', { name: 'Sort consumers' }).getByRole('button', { name: 'RAM', exact: true }).click();
  await telemetry.getByRole('row').filter({ hasText: 'web-alpha' }).click();await expect(telemetry.getByText('app', { exact: true })).toBeVisible();await expect(telemetry.getByText('sidecar', { exact: true })).toBeVisible();await expect(telemetry.getByRole('button', { name: 'Open resource', exact: true })).toBeVisible();
  await page.getByTestId('cluster-overview').evaluate(el => el.scrollTop = 0);
  await page.screenshot({ path: 'test-results/overview-telemetry.png', fullPage: false });
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();await page.getByRole('option', { name: 'alpha', exact: true }).click();await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('625m');await expect(telemetry.getByRole('button', { name: 'Rank Nodes', exact: true })).toHaveCount(0);await expect(telemetry.getByRole('row').filter({ hasText: 'web-beta' })).toHaveCount(0);
  await page.setViewportSize({ width: 900, height: 900 });expect(await page.getByTestId('cluster-overview').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});
test('missing Metrics Server displays a reason and never turns unavailable usage into zero', async ({ page }) => {
  const { telemetry } = await fixture(page, true);await expect(telemetry.getByRole('status')).toContainText('Metrics Server unavailable');await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('—');await expect(telemetry.getByTestId('metric-memory-usage')).toHaveText('—');
});
test('late metrics from a previous scope cannot overwrite a selected namespace', async ({ page }) => {
  const { telemetry, requests, release } = await fixture(page, false, true);await expect.poll(() => requests).toContain('all');
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();await page.getByRole('option', { name: 'alpha', exact: true }).click();await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('625m');await release();await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('625m');
});

test('metrics polling pauses when hidden or navigating away and resumes without duplicate requests', async ({ page }) => {
  await page.clock.install({ time: new Date() });const { telemetry, requests } = await fixture(page);await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('1.6 cores');expect(requests).toHaveLength(1);
  await page.clock.runFor(16000);await expect.poll(() => requests.length).toBe(2);await expect(telemetry.getByRole('button', { name: 'Refresh metrics' })).toBeEnabled();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true });document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(60000);expect(requests).toHaveLength(2);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false });document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => requests.length).toBe(3);await expect(telemetry.getByRole('button', { name: 'Refresh metrics' })).toBeEnabled();
  await page.getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();await page.clock.runFor(30000);expect(requests).toHaveLength(3);
});
