import { test, expect, type Page } from '@playwright/test';

const pod = (uid = 'original') => ({ apiVersion: 'v1', kind: 'Pod', metadata: { uid, name: 'live-web', namespace: 'backend' }, spec: { containers: [{ name: 'app', image: 'nginx' }] }, status: { phase: 'Running' } });
async function api(page: Page, read: () => { status?: number; json: unknown }) {
  await page.route('**/api/k8s/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.34.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['backend'] });
    return route.fulfill(url.searchParams.get('kind') === 'Pod' ? read() : { json: { items: [] } });
  });
}

for (const [status, code, hint] of [[403, 'forbidden', 'RBAC'], [404, 'not_found', 'no longer exists'], [504, 'timeout', 'timed out']] as const) {
  test(`resource error ${status} has a useful reason and retry recovers`, async ({ page }) => {
    let failed = true;
    await api(page, () => failed ? { status, json: { error: { code, status, message: `API request failed (${status})` } } } : { json: { items: [pod()] } });
    await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
    const table = page.getByTestId('resource-table');
    const notice = table.getByRole('alert');
    await expect(notice).toHaveAttribute('data-error-code', code);
    await expect(notice).toContainText(hint);
    await expect(table.getByText('No pods found', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Disconnected', { exact: true })).toHaveCount(0);
    failed = false;
    await notice.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(table.getByText('live-web', { exact: true })).toBeVisible();
    await expect(notice).toHaveCount(0);
  });
}

test('a failed refresh retains the previous snapshot with an explicit stale notice', async ({ page }) => {
  let failed = false;
  await api(page, () => failed ? { status: 504, json: { error: { code: 'timeout', status: 504, message: 'Request timed out' } } } : { json: { items: [pod()] } });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  const table = page.getByTestId('resource-table');
  await expect(table.getByText('live-web', { exact: true })).toBeVisible();
  failed = true;
  await page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(table.getByRole('alert')).toContainText('may be out of date');
  await expect(table.getByText('live-web', { exact: true })).toBeVisible();
  failed = false;
  await table.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(table.getByRole('alert')).toHaveCount(0);
});

test('a details tab never silently switches to a recreated resource with the same name', async ({ page }) => {
  let uid = 'original';
  await api(page, () => ({ json: { items: [pod(uid)] } }));
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('resource-table').getByText('live-web', { exact: true }).click();
  await page.getByTestId('resource-details').getByRole('button', { name: 'Open details in tab' }).click();
  await expect(page.locator('main').getByTestId('resource-details')).toBeVisible();
  uid = 'replacement';
  await page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('main').getByText('Resource Not Found', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('live-web', { exact: true }).click();
  await page.getByTestId('resource-details').getByRole('button', { name: 'Open details in tab' }).click();
  await expect(page.locator('main').getByTestId('resource-details')).toBeVisible();
});
