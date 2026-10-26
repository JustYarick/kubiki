import { captureScreenshot } from './helpers/screenshots';
import { layoutCases } from './helpers/layout';
import { test, expect } from '@playwright/test';
import { overviewMetricsFixture } from './helpers/overview';

for (const { width, scale } of layoutCases('overview')) {
  test(`Overview charts and health panels adapt to the pane at ${width}px and ${scale}%`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(scale => localStorage.setItem('kubiki.settings.v3', JSON.stringify({ state: { uiScale: scale }, version: 0 })), scale);
    const { telemetry } = await overviewMetricsFixture(page);
    if (await page.getByTestId('explorer-panel').isVisible()) await page.keyboard.press('ControlOrMeta+b');
    const overview = page.getByTestId('cluster-overview');
    await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('1.6 cores');
    await page.evaluate(() => document.fonts.ready);
    const blocks = await overview.locator('.overview-section').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { x: rect.x, width: rect.width, y: rect.y, bottom: rect.bottom };
    }));
    expect(blocks).toHaveLength(4);
    const pane = await overview.boundingBox();
    for (const block of blocks) {
      expect(block.x).toBeGreaterThanOrEqual(pane!.x);
      expect(block.x + block.width).toBeLessThanOrEqual(pane!.x + pane!.width + 1);
    }
    const summaryWidths = await overview.locator('.overview-summary-item').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    for (const width of summaryWidths) expect(width).toBeCloseTo(summaryWidths[0], 1);
    await expect(overview.locator('.telemetry-gauge')).toHaveCount(0);
    await expect(telemetry.getByRole('img', { name: 'CPU usage history', exact: true })).toBeVisible();
    await expect(telemetry.getByRole('img', { name: 'RAM usage history', exact: true })).toBeVisible();
    const cpu = telemetry.getByRole('region', { name: 'CPU usage', exact: true });
    const memory = telemetry.getByRole('region', { name: 'RAM usage', exact: true });
    expect((await cpu.boundingBox())!.width).toBeCloseTo((await memory.boundingBox())!.width, 1);
    if (width === 1440) expect((await memory.boundingBox())!.y).toBeCloseTo((await cpu.boundingBox())!.y, 1);
    else expect((await memory.boundingBox())!.y).toBeGreaterThanOrEqual((await cpu.boundingBox())!.y + (await cpu.boundingBox())!.height);
    for (const metric of [cpu, memory]) {
      expect(await metric.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    expect(await overview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await overview.evaluate(element => element.scrollTop = 0);
    await captureScreenshot(page, { path: `test-results/overview-dashboard-${width}-${scale}.png`, animations: 'disabled' });
    if (width === 1440) {
      const before = await overview.locator('.overview-section').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }));
      await telemetry.getByRole('button', { name: 'Refresh metrics', exact: true }).click();
      await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('1.7 cores');
      const after = await overview.locator('.overview-section').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }));
      expect(after).toEqual(before);
    }
  });
}
