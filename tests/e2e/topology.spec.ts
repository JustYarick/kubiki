import { captureScreenshot } from './helpers/screenshots';
import { selectDiagramNamespaces } from './helpers/topology';
import { test, expect } from '@playwright/test';

const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'pod', name: 'web', namespace: 'backend' }, spec: { containers: [] } };
const events = Array.from({ length: 500 }, (_, index) => ({
  metadata: { uid: `event-${index}`, name: `web.${index}`, namespace: 'backend' },
  involvedObject: { uid: 'pod', kind: 'Pod', name: 'web', namespace: 'backend' },
  type: index === 499 ? 'Warning' : 'Normal', reason: index === 499 ? 'BackOff' : 'Scheduled', message: `Message ${index}`, count: index === 499 ? 4 : 1,
  lastTimestamp: new Date(1700000000000 + index * 1000).toISOString(),
}));

test('Events stay in a bounded collapsible island and never consume the namespace graph budget', async ({ page }) => {
  await page.route('**/api/k8s/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.34.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['backend', 'other'] });
    const kind = url.searchParams.get('kind');
    return route.fulfill({ json: { items: kind === 'Pod' ? [pod] : kind === 'Event' ? [...events, { ...events[499], metadata: { uid: 'other-event', name: 'other', namespace: 'other' }, message: 'Wrong namespace message' }] : [] } });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await selectDiagramNamespaces(page, ['backend']);
  await expect(page.locator('.react-flow__node-resource')).toHaveCount(1);
  await expect(page.locator('[data-namespace-group="backend"]')).toBeVisible();
  const frame = (await page.locator('[data-namespace-group="backend"]').boundingBox())!;
  const member = (await page.locator('.react-flow__node-resource').boundingBox())!;
  expect(member.x).toBeGreaterThan(frame.x);
  expect(member.y).toBeGreaterThan(frame.y);
  expect(member.x + member.width).toBeLessThan(frame.x + frame.width);
  expect(member.y + member.height).toBeLessThan(frame.y + frame.height);
  await expect(page.locator('.react-flow__node [data-resource-kind="Event"]')).toHaveCount(0);
  await expect(page.getByText('1 resources · 0 links', { exact: true })).toBeVisible();
  const island = page.getByRole('complementary', { name: 'Topology events', exact: true });
  await expect(island.locator('li')).toHaveCount(10);
  await expect(island.locator('li').first()).toContainText('BackOff');
  await expect(island.locator('li').first()).toContainText('×4');
  await expect(island.getByText('Latest 10 of 500 events')).toBeVisible();
  await expect(island.getByText('Wrong namespace message')).toHaveCount(0);
  const typesBounds = (await page.getByRole('button', { name: 'Diagram settings', exact: true }).boundingBox())!;
  expect((await island.boundingBox())!.y).toBeGreaterThan(typesBounds.y + typesBounds.height);
  const toggle = island.getByRole('button', { name: /Recent events/ });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(island.locator('li')).toHaveCount(0);
  await toggle.click();
  await captureScreenshot(page, { path: 'test-results/topology-events.png' });
  await island.getByRole('button', { name: 'Pod/web', exact: true }).first().click();
  const inspector = page.getByTestId('resource-details');
  await expect(inspector.getByRole('tab', { name: 'Events', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(inspector.getByText('Pod · backend', { exact: true })).toBeVisible();
});

test('dragging and late Events preserve positions and viewport without restarting layout', async ({ page }) => {
  const workers: string[] = [];
  page.on('worker', (worker) => { if (worker.url().includes('layout_worker')) workers.push(worker.url()); });
  let releaseEvents!: () => void;
  const eventGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
  await page.route('**/api/k8s/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.34.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['backend'] });
    const kind = url.searchParams.get('kind');
    if (kind === 'Event') await eventGate;
    return route.fulfill({ json: { items: kind === 'Pod' ? [{ ...pod, metadata: { ...pod.metadata, ownerReferences: [{ uid: 'dep', kind: 'Deployment', name: 'web-owner' }] } }] : kind === 'Deployment' ? [{ metadata: { uid: 'dep', name: 'web-owner', namespace: 'backend' } }] : kind === 'Event' ? events : [] } });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await expect(page.getByTestId('resource-table').getByText('web', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await selectDiagramNamespaces(page, ['backend']);
  await expect(page.locator('.react-flow__node-resource')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge-text')).toHaveCount(1);
  const island = page.getByTestId('topology-events');
  await island.getByRole('button', { name: /Recent events/ }).click();
  const node = page.locator('.react-flow__node').filter({ hasText: 'web-owner' });
  const initialPosition = await node.getAttribute('style');
  const bounds = (await node.boundingBox())!;
  const workerCount = workers.length;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 70, bounds.y + bounds.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge-text')).toHaveCount(1);
  const draggedPosition = await node.getAttribute('style');
  expect(draggedPosition).not.toBe(initialPosition);
  const viewport = page.locator('.react-flow__viewport');
  const beforePan = await viewport.getAttribute('style');
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(pane.x + 40, pane.y + 60);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(pane.x + 100, pane.y + 100, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  await expect(viewport).not.toHaveAttribute('style', beforePan!);
  const afterPan = await viewport.getAttribute('style');
  releaseEvents();
  await expect(island.getByRole('button', { name: /Recent events \(500\)/ })).toBeVisible();
  await expect(node).toHaveAttribute('style', draggedPosition!);
  await expect(viewport).toHaveAttribute('style', afterPan!);
  expect(workers.length).toBe(workerCount);
});
