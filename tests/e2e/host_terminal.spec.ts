import { test, expect } from '@playwright/test';
async function setup(page: import('@playwright/test').Page, failInfo = false) {
  await page.addInitScript(({ failInfo }) => {
    const w = window as any;let callback = 0;let infoFailure = failInfo;const callbacks = new Map();const active = new Map<string, any>();const closed: any[] = [];const starts: any[] = [];const input: any[] = [];const sizes: any[] = [];const acks: any[] = [];const encoder = new TextEncoder();
    const output = (text: string) => ({ type: 'Output', payload: { data: [...encoder.encode(text)] } });
    const send = (s: any, events: any[]) => s.channel.onmessage({ session_id: s.id, messages: events.map((event) => ({ sequence: ++s.sequence, event })) });
    w.__hostHarness = { starts, input, sizes, acks, active: () => active.size, callbacks: () => callbacks.size,
      finish: () => { for (const s of active.values()) send(s, [{ type: 'Exited', payload: { code: 7 } }]); },
      late: () => { for (const s of closed) send(s, [output('STALE HOST OUTPUT\r\n')]); },
    };
    w.__TAURI_INTERNALS__ = { transformCallback: (fn: any) => { callbacks.set(++callback, fn);return callback; }, unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'get_kube_contexts') return [];
        if (command === 'get_host_terminal_info') { if (infoFailure) { infoFailure = false;throw { code: 'internal', operation: 'host_terminal', message: 'Cannot discover local shells' }; }return { shells: ['/bin/zsh','/bin/sh'], default_shell: '/bin/zsh', cwd: '/home/test' }; }
        if (command === 'start_host_terminal') { const s = { id: args.sessionId, channel: args.onEvent, sequence: 0 };active.set(s.id, s);starts.push(args.request);queueMicrotask(() => send(s, [{ type: 'Started' }, output('local-shell-ready\r\n')]));return; }
        if (command === 'write_host_terminal') { input.push(args);const s = active.get(args.sessionId);if (s) send(s, [output(args.data.includes('\r') ? '\r\nlocal-command-result\r\n' : args.data)]);return; }
        if (command === 'resize_host_terminal') { sizes.push(args);return; }
        if (command === 'ack_host_terminal') { acks.push(args);return; }
        if (command === 'close_host_terminal') { const s = active.get(args.sessionId);if (s) closed.push(s);active.delete(args.sessionId);return; }
        if (command === 'stop_host_terminals') { active.clear();return; }
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  }, { failInfo });
  await page.goto('/');await page.getByRole('button', { name: 'Expand bottom panel', exact: true }).click();await page.getByRole('button', { name: 'Open Local Terminal (Host PC)', exact: true }).click();
}
test('host shell works without a cluster, carries keys/resize, preserves hidden sessions and cleans up', async ({ page }) => {
  await setup(page);const pane = page.getByTestId('live-terminal');await expect(pane.getByRole('status')).toHaveText('Connected');
  await expect(pane.getByText(/^Local host/)).toBeVisible();await expect(pane.getByRole('button', { name: 'Select Container' })).toHaveCount(0);
  await expect(pane.getByRole('combobox', { name: 'Shell binary' })).toHaveValue('/bin/zsh');
  await pane.locator('.xterm').getByRole('textbox', { name: 'Terminal input' }).focus();await page.keyboard.type('echo test');await page.keyboard.press('Enter');await page.keyboard.press('Control+c');await page.keyboard.press('Control+w');
  await expect(pane.locator('.xterm-rows')).toContainText('local-command-result');
  await expect.poll(() => page.evaluate(() => (window as any).__hostHarness.input.some((i: any) => i.data === '\u0003'))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__hostHarness.input.some((i: any) => i.data === '\u0017'))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__hostHarness.acks.length)).toBeGreaterThan(0);
  await page.keyboard.press('Control+j');await page.keyboard.press('Control+j');expect(await page.evaluate(() => (window as any).__hostHarness.starts.length)).toBe(1);
  await pane.getByRole('combobox', { name: 'Shell binary' }).selectOption('/bin/sh');
  await expect.poll(() => page.evaluate(() => (window as any).__hostHarness.starts.length)).toBe(2);await expect.poll(() => page.evaluate(() => (window as any).__hostHarness.active())).toBe(1);
  await page.evaluate(() => (window as any).__hostHarness.late());await expect(pane.locator('.xterm-rows')).not.toContainText('STALE HOST OUTPUT');
  await page.setViewportSize({ width: 900, height: 700 });await expect.poll(() => page.evaluate(() => (window as any).__hostHarness.sizes.length)).toBeGreaterThan(1);
  await page.screenshot({ path: 'test-results/host-terminal.png' });
  await page.evaluate(() => (window as any).__hostHarness.finish());await expect(pane.getByRole('status')).toHaveText('Exited (7)');await expect.poll(() => page.evaluate(() => (window as any).__hostHarness.active())).toBe(0);
  await pane.getByRole('button', { name: 'Reconnect shell' }).click();await expect(pane.getByRole('status')).toHaveText('Connected');
  await pane.getByRole('button', { name: 'Disconnect shell' }).click();await expect(pane.getByRole('status')).toHaveText('Disconnected');
  await expect.poll(() => page.evaluate(() => (window as any).__hostHarness.active())).toBe(0);
  await pane.getByRole('button', { name: 'Reconnect shell' }).click();await expect(pane.getByRole('status')).toHaveText('Connected');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));await expect.poll(() => page.evaluate(() => (window as any).__hostHarness.active())).toBe(0);await expect.poll(() => page.evaluate(() => (window as any).__hostHarness.callbacks())).toBe(0);
});
test('host shell metadata error can be retried with Reconnect', async ({ page }) => {
  await setup(page, true);const pane = page.getByTestId('live-terminal');await expect(pane.getByRole('alert')).toContainText('Cannot discover local shells');
  await pane.getByRole('button', { name: 'Reconnect shell' }).click();await expect(pane.getByRole('status')).toHaveText('Connected');
});
test('browser local terminal explains desktop requirement and does not simulate a real shell', async ({ page }) => {
  await page.route('**/api/k8s/contexts', (route) => route.fulfill({ json: [] }));await page.goto('/');
  await page.getByRole('button', { name: 'Expand bottom panel', exact: true }).click();await page.getByRole('button', { name: 'Open Local Terminal (Host PC)', exact: true }).click();
  await expect(page.getByTestId('live-terminal').getByRole('alert')).toContainText('Local shell is available in the desktop app');
  await expect(page.getByTestId('live-terminal').getByRole('status')).toHaveText('Failed');
});
