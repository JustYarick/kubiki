import { expect, type Page } from '@playwright/test';

export async function openDiagramSettings(page: Page) {
  const toggle = page.getByRole('button', { name: 'Diagram settings', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  return page.getByRole('complementary', { name: 'Diagram settings', exact: true });
}
export async function selectDiagramNamespaces(page: Page, names: string[] | 'all') {
  const trigger = page.getByRole('button', { name: 'Diagram namespaces', exact: true });
  await expect(trigger.or(page.getByRole('button', { name: 'Diagram settings', exact: true })).first()).toBeVisible();
  if (!await trigger.isVisible()) await openDiagramSettings(page);
  await trigger.click();
  const menu = page.getByRole('dialog', { name: 'Choose Diagram namespaces', exact: true });
  if (names === 'all') await menu.getByRole('option', { name: 'All Namespaces', exact: true }).click();
  else {
    await menu.getByRole('button', { name: 'Clear selection', exact: true }).click();
    for (const name of names) await menu.getByRole('option', { name, exact: true }).click();
  }
  await menu.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(menu).toHaveCount(0);
}
