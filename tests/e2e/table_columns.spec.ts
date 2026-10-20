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
