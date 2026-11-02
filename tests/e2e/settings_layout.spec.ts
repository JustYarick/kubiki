import {expect, test, type Page} from '@playwright/test';
import {captureScreenshot} from './helpers/screenshots';

async function category(page: Page, name: string, id: string) {
  const dialog = page.getByRole('dialog', {name: 'Settings', exact: true});
  const select = dialog.getByRole('combobox', {name: 'Settings category', exact: true});
  if (await select.isVisible()) await select.selectOption(id);
  else await dialog.getByRole('navigation', {name: 'Settings categories'}).getByRole('button', {name, exact: true}).click();
  return dialog;
}

for (const [width, height, scale] of [[1440, 900, 120], [960, 700, 200], [375, 812, 100]]) {
  test(`settings remain usable at ${width}px and ${scale}% scale`, async ({page}) => {
    await page.setViewportSize({width, height});
    await page.emulateMedia({reducedMotion: 'reduce'});
    await page.addInitScript(scale => localStorage.setItem('kubiki.settings.v3', JSON.stringify({state: {uiScale: scale}, version: 0})), scale);
    await page.goto('/?demo=1');
    // Open through the store when the titlebar is collapsed on a narrow viewport.
    await page.evaluate(async () => {
      const {useUiStore} = await import(/* @vite-ignore */ '/src/state/ui_store.ts' as string);
      useUiStore.getState().setSettingsOpen(true);
    });
    const dialog = await category(page, 'Logs', 'logs');
    const content = dialog.locator('.settings-content');
    if (scale === 200) await expect(dialog.getByRole('combobox', {name: 'Settings category', exact: true})).toBeVisible();
    await expect(dialog.getByRole('heading', {name: 'Logs', exact: true})).toBeVisible();
    expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const wrap = dialog.getByRole('checkbox', {name: 'Wrap log lines by default'});
    const before = await wrap.isChecked();
    await dialog.locator('label').filter({hasText: /^Wrap long lines$/}).click();
    await expect(wrap).toBeChecked({checked: !before});
    await dialog.getByRole('group', {name: 'Log updates', exact: true}).getByRole('button', {name: 'Streaming', exact: true}).click();
    for (const button of await dialog.getByRole('group', {name: 'Polling interval', exact: true}).getByRole('button').all()) await expect(button).toBeDisabled();
    await dialog.getByText('History and scrolling', {exact: true}).click();
    await dialog.getByRole('group', {name: 'Follow-scroll threshold', exact: true}).getByRole('button', {name: '80 px', exact: true}).click();
    expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await captureScreenshot(page, {path: `test-results/settings-logs-${width}-${scale}.png`});
    await category(page, 'Topology', 'topology');
    await expect(dialog.getByRole('heading', {name: 'Topology rendering'})).toBeInViewport();
    await dialog.getByRole('button', {name: 'Performance', exact: true}).click();
    const interval = dialog.getByRole('combobox', {name: 'Topology live redraw interval'});
    await expect(interval).toHaveValue('3000');
    await expect(dialog.getByRole('checkbox', {name: 'Topology connection labels'})).toBeDisabled();
    await dialog.getByRole('button', {name: 'Balanced', exact: true}).click();
    await expect(interval).toHaveValue('1000');
    await expect(dialog.getByRole('checkbox', {name: 'Topology connection labels'})).toBeEnabled();
    expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
  });
}

test('search reveals advanced log settings and resets scroll when changing pages', async ({page}) => {
  await page.goto('/?demo=1');
  await page.getByRole('banner').getByRole('button', {name: 'Settings', exact: true}).click();
  const dialog = await category(page, 'Logs', 'logs');
  const search = dialog.getByRole('textbox', {name: 'Search settings'});
  await search.fill('stickiness');
  const threshold = dialog.getByRole('group', {name: 'Follow-scroll threshold', exact: true});
  await expect(threshold).toBeVisible();
  await threshold.getByRole('button', {name: '120 px', exact: true}).click();
  await search.fill('');
  await dialog.locator('.settings-content').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await category(page, 'Terminal', 'terminal');
  await expect(dialog.getByRole('heading', {name: 'Terminal', exact: true})).toBeInViewport();
  await expect(dialog.getByRole('combobox', {name: 'Output processing timeout'})).toHaveCount(1);
  await dialog.getByText('Session behavior', {exact: true}).click();
  await expect(dialog.getByText('Lower timeout values apply to new sessions.', {exact: false})).toBeVisible();
});
