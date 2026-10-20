import { test, expect } from '@playwright/test';

test('column visibility toggles immediately, keeps Name, and persists across reload', async ({ page }) => {
  await page.goto('/?demo=1');const table = page.getByTestId('resource-table');
  await expect(table.getByRole('columnheader', { name: 'Namespace', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Columns', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Name', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Namespace', exact: true }).click();
  await expect(table.getByRole('columnheader', { name: 'Namespace', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Namespace', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');await page.reload();
  await expect(table.locator('tbody tr').first()).toBeVisible();await expect(table.getByRole('columnheader', { name: 'Namespace', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Columns', exact: true }).last().click();await page.getByRole('button', { name: 'Namespace', exact: true }).click();await expect(table.getByRole('columnheader', { name: 'Namespace', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Namespace', exact: true }).click();await page.getByRole('button', { name: 'Reset visibility', exact: true }).click();await expect(table.getByRole('columnheader', { name: 'Namespace', exact: true })).toBeVisible();
});
test('row number column resizes, persists and resets without selecting rows', async ({ page }) => {
  await page.goto('/?demo=1');const table = page.getByTestId('resource-table');const column = table.getByRole('columnheader', { name: 'Row numbers', exact: true });
  const width = () => column.evaluate(el => el.getBoundingClientRect().width);
  const before = await width();const handle = table.getByRole('separator', { name: 'Resize row numbers column', exact: true });const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);await page.mouse.down();await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 8 });await page.mouse.up();
  await expect.poll(width).toBeGreaterThan(before + 45);const resized = await width();
  await expect(table.locator('tbody tr.selected')).toHaveCount(0);await page.reload();await expect(table.locator('tbody tr').first()).toBeVisible();await expect.poll(width).toBeCloseTo(resized, 0);
  await handle.dblclick();await expect.poll(width).toBeCloseTo(before, 0);await expect(table.locator('tbody tr.selected')).toHaveCount(0);
});

test('resizing one column preserves every other width in an oversized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 900 });
  await page.goto('/?demo=1');
  const table = page.getByTestId('resource-table');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  const widths = () => table.locator('thead th').evaluateAll(headers => headers.map(header => ({ width: header.getBoundingClientRect().width, left: header.getBoundingClientRect().left })));
  const initial = await widths();
  const handle = table.getByRole('separator', { name: 'Resize Name column', exact: true });
  const drag = async (delta: number) => {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
  };
  await drag(90);
  const expanded = await widths();
  expect(expanded[1].width - initial[1].width).toBeCloseTo(90, 0);
  for (let i = 0; i < initial.length; i++) {
    if (i !== 1) expect(expanded[i].width).toBeCloseTo(initial[i].width, 0);
    if (i > 1) expect(expanded[i].left - initial[i].left).toBeCloseTo(90, 0);
  }
  await drag(-60);
  const shrunk = await widths();
  expect(shrunk[1].width - expanded[1].width).toBeCloseTo(-60, 0);
  for (let i = 0; i < initial.length; i++) if (i !== 1) expect(shrunk[i].width).toBeCloseTo(initial[i].width, 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => table.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  const narrow = await widths();
  for (let i = 0; i < narrow.length; i++) expect(narrow[i].width).toBeCloseTo(shrunk[i].width, 0);
});

test('resize stops at the visible pane edge and cleans up its guide', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto('/?demo=1');
  const table = page.getByTestId('resource-table');
  const name = table.getByRole('columnheader', { name: 'Name', exact: true });
  const status = table.getByRole('columnheader', { name: 'Status', exact: true });
  const statusWidth = (await status.boundingBox())!.width;
  const bounds = (await table.boundingBox())!;
  const handle = (await table.getByRole('separator', { name: 'Resize Name column', exact: true }).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await expect(page.getByTestId('column-resize-guide')).toBeVisible();
  await page.mouse.move(bounds.x + bounds.width + 200, handle.y + handle.height / 2, { steps: 8 });
  const first = (await name.boundingBox())!;
  expect(first.x + first.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  await page.mouse.move(bounds.x + bounds.width + 600, handle.y + handle.height / 2);
  expect((await name.boundingBox())!.width).toBeCloseTo(first.width, 0);
  expect((await status.boundingBox())!.width).toBeCloseTo(statusWidth, 0);
  await page.mouse.up(); await expect(page.getByTestId('column-resize-guide')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
