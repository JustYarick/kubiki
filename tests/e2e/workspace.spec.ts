import { captureScreenshot } from './helpers/screenshots';
import { selectDiagramNamespaces } from './helpers/topology';
import { test, expect } from '@playwright/test';

test('plain table rows, related resource navigation, container logs and persistent dock', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  const row = page.getByTestId('resource-table').locator('tbody tr').filter({ hasText: 'api-gateway-7f9c8b6d5-q7x9z' });
  await page.getByPlaceholder('Filter pods…').fill('api-gateway');
  await expect(row).toBeVisible(); await row.hover(); await expect(row.locator('button')).toHaveCount(0);
  await row.click();
  const details = page.getByTestId('resource-details');
  await expect(details.getByText('api-gateway-7f9c8b6d5-q7x9z', { exact: true }).first()).toBeVisible();
  await details.getByRole('tab', { name: /^Related/ }).click();
  await details.getByRole('region', { name: 'Resource relationships' }).getByRole('button').filter({ hasText: 'api-gateway-7f9c8b6d5' }).click();
  await expect(details.getByText('ReplicaSet · default')).toBeVisible();
  await details.getByRole('tab', { name: /^Related/ }).click();
  await details.getByRole('region', { name: 'Resource relationships' }).getByRole('button').filter({ has: page.locator('[data-resource-kind="Deployment"]') }).click();
  await expect(details.getByText('Deployment · default')).toBeVisible();
  await details.getByRole('button', { name: 'Back to previous resource' }).click();
  await details.getByRole('button', { name: 'Back to previous resource' }).click();
  await details.getByRole('button', { name: 'Logs', exact: true }).click();
  await expect(page.getByText('Simulated logs')).toBeVisible();
  await page.getByPlaceholder('Filter log lines…').fill('readiness');
  await page.keyboard.press('Control+j');
  await expect(page.getByRole('button', { name: 'Expand bottom panel' })).toBeVisible();
  await page.keyboard.press('Control+j');
  await expect(page.getByPlaceholder('Filter log lines…')).toHaveValue('readiness');
  await captureScreenshot(page, { path: 'test-results/inspector-and-logs.png' });
  expect(errors).toEqual([]);
});

test('deployment actions are available through the context menu, with no inline controls', async ({ page }) => {
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Deployments(?: \d+)?$/ }).click();
  const row = page.getByTestId('resource-table').locator('tbody tr').filter({ hasText: 'api-gateway' }).first();
  await page.getByPlaceholder('Filter deployments…').fill('api-gateway');
  await expect(row).toBeVisible(); await row.hover(); await expect(row.locator('button')).toHaveCount(0);
  await row.click({ button: 'right' });
  await expect(page.getByText('Scale replicas…', { exact: true })).toBeVisible();
});

test('cluster and focused topology automatically lay out and open resource details', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await expect(page.locator('.topology-view')).toHaveAttribute('data-scope', '');
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  await selectDiagramNamespaces(page, ['backend']);
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Arranging topology…')).toHaveCount(0);
  const node = page.locator('.react-flow__node').filter({ hasText: 'auth-service-58848db6cb-kl8m2' });
  await node.click(); await expect(page.getByTestId('resource-details')).toBeVisible();
  await captureScreenshot(page, { path: 'test-results/topology.png', fullPage: true });
  await page.getByTestId('resource-details').getByRole('button', { name: 'Topology', exact: true }).click();
  await expect(page.locator('.topology-view')).toHaveAttribute('data-scope', 'resource');
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await expect(page.getByText('Arranging topology…')).toHaveCount(0);
  await captureScreenshot(page, { path: 'test-results/resource-topology.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('an unavailable API server remains disconnected without demo fallback', async ({ page }) => {
  await page.route('**/api/k8s/**', async (route) => {
    if (route.request().url().includes('/contexts')) return route.fulfill({ json: [{ name: 'unreachable', is_current: true }] });
    return route.fulfill({ status: 503, json: { error: 'API server unavailable' } });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'API server unavailable' })).toBeVisible();
  await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
  await expect(page.getByTestId('resource-table').locator('tbody tr')).toHaveCount(0);
});

test('live details, manifest and logs use the selected object and container', async ({ page }) => {
  const logs: string[] = [];
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'live-pod', name: 'live-web', namespace: 'backend', labels: { app: 'web' } }, spec: { containers: [{ name: 'web', image: 'nginx' }, { name: 'sidecar', image: 'envoy' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'web', ready: true }, { name: 'sidecar', ready: true }] } };
  await page.route('**/api/k8s/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.34.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['backend'] });
    if (url.pathname.endsWith('/logs')) { logs.push(url.search); return route.fulfill({ json: '2026-10-20T00:00:00Z actual-container-output\n' }); }
    return route.fulfill({ json: { items: url.searchParams.get('kind') === 'Pod' ? [pod] : [] } });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('live-web', { exact: true }).click();
  const details = page.getByTestId('resource-details');
  await details.getByRole('button', { name: 'Open details in tab' }).click();
  await expect(page.getByTestId('workspace-tab-panel').getByTestId('resource-details')).toBeVisible();
  await page.getByTestId('workspace-tab-panel').getByRole('tab', { name: 'YAML', exact: true }).click();
  await expect(page.getByTestId('workspace-tab-panel').getByTestId('yaml-editor')).toContainText('live-web', { timeout: 15000 });
  await details.last().getByRole('tab', { name: 'Overview', exact: true }).click();
  await details.last().getByRole('button', { name: 'Logs for sidecar', exact: true }).click();
  await expect(page.getByText('actual-container-output', { exact: true })).toBeVisible();
  expect(logs.some((query) => query.includes('container=sidecar') && query.includes('namespace=backend') && query.includes('context=test'))).toBe(true);
});

test('late responses from the previous cluster cannot replace the current cluster', async ({ page }) => {
  await page.route('**/api/k8s/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'cluster-a', is_current: true }, { name: 'cluster-b', is_current: false }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.34.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['default'] });
    const context = url.searchParams.get('context');
    if (context === 'cluster-a') await new Promise((resolve) => setTimeout(resolve, 800));
    return route.fulfill({ json: { items: url.searchParams.get('kind') === 'Pod' ? [{ metadata: { uid: context, name: context, namespace: 'default' }, spec: { containers: [] } }] : [] } });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByRole('banner').getByRole('button', { name: /^cluster-a(?: |$)/ }).click();
  await page.getByText('cluster-b', { exact: true }).click();
  await expect(page.getByTestId('resource-table').getByText('cluster-b', { exact: true })).toBeVisible();
  await expect(page.getByTestId('resource-table').getByText('cluster-a', { exact: true })).toHaveCount(0);
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('resource-table').getByText('cluster-a', { exact: true })).toHaveCount(0);
});

test('details leave usable editor space at the minimum window size', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').locator('tbody tr').first().click();
  const details = await page.getByTestId('resource-details').boundingBox();
  const table = await page.getByTestId('resource-table').boundingBox();
  expect(details?.width).toBeGreaterThanOrEqual(340);
  expect(table?.width).toBeGreaterThanOrEqual(300);
  await expect(page.getByRole('button', { name: 'Close details' })).toBeVisible();
  const overview = page.getByTestId('resource-details').getByRole('tabpanel').locator(':scope > div');
  expect(await overview.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await captureScreenshot(page, { path: 'test-results/inspector-900.png' });
});
