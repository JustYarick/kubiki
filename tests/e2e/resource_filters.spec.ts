import { test, expect } from '@playwright/test';

test('resource search, health, status and chronological order compose with one global namespace selector', async ({ page }) => {
  const ready = { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }] };
  const pods = [
    { name: 'z-new', date: '2026-10-20T09:00:00Z', status: ready },
    { name: 'b-warning', date: '2026-10-19T00:00:00Z', status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient memory' }] } },
    { name: 'a-error', date: '2026-10-20T08:00:00Z', status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } },
    { name: 'c-completed', date: '2026-10-20T07:00:00Z', status: { phase: 'Succeeded' } },
    { name: 'd-unknown-date', status: ready },
    { name: 'other-error', namespace: 'other', date: '2026-10-20T10:00:00Z', status: { phase: 'Failed' } },
  ].map((item) => ({ metadata: { uid: item.name, name: item.name, namespace: item.namespace ?? 'backend', creationTimestamp: item.date }, spec: { containers: [{ name: 'app' }] }, status: item.status }));
  await page.route('**/api/k8s/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.34.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['backend', 'other'] });
    return route.fulfill({ json: { items: url.searchParams.get('kind') === 'Pod' ? pods : [] } });
  });
  await page.goto('/');
  const table = page.getByTestId('resource-table');
  await expect(table.locator('tbody tr')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Namespace Scope', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Namespace filter', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Breadcrumb namespace', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  await page.getByRole('option', { name: 'backend', exact: true }).click();
  const names = () => table.locator('tbody tr').evaluateAll((rows) => rows.map((row) => row.querySelector('td:nth-child(2)')?.textContent?.trim()));
  await page.getByLabel('Resource order', { exact: true }).selectOption('issues');
  await expect.poll(names).toEqual(['a-error', 'b-warning', 'c-completed', 'd-unknown-date', 'z-new']);
  await page.getByLabel('Resource health filter').selectOption('issues');
  await expect.poll(names).toEqual(['a-error', 'b-warning']);
  await page.getByLabel('Resource status filter').selectOption('Pending');
  await expect.poll(names).toEqual(['b-warning']);
  await page.getByLabel('Resource status filter').selectOption('');
  await page.getByLabel('Resource health filter').selectOption('all');
  await page.getByLabel('Resource order', { exact: true }).selectOption('newest');
  await expect.poll(names).toEqual(['z-new', 'a-error', 'c-completed', 'b-warning', 'd-unknown-date']);
  await page.getByLabel('Resource order', { exact: true }).selectOption('oldest');
  await expect.poll(names).toEqual(['b-warning', 'c-completed', 'a-error', 'z-new', 'd-unknown-date']);
  const search = page.getByPlaceholder('Filter pods…');
  const searchBounds = (await search.boundingBox())!;
  const toolbarBounds = (await page.getByTestId('resource-search-toolbar').boundingBox())!;
  const healthBounds = (await page.getByLabel('Resource health filter').boundingBox())!;
  expect(Math.abs(healthBounds.y - searchBounds.y)).toBeLessThan(3);
  expect(searchBounds.width).toBeGreaterThan(300);
  expect(searchBounds.x - toolbarBounds.x).toBeLessThan(20);
  await search.fill('  BACKEND  ');
  await expect(table.locator('tbody tr')).toHaveCount(5);
  for (const status of ['Running', 'Pending', 'Succeeded']) {
    await search.fill(status);
    await expect(table.locator('tbody tr')).toHaveCount(0);
  }
  await search.fill('  A-ERROR  ');
  await expect.poll(names).toEqual(['a-error']);
  await search.fill('error');
  await expect.poll(names).toEqual(['a-error']);
  await expect(table.locator('tbody tr button')).toHaveCount(0);
  await search.fill('');
  await page.screenshot({ path: 'test-results/resource-filters.png' });
});

test('filters share one row with search and collapse into a menu without moving rows or losing state', async ({ page }) => {
  await page.goto('/?demo=1');
  const table = page.getByTestId('resource-table');
  const toolbar = page.getByTestId('resource-search-toolbar');
  const search = page.getByPlaceholder('Filter pods…');
  const row = table.locator('tbody tr').first();
  await expect(row).toBeVisible();
  await expect(page.getByLabel('Resource health filter')).toBeVisible();
  const before = (await toolbar.boundingBox())!;
  const rowBefore = (await row.boundingBox())!;
  await row.click();
  const trigger = page.getByRole('button', { name: 'Resource filters and sorting', exact: true });
  await expect(trigger).toBeVisible();
  const after = (await toolbar.boundingBox())!;
  expect(after.height).toBeCloseTo(before.height, 0);
  expect((await row.boundingBox())!.y).toBeCloseTo(rowBefore.y, 0);
  expect(Math.abs((await trigger.boundingBox())!.y - (await search.boundingBox())!.y)).toBeLessThan(3);
  await trigger.click();
  const options = page.getByRole('group', { name: 'Resource filter options', exact: true });
  await options.getByLabel('Resource health filter').selectOption('issues');
  await options.getByLabel('Resource order', { exact: true }).selectOption('newest');
  await page.keyboard.press('Escape');
  await expect(trigger).toContainText('2');
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect(trigger).toHaveCount(0);
  await expect(page.getByLabel('Resource health filter')).toHaveValue('issues');
  await expect(page.getByLabel('Resource order', { exact: true })).toHaveValue('newest');
  expect((await search.boundingBox())!.width).toBeGreaterThan(300);
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(trigger).toBeVisible();
  await expect.poll(() => toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await trigger.click();
  await expect(options.getByLabel('Resource health filter')).toHaveValue('issues');
  await expect(options.getByLabel('Resource order', { exact: true })).toHaveValue('newest');
  await expect(options.locator('..')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'test-results/adaptive-resource-filters.png' });
});
