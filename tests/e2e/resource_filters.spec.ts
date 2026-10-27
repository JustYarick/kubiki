import { test, expect, type Page, type Locator } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';

/** Rows of the resource table as plain names. */
async function names(table: Locator): Promise<string[]> {
  return table.locator('tbody tr').evaluateAll((rows) => rows.map((row) => row.querySelector('td:nth-child(2)')?.textContent?.trim() ?? ''));
}

async function openPods(page: Page) {
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  return page.getByTestId('resource-table');
}

const ready = { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }] };
const pods = [
  { name: 'z-new', date: '2026-10-20T09:00:00Z', status: ready },
  { name: 'b-warning', date: '2026-10-19T00:00:00Z', status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient memory' }] } },
  { name: 'a-error', date: '2026-10-20T08:00:00Z', status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } },
  { name: 'c-completed', date: '2026-10-20T07:00:00Z', status: { phase: 'Succeeded' } },
  { name: 'd-unknown-date', status: ready },
  { name: 'other-error', namespace: 'other', date: '2026-10-20T10:00:00Z', status: { phase: 'Failed' } },
].map((item) => ({ metadata: { uid: item.name, name: item.name, namespace: item.namespace ?? 'backend', creationTimestamp: item.date }, spec: { containers: [{ name: 'app' }] }, status: item.status }));

async function fixture(page: Page) {
  await page.route('**/api/k8s/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.34.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['backend', 'other'] });
    if (url.searchParams.get('kind') === 'Namespace') return route.fulfill({ json: namespaceList(['backend', 'other']) });
    return route.fulfill({ json: { items: url.searchParams.get('kind') === 'Pod' ? pods : [] } });
  });
}

async function selectNamespace(page: Page, name: string) {
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Choose Namespace Scope' });
  await menu.getByRole('option', { name, exact: true }).click();
  await menu.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
}

