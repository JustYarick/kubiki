import { expect, test, type Page } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';
import { captureScreenshot } from './helpers/screenshots';

async function setup(page: Page, unavailable = false) {
  const base = Date.now() - 1000;
  let generation = 0;
  const pod = (name: string, namespace: string) => ({ apiVersion: 'v1', kind: 'Pod', metadata: { uid: `${namespace}-${name}`, name, namespace, creationTimestamp: new Date(base - 3600000).toISOString() }, spec: { nodeName: 'worker-a', containers: [
    { name: 'app', image: 'app:latest', resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } } },
  ], initContainers: [
    { name: 'migrate', image: 'migrate:latest', resources: { requests: { cpu: '20m', memory: '32Mi' }, limits: { cpu: '100m', memory: '64Mi' } } },
    { name: 'sidecar', image: 'sidecar:latest', restartPolicy: 'Always', ports: [{ containerPort: 15090, name: 'metrics' }], resources: { requests: { cpu: '50m', memory: '32Mi' }, limits: { cpu: '500m', memory: '256Mi' } }, readinessProbe: { httpGet: { path: '/ready', port: 15090 } }, volumeMounts: [{ name: 'config', mountPath: '/etc/sidecar' }] },
  ], ephemeralContainers: [{ name: 'debug', image: 'debug:latest' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }], initContainerStatuses: [
    { name: 'sidecar', ready: true, restartCount: 3, state: { running: {} }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } } },
    { name: 'migrate', ready: false, restartCount: 0, state: { terminated: { reason: 'Completed', exitCode: 0 } } },
  ], ephemeralContainerStatuses: [{ name: 'debug', ready: false, restartCount: 0, state: { terminated: { reason: 'Completed', exitCode: 0 } } }] } });
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/').pop(); const kind = url.searchParams.get('kind');
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['alpha', 'beta'] });
    const namespace = url.searchParams.get('namespace');
    if (op === 'metrics') {
      const timestamp = new Date(base + generation * 15000).toISOString();
      const metrics = [
        { name: 'web-alpha', namespace: 'alpha', timestamp, window: '15s', containers: [{ name: 'app', cpu: generation ? '700m' : '300m', memory: generation ? '164Mi' : '100Mi' }, { name: 'sidecar', cpu: '100m', memory: '28Mi' }] },
        { name: 'neighbor', namespace: 'alpha', timestamp, window: '15s', containers: [{ name: 'app', cpu: '8', memory: '8Gi' }] },
        { name: 'web-alpha', namespace: 'beta', timestamp, window: '15s', containers: [{ name: 'app', cpu: '4', memory: '4Gi' }] },
      ];
      return route.fulfill({ json: { context: 'test', namespace, pods: unavailable ? { items: null, error: { code: 'forbidden', message: 'Pod metrics access denied', operation: 'metrics', retryable: false } } : { items: metrics.filter(item => !namespace || item.namespace === namespace), error: null }, nodes: { items: null, error: null } } });
    }
    const items = kind === 'Namespace' ? namespaceList(['alpha', 'beta']).items : kind === 'Pod' ? [pod('web-alpha', 'alpha'), pod('neighbor', 'alpha'), pod('web-alpha', 'beta')] : [];
    return route.fulfill({ json: { items: items.filter(item => !namespace || !('namespace' in item.metadata) || item.metadata.namespace === namespace) } });
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').locator('[data-resource-type="Pod"]').click();
  await page.getByTestId('resource-table').getByText('web-alpha', { exact: true }).first().click();
  return { details: page.getByTestId('inspector-panel').getByTestId('resource-details'), advance: (steps = 1) => { generation += steps; }, denyMetrics: () => { unavailable = true; } };
}

