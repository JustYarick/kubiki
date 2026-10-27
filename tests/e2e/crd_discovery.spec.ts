import { test, expect } from '@playwright/test';

test.describe('CRD Discovery and Lens Parity', () => {
  test('discovers buckets.source.toolkit.fluxcd.io in Custom Resources and via search', async ({ page }) => {
    await page.goto('/?demo=1');
    const explorer = page.getByTestId('explorer-panel');

    // 1. Search directly for full CRD name "buckets.source.toolkit.fluxcd.io"
    const filter = explorer.getByPlaceholder('Filter tree (e.g. pods, cm)…');
    await filter.fill('buckets.source.toolkit.fluxcd.io');

    // Should match Bucket under Custom Resources -> source.toolkit.fluxcd.io AND Flux -> Sources
    await expect(explorer.getByRole('button', { name: 'Bucket' }).first()).toBeVisible();

    // 2. Search for plural "buckets"
    await filter.fill('buckets');
    await expect(explorer.getByRole('button', { name: 'Bucket' }).first()).toBeVisible();

    // 3. Search for group "source.toolkit"
    await filter.fill('source.toolkit');
    await expect(explorer.getByRole('button', { name: 'Bucket' }).first()).toBeVisible();

    // 4. Clear search
    await filter.fill('');

    // 5. Expand Custom Resources and inspect group hierarchy
    await explorer.getByRole('button', { name: /^Custom Resources(?: \d+)?$/ }).click();
    await expect(explorer.getByRole('button', { name: /^Definitions(?: \d+)?$/ })).toBeVisible();
    await expect(explorer.getByRole('button', { name: 'source.toolkit.fluxcd.io' })).toBeVisible();

    // Expand source.toolkit.fluxcd.io group
    await explorer.getByRole('button', { name: 'source.toolkit.fluxcd.io' }).click();
    await expect(explorer.getByRole('button', { name: 'Bucket' })).toBeVisible();

    // 6. Navigate to Definitions table
    await explorer.getByRole('button', { name: /^Definitions(?: \d+)?$/ }).click();
    const table = page.getByTestId('resource-table');
    await expect(table.locator('tbody tr').first()).toBeVisible();

    // Verify columns: Resource, Group, Version, Scope
    const headers = await table.locator('thead th').allTextContents();
    expect(headers).toContain('Resource');
    expect(headers).toContain('Group');
    expect(headers).toContain('Version');
    expect(headers).toContain('Scope');

    // Check row for buckets.source.toolkit.fluxcd.io
    const bucketRow = table.locator('tbody tr', { hasText: 'buckets.source.toolkit.fluxcd.io' });
    await expect(bucketRow).toBeVisible();
    await expect(bucketRow).toContainText('source.toolkit.fluxcd.io');
    await expect(bucketRow).toContainText('v1beta2');
    await expect(bucketRow).toContainText('Namespaced');

    // 7. Clicking the resource name navigates to Buckets table
    const bucketLink = bucketRow.getByRole('button', { name: 'buckets.source.toolkit.fluxcd.io' });
    await bucketLink.click();

    // Verify Buckets table opened
    await expect(page.getByTestId('resource-table')).toHaveAttribute('aria-label', 'Bucket resource table');
    // Verify printer columns: Endpoint, Ready, Status
    const bucketHeaders = await page.getByTestId('resource-table').locator('thead th').allTextContents();
    expect(bucketHeaders).toContain('Endpoint');
    expect(bucketHeaders).toContain('Ready');
    expect(bucketHeaders).toContain('Status');

    // Verify instances loaded
    await expect(page.getByTestId('resource-table').locator('tbody tr', { hasText: 'media-assets' })).toBeVisible();

    // 8. Command Palette discovers custom resources
    await page.getByRole('button', { name: /Search resources, YAML, actions/ }).click();
    const paletteInput = page.getByPlaceholder('Search resources, run commands…');
    await expect(paletteInput).toBeVisible();
    await paletteInput.fill('buckets.source.toolkit.fluxcd.io');
    await expect(page.getByText('Bucket (source.toolkit.fluxcd.io)')).toBeVisible();
    await page.keyboard.press('Escape');

    // A pinned custom editor reads its object's namespace and stays quiet when
    // another view changes the global picker while the draft remains mounted.
    await page.evaluate(async () => {
      const { k8s } = await import(/* @vite-ignore */ '/src/providers/k8s_provider.ts' as string);
      const read = k8s.getCustomResources.bind(k8s);
      (window as any).__customScopes = [];
      k8s.getCustomResources = async (...args: [string, string, string, string | null, AbortSignal?]) => {
        (window as any).__customScopes.push(args[3]);
        return read(...args);
      };
    });
    await page.getByTestId('resource-table').locator('tbody tr', { hasText: 'media-assets' }).click({ button: 'right' });
    await page.getByRole('button', { name: /Open YAML Editor Tab/ }).click();
    await expect(page.getByTestId('yaml-editor')).toContainText('media-assets');
    expect(await page.evaluate(() => [...new Set((window as any).__customScopes)])).toEqual(['default']);
    await page.evaluate(async () => {
      const { useWorkspaceStore } = await import(/* @vite-ignore */ '/src/state/workspace_store.ts' as string);
      const { useClusterStore } = await import(/* @vite-ignore */ '/src/state/cluster_store.ts' as string);
      useWorkspaceStore.getState().openOverview();
      useClusterStore.getState().selectNamespace('infra');
    });
    await expect(page.getByTestId('yaml-editor')).toBeHidden();
    expect(await page.evaluate(() => [...new Set((window as any).__customScopes)])).toEqual(['default']);
  });
});
