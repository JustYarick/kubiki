import { test, expect, type Page } from '@playwright/test';
async function setup(page: Page, mode = 'ok') {
  await page.addInitScript(({ mode }) => {
    const w = window as any; let callback = 0; const callbacks = new Map(); const active = new Map(); const starts: any[] = []; const stopped: string[] = []; let release: (() => void) | undefined;
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'pod-uid', name: 'web', namespace: 'backend' }, spec: { containers: [{ name: 'app', image: 'nginx', ports: [{ containerPort: 8080, name: 'http' }] }] }, status: { phase: 'Running' } };
    const service = { apiVersion: 'v1', kind: 'Service', metadata: { uid: 'service-uid', name: 'web-service', namespace: 'backend' }, spec: { selector: { app: 'web' }, ports: [{ name: 'http', port: 80, targetPort: 'http' }] } };
    w.__pfHarness = { starts, stopped, active: () => active.size, release: () => release?.(), failure: () => { for (const s of active.values()) s.last_error = { code: 'unavailable', message: 'Application connection refused', operation: 'port_forward' }; } };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (fn: any) => { callbacks.set(++callback, fn); return callback; }, unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'get_kube_contexts') return [{ name: 'cluster-a', is_current: true }, { name: 'cluster-b', is_current: false }];
        if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
        if (command === 'get_namespaces') return ['backend'];
        if (command === 'watch_resources') {
          const items = args.query.kind === 'Pod' ? [pod] : args.query.kind === 'Service' ? [service] : [];
          queueMicrotask(() => args.onEvent.onmessage({ subscription_id: args.subscriptionId, query: args.query, messages: [
            { sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items } } } }, { sequence: 2, event: { type: 'Status', payload: { phase: 'live' } } },
          ] })); return;
        }
        if (command === 'start_port_forward') {
          starts.push(args);
          if (mode === 'denied') throw { code: 'forbidden', status: 403, message: 'pods/portforward denied', operation: 'port_forward' };
          if (mode === 'delayed') await new Promise<void>(resolve => { release = resolve; });
          const r = args.request.resource;
          const s = { id: args.sessionId, resource: r, target_kind: r.kind, namespace: r.namespace, name: r.name, local_port: args.request.local_port || 34123, remote_port: args.request.remote_port,
            pod_name: 'web', pod_uid: 'pod-uid', pod_port: 8080, status: 'Active', last_error: null, started_at: Date.now(), bytes_sent: 123, bytes_received: 456 };
          active.set(s.id, s); return s;
        }
        if (command === 'list_port_forwards') return [...active.values()];
        if (command === 'stop_port_forward') { stopped.push(args.sessionId); active.delete(args.sessionId); return; }
        if (command === 'stop_port_forwards') { active.clear(); return; }
        if (command.startsWith('stop_')) return;
        throw new Error(`Unexpected native command ${command}`);
      },
    };
  }, { mode });
  await page.goto('/');
  await page.getByTestId('resource-table').getByText('web', { exact: true }).click();
  await page.getByTestId('resource-details').getByRole('button', { name: 'Ports', exact: true }).click();
  return page.getByRole('dialog', { name: 'Create port-forward', exact: true });
}
test('Pod and Service forwards use native assigned ports, show errors and stop explicitly', async ({ page }) => {
  const dialog = await setup(page);
  await expect(dialog.getByLabel('Remote port', { exact: true })).toHaveValue('8080');
  await dialog.getByRole('button', { name: 'Start forward' }).click();
  await expect(page.getByText('http://127.0.0.1:34123', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pfHarness.starts[0].request)).toMatchObject({ resource: { uid: 'pod-uid', context: 'cluster-a', namespace: 'backend', kind: 'Pod' }, remote_port: 8080, local_port: 0 });
  await page.getByRole('button', { name: /^Services(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('web-service', { exact: true }).click();
  await page.getByTestId('resource-details').getByRole('button', { name: 'Ports', exact: true }).click();
  await expect(dialog.getByLabel('Remote port', { exact: true })).toHaveValue('80');
  await dialog.getByLabel('Local port', { exact: true }).fill('4000');
  await dialog.getByRole('button', { name: 'Start forward' }).click();
  await expect(page.getByText('http://127.0.0.1:4000', { exact: true })).toBeVisible();
  const service = page.getByRole('row').filter({ hasText: 'Service/web-service' });
  await expect(service).toContainText('web:8080');
  await page.clock.install(); await page.evaluate(() => (window as any).__pfHarness.failure()); await page.clock.fastForward(2100);
  await expect(service).toContainText('Application connection refused');
  await service.getByRole('button', { name: 'Stop forward web-service' }).click(); await expect(service).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pfHarness.active())).toBe(1);
  await page.screenshot({ path: 'test-results/port-forwards.png' });
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => page.evaluate(() => (window as any).__pfHarness.active())).toBe(0);
});
test('RBAC errors stay in the launcher and do not create a pretend tunnel', async ({ page }) => {
  const dialog = await setup(page, 'denied'); await dialog.getByRole('button', { name: 'Start forward' }).click();
  await expect(dialog.getByRole('alert')).toContainText('pods/portforward denied');
  expect(await page.evaluate(() => (window as any).__pfHarness.active())).toBe(0);
  await expect(page.getByText('http://127.0.0.1:34123', { exact: true })).toHaveCount(0);
});
test('cancelling startup closes a late native registration', async ({ page }) => {
  const dialog = await setup(page, 'delayed'); await dialog.getByRole('button', { name: 'Start forward' }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel start', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel start', exact: true }).click();
  await page.evaluate(() => (window as any).__pfHarness.release());
  await expect.poll(() => page.evaluate(() => (window as any).__pfHarness.stopped.length)).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => (window as any).__pfHarness.active())).toBe(0);
});
test('context changes close active tunnels and clear their UI', async ({ page }) => {
  const dialog = await setup(page); await dialog.getByRole('button', { name: 'Start forward' }).click();
  await expect(page.getByText('http://127.0.0.1:34123', { exact: true })).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: /cluster-a/ }).click();
  await page.getByRole('button', { name: 'cluster-b', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pfHarness.active())).toBe(0);
  await expect(page.getByText('http://127.0.0.1:34123', { exact: true })).toHaveCount(0);
});

