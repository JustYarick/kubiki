import { test, expect } from '@playwright/test';
import { overviewMetricsFixture } from './helpers/overview';

for (const { width, scale } of [{ width: 1920, scale: 110 }, { width: 1440, scale: 110 }, { width: 768, scale: 150 }, { width: 375, scale: 110 }, { width: 375, scale: 200 }]) {
  test(`Overview sections use the full pane without gaps at ${width}px and ${scale}%`, async ({ page }) => {
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
    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      expect(block.x).toBeCloseTo(blocks[0].x, 1);
      expect(block.width).toBeCloseTo(blocks[0].width, 1);
    }
    const factor = await overview.evaluate(element => Number(getComputedStyle(element).getPropertyValue('--ui-factor')));
    const summaryRows = await overview.locator('.overview-summary-item').evaluateAll(elements => {
      const rows = new Map<number, number>();
      for (const element of elements) { const y = Math.round(element.getBoundingClientRect().y); rows.set(y, (rows.get(y) ?? 0) + 1); }
      return [...rows.values()];
    });
    expect(new Set(summaryRows).size).toBe(1);
    expect(blocks[1].y - blocks[0].bottom).toBeCloseTo(12 * factor, 0);
    expect(blocks[2].y - blocks[1].bottom).toBeCloseTo(12 * factor, 0);
    await expect(overview.locator('.telemetry-gauge')).toHaveCount(0);
    await expect(telemetry.locator('.telemetry-history[open]')).toHaveCount(0);
    const cpu = telemetry.getByRole('region', { name: 'CPU usage', exact: true });
    const memory = telemetry.getByRole('region', { name: 'RAM usage', exact: true });
    expect((await cpu.boundingBox())!.width).toBeCloseTo((await memory.boundingBox())!.width, 1);
    expect((await memory.boundingBox())!.y).toBeGreaterThanOrEqual((await cpu.boundingBox())!.y + (await cpu.boundingBox())!.height);
    for (const metric of [cpu, memory]) {
      const allocatable = metric.locator('dt').getByText('Allocatable', { exact: true });
      await expect(allocatable).toBeVisible();
      expect(await metric.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    expect(await overview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await overview.evaluate(element => element.scrollTop = 0);
    await page.screenshot({ path: `test-results/overview-minimal-${width}-${scale}.png`, animations: 'disabled' });
    if (width === 1440) {
      const before = await overview.locator('.overview-section').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }));
      await telemetry.getByRole('button', { name: 'Refresh metrics', exact: true }).click();
      await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('1.7 cores');
      const after = await overview.locator('.overview-section').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }));
      expect(after).toEqual(before);
    }
  });
}