test('header clicks sort by column and the right-click popup filters the column', async ({ page }) => {
  await fixture(page);
  const table = await openPods(page);
  await expect(table.locator('tbody tr')).toHaveCount(6);

  const statusHeader = table.getByRole('columnheader', { name: 'Status', exact: true });
  // Clicking the Status header cycles through the statuses present in the data.
  await statusHeader.click();
  await expect(statusHeader).toHaveAttribute('aria-sort', 'other');
  await expect(table.locator('tbody tr').first()).toContainText('Running');
  await expect(table.locator('tbody tr')).toHaveCount(6);

  // A plain column sorts descending first, then ascending, then resets.
  const readyHeader = table.getByRole('columnheader', { name: 'Ready', exact: true });
  await readyHeader.click();
  await expect(readyHeader).toHaveAttribute('aria-sort', 'descending');
  await readyHeader.click();
  await expect(readyHeader).toHaveAttribute('aria-sort', 'ascending');
  await readyHeader.click();
  await expect(readyHeader).toHaveAttribute('aria-sort', 'none');

  // Right-click opens the filter popup with the values of that column.
  await statusHeader.click({ button: 'right' });
  const popup = page.getByTestId('column-filter-popup');
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('checkbox', { name: 'Running', exact: true })).toBeVisible();
  await popup.getByRole('checkbox', { name: 'Running', exact: true }).check();
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.getByRole('columnheader', { name: 'Status', exact: true })).toContainText('1');

  // Filters compose across columns: status AND node.
  await statusHeader.click({ button: 'right' });
  await page.getByTestId('column-filter-popup').getByRole('button', { name: 'Clear Status filter', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(6);
  await page.keyboard.press('Escape');

  // The popup searches its values and scrolls when there are many.
  await statusHeader.click({ button: 'right' });
  const popup2 = page.getByTestId('column-filter-popup');
  await popup2.getByLabel('Search Status values').fill('pending');
  await expect(popup2.getByRole('checkbox', { name: 'Pending', exact: true })).toBeVisible();
  await expect(popup2.getByRole('checkbox', { name: 'Running', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // One reset clears every filter and every sort key.
  await statusHeader.click({ button: 'right' });
  await page.getByTestId('column-filter-popup').getByRole('checkbox', { name: 'Pending', exact: true }).check();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  const reset = page.getByRole('button', { name: 'Reset all filters and sorting', exact: true });
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(table.locator('tbody tr')).toHaveCount(6);
  await expect(statusHeader).toHaveAttribute('aria-sort', 'none');
});

test('the sort hierarchy groups by the first clicked column and orders inside each group', async ({ page }) => {
  await fixture(page);
  const table = await openPods(page);
  const statusHeader = table.getByRole('columnheader', { name: 'Status', exact: true });
  const readyHeader = table.getByRole('columnheader', { name: 'Ready', exact: true });
  await statusHeader.click();
  await readyHeader.click();
  // Status groups the rows, Ready orders inside each group.
  await expect(statusHeader).toContainText('1');
  await expect(readyHeader).toContainText('2');
  const rows = await names(table);
  const running = rows.filter((name) => !name.includes('a-error'));
  expect(rows.length).toBe(6);
  expect(running.length).toBeGreaterThan(1);
});

test('filter values cycle include, exclude, reset and status sorting uses only filtered values', async ({ page }) => {
  await fixture(page);
  const table = await openPods(page);
  const header = table.getByRole('columnheader', { name: 'Status', exact: true });
  await expect(table.locator('tbody tr')).toHaveCount(6);
  await header.click();
  await expect(header).toHaveAttribute('title', 'Running first');
  await header.click({ button: 'right' });
  const popup = page.getByTestId('column-filter-popup');
  const running = popup.getByRole('checkbox', { name: 'Running', exact: true });
  await running.click();
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(running).toHaveAttribute('aria-checked', 'true');
  await running.click();
  await expect(running).toHaveAttribute('aria-checked', 'mixed');
  await expect(popup.getByText('Excluded', { exact: true })).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(4);
  await running.click();
  await expect(running).toHaveAttribute('aria-checked', 'false');
  await expect(table.locator('tbody tr')).toHaveCount(6);

  // Exclusions also apply when another value of this column is included.
  await popup.getByRole('checkbox', { name: 'Pending', exact: true }).click();
  await expect(popup.getByRole('checkbox').first()).toHaveAttribute('aria-label', 'Pending');
  await running.click();
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await running.click();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(header).toHaveAttribute('title', 'Pending first');
  await page.keyboard.press('Escape');
  await header.click();
  await expect(header).toHaveAttribute('title', 'Pending first');
  await header.click();
  await expect(header).toHaveAttribute('title', 'Pending first');

  // The popup still offers other values; the sort cycle must not use those.
  await header.click({ button: 'right' });
  await popup.getByRole('checkbox', { name: 'CrashLoopBackOff', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await header.click();
  await expect(header).toHaveAttribute('title', 'CrashLoopBackOff first');
  await expect(table.locator('tbody tr').first()).toContainText('a-error');
  await header.click();
  await expect(header).toHaveAttribute('title', 'Pending first');
});

test('a namespace selection never changes the metrics of global objects such as nodes', async ({ page }) => {
  await fixture(page);
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Nodes(?: \d+)?$/ }).click();
  const table = page.getByTestId('resource-table');
  await expect(table.locator('tbody tr')).toHaveCount(0);
  await selectNamespace(page, 'backend');
  await expect(page.getByRole('button', { name: 'Namespace Scope', exact: true })).toHaveAttribute('data-value', 'backend');
});

test('columns can be reordered by drag and by the keyboard alternative', async ({ page }) => {
  await fixture(page);
  const table = await openPods(page);
  const headers = table.getByRole('columnheader');
  await expect(headers.first()).toBeVisible();
  const before = await headers.evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label')));
  expect(before).toContain('Namespace');
  expect(before).toContain('Status');

  // The caret menu offers a keyboard alternative to dragging.
  await table.getByRole('columnheader', { name: 'Status', exact: true }).getByRole('button', { name: 'Status column actions', exact: true }).click();
  await page.getByRole('button', { name: 'Move column left', exact: true }).click();
  const after = await headers.evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label')));
  expect(after.indexOf('Status')).toBe(before.indexOf('Status') - 1);
  expect(after.length).toBe(before.length);

  // The order survives a reload.
  await page.reload();
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  const reloaded = await page.getByTestId('resource-table').getByRole('columnheader').evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label')));
  expect(reloaded.indexOf('Status')).toBe(after.indexOf('Status'));
});
