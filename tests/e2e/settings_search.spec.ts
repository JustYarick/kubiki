import { test, expect } from '@playwright/test';

test('settings search filters pages and rows, highlights matches, jumps on Enter and shows a no-results state', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const search = dialog.getByLabel('Search settings');
  const categories = dialog.getByRole('navigation', { name: 'Settings categories' });
  await expect(search).toBeFocused();
  await expect(categories.getByRole('button')).toHaveCount(8);

  await search.fill('scrollback');
  const terminalPage = categories.getByRole('button', { name: 'Terminal' });
  await expect(terminalPage).toHaveAttribute('aria-current', 'true');
  const content = dialog.getByRole('region', { name: 'Settings: Terminal' });
  await expect(content.getByLabel('Terminal scrollback limit')).toBeVisible();
  /* Non-matching rows stay hidden while searching. */
  await expect(content.getByLabel('Terminal font size')).toHaveCount(0);
  await expect(content.locator('mark').first()).toBeVisible();

  await search.fill('font');
  await page.keyboard.press('Enter');
  await expect(categories.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-current', 'true');
  await expect(dialog.getByRole('region', { name: 'Settings: Terminal' }).getByLabel('Terminal font size')).toBeVisible();

  await search.fill('qzxjwv');
  await expect(dialog.getByText('No settings found')).toBeVisible();
  await expect(categories.getByRole('button')).toHaveCount(0);

  await dialog.getByLabel('Clear search').click();
  await expect(categories.getByRole('button')).toHaveCount(8);
  await expect(categories.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-current', 'true');
});

test('starting prompt is saved, restored after reload and reset to the default', async ({ page }) => {
  await page.goto('/?demo=1');
  const openSettings = async () => {
    await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'AI assistant', exact: true }).click();
  };
  await openSettings();
  const editor = page.getByRole('textbox', { name: 'Starting prompt', exact: true });
  await expect(editor).toContainText('ANALYSIS ONLY');
  await editor.fill('Explain the root cause and evidence. Reply in English.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await openSettings();
  await expect(editor).toHaveValue('Explain the root cause and evidence. Reply in English.');
  await page.getByRole('button', { name: 'Restore default prompt', exact: true }).click();
  await expect(editor).toContainText('ANALYSIS ONLY');
  await editor.fill('');
  await editor.press('Tab');
  await expect(editor).toContainText('ANALYSIS ONLY');
});
