import { test, expect } from '@playwright/test';

test('UI scale changes text and controls, persists after restart, and can be reset by keyboard', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  const row = page.getByTestId('resource-table').locator('tbody tr').first();
  await expect(row).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '110');
  const initial = await row.evaluate((element) => ({ height: element.getBoundingClientRect().height, font: parseFloat(getComputedStyle(element.querySelector('td')!).fontSize) }));
  expect(initial.font).toBeGreaterThan(13);
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Set interface scale to 150%', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '150');
  const larger = await row.evaluate((element) => ({ height: element.getBoundingClientRect().height, font: parseFloat(getComputedStyle(element.querySelector('td')!).fontSize) }));
  expect(larger.font / initial.font).toBeCloseTo(150 / 110, 1);
  expect(larger.height).toBeGreaterThan(initial.height);
  await page.screenshot({ path: 'test-results/settings-scale-150.png' });
  await dialog.getByLabel('YAML editor font size').fill('18');
  await dialog.getByLabel('Terminal font size').fill('20');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '150');
  await page.keyboard.press('Control+,');
  await expect(dialog.getByLabel('YAML editor font size')).toHaveValue('18');
  await expect(dialog.getByLabel('Terminal font size')).toHaveValue('20');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+0');
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '110');
  await page.keyboard.press('Control+Equal');
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '120');
  await page.keyboard.press('Control+Minus');
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '110');
  expect(errors).toEqual([]);
});

test('changing the editor font keeps a live Monaco model and unsaved draft intact', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  const row = page.getByTestId('resource-table').locator('tbody tr').filter({ hasText: 'api-gateway-7f9c8b6d5-q7x9z' });
  await row.click();
  await page.getByTestId('resource-details').getByRole('tab', { name: 'YAML', exact: true }).click();
  const editor = page.getByTestId('yaml-editor');
  await expect(editor.locator('.monaco-editor')).toBeVisible({ timeout: 15000 });
  await editor.locator('.view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('End');
  await page.keyboard.type('\n# preserved-unsaved-draft');
  await expect(editor.getByText('unsaved demo changes', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+,');
  await page.getByRole('dialog').getByLabel('YAML editor font size').fill('18');
  await page.keyboard.press('Escape');
  await expect.poll(() => editor.locator('.view-lines').evaluate((element) => getComputedStyle(element).fontSize)).toBe('18px');
  await expect(editor.getByText('unsaved demo changes', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Copy YAML', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('preserved-unsaved-draft');
});

test('settings stay reachable at maximum scale in a small window and recover invalid stored values', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.addInitScript(() => localStorage.setItem('kubiki.settings.v3', JSON.stringify({ state: { uiScale: 900, editorFontSize: -1, terminalFontSize: null }, version: 0 })));
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '200');
  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Reset appearance', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Reset appearance', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '110');
  await expect(dialog.getByLabel('YAML editor font size')).toHaveValue('14');
  await expect(dialog.getByLabel('Terminal font size')).toHaveValue('14');
});

test('a terminal font change resizes text without restarting the open session', async ({ page }) => {
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('resource-table').locator('tbody tr').first().click();
  await page.getByTestId('resource-details').getByRole('button', { name: 'Shell', exact: true }).click();
  const terminal = page.locator('.xterm');
  await expect(terminal).toBeVisible();
  await terminal.getByRole('textbox', { name: 'Terminal input' }).focus();
  await page.keyboard.type('echo fontsurvives');
  await page.keyboard.press('Enter');
  await expect(terminal.locator('.xterm-rows')).toContainText('fontsurvives');
  await page.keyboard.press('Control+,');
  await page.getByRole('dialog').getByLabel('Terminal font size').fill('20');
  await page.keyboard.press('Escape');
  await expect.poll(() => terminal.locator('.xterm-rows span').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('20px');
  await expect(terminal.locator('.xterm-rows')).toContainText('fontsurvives');
});
