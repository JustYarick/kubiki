import { expect, test } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';

test('namespace selections rise above unselected choices immediately and remain first when reopening', async ({ page }) => {
  const names = Array.from({ length: 150 }, (_, index) => `ns-${String(index).padStart(3, '0')}`);
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: names });
    return route.fulfill({ json: url.searchParams.get('kind') === 'Namespace' ? namespaceList(names) : { items: [] } });
  });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Namespace Scope', exact: true });
  await trigger.click();
  const menu = page.getByRole('dialog', { name: 'Choose Namespace Scope' });
  const options = menu.getByRole('option');
  await menu.getByRole('option', { name: 'ns-149', exact: true }).click();
  await expect(options.first()).toHaveText('ns-149');
  await menu.getByRole('option', { name: 'ns-090', exact: true }).click();
  await expect(options.nth(0)).toHaveText('ns-090');
  await expect(options.nth(1)).toHaveText('ns-149');
  await expect(options.nth(2)).toHaveText('All Namespaces');
  const search = menu.getByRole('searchbox');
  await search.fill('ns-000');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText('ns-000');
  await search.fill('');
  await search.press('ArrowDown');
  await expect(options.first()).toBeFocused();
  await menu.getByRole('button', { name: 'Apply namespaces' }).click();
  await trigger.click();
  await expect(options.nth(0)).toHaveText('ns-090');
  await expect(options.nth(1)).toHaveText('ns-149');
  await expect(options.first()).toBeInViewport();
  await menu.getByRole('option', { name: 'All Namespaces', exact: true }).click();
  await expect(options.first()).toHaveText('All Namespaces');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
});

test('column selectors keep enabled choices before disabled choices without moving their actions', async ({ page }) => {
  await page.goto('/?demo=1');
  const explorer = page.getByTestId('explorer-panel');
  await explorer.getByRole('button', { name: 'Expand All', exact: true }).click();
  await explorer.locator('[data-resource-type="Pod"]').click();
  await page.getByRole('button', { name: 'Columns', exact: true }).last().click();
  const menu = page.locator('[data-floating-panel]').filter({ has: page.getByRole('button', { name: 'Reset visibility', exact: true }) });
  await menu.getByRole('button', { name: 'Namespace', exact: true }).click();
  const choices = menu.locator('button[aria-pressed]');
  const states = await choices.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-pressed')));
  // Ignore the separate "Sort: issues first" action after the column choices.
  const columns = states.slice(0, -1);
  expect(columns.indexOf('false')).toBeGreaterThan(0);
  expect(columns.slice(columns.indexOf('false')).every(state => state === 'false')).toBe(true);
  await menu.getByRole('button', { name: 'Namespace', exact: true }).click();
  const enabled = await choices.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-pressed')));
  expect(enabled.slice(0, -1).every(state => state === 'true')).toBe(true);
  await expect(menu.getByRole('button', { name: 'Reset visibility', exact: true })).toBeVisible();
});

test('the active cluster rises to the top of context dropdowns', async ({ page }) => {
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: ['alpha', 'middle', 'zeta'].map(name => ({ name, is_current: name === 'zeta' })) });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['default'] });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/');
  await page.getByTitle('Switch Kubernetes Cluster Context', { exact: true }).click();
  const menu = page.locator('[data-floating-panel]').filter({ hasText: 'Active Kubernetes Context' });
  await expect(menu.getByRole('button').first()).toHaveText('zeta');
  await expect(menu.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
  await expect(menu.getByRole('button').nth(1)).toHaveText('alpha');
});

test('shell dropdowns reopen with the selected binary first', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.evaluate(async () => {
    const { useDockStore } = await import(/* @vite-ignore */ '/src/state/dock_store.ts' as string);
    useDockStore.getState().openLocalTerminal();
  });
  await page.getByTitle('Shell Binary', { exact: true }).click();
  await page.getByRole('option', { name: '/bin/bash', exact: true }).click();
  await page.getByTitle('Shell Binary', { exact: true }).click();
  const choices = page.getByRole('listbox', { name: 'Shell binaries' }).getByRole('option');
  await expect(choices.first()).toHaveText('/bin/bash');
  await expect(choices.first()).toHaveAttribute('aria-selected', 'true');
});
