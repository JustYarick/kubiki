import { test, expect, type Page, type Locator } from '@playwright/test';

/** Geometry of an element, rounded to avoid sub-pixel noise. */
async function box(locator: Locator) {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value * 10) / 10);
  });
}

async function openPods(page: Page) {
  await page.goto('/?demo=1');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  return page.getByTestId('resource-table');
}

test('the details panel floats above the resource table and never resizes it', async ({ page }) => {
  const table = await openPods(page);
  const before = await box(table);
  const viewport = page.viewportSize()!.width;

  await table.locator('tbody tr').first().click();
  const panel = page.getByTestId('inspector-panel');
  await expect(panel).toHaveAttribute('data-layout', 'overlay');
  await expect(panel.getByTestId('resource-details')).toBeVisible();

  // The table keeps its exact geometry while the panel is open.
  expect(await box(table)).toEqual(before);
  const panelBox = await box(panel);
  expect(panelBox[0] + panelBox[2]).toBeCloseTo(viewport, 0);
  expect(panelBox[0]).toBeGreaterThan(0);

  // The panel starts below the workspace tab bar, so tab actions stay reachable.
  const tabBar = await box(page.getByRole('tablist', { name: 'Workspace tabs' }));
  expect(panelBox[1]).toBeGreaterThanOrEqual(tabBar[1] - 1);

  // Closing the panel changes nothing about the table either.
  await panel.getByTestId('resource-details').getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await box(table)).toEqual(before);
});

test('the overlay keeps the resource table scrollable and the panel resizable', async ({ page }) => {
  const table = await openPods(page);
  const before = await box(table);
  await table.locator('tbody tr').first().click();

  const panel = page.getByTestId('inspector-panel');
  const widthBefore = (await box(panel))[2];

  const separator = page.getByRole('separator', { name: 'Resize panels', exact: true }).last();
  await separator.focus();
  await separator.press('Shift+ArrowRight');
  await separator.press('Shift+ArrowRight');
  const widthAfter = (await box(panel))[2];
  expect(widthAfter).toBeLessThan(widthBefore);
  expect(await box(table)).toEqual(before);

  // The panel keeps its own scrolling instead of stretching the table.
  await expect(panel.getByTestId('resource-details')).toBeVisible();
  expect(await table.evaluate(element => element.scrollWidth >= element.clientWidth)).toBe(true);
});

test('keyboard focus in the table is not hidden under the floating panel', async ({ page }) => {
  const table = await openPods(page);
  await table.locator('tbody tr').first().click();
  await expect(page.getByTestId('inspector-panel')).toBeVisible();
  const padding = await table.evaluate(element => getComputedStyle(element).scrollPaddingRight);
  expect(parseFloat(padding)).toBeGreaterThan(0);
});

test('the right panel opening resizes the bottom dock and never occludes it', async ({ page }) => {
  const table = await openPods(page);
  await page.keyboard.press('ControlOrMeta+j');
  const dock = page.getByTestId('bottom-dock-wrapper');
  await expect(dock).toBeVisible();

  const dockBoxBefore = await box(dock);

  await table.locator('tbody tr').first().click();
  const panel = page.getByTestId('inspector-panel');
  await expect(panel).toBeVisible();

  const dockBoxAfter = await box(dock);
  const panelBox = await box(panel);

  expect(dockBoxAfter[2]).toBeLessThan(dockBoxBefore[2]);
  expect(dockBoxAfter[0] + dockBoxAfter[2]).toBeLessThanOrEqual(panelBox[0] + 1);

  const collapseButton = page.getByRole('button', { name: 'Collapse', exact: true });
  await expect(collapseButton).toBeVisible();
  const btnBox = (await collapseButton.boundingBox())!;
  expect(btnBox.x + btnBox.width).toBeLessThanOrEqual(panelBox[0] + 1);

  await panel.getByTestId('resource-details').getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect((await box(dock))[2]).toBeCloseTo(dockBoxBefore[2], 0);
});
