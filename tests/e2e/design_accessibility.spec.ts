import { test, expect } from '@playwright/test';

test('settings contain keyboard focus and restore it after closing', async ({ page }) => {
  await page.goto('/?demo=1');
  const settings = page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true });
  await settings.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Settings');
  await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  const first = dialog.getByRole('button', { name: 'Close', exact: true });
  await first.focus(); await page.keyboard.press('Shift+Tab');
  await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  for (let index = 0; index < 35; index++) await page.keyboard.press('Tab');
  await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(settings).toBeFocused();
});

test('workspace tabs and table column sizes are keyboard operable', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: 'Workspace tabs' });
  await tabs.getByRole('tab', { name: /Overview/ }).focus();
  await page.keyboard.press('Home'); await expect(tabs.getByRole('tab').first()).toBeFocused();
  await expect(tabs.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End'); await expect(tabs.getByRole('tab').last()).toBeFocused();
  await page.keyboard.press('Home');
  const handle = page.getByRole('separator', { name: 'Resize row numbers column', exact: true });
  await handle.focus(); const initial = Number(await handle.getAttribute('aria-valuenow'));
  await page.keyboard.press('Shift+ArrowRight'); await expect(handle).toHaveAttribute('aria-valuenow', String(initial + 40));
  await page.keyboard.press('Home'); await expect(handle).toHaveAttribute('aria-valuenow', String(initial));
  await page.getByTestId('resource-table').focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('button', { name: /^View in Inspector/ })).toBeVisible();
});

test('compact panels keep the table usable and Explorer toggle always works', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto('/?demo=1');
  const toggle = page.getByRole('button', { name: 'Toggle Explorer', exact: true });
  await toggle.click(); await expect(page.getByTestId('explorer-panel')).toHaveCount(0);
  const table = page.getByTestId('resource-table');
  await table.locator('tbody tr').first().click();
  const inspector = page.getByTestId('inspector-panel');
  await expect(inspector).toHaveAttribute('data-layout', 'overlay');
  expect((await table.boundingBox())!.width).toBeGreaterThan(700);
  await toggle.click(); await expect(page.getByTestId('explorer-panel')).toBeVisible();
  await toggle.click(); await expect(page.getByTestId('explorer-panel')).toHaveCount(0);
  await toggle.click();
  await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  expect((await page.getByTestId('cluster-overview').boundingBox())!.width).toBeGreaterThan(500);
  await toggle.click();
  expect((await page.getByTestId('cluster-overview').boundingBox())!.width).toBeGreaterThan(700);
});

test('resource action lists support keyboard navigation and activation', async ({ page }) => {
  await page.goto('/?demo=1');
  const row = page.getByTestId('resource-table').locator('tbody tr').filter({ hasText: 'api-gateway-7f9c8b6d5-q7x9z' });
  await row.click({ button: 'right' });
  const first = page.getByRole('button', { name: /^View in Inspector/ });
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Inspect YAML (Side Panel)', exact: true })).toBeFocused();
  await page.keyboard.press('Home'); await expect(first).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.getByTestId('resource-details')).toBeVisible();
});

test('details can stay pinned on Overview and can be explicitly reopened', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByTestId('resource-table').locator('tbody tr').first().click();
  const details = page.getByTestId('resource-details');
  await details.getByRole('button', { name: 'Keep details on Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
  await expect(details).toBeVisible();
  await details.getByRole('button', { name: 'Keep details on Overview', exact: true }).click();
  await expect(details).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle Details Panel', exact: true }).click();
  await expect(details).toBeVisible();
});

test('readable text tokens meet contrast on IDE surfaces and chart labels follow UI scale', async ({ page }) => {
  await page.goto('/?demo=1');
  const tokens = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return Object.fromEntries(['--text-muted', '--accent-text', '--accent-fill', '--accent-fill-hover', '--bg-canvas', '--bg-secondary', '--bg-sidebar', '--bg-surface'].map(key => [key, css.getPropertyValue(key).trim()]));
  });
  const luminance = (hex: string) => {
    const values = hex.replace('#', '').match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
  };
  const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  for (const surface of ['--bg-canvas', '--bg-secondary', '--bg-sidebar', '--bg-surface']) {
    expect(contrast(tokens['--text-muted'], tokens[surface])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['--accent-text'], tokens[surface])).toBeGreaterThanOrEqual(4.5);
  }
  for (const fill of ['--accent-fill', '--accent-fill-hover']) expect(contrast('#ffffff', tokens[fill])).toBeGreaterThanOrEqual(4.5);
  await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
  for (const scale of [100, 110, 150, 200]) {
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: `Set interface scale to ${scale}%`, exact: true }).click();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.telemetry-chart-scale').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(10.8 * scale / 100);
    expect(await page.getByTestId('cluster-overview').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
});