test('Ports picker filters targets and compact sessions stay inside the dock', async ({ page }) => {
  const dialog = await setup(page); await dialog.getByRole('button', { name: 'Start forward' }).click();
  const table = page.getByRole('table', { name: 'Port forward sessions', exact: true });
  await expect(table).toBeVisible();
  expect(await table.evaluate(el => el.scrollWidth <= el.parentElement!.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Add Tunnel', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a port-forward target' });
  await picker.getByPlaceholder('Find Pod or Service…').fill('service');
  await picker.getByRole('button').filter({ hasText: 'web-service' }).click();
  await expect(dialog.getByLabel('Remote port', { exact: true })).toHaveValue('80');
  await dialog.getByLabel('Local port', { exact: true }).fill('65536');
  await expect(dialog.getByRole('button', { name: 'Start forward' })).toBeDisabled();
  await dialog.getByLabel('Local port', { exact: true }).fill('65535');
  await expect(dialog.getByRole('button', { name: 'Start forward' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__pfHarness.starts.length)).toBe(1);
  await page.setViewportSize({ width: 900, height: 800 });
  expect(await table.evaluate(el => el.scrollWidth <= el.parentElement!.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/ports-compact.png' });
});

test('browser snapshots explain the desktop transport requirement', async ({ page }) => {
  await page.route('**/api/k8s/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['backend'] });
    return route.fulfill({ json: { items: url.searchParams.get('kind') === 'Pod' ? [{ apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'pod', name: 'web', namespace: 'backend' }, spec: { containers: [{ name: 'app', image: 'nginx' }] }, status: { phase: 'Running' } }] : [] } });
  });
  await page.goto('/'); await page.getByTestId('resource-table').getByText('web', { exact: true }).click();
  await page.getByTestId('resource-details').getByRole('button', { name: 'Ports', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create port-forward' });
  await dialog.getByRole('button', { name: 'Start forward' }).click();
  await expect(dialog.getByRole('alert')).toContainText('desktop app');
  await expect(page.getByRole('table', { name: 'Port forward sessions' })).toHaveCount(0);
});
