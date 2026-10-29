import { captureScreenshot } from './helpers/screenshots';
import { test, expect } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';
async function setup(page: import('@playwright/test').Page, partial = false, metrics?: (url: URL) => object) {
  let extra = false;
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());const op = url.pathname.split('/').pop();const kind = url.searchParams.get('kind');
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['a', 'b', 'empty'] });
    if (op === 'metrics' && metrics) return route.fulfill({ json: metrics(url) });
    if (kind === 'Namespace') return route.fulfill({ json: namespaceList(['a', 'b', 'empty']) });
    if (partial && kind === 'Event') return route.fulfill({ status: 403, json: { error: { code: 'forbidden', status: 403, message: 'Events access denied', retryable: false } } });
    const resource = (name: string, namespace?: string, status = {}) => ({ kind, metadata: { uid: name, name, namespace, creationTimestamp: new Date(Date.now() - 600000).toISOString() }, status });
    const items = kind === 'Pod' ? [resource('good', 'a', { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 2, state: { running: {} } }] }), resource('bad', 'b', { phase: 'Failed' }), ...(extra ? [resource('new', 'a', { phase: 'Pending' })] : [])]
      : kind === 'Service' ? [resource('svc', 'a')] : kind === 'Node' ? [resource('worker', undefined, { conditions: [{ type: 'Ready', status: 'True' }] })] : [];
    const namespace = url.searchParams.get('namespace');
    return route.fulfill({ json: { items: items.filter(item => !namespace || !item.metadata.namespace || item.metadata.namespace === namespace) } });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
  return { overview: page.getByTestId('cluster-overview'), change: () => { extra = true; } };
}
test('Overview follows global namespace, refreshes counts, opens resources and persists as one tab', async ({ page }) => {
  const { overview, change } = await setup(page);await expect(overview.getByRole('region', { name: 'Summary', exact: true })).toHaveAttribute('data-metric-count', '5');await expect(overview.getByRole('button', { name: 'Pods: 2', exact: true })).toBeVisible();await expect(overview.getByRole('button', { name: 'Nodes: 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();await page.getByRole('option', { name: 'a', exact: true }).click();await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();await expect(overview.getByRole('region', { name: 'Summary', exact: true })).toHaveAttribute('data-metric-count', '3');await expect(overview.getByRole('button', { name: 'Pods: 1', exact: true })).toBeVisible();await expect(overview.getByRole('button', { name: /^Nodes:/ })).toHaveCount(0);await expect(overview.getByText('Container restarts', { exact: true })).toHaveCount(0);
  change();await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();await expect(overview.getByRole('button', { name: 'Pods: 2', exact: true })).toBeVisible();
  await overview.getByRole('button', { name: 'Services: 1', exact: true }).click();await expect(page.getByTestId('resource-table').getByTitle('svc', { exact: true })).toBeVisible();await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
  await page.reload();await expect(overview).toBeVisible();await expect(overview.getByRole('region', { name: 'Summary', exact: true })).toHaveAttribute('data-metric-count', '3');
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();await page.getByRole('option', { name: 'All Namespaces', exact: true }).click();await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();await expect(overview.getByRole('region', { name: 'Summary', exact: true })).toHaveAttribute('data-metric-count', '5');
  await overview.getByRole('region', { name: 'Detected issues', exact: true }).getByRole('button').filter({ hasText: 'bad' }).click();await expect(page.locator('main').getByTestId('resource-details')).toContainText('bad');
});

test('Overview keeps one continuous CPU/RAM history while switching workspace tabs and stops collecting when closed', async ({ page }) => {
  let sampledAt = Date.now();
  let reads = 0;
  await page.clock.install({ time: sampledAt });
  const { overview } = await setup(page, false, url => {
    reads++;
    const namespace = url.searchParams.get('namespace');
    const timestamp = new Date(sampledAt).toISOString();
    return { context: 'test', namespace,
      pods: { items: [{ name: 'good', namespace: 'a', timestamp, window: '15s', containers: [{ name: 'app', cpu: `${100 + reads * 20}m`, memory: '64Mi' }] }], error: null },
      nodes: { items: namespace ? null : [{ name: 'worker', timestamp, window: '15s', cpu: `${200 + reads * 30}m`, memory: '128Mi' }], error: null },
    };
  });
  const cpu = overview.getByRole('img', { name: 'CPU usage history', exact: true });
  const memory = overview.getByRole('img', { name: 'RAM usage history', exact: true });
  await expect(cpu).toHaveAttribute('data-samples', '1');
  const explorer = page.getByTestId('explorer-panel');
  for (let index = 0; index < 4; index++) {
    await explorer.locator(`[data-resource-type="${index % 2 ? 'Service' : 'Pod'}"]`).click();
    await expect(overview).toHaveCount(0);
    const before = reads;
    sampledAt += 15000;
    const response = page.waitForResponse(response => response.url().includes('/api/k8s/metrics?'));
    await page.clock.runFor(15000);
    await (await response).finished();
    await expect.poll(() => reads).toBe(before + 1);
    await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
    await expect(cpu).toHaveAttribute('data-samples', String(index + 2));
    await expect(memory).toHaveAttribute('data-samples', String(index + 2));
  }
  await expect(cpu.locator('.telemetry-chart-line')).toHaveCount(1);
  await expect(memory.locator('.telemetry-chart-line')).toHaveCount(1);
  expect((await cpu.locator('.telemetry-chart-line').getAttribute('d'))?.match(/L/g)).toHaveLength(4);
  await captureScreenshot(page, { path: 'test-results/overview-continuous-history.png' });
  await page.getByRole('tab', { name: /^Overview/ }).getByRole('button', { name: 'Close tab', exact: true }).click();
  const beforeClose = reads;
  await page.clock.runFor(60000);
  expect(reads).toBe(beforeClose);
});
test('Overview marks missing data, handles empty namespaces and fits narrow editor panes', async ({ page }) => {
  const { overview } = await setup(page, true);await expect(overview.getByText(/Partial or stale data/)).toBeVisible();await expect(overview.locator('details')).toContainText('Events access denied');
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();await page.getByRole('option', { name: 'empty', exact: true }).click();await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();await expect(overview.getByRole('button', { name: 'Pods: 0', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });expect(await overview.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);await captureScreenshot(page, { path: 'test-results/overview.png' });
});


test('Problems has severity counts, filters and resource navigation without widening the Overview', async ({ page }) => {
  const { overview, change } = await setup(page);
  change(); await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();
  const problems = overview.getByRole('region', { name: 'Detected issues', exact: true });
  await expect(problems.getByRole('button', { name: 'Critical problems', exact: true })).toContainText('1');
  await expect(problems.getByRole('button', { name: 'Warning problems', exact: true })).toContainText('1');
  await problems.getByRole('button', { name: 'Critical problems', exact: true }).click();
  await expect(problems.getByRole('button').filter({ hasText: 'bad' })).toBeVisible();
  await expect(problems.getByRole('button').filter({ hasText: 'new' })).toHaveCount(0);
  await problems.getByRole('button', { name: 'Warning problems', exact: true }).click();
  await expect(problems.getByRole('button').filter({ hasText: 'new' })).toBeVisible();
  await expect(problems.getByRole('button').filter({ hasText: 'bad' })).toHaveCount(0);
  for (const width of [1200, 900, 700]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => overview.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await problems.getByRole('button').filter({ hasText: 'new' }).click();
  await expect(page.locator('main').getByTestId('resource-details')).toContainText('new');
});