test('Pod charts show only its containers, retain real samples and support pause and narrow details', async ({ page }) => {
  const { details, advance } = await setup(page);
  const performance = details.getByRole('region', { name: 'Pod performance', exact: true });
  const cpu = performance.getByRole('region', { name: 'Pod CPU performance', exact: true });
  const memory = performance.getByRole('region', { name: 'Pod RAM performance', exact: true });
  await expect(cpu.locator('.telemetry-value')).toHaveText('400m');
  await expect(memory.locator('.telemetry-value')).toHaveText('128 MiB');
  await expect(cpu).toContainText('26.7% of limit');
  await expect(cpu).toContainText('Requests 150m');
  await expect(performance.getByRole('table')).toHaveCount(0);
  const containers = details.getByRole('region', { name: 'Containers', exact: true });
  await expect(containers.locator('.container-card')).toHaveCount(4);
  await expect(containers.locator('[data-container-name="app"] .container-card-usage')).toContainText('300m');
  await expect(containers.locator('[data-container-name="sidecar"] .container-card-usage')).toContainText('28 MiB');
  const chart = cpu.getByRole('img', { name: 'CPU usage history', exact: true });
  await expect(chart).toHaveAttribute('data-samples', '1');
  const path = () => chart.locator('.telemetry-chart-line').getAttribute('d');
  const first = (await path())!.match(/M[\d.]+,([\d.]+) L[\d.]+,([\d.]+)/)!;
  expect(first[1]).toBe(first[2]);
  advance();
  await performance.getByRole('button', { name: 'Refresh pod metrics', exact: true }).click();
  await expect(chart).toHaveAttribute('data-samples', '2');
  await expect(cpu.locator('.telemetry-value')).toHaveText('800m');
  await expect(memory.locator('.telemetry-value')).toHaveText('192 MiB');
  await expect(containers.locator('[data-container-name="app"] .container-card-usage')).toContainText('700m');
  const next = (await path())!.match(/M[\d.]+,([\d.]+) L[\d.]+,([\d.]+)/)!;
  expect(next[1]).not.toBe(next[2]);
  await performance.getByRole('button', { name: 'Pause pod metrics', exact: true }).click();
  await expect(performance.getByRole('button', { name: 'Refresh pod metrics', exact: true })).toBeDisabled();
  await performance.getByRole('button', { name: 'Resume pod metrics', exact: true }).click();
  await expect(performance.getByRole('button', { name: 'Refresh pod metrics', exact: true })).toBeEnabled();
  await expect(chart).toHaveAttribute('data-samples', '2');
  await performance.getByRole('button', { name: 'Fixed scale', exact: true }).click();
  await expect(cpu.getByText('Fixed scale', { exact: true })).toBeVisible();
  for (const width of [1200, 900, 700]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await details.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await captureScreenshot(page, { path: 'test-results/pod-performance.png' });
});

test('One container list discloses native sidecar details, preserves keyboard focus and keeps actions independent', async ({ page }) => {
  const { details } = await setup(page);
  const containers = details.getByRole('region', { name: 'Containers', exact: true });
  await expect(containers.locator('.container-card')).toHaveCount(4);
  expect(await containers.locator('.container-card').evaluateAll(elements => elements.map(element => [element.getAttribute('data-container-name'), element.getAttribute('data-container-role')]))).toEqual([['app', 'application'], ['sidecar', 'sidecar'], ['migrate', 'init'], ['debug', 'ephemeral']]);
  await expect(details.getByRole('region', { name: 'Init Containers', exact: true })).toHaveCount(0);
  const sidecar = containers.locator('[data-container-name="sidecar"]');
  await expect(sidecar.locator('.container-card-state')).toHaveText('running');
  await expect(sidecar).toContainText('3 restarts');
  const toggle = sidecar.getByRole('button', { name: 'Details for sidecar', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(sidecar.getByText('sidecar:latest', { exact: true })).toHaveCount(0);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(sidecar).toContainText('sidecar:latest');
  await expect(sidecar).toContainText('metrics: 15090/TCP');
  await expect(sidecar).toContainText('CPU: 500m');
  await expect(sidecar).toContainText('HTTP /ready');
  await expect(sidecar).toContainText('/etc/sidecar');
  await expect(sidecar).toContainText('OOMKilled');
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(sidecar.getByRole('button', { name: 'Shell for sidecar', exact: true })).toBeEnabled();
  const completed = containers.locator('[data-container-name="migrate"]');
  await expect(completed.locator('.container-card-state')).toHaveText('Completed');
  await expect(completed.locator('.container-card-usage')).toHaveText('CPU —RAM —');
  await expect(completed.getByRole('button', { name: 'Shell for migrate', exact: true })).toBeDisabled();
  await page.route('**/api/k8s/logs?*', route => route.fulfill({ json: 'sidecar log\n' }));
  await sidecar.getByRole('button', { name: 'Logs for sidecar', exact: true }).click();
  await expect(page.getByTestId('logs-toolbar').getByRole('button', { name: 'Select Container', exact: true })).toContainText('sidecar');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await containers.scrollIntoViewIfNeeded();
  await captureScreenshot(page, { path: 'test-results/pod-containers.png' });
});

test('Pod history connects observations after returning from another Pod two minutes later', async ({ page }) => {
  await page.clock.install({ time: Date.now() });
  const { details, advance } = await setup(page);
  const performance = details.getByRole('region', { name: 'Pod performance', exact: true });
  const cpu = performance.getByRole('img', { name: 'CPU usage history', exact: true });
  const ram = performance.getByRole('img', { name: 'RAM usage history', exact: true });
  await expect(cpu).toHaveAttribute('data-samples', '1');
  await page.getByTestId('resource-table').getByText('neighbor', { exact: true }).click();
  await expect(details.locator('.details-title')).toHaveText('neighbor');
  advance(8);
  await page.clock.fastForward(120000);
  await page.getByTestId('resource-table').getByText('web-alpha', { exact: true }).first().click();
  await expect(details.locator('.details-title')).toHaveText('web-alpha');
  for (const chart of [cpu, ram]) {
    await expect(chart).toHaveAttribute('data-samples', '2');
    await expect(chart.locator('.telemetry-chart-line')).toHaveCount(1);
    expect((await chart.locator('.telemetry-chart-line').getAttribute('d'))?.match(/L/g)).toHaveLength(1);
  }
  await cpu.focus();
  await page.keyboard.press('Home');
  await expect(performance.locator('.telemetry-chart-tooltip')).toContainText('400m');
  await page.keyboard.press('End');
  await expect(performance.locator('.telemetry-chart-tooltip')).toContainText('800m');
});

test('Unavailable Pod metrics explain the failure and keep charts empty', async ({ page }) => {
  const { details } = await setup(page, true);
  const performance = details.getByRole('region', { name: 'Pod performance', exact: true });
  await expect(performance.getByRole('status')).toContainText('Pod metrics access denied');
  for (const dimension of ['CPU', 'RAM']) {
    const metric = performance.getByRole('region', { name: `Pod ${dimension} performance`, exact: true });
    await expect(metric.locator('.telemetry-value')).toHaveText('—');
    await expect(metric.getByRole('img', { name: `${dimension} usage history`, exact: true })).toHaveAttribute('data-samples', '0');
  }
  const containers = details.getByRole('region', { name: 'Containers', exact: true });
  await expect(containers.locator('.container-card-usage b')).toHaveText(['—', '—', '—', '—', '—', '—', '—', '—']);
});

test('A narrow inspector at 200% UI scale keeps rows readable and labels last observed usage after an error', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kubiki.settings.v3', JSON.stringify({ version: 0, state: { inspectorWidth: 320, uiScale: 200 } })));
  const { details, denyMetrics } = await setup(page);
  const containers = details.getByRole('region', { name: 'Containers', exact: true });
  await expect(containers.getByRole('group', { name: 'Usage for app', exact: true })).toContainText('300m');
  await containers.getByRole('button', { name: 'Details for sidecar', exact: true }).click();
  for (const element of [details, containers, containers.locator('[data-container-name="sidecar"]')]) {
    await expect.poll(() => element.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  }
  await expect(containers.getByRole('button', { name: 'Logs for sidecar', exact: true })).toBeVisible();
  await captureScreenshot(page, { path: 'test-results/pod-containers-scaled.png' });
  await containers.getByRole('button', { name: 'Details for sidecar', exact: true }).click();
  denyMetrics();
  await details.getByRole('button', { name: 'Refresh pod metrics', exact: true }).click();
  await expect(details.getByRole('region', { name: 'Pod performance', exact: true }).getByRole('status')).toContainText('Pod metrics access denied');
  await expect(containers.locator('.container-card-stale')).toHaveCount(2);
  await expect(containers.getByRole('group', { name: 'Usage for sidecar', exact: true })).toContainText('100m');
});
