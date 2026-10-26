import { box } from './helpers/layout';
import { test, expect, type Page } from '@playwright/test';

async function openPods(page: Page) {
  await page.goto('/?demo=1');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  return page.getByTestId('resource-table');
}

test('overlay resizing and detail scrolling preserve table geometry and keyboard access', async ({ page }) => {
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

  const separator = page.getByRole('separator', { name: 'Resize panels', exact: true }).last();
  await separator.focus();
  await separator.press('Shift+ArrowRight');
  await separator.press('Shift+ArrowRight');
  expect((await box(panel))[2]).toBeLessThan(panelBox[2]);
  expect(await box(table)).toEqual(before);

  await table.focus();
  await table.press('ArrowDown');
  const focusedName = table.locator('tr.focused td').nth(1);
  await expect(focusedName).toBeVisible();
  const nameBounds = await focusedName.boundingBox();
  expect(nameBounds!.x + nameBounds!.width).toBeLessThanOrEqual((await panel.boundingBox())!.x + 1);
  await expect(table).toBeFocused();

  const detailsScroll = panel.locator('.details-scroll');
  await detailsScroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => detailsScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await box(table)).toEqual(before);

  // Closing the panel changes nothing about the table either.
  await panel.getByTestId('resource-details').getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await box(table)).toEqual(before);
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
