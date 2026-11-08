import { expect, test, type Locator, type Page } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';

const columnIds = ['__index', 'name', 'status', 'ready', 'restarts', 'namespace', 'containers', 'ip', 'node', 'age'];
async function setup(page: Page, scale = 110, width = 80, manual = true) {
  await page.addInitScript(({ scale, width, columnIds, manual }) => {
    if (!localStorage.getItem('kubiki.settings.v3')) localStorage.setItem('kubiki.settings.v3', JSON.stringify({ version: 0, state: { uiScale: scale, columnWidths: manual ? Object.fromEntries(columnIds.map(id => [`Pod:${id}`, id === '__index' ? 38 : id === 'name' ? width * 2 : width])) : {} } }));
  }, { scale, width, columnIds, manual });
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/').pop(); const kind = url.searchParams.get('kind');
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['apps'] });
    return route.fulfill({ json: kind === 'Namespace' ? namespaceList(['apps']) : { items: kind === 'Pod' ? [{ apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'web', name: 'web', namespace: 'apps' }, spec: { nodeName: 'worker', containers: [{ name: 'app', image: 'app:v1' }] }, status: { phase: 'Running' } }] : [] } });
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').locator('[data-resource-type="Pod"]').click();
  const table = page.getByTestId('resource-table');
  await expect(table.getByRole('columnheader', { name: 'Name', exact: true })).toBeVisible();
  return table;
}
const header = (table: Locator, name: string) => table.getByRole('columnheader', { name, exact: true });
const widths = (table: Locator) => table.getByRole('columnheader').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.getAttribute('aria-label')!, element.getBoundingClientRect().width])));
const order = (table: Locator) => table.getByRole('columnheader').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
async function beginResize(page: Page, table: Locator, name: string) {
  const handle = table.getByRole('separator', { name: `Resize ${name} column`, exact: true });
  await handle.scrollIntoViewIfNeeded();
  const rect = (await handle.boundingBox())!;
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return point;
}
async function reorder(page: Page, table: Locator, from: string, to: string) {
  const source = (await header(table, from).boundingBox())!;
  const target = (await header(table, to).boundingBox())!;
  await page.mouse.move(source.x + 20, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + 35, source.y + source.height / 2, { steps: 3 });
  await page.mouse.move(target.x + target.width * .75, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
}

for (const scale of [100, 150, 200]) test(`resize guide follows the real column edge and changes only that column at ${scale}%`, async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 });
  const table = await setup(page, scale);
  const before = await widths(table);
  const rect = (await header(table, 'Name').boundingBox())!;
  const point = await beginResize(page, table, 'Name');
  const guide = page.getByTestId('column-resize-guide');
  await expect(guide).toBeVisible();
  await expect.poll(async () => { const line = (await guide.boundingBox())!; return Math.abs(line.x + line.width / 2 - rect.x - rect.width); }).toBeLessThan(1.5);
  await page.mouse.move(point.x + 90, point.y, { steps: 8 });
  await expect.poll(async () => { const line = (await guide.boundingBox())!; return Math.abs(line.x + line.width / 2 - rect.x - rect.width - 90); }).toBeLessThan(1.5);
  await page.mouse.up();
  await expect(guide).toHaveCount(0);
  const after = await widths(table);
  expect(after.Name - before.Name).toBeCloseTo(90, 0);
  for (const name of Object.keys(before).filter(name => name !== 'Name')) expect(after[name]).toBeCloseTo(before[name], 0);
  await expect(header(table, 'Name')).toHaveAttribute('aria-sort', 'none');
});

test('a moved column can be resized immediately and repeated gestures keep widths and sorting stable', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  const table = await setup(page);
  const before = await widths(table);
  await reorder(page, table, 'Status', 'Namespace');
  const moved = await order(table);
  expect(moved.indexOf('Status')).toBe(moved.indexOf('Namespace') + 1);
  for (const [name, width] of Object.entries(before)) expect((await widths(table))[name]).toBeCloseTo(width, 0);
  for (const delta of [70, -35, 45]) {
    const previous = (await widths(table)).Status;
    const point = await beginResize(page, table, 'Status');
    await page.mouse.move(point.x + delta, point.y, { steps: 6 });
    await expect(page.getByTestId('column-resize-guide')).toHaveCount(1);
    await page.mouse.up();
    await expect(page.getByTestId('column-resize-guide')).toHaveCount(0);
    expect((await widths(table)).Status - previous).toBeCloseTo(delta, 0);
    await expect(header(table, 'Status')).toHaveAttribute('aria-sort', 'none');
  }
  await reorder(page, table, 'Status', 'Name');
  expect((await order(table)).indexOf('Status')).toBe((await order(table)).indexOf('Name') + 1);
  const savedOrder = await order(table);
  const savedWidth = (await widths(table)).Status;
  await page.reload();
  await expect(header(table, 'Status')).toBeVisible();
  expect(await order(table)).toEqual(savedOrder);
  expect((await widths(table)).Status).toBeCloseTo(savedWidth, 0);
});

