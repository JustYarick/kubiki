import type { Page } from '@playwright/test';

/** Optional review images; Playwright still captures every failed test. */
export async function captureScreenshot(page: Page, options: NonNullable<Parameters<Page['screenshot']>[0]>) {
  if (process.env.E2E_SCREENSHOTS === '1') await page.screenshot(options);
}
