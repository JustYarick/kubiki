import { test, expect } from '@playwright/test';

for (const { width, scale } of [{ width: 1440, scale: 100 }, { width: 900, scale: 100 }, { width: 1280, scale: 200 }]) {
  test(`documents share the layer behind tool windows at ${width}px / ${scale}%`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(scale => localStorage.setItem('kubiki.settings.v3', JSON.stringify({ state: { uiScale: scale }, version: 0 })), scale);
    await page.goto('/?demo=1');
    const explorer = page.getByTestId('explorer-panel');
    await explorer.getByRole('button', { name: 'Expand All', exact: true }).click();
    await explorer.getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
    const search = page.getByPlaceholder('Filter pods…');
    await search.fill('api-gateway');
    await page.getByTestId('resource-table').locator('tbody tr').first().click();
    const inspector = page.getByTestId('inspector-panel');
    await inspector.getByRole('button', { name: 'Open details in tab', exact: true }).click();
    const document = page.getByTestId('workspace-tab-panel').filter({ visible: true });
    await expect(document.getByTestId('resource-details')).toBeVisible();

    const measure = () => document.evaluate(element => {
      const document = element.getBoundingClientRect();
      const main = element.closest('main')!.getBoundingClientRect();
      return { left: document.left, width: document.width, mainLeft: main.left, mainWidth: main.width };
    });
    const opened = await measure();
    expect(opened.left).toBeCloseTo(opened.mainLeft, 0);
    expect(opened.width).toBeCloseTo(opened.mainWidth, 0);

    if (width === 1440) {
      await inspector.getByRole('button', { name: 'Logs', exact: true }).click();
      const dock = page.getByTestId('bottom-dock-wrapper');
      await expect(page.getByTestId('logs-toolbar')).toBeVisible();
      const dockBox = (await dock.boundingBox())!;
      const inspectorBox = (await inspector.boundingBox())!;
      expect(dockBox.x).toBeCloseTo(opened.mainLeft, 0);
      expect(dockBox.x + dockBox.width).toBeCloseTo(inspectorBox.x, 0);
      expect(await dock.evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.contains(window.document.elementFromPoint(box.left + 20, box.bottom - 20));
      })).toBe(true);
      const handle = (await inspector.getByRole('separator', { name: 'Resize panels', exact: true }).first().boundingBox())!;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
      await page.mouse.down(); await page.mouse.move(handle.x - 80, handle.y + 80); await page.mouse.up();
      await expect.poll(async () => (await inspector.boundingBox())!.width).toBeGreaterThan(inspectorBox.width + 50);
      expect((await measure()).width).toBeCloseTo(opened.width, 0);
      expect((await dock.boundingBox())!.x + (await dock.boundingBox())!.width).toBeCloseTo((await inspector.boundingBox())!.x, 0);
    }

    // Even a document-local high z-index stays below the inspector.
    await document.evaluate(element => {
      const marker = window.document.createElement('div'); marker.id = 'document-layer-probe';
      marker.style.cssText = 'position:absolute;inset:0;z-index:9999;background:transparent';
      element.append(marker);
    });
    expect(await inspector.evaluate(element => {
      const box = element.getBoundingClientRect();
      return element.contains(window.document.elementFromPoint(box.right - 20, box.top + 60));
    })).toBe(true);
    await page.locator('#document-layer-probe').evaluate(element => element.remove());

    await inspector.getByRole('button', { name: 'Close details', exact: true }).click();
    expect((await measure()).width).toBeCloseTo(opened.width, 0);
    await page.getByRole('tab', { selected: true }).getByRole('button', { name: 'Close tab', exact: true }).click();
    await expect(search).toHaveValue('api-gateway');
    await expect(page.getByTestId('resource-table').locator('tbody tr').first()).toContainText('api-gateway');
  });
}
