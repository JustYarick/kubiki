import { expect, test, type Page } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';
import { captureScreenshot } from './helpers/screenshots';

const secret = (name: string) => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name, uid: name, namespace: 'apps', resourceVersion: '1' }, type: 'Opaque', data: { password: btoa('private-value\n'), empty: '', binary: '/wAB' } });
const definition = (kind: string) => ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: `${kind.toLowerCase()}s.external-secrets.io`, uid: kind }, spec: { group: 'external-secrets.io', names: { kind, plural: `${kind.toLowerCase()}s` }, scope: 'Namespaced', versions: [{ name: 'v1', storage: true, served: true }] } });

async function setup(page: Page, denyStore = false) {
  const reads: URL[] = [];
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['apps'] });
    if (url.pathname.endsWith('/custom-resources')) {
      reads.push(url);
      if (url.searchParams.get('name')?.startsWith('externalsecrets.')) return route.fulfill({ json: { items: [{ apiVersion: 'external-secrets.io/v1', kind: 'ExternalSecret', metadata: { name: 'vault-sync', uid: 'sync', namespace: 'apps' }, spec: { target: { name: 'vault-secret' }, secretStoreRef: { name: 'vault' }, data: [{ secretKey: 'password', remoteRef: { key: 'production/db', property: 'password' } }], dataFrom: [{ extract: { key: 'shared' } }] } }] } });
      if (denyStore) return route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Access denied', retryable: false } } });
      return route.fulfill({ json: { items: [{ apiVersion: 'external-secrets.io/v1', kind: 'SecretStore', metadata: { name: 'vault', uid: 'vault', namespace: 'apps' }, spec: { provider: { vault: { server: 'https://vault.example', path: 'secret', version: 'v2' } } } }] } });
    }
    const kind = url.searchParams.get('kind');
    const items = kind === 'Secret' ? [secret('vault-secret'), secret('internal-secret')] : kind === 'CustomResourceDefinition' ? ['ExternalSecret', 'SecretStore'].map(definition) : kind === 'Namespace' ? namespaceList(['apps']).items : [];
    return route.fulfill({ json: { items } });
  });
  await page.addInitScript(() => {
    (window as any).__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as any).__copied.push(value); } } });
  });
  await page.goto('/');
  const explorer = page.getByTestId('explorer-panel');
  await explorer.getByRole('button', { name: 'Expand All', exact: true }).click();
  await explorer.locator('[data-resource-type="Secret"]').click();
  await page.getByTestId('resource-table').getByText('vault-secret', { exact: true }).click();
  return reads;
}

test('Secret details show Vault paths and links, scoped lookups, and switch back to an internal source', async ({ page }) => {
  const reads = await setup(page);
  const source = page.getByRole('region', { name: 'Secret source', exact: true });
  await expect(source.getByRole('status')).toHaveText('External');
  await expect(source.getByText('Vault', { exact: true })).toBeVisible();
  await expect(source.getByText('https://vault.example', { exact: true })).toBeVisible();
  await expect(source.getByRole('link', { name: 'Open secret/production/db in Vault', exact: true })).toHaveAttribute('href', 'https://vault.example/ui/vault/secrets/secret/kv/production%2Fdb/details');
  await expect(source.getByRole('link', { name: 'Open secret/shared in Vault', exact: true })).toBeVisible();
  await captureScreenshot(page, { path: 'test-results/secret-sources.png' });
  expect(reads.every(url => url.searchParams.get('namespace') === 'apps')).toBe(true);
  await page.getByTestId('resource-table').getByText('internal-secret', { exact: true }).click();
  await expect(source.getByRole('status')).toHaveText('Internal · Kubernetes');
  await expect(source.getByRole('link')).toHaveCount(0);
});

test('source button opens its Kubernetes custom resource and supports returning to the Secret', async ({ page }) => {
  await setup(page);
  const details = page.getByTestId('inspector-panel').getByTestId('resource-details');
  await details.getByRole('button', { name: 'Inspect ExternalSecret vault-sync in apps', exact: true }).click();
  await expect(details.getByText('ExternalSecret · apps', { exact: true })).toBeVisible();
  await expect(details.getByText('Select a resource to inspect', { exact: true })).toHaveCount(0);
  await details.getByRole('button', { name: 'Back to previous resource', exact: true }).click();
  await expect(details.getByText('Secret · apps', { exact: true })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Secret source', exact: true }).getByRole('status')).toHaveText('External');
  await details.getByRole('button', { name: 'Open details in tab', exact: true }).click();
  const workspaceDetails = page.getByTestId('workspace-tab-panel').getByTestId('resource-details');
  await workspaceDetails.getByRole('button', { name: 'Inspect ExternalSecret vault-sync in apps', exact: true }).click();
  await expect(workspaceDetails.getByText('ExternalSecret · apps', { exact: true })).toBeVisible();
});

test('copy key and masked values honors Text/Base64, binary and empty values and reports failures', async ({ page }) => {
  await setup(page);
  const data = page.getByRole('region', { name: 'Secret data', exact: true });
  await expect(data.getByLabel('Value for password', { exact: true })).toHaveText('••••••••');
  await data.getByRole('button', { name: 'Copy key password', exact: true }).click();
  await data.getByRole('button', { name: 'Copy value for password', exact: true }).click();
  await data.getByRole('button', { name: 'Copy value for empty', exact: true }).click();
  await data.getByRole('button', { name: 'Copy value for binary', exact: true }).click();
  await data.getByRole('button', { name: 'Base64', exact: true }).click();
  await data.getByRole('button', { name: 'Copy value for password', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__copied)).toEqual(['password', 'private-value\n', '', '/wAB', btoa('private-value\n')]);
  await expect(data.getByLabel('Value for password', { exact: true })).toHaveText('••••••••');
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
  await data.getByRole('button', { name: 'Copy value for password', exact: true }).click();
  await expect(page.getByText('Clipboard unavailable', { exact: true })).toBeVisible();
});

test('missing store permissions retain external source and remote path without inventing a Vault link', async ({ page }) => {
  await setup(page, true);
  const source = page.getByRole('region', { name: 'Secret source', exact: true });
  await expect(source.getByRole('status')).toHaveText('External');
  await expect(source.getByText('production/db', { exact: true })).toBeVisible();
  await expect(source.getByRole('link')).toHaveCount(0);
  await expect(source.getByRole('button', { name: 'Retry source lookup', exact: true })).toBeVisible();
  await source.getByRole('button', { name: 'Retry source lookup', exact: true }).click();
  await expect(source.getByRole('status')).toHaveText('External');
});
