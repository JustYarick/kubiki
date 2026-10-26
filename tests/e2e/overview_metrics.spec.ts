import { captureScreenshot } from './helpers/screenshots';
import { test, expect } from '@playwright/test';
import { overviewMetricsFixture as fixture } from './helpers/overview';
test('CPU/RAM dashboard shows usage, budgets, source history, sorting and container drilldown', async ({ page }) => {
  const { telemetry } = await fixture(page);
  await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('1.6 cores');await expect(telemetry.getByTestId('metric-memory-usage')).toHaveText('3 GiB');
  const cpu = telemetry.getByRole('region', { name: 'CPU usage', exact: true });await cpu.locator('.telemetry-history > summary').click();await expect(cpu).toContainText('1.2 cores');await expect(cpu).toContainText('3.5 cores');await expect(cpu).toContainText('4 cores');await expect(cpu).toContainText('171.4% of allocatable');
  for (let index = 0; index < 2; index++) { await telemetry.getByRole('button', { name: 'Refresh metrics' }).click();await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText((1.7 + index * .1).toFixed(1) + ' cores'); }
  await expect(cpu.getByRole('img', { name: 'CPU usage history' })).toHaveAttribute('data-samples', '3');
  await cpu.getByRole('img', { name: 'CPU usage history' }).hover();await expect(cpu.locator('output')).toBeVisible();
  await telemetry.getByRole('group', { name: 'Sort consumers' }).getByRole('button', { name: 'RAM', exact: true }).click();
  await telemetry.getByRole('row').filter({ hasText: 'web-alpha' }).click();await expect(telemetry.getByText('app', { exact: true })).toBeVisible();await expect(telemetry.getByText('sidecar', { exact: true })).toBeVisible();await expect(telemetry.getByRole('button', { name: 'Open resource', exact: true })).toBeVisible();
  await page.getByTestId('cluster-overview').evaluate(el => el.scrollTop = 0);
  await captureScreenshot(page, { path: 'test-results/overview-telemetry.png', fullPage: false });
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();await page.getByRole('option', { name: 'alpha', exact: true }).click();await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('625m');await expect(telemetry.getByRole('button', { name: 'Rank Nodes', exact: true })).toHaveCount(0);await expect(telemetry.getByRole('row').filter({ hasText: 'web-beta' })).toHaveCount(0);
  await cpu.locator('.telemetry-history > summary').click();
  for (const width of [900, 700]) {
    await page.setViewportSize({ width, height: 900 });await expect.poll(() => page.getByTestId('cluster-overview').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect((await cpu.getByRole('img', { name: 'CPU usage history' }).boundingBox())!.height).toBeLessThan(125);
  }
});
test('missing Metrics Server displays a reason and never turns unavailable usage into zero', async ({ page }) => {
  const { telemetry } = await fixture(page, true);await expect(telemetry.getByRole('status')).toContainText('Metrics Server unavailable');await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('—');await expect(telemetry.getByTestId('metric-memory-usage')).toHaveText('—');
});
test('late metrics from a previous scope cannot overwrite a selected namespace', async ({ page }) => {
  const { telemetry, requests, release } = await fixture(page, false, true);await expect.poll(() => requests).toContain('all');
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();await page.getByRole('option', { name: 'alpha', exact: true }).click();await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('625m');await release();await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('625m');
});

test('combined namespace telemetry shows the sum and keeps both namespaces in the ranking', async ({ page }) => {
  const { telemetry } = await fixture(page);
  await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('1.6 cores');
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Choose Namespace Scope', exact: true });
  await menu.getByRole('option', { name: 'alpha', exact: true }).click();
  await menu.getByRole('option', { name: 'beta', exact: true }).click();
  await menu.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('1 cores');
  await expect(telemetry.getByTestId('metric-memory-usage')).toHaveText('640 MiB');
  await expect(telemetry.getByRole('row').filter({ hasText: 'web-alpha' })).toBeVisible();
  await expect(telemetry.getByRole('row').filter({ hasText: 'web-beta' })).toBeVisible();
});

test('metrics polling pauses when hidden or navigating away and resumes without duplicate requests', async ({ page }) => {
  await page.clock.install({ time: new Date() });const { telemetry, requests } = await fixture(page);await expect(telemetry.getByTestId('metric-cpu-usage')).toHaveText('1.6 cores');expect(requests).toHaveLength(1);
  await page.clock.runFor(16000);await expect.poll(() => requests.length).toBe(2);await expect(telemetry.getByRole('button', { name: 'Refresh metrics' })).toBeEnabled();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true });document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(60000);expect(requests).toHaveLength(2);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false });document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => requests.length).toBe(3);await expect(telemetry.getByRole('button', { name: 'Refresh metrics' })).toBeEnabled();
  await page.getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();await page.clock.runFor(30000);expect(requests).toHaveLength(3);
});

test('history supports keyboard inspection, sampled data and pause/resume without synthetic points', async ({ page }) => {
  const { telemetry, requests } = await fixture(page);
  await telemetry.getByRole('region', { name: 'CPU usage', exact: true }).locator('.telemetry-history > summary').click();
  const chart = telemetry.getByRole('img', { name: 'CPU usage history', exact: true });
  await expect(chart).toHaveAttribute('data-samples', '1');
  await telemetry.getByRole('button', { name: 'Refresh metrics', exact: true }).click();
  await expect(chart).toHaveAttribute('data-samples', '2');
  await chart.focus(); await page.keyboard.press('Home');
  const cpu = telemetry.getByRole('region', { name: 'CPU usage', exact: true });
  await expect(cpu.locator('output')).toContainText('1.6 cores');
  await page.keyboard.press('End'); await expect(cpu.locator('output')).toContainText('1.7 cores');
  await cpu.locator('.telemetry-history-data > summary').click(); await expect(cpu.getByRole('table')).toBeVisible();
  await expect(cpu.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await telemetry.getByRole('button', { name: 'Metrics display options', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'Metrics display options', exact: true });
  await options.getByRole('checkbox', { name: 'Fixed scale', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(cpu).toContainText('Fixed to budget');
  await telemetry.getByRole('button', { name: 'Metrics display options', exact: true }).click();
  await options.getByRole('button', { name: 'Pause metrics', exact: true }).click();
  const before = requests.length;
  await page.clock.install(); await page.clock.fastForward(31000);
  expect(requests).toHaveLength(before); await expect(chart).toHaveAttribute('data-samples', '2');
  await expect(telemetry.getByRole('button', { name: 'Refresh metrics' })).toBeDisabled();
  await options.getByRole('button', { name: 'Resume metrics', exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(before);
  await expect(chart).toHaveAttribute('data-samples', '3');
});
