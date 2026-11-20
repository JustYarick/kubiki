import { expect, test } from '@playwright/test';

test('renders Markdown changelog release notes safely in the update dialog', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.evaluate(async () => {
    const { appUpdates } = await import(/* @vite-ignore */ '/src/state/update_store.ts' as string);
    appUpdates.store.setState({
      dialogOpen: true,
      phase: {
        status: 'available',
        update: {
          currentVersion: '1.1.0-dev.1',
          version: '1.1.0-dev.2',
          notes: [
            '### Added',
            '',
            '- Added **cache mode** setting in `Settings → Kubernetes` with [docs](https://github.com/JustYarick/kubiki).',
            '- Ignored unsafe [js-link](javascript:alert(1)) and raw <script>window.__xss = true</script> tags.',
            '',
            '### Fixed',
            '',
            '> Summary blockquote note',
            '',
            '```sh',
            'kubectl get pods',
            '```',
          ].join('\n'),
        },
      },
    });
  });

  const dialog = page.getByRole('dialog', { name: 'Update Kubiki to 1.1.0-dev.2', exact: true });
  await expect(dialog).toBeVisible();
  const notes = dialog.getByTestId('update-release-notes');

  // Markdown headings, lists, inline code, bold, blockquote, and fenced code render as structured HTML.
  await expect(notes.locator('h3', { hasText: 'Added' })).toBeVisible();
  await expect(notes.locator('h3', { hasText: 'Fixed' })).toBeVisible();
  await expect(notes.locator('strong', { hasText: 'cache mode' })).toBeVisible();
  await expect(notes.locator('code', { hasText: 'Settings → Kubernetes' })).toBeVisible();
  await expect(notes.locator('blockquote', { hasText: 'Summary blockquote note' })).toBeVisible();
  await expect(notes.locator('pre code', { hasText: 'kubectl get pods' })).toBeVisible();

  // Safe https link renders with target=_blank; javascript: URL and raw <script> are neutralized.
  const link = notes.locator('a', { hasText: 'docs' });
  await expect(link).toHaveAttribute('href', 'https://github.com/JustYarick/kubiki');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(notes.locator('a', { hasText: 'js-link' })).toHaveCount(0);
  await expect(notes).toContainText('js-link');
  await expect(notes.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: boolean }).__xss)).toBeUndefined();
});