test('horizontal scrolling during resize preserves the guide anchor and Escape cancels without saving', async ({ page }) => {
  const table = await setup(page, 150, 240);
  await table.evaluate(element => { element.scrollLeft = 350; });
  const before = (await widths(table)).Status;
  const point = await beginResize(page, table, 'Status');
  const edge = (await header(table, 'Status').boundingBox())!;
  await table.evaluate(element => { element.scrollLeft += 80; });
  const guide = page.getByTestId('column-resize-guide');
  await expect.poll(async () => { const line = (await guide.boundingBox())!; return Math.abs(line.x + line.width / 2 - edge.x - edge.width); }).toBeLessThan(1.5);
  await page.mouse.move(point.x + 30, point.y, { steps: 4 });
  await page.mouse.up();
  expect((await widths(table)).Status - before).toBeCloseTo(110, 0);
  const saved = (await widths(table)).Status;
  const next = await beginResize(page, table, 'Status');
  await page.mouse.move(next.x - 90, next.y, { steps: 5 });
  await page.keyboard.press('Escape');
  await expect(guide).toHaveCount(0);
  await page.mouse.up();
  expect((await widths(table)).Status).toBeCloseTo(saved, 0);
});

test('column controls keep keyboard behavior separate from header sorting', async ({ page }) => {
  const table = await setup(page);
  const resize = table.getByRole('separator', { name: 'Resize Status column', exact: true });
  const before = Number(await resize.getAttribute('aria-valuenow'));
  await resize.focus();
  await resize.press('ArrowRight');
  await expect(resize).toHaveAttribute('aria-valuenow', String(before + 10));
  await resize.press('Enter');
  await expect(header(table, 'Status')).toHaveAttribute('aria-sort', 'none');
  const actions = table.getByRole('button', { name: 'Status column actions', exact: true });
  await actions.focus();
  await actions.press('Enter');
  await expect(page.getByRole('button', { name: 'Move column left', exact: true })).toBeVisible();
  await expect(header(table, 'Status')).toHaveAttribute('aria-sort', 'none');
});

test('dragging scrolls a wide table and cancelling releases the header for the next gesture', async ({ page }) => {
  const table = await setup(page, 110, 240);
  const before = await order(table);
  const source = (await header(table, 'Name').boundingBox())!;
  const viewport = (await table.boundingBox())!;
  await page.mouse.move(source.x + 25, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewport.x + viewport.width - 12, source.y + source.height / 2, { steps: 10 });
  await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(120);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await order(table)).toEqual(before);
  await expect(table.locator('[data-column-drop]')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/column-layout-reordering/);
  await table.evaluate(element => { element.scrollLeft = 0; });
  const point = await beginResize(page, table, 'Name');
  await page.mouse.move(point.x - 40, point.y, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('column-resize-guide')).toHaveCount(0);
  await expect(header(table, 'Name')).toHaveAttribute('aria-sort', 'none');
});

test('leaving a resource table cancels an unfinished resize and removes its guide', async ({ page }) => {
  const table = await setup(page);
  const storedWidth = await table.getByRole('separator', { name: 'Resize Status column', exact: true }).getAttribute('aria-valuenow');
  const point = await beginResize(page, table, 'Status');
  await page.mouse.move(point.x + 80, point.y, { steps: 5 });
  await expect(page.getByTestId('column-resize-guide')).toBeVisible();
  await page.getByTestId('explorer-panel').locator('[data-resource-type="Service"]').evaluate((element: HTMLElement) => element.click());
  await expect(page.getByTestId('column-resize-guide')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/column-layout-resizing/);
  await page.getByTestId('explorer-panel').locator('[data-resource-type="Pod"]').click();
  await expect(table.getByRole('separator', { name: 'Resize Status column', exact: true })).toHaveAttribute('aria-valuenow', storedWidth!);
});

test('reordering an automatically fitted table preserves the resized column and every other width', async ({ page }) => {
  const table = await setup(page, 110, 80, false);
  const before = await widths(table);
  const point = await beginResize(page, table, 'Name');
  await page.mouse.move(point.x + 80, point.y, { steps: 6 });
  await page.mouse.up();
  const resized = await widths(table);
  expect(resized.Name - before.Name).toBeCloseTo(80, 0);
  await reorder(page, table, 'Status', 'Namespace');
  const after = await widths(table);
  expect((await order(table)).indexOf('Status')).toBe((await order(table)).indexOf('Namespace') + 1);
  for (const name of Object.keys(before)) expect(after[name]).toBeCloseTo(resized[name], 0);
});
