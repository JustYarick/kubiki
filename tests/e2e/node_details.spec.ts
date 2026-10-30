import { expect, test, type Page } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';
import { captureScreenshot } from './helpers/screenshots';

async function setup(page: Page, unavailable = false, sampleAt?: () => number) {
  let reads = 0;
  const base = Date.now() - 1000;
  const node = (name: string) => ({ apiVersion: 'v1', kind: 'Node', metadata: { uid: name, name, creationTimestamp: new Date(base - 3600000).toISOString(), labels: { 'topology.kubernetes.io/zone': 'zone-a' } }, spec: { providerID: 'local://node/worker-a', podCIDRs: ['10.42.0.0/24'] }, status: { capacity: { cpu: '8', memory: '16Gi', pods: '110' }, allocatable: { cpu: '4', memory: '8Gi', pods: '100' }, nodeInfo: { kubeletVersion: 'v1.35.0', containerRuntimeVersion: 'containerd://2.0', osImage: 'Linux', kernelVersion: '6.12', bootID: 'boot-test' }, conditions: [{ type: 'Ready', status: 'True' }] } });
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/').pop(); const kind = url.searchParams.get('kind');
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['alpha', 'beta'] });
    if (op === 'metrics') {
      reads++;
      const namespace = url.searchParams.get('namespace');
      const timestamp = new Date(sampleAt ? sampleAt() : base + (reads - 1) * 15000).toISOString();
      return route.fulfill({ json: { context: 'test', namespace, pods: { items: [], error: null }, nodes: unavailable ? { items: null, error: { code: 'forbidden', message: 'Node metrics access denied', operation: 'metrics', retryable: false } } : { items: [
        { name: 'worker-a', timestamp, window: '15s', cpu: reads === 1 ? '1' : '1500m', memory: '2Gi' },
        { name: 'worker-b', timestamp, window: '15s', cpu: '3', memory: '6Gi' },
      ], error: null } } });
    }
    const pod = (name: string, namespace: string, nodeName: string) => ({ apiVersion: 'v1', kind: 'Pod', metadata: { uid: name, name, namespace }, spec: { nodeName, containers: [{ name: 'app', resources: { requests: { cpu: '100m', memory: '128Mi' } } }] }, status: { phase: 'Running' } });
    const items = kind === 'Node' ? [node('worker-a'), node('worker-b')] : kind === 'Namespace' ? namespaceList(['alpha', 'beta']).items : kind === 'Pod' ? [pod('alpha-pod', 'alpha', 'worker-a'), pod('beta-pod', 'beta', 'worker-a'), pod('other-node-pod', 'alpha', 'worker-b')] : [];
    const namespace = url.searchParams.get('namespace');
    return route.fulfill({ json: { items: items.filter(item => !namespace || !('namespace' in item.metadata) || item.metadata.namespace === namespace) } });
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').locator('[data-resource-type="Node"]').click();
  await page.getByTestId('resource-table').getByText('worker-a', { exact: true }).click();
  return { details: page.getByTestId('inspector-panel').getByTestId('resource-details'), reads: () => reads };
}

test('Node details show independent live history, system details and all scheduled namespaces', async ({ page }) => {
  const { details, reads } = await setup(page);
  const performance = details.getByRole('region', { name: 'Node performance', exact: true });
  const cpu = performance.getByRole('region', { name: 'Node CPU performance', exact: true });
  const memory = performance.getByRole('region', { name: 'Node RAM performance', exact: true });
  await expect(cpu.locator('.telemetry-value')).toHaveText('1 cores');
  await expect(memory.locator('.telemetry-value')).toHaveText('2 GiB');
  await expect(cpu).toContainText('25.0% of allocatable');
  const chart = cpu.getByRole('img', { name: 'CPU usage history', exact: true });
  await expect(chart).toHaveAttribute('data-samples', '1');
  const first = (await chart.locator('.telemetry-chart-line').getAttribute('d'))!.match(/M[\d.]+,([\d.]+) L[\d.]+,([\d.]+)/)!;
  expect(first[1]).toBe(first[2]);
  await performance.getByRole('button', { name: 'Refresh node metrics', exact: true }).click();
  await expect(chart).toHaveAttribute('data-samples', '2');
  await expect(cpu.locator('.telemetry-value')).toHaveText('1.5 cores');
  const line = (await chart.locator('.telemetry-chart-line').getAttribute('d'))!.match(/M[\d.]+,([\d.]+) L[\d.]+,([\d.]+)/)!;
  expect(line[1]).not.toBe(line[2]);
  expect(reads()).toBe(2);
  await performance.getByRole('button', { name: 'Fixed scale', exact: true }).click();
  await expect(performance.getByText('Fixed scale', { exact: true }).last()).toBeVisible();
  await expect(details.getByRole('region', { name: 'Node identity and scheduling', exact: true })).toContainText('zone-a');
  await expect(details.getByRole('region', { name: 'Pods on this node', exact: true })).toContainText('beta-pod');
  await expect(details.getByRole('region', { name: 'Pods on this node', exact: true })).not.toContainText('other-node-pod');
  for (const width of [1200, 900, 700]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await details.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await captureScreenshot(page, { path: 'test-results/node-performance.png' });
});

test('Node metric denial remains unavailable rather than rendering zero usage', async ({ page }) => {
  const { details } = await setup(page, true);
  const performance = details.getByRole('region', { name: 'Node performance', exact: true });
  await expect(performance.getByRole('status')).toContainText('Node metrics access denied');
  await expect(performance.locator('.telemetry-value').first()).toHaveText('—');
  await expect(performance.getByRole('img', { name: 'CPU usage history', exact: true })).toHaveAttribute('data-samples', '0');
});

test('Node history connects observations across a two-minute pause while viewing another node', async ({ page }) => {
  let sampledAt = Date.now() - 1000;
  await page.clock.install({ time: Date.now() });
  const { details } = await setup(page, false, () => sampledAt);
  const performance = details.getByRole('region', { name: 'Node performance', exact: true });
  const cpu = performance.getByRole('img', { name: 'CPU usage history', exact: true });
  await expect(cpu).toHaveAttribute('data-samples', '1');
  await page.getByTestId('resource-table').getByText('worker-b', { exact: true }).click();
  await expect(details.locator('.details-title')).toHaveText('worker-b');
  sampledAt += 120000;
  await page.clock.fastForward(120000);
  await page.getByTestId('resource-table').getByText('worker-a', { exact: true }).click();
  await expect(details.locator('.details-title')).toHaveText('worker-a');
  for (const dimension of ['CPU', 'RAM']) {
    const chart = performance.getByRole('img', { name: `${dimension} usage history`, exact: true });
    await expect(chart).toHaveAttribute('data-samples', '2');
    await expect(chart.locator('.telemetry-chart-line')).toHaveCount(1);
    expect((await chart.locator('.telemetry-chart-line').getAttribute('d'))?.match(/L/g)).toHaveLength(1);
  }
});
