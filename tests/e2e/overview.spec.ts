import { captureScreenshot } from './helpers/screenshots';
import { test, expect } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';
async function setup(page: import('@playwright/test').Page, partial = false) {
  let extra = false;
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());const op = url.pathname.split('/').pop();const kind = url.searchParams.get('kind');
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['a', 'b', 'empty'] });
    if (kind === 'Namespace') return route.fulfill({ json: namespaceList(['a', 'b', 'empty']) });
    if (partial && kind === 'Secret') return route.fulfill({ status: 403, json: { error: { code: 'forbidden', status: 403, message: 'Secrets access denied', retryable: false } } });
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
  const { overview, change } = await setup(page);await expect(overview.getByRole('heading', { name: 'Cluster overview' })).toBeVisible();await expect(overview.getByTestId('overview-count-Pod')).toHaveText('2');await expect(overview.getByRole('button', { name: 'Nodes: 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();await page.getByRole('option', { name: 'a', exact: true }).click();await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();await expect(overview.getByRole('heading', { name: 'Namespace overview' })).toBeVisible();await expect(overview.getByTestId('overview-count-Pod')).toHaveText('1');await expect(overview.getByTestId('overview-count-Node')).toHaveCount(0);await expect(overview.getByText('Container restarts', { exact: true })).toBeVisible();
  change();await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();await expect(overview.getByTestId('overview-count-Pod')).toHaveText('2');
  await overview.getByRole('button', { name: 'Open Service resources', exact: true }).click();await expect(page.getByTestId('resource-table').getByTitle('svc', { exact: true })).toBeVisible();await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
  await page.reload();await expect(overview).toBeVisible();await expect(overview.getByRole('heading', { name: 'Namespace overview' })).toBeVisible();
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();await page.getByRole('option', { name: 'All Namespaces', exact: true }).click();await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();await expect(overview.getByRole('heading', { name: 'Cluster overview' })).toBeVisible();
  await overview.getByRole('region', { name: 'Detected issues', exact: true }).getByRole('button').filter({ hasText: 'bad' }).click();await expect(page.locator('main').getByTestId('resource-details')).toContainText('bad');
});
test('Overview marks missing data, handles empty namespaces and fits narrow editor panes', async ({ page }) => {
  const { overview } = await setup(page, true);await expect(overview.getByText(/Partial or stale data/)).toBeVisible();await expect(overview.getByTestId('overview-count-Secret')).toHaveText('—');
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();await page.getByRole('option', { name: 'empty', exact: true }).click();await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();await expect(overview.getByTestId('overview-count-Pod')).toHaveText('0');
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
