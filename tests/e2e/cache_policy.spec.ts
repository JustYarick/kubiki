import { expect, test, type Page } from '@playwright/test';

const configMaps = [
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: { uid: 'cm-1', name: 'app-settings', namespace: 'backend' }, data: { MODE: 'prod' } },
];

async function setupClusterFixture(page: Page) {
  let holdConfigMaps = false;
  let failConfigMaps = false;
  let releaseConfigMaps: (() => void) | null = null;

  await page.route('**/api/k8s/**', async (route) => {
    const url = new URL(route.request().url());
    const op = url.pathname.split('/').pop();
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'prod', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['backend'] });
    if (op === 'api-resources') return route.fulfill({ json: 'configmaps cm v1 true ConfigMap list\npods po v1 true Pod list\nnamespaces ns v1 false Namespace list\ncustomresourcedefinitions crd apiextensions.k8s.io/v1 false CustomResourceDefinition list' });
    if (op === 'resources' && url.searchParams.get('kind') === 'ConfigMap') {
      if (holdConfigMaps) {
        await new Promise<void>((resolve) => { releaseConfigMaps = resolve; });
      }
      if (failConfigMaps) {
        return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Kubernetes API server temporarily unreachable', retryable: true } } });
      }
      return route.fulfill({ json: { items: configMaps } });
    }
    return route.fulfill({ json: { items: [] } });
  });

  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();

  return {
    setHold: (v: boolean) => { holdConfigMaps = v; },
    setFail: (v: boolean) => { failConfigMaps = v; },
    release: () => { releaseConfigMaps?.(); releaseConfigMaps = null; },
  };
}

test('marks cached rows on tab reopen, alerts and allows discarding stale rows on refresh error, and honors Always fresh setting', async ({ page }) => {
  const ctrl = await setupClusterFixture(page);

  // Open ConfigMaps tab (not demanded by Overview, so closing it stops its watch).
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^ConfigMaps\b/ }).click();
  await expect(page.getByTestId('resource-table')).toContainText('app-settings');
  await expect(page.getByTestId('resource-freshness-pill')).toHaveCount(0);

  // Close ConfigMaps tab so the watch stops while the snapshot stays cached.
  await page.getByRole('tab', { name: /^ConfigMaps/ }).getByRole('button', { name: 'Close tab' }).click();

  // Reopen ConfigMaps while the new request is held -> cached rows appear with explicit "Cached · updating…" pill.
  ctrl.setHold(true);
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^ConfigMaps\b/ }).click();
  await expect(page.getByTestId('resource-table')).toContainText('app-settings');
  await expect(page.getByTestId('resource-freshness-pill')).toHaveAttribute('data-state', 'cached-refreshing');
  await expect(page.getByTestId('resource-freshness-pill')).toContainText('Cached · updating…');

  // Fail the in-flight refresh -> sticky alert banner + Stale pill + warn toast appear.
  ctrl.setFail(true);
  ctrl.release();
  const alert = page.getByRole('alert').filter({ hasText: 'Kubernetes API server temporarily unreachable' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Cached data');
  await expect(alert).toContainText('Showing previously loaded data. It may be out of date.');
  await expect(page.getByTestId('resource-freshness-pill')).toHaveAttribute('data-state', 'stale-error');
  await expect(page.getByTestId('resource-freshness-pill')).toContainText('Stale · refresh failed');
  await expect(page.locator('[data-toast-type="warn"]').filter({ hasText: 'Showing cached configmaps' })).toHaveCount(1);

  // Clicking "Clear stale data" removes outdated rows while keeping error banner + Retry.
  await alert.getByRole('button', { name: 'Clear stale data', exact: true }).click();
  await expect(page.getByTestId('resource-table')).not.toContainText('app-settings');
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();

  // Recover via Retry.
  ctrl.setHold(false);
  ctrl.setFail(false);
  await alert.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('resource-table')).toContainText('app-settings');
  await expect(page.getByTestId('resource-freshness-pill')).toHaveCount(0);

  // Switch setting in Settings -> Kubernetes to "Always fresh".
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Kubernetes', exact: true }).click();
  await dialog.getByRole('group', { name: 'Cached data on tab reopen', exact: true }).getByRole('button', { name: 'Always fresh', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();

  // Close ConfigMaps tab and reopen with held request -> must show loading skeleton, NOT cached rows.
  await page.getByRole('tab', { name: /^ConfigMaps/ }).getByRole('button', { name: 'Close tab' }).click();
  ctrl.setHold(true);
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^ConfigMaps\b/ }).click();
  await expect(page.getByTestId('resource-loading')).toContainText('Loading ConfigMap resources…');
  await expect(page.getByTestId('resource-table')).not.toContainText('app-settings');

  // Release fresh response -> rows render cleanly without Cached pill.
  ctrl.release();
  await expect(page.getByTestId('resource-table')).toContainText('app-settings');
  await expect(page.getByTestId('resource-freshness-pill')).toHaveCount(0);
});
