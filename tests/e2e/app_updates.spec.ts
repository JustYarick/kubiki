import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.__updateChecks = 0;
    w.__updateInstalls = [];
    w.__updateOffline = new URLSearchParams(window.location.search).has('update-offline');
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    let sequence = 0;
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => ++sequence,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (command === 'check_app_update') {
          w.__updateChecks++;
          if (w.__updateOffline) throw 'GitHub is unavailable';
          if (new URLSearchParams(window.location.search).has('dev-update')) {
            return { status: 'available', update: { version: '0.2.0-dev.10', currentVersion: '0.2.0-dev.9', notes: 'Dev release with fixes.' } };
          }
          return { status: 'available', update: { version: '0.2.1', currentVersion: '0.1.0', notes: 'Stable release with fixes.\n<em>Plain text release notes</em>' } };
        }
        if (command === 'download_app_update') {
          args.onProgress.onmessage({ downloaded: 50, total: 100 });
          await new Promise(resolve => setTimeout(resolve, 100));
          return;
        }
        if (command === 'install_app_update') { w.__updateInstalls.push(args.version); return; }
        if (command === 'extension_request') return [];
        return null;
      },
    };
  });
});

test('startup offers a stable release, verifies download and requires an explicit restart action', async ({ page }) => {
  await page.goto('/?demo=1');
  const dialog = page.getByRole('dialog', { name: 'Update Kubiki to 0.2.1' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Installed: 0.1.0');
  await expect(dialog).toContainText('Stable channel');
  await expect(dialog).toContainText('<em>Plain text release notes</em>');
  await expect(dialog.locator('em')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Install and restart' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Download update' }).click();
  await expect(dialog.getByText('The update is downloaded and its signature has been verified.')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__updateInstalls)).toEqual([]);
  await page.screenshot({ path: 'test-results/app-update-downloaded.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Install and restart' }).click();
  await expect(dialog.getByRole('status')).toContainText('Installing the update');
  await expect.poll(() => page.evaluate(() => (window as any).__updateInstalls)).toEqual(['0.2.1']);
  expect(await page.evaluate(() => (window as any).__updateChecks)).toBe(1);
});

test('a dev build labels and installs the selected dev update without calling it stable', async ({ page }) => {
  await page.goto('/?demo=1&dev-update=1');
  const dialog = page.getByRole('dialog', { name: 'Update Kubiki to 0.2.0-dev.10' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Dev channel');
  await expect(dialog).not.toContainText('Stable channel');
  await dialog.getByRole('button', { name: 'Download update' }).click();
  await expect(dialog.getByText('The update is downloaded and its signature has been verified.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Install and restart' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__updateInstalls)).toEqual(['0.2.0-dev.10']);
});

test('skipping a version survives reload and manual settings checks can still offer it', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: 'Skip this version' }).click();
  await expect(page.getByRole('dialog', { name: 'Update Kubiki to 0.2.1' })).toHaveCount(0);
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).__updateChecks)).toBe(1);
  await expect(page.getByRole('dialog', { name: 'Update Kubiki to 0.2.1' })).toHaveCount(0);
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'About', exact: true }).click();
  await page.getByRole('button', { name: 'View update', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Update Kubiki to 0.2.1' })).toBeVisible();
});

test('offline startup remains usable and a manual check exposes a retryable error', async ({ page }) => {
  await page.goto('/?demo=1&update-offline=1');
  await expect.poll(() => page.evaluate(() => (window as any).__updateChecks)).toBe(1);
  await expect(page.getByRole('dialog', { name: 'Kubiki updates' })).toHaveCount(0);
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'About', exact: true }).click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Kubiki updates' });
  await expect(dialog.getByRole('alert')).toHaveText('GitHub is unavailable');
  await page.evaluate(() => { (window as any).__updateOffline = false; });
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('dialog', { name: 'Update Kubiki to 0.2.1' })).toBeVisible();
});
