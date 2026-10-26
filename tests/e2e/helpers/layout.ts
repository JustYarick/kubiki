import type { Locator } from '@playwright/test';

export async function box(locator: Locator) {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value * 10) / 10);
  });
}

/** Ordinary runs cover desktop, tablet and narrow/high-scale layouts.
 * Publication runs retain the full original matrix via E2E_FULL_LAYOUT=1. */
export function layoutCases(area: 'details' | 'overview' | 'editors-topology') {
  const standard = area === 'details'
    ? [{ width: 1440, scale: 200 }, { width: 768, scale: 110 }, { width: 375, scale: 200 }]
    : [{ width: 1440, scale: 110 }, { width: 768, scale: 150 }, { width: 375, scale: 200 }];
  if (process.env.E2E_FULL_LAYOUT !== '1') return standard;
  const extra = area === 'details'
    ? [{ width: 375, scale: 110 }, { width: 900, scale: 150 }, { width: 1920, scale: 110 }]
    : area === 'overview' ? [{ width: 1920, scale: 110 }, { width: 375, scale: 110 }]
      : [{ width: 375, scale: 110 }];
  return [...standard, ...extra];
}
