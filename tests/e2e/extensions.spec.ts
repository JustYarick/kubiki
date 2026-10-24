import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

async function setup(page: Page) {
  const modulePath = pathToFileURL(
    path.resolve('packages/extension-host/src/controller.mjs'),
  ).href;
  const { ExtensionController } = await import(modulePath);
  const root = await mkdtemp(path.join(tmpdir(), 'kubiki-extension-browser-'));
  const secrets = new Map<string, string>();
  const controller = new ExtensionController(
    root,
    path.resolve('.kubiki-build/extension-host.cjs'),
    async (id: string, method: string, p: any) => {
      const key = `${id}:${p.key}`;
      if (method === 'secrets.get') return secrets.get(key) ?? null;
      if (method === 'secrets.set') {
        secrets.set(key, p.value);
        return null;
      }
      if (method === 'secrets.delete') secrets.delete(key);
      return null;
    },
  );
  await controller.init(path.resolve('.kubiki-build/extensions'));
  await page.route('**/__extension_test', async (route) => {
    try {
      const p = route.request().postDataJSON();
      await route.fulfill({
        json: { result: await controller.request(p.method, p.params) },
      });
    } catch (error) {
      await route.fulfill({
        json: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  });
  await page.addInitScript(() => {
    const callbacks = new Map();
    let callback = 0;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: (fn: any) => {
        callbacks.set(++callback, fn);
        return callback;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'extension_request') {
          const data = await (
            await fetch('/__extension_test', {
              method: 'POST',
              body: JSON.stringify(args),
            })
          ).json();
          if (data.error) throw data.error;
          return data.result;
        }
        if (command === 'extension_cancel') return;
        if (command === 'get_kube_contexts') return [];
        if (command === 'plugin:event|listen') return ++callback;
        if (command === 'plugin:event|unlisten' || command.startsWith('stop_'))
          return;
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Extensions', exact: true }).click();
  return {
    controller,
    close: async () => {
      await page.close();
      await controller.runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('bundled diagnostics exercise real backend RPC and survive disable/re-enable', async ({
  page,
}) => {
  const fixture = await setup(page);
  try {
    const manager = page.getByTestId('extensions-manager');
    await expect(manager.getByText('SDK Diagnostics', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'SDK Diagnostics', exact: true })).toHaveCount(0);
    const developerMode = async (enabled: boolean) => {
      await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Developer', exact: true }).click();
      await dialog.getByRole('checkbox', { name: 'Developer mode', exact: true }).setChecked(enabled);
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    };
    await developerMode(true);
    await expect(
      manager.getByText('SDK Diagnostics', { exact: true }).first(),
    ).toBeVisible();
    await manager.getByRole('button', { name: 'Open', exact: true }).click();
    const frame = page.frameLocator('iframe[title="kubiki.sdk-test panel"]');
    await expect(frame.getByRole('status')).toContainText(
      'Panel ↔ backend RPC and Unicode: PASS',
    );
    await expect(frame.getByRole('status')).toContainText('Cancellation: PASS');
    await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await manager.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(
      manager.getByRole('button', { name: 'Enable', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'SDK Diagnostics', exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => fixture.controller.runtime.hosts.size).toBe(0);
    await manager.getByRole('button', { name: 'Enable', exact: true }).click();
    await manager.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(frame.getByRole('status')).toContainText(
      'Error propagation: PASS',
    );
    await developerMode(false);
    await expect(page.locator('iframe[title="kubiki.sdk-test panel"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'SDK Diagnostics', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /SDK Diagnostics/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await expect(manager.getByText('SDK Diagnostics', { exact: true })).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('local package installs through review and its iframe cannot reach main DOM or Tauri', async ({
  page,
}) => {
  const fixture = await setup(page);
  try {
    const manifest = {
      manifestVersion: 1,
      id: 'example.external',
      name: 'External Test',
      version: '0.1.0',
      description: 'Independent package fixture',
      hostApi: '^1.0.0',
      main: 'backend/index.cjs',
      contributes: {
        panels: [
          { id: 'view', title: 'External Test', entry: 'ui/index.html' },
        ],
      },
      requestedCapabilities: [],
    };
    const html = `<p id="result">Waiting</p><p id="boundary"></p><p id="invalid"></p><script>document.getElementById('boundary').textContent=typeof window.__TAURI_INTERNALS__ === 'undefined' ? 'No Tauri' : 'FAIL'; try { parent.document.body; document.getElementById('boundary').textContent+=' FAIL'; } catch {document.getElementById('boundary').textContent+=' · Parent isolated';} window.addEventListener('message',e=>{if(e.source!==parent||e.data.type!=='kubiki:init')return; const p=e.ports[0];p.onmessage=e=>{if(e.data.id===1)document.getElementById('result').textContent=e.data.result;if(e.data.id===2)document.getElementById('invalid').textContent=e.data.error;};p.postMessage({id:1,method:'call',params:{method:'hello',params:null}});const cycle={id:2,method:'call'};cycle.params=cycle;p.postMessage(cycle);});</script>`;
    const bytes = zipSync({
      'extension.json': strToU8(JSON.stringify(manifest)),
      'backend/index.cjs': strToU8(
        `exports.activate=()=>({methods:{hello:()=> 'External backend connected'}})`,
      ),
      'ui/index.html': strToU8(html),
    });
    await page.locator('input[type=file]').setInputFiles({
      name: 'external.kubiki-extension',
      mimeType: 'application/zip',
      buffer: Buffer.from(bytes),
    });
    const dialog = page.getByRole('dialog', {
      name: 'Install extension',
      exact: true,
    });
    await expect(dialog).toContainText('External Test');
    await dialog
      .getByRole('button', { name: 'Install & Enable', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await page
      .getByRole('button', { name: 'External Test', exact: true })
      .click();
    const frame = page.frameLocator('iframe[title="example.external panel"]');
    await expect(frame.locator('#result')).toHaveText(
      'External backend connected',
    );
    await expect(frame.locator('#invalid')).toHaveText('Invalid panel message');
    await expect(frame.locator('#boundary')).toHaveText(
      'No Tauri · Parent isolated',
    );
    await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await page
      .getByTestId('extensions-manager')
      .getByRole('button')
      .filter({ hasText: 'External Test' })
      .click();
    await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Uninstall extension' })
      .getByRole('button', { name: 'Uninstall', exact: true })
      .click();
    await expect
      .poll(() => fixture.controller.store.entries[manifest.id])
      .toBeUndefined();
  } finally {
    await fixture.close();
  }
});

test('external Redis package connects and edits a string through reviewed changes', async ({
  page,
}) => {
  test.skip(
    !process.env.KUBIKI_REDIS_PACKAGE,
    'Run against the independently built Redis package',
  );
  const fixture = await setup(page);
  try {
    const bytes = await readFile(process.env.KUBIKI_REDIS_PACKAGE!);
    await page.locator('input[type=file]').setInputFiles({
      name: 'redis.kubiki-extension',
      mimeType: 'application/zip',
      buffer: bytes,
    });
    await page
      .getByRole('dialog', { name: 'Install extension' })
      .getByRole('button', { name: 'Install & Enable', exact: true })
      .click();
    await page.getByRole('button', { name: 'Redis', exact: true }).click();
    const frame = page.frameLocator('iframe[title="kubiki.redis panel"]');
    await frame.getByLabel('Name', { exact: true }).fill('Browser integration');
    await frame
      .getByLabel('Port', { exact: true })
      .fill(process.env.REDIS_PORT ?? '16381');
    await frame
      .getByLabel('Password', { exact: true })
      .fill(process.env.REDIS_PASSWORD ?? 'test-extension-password');
    await frame
      .getByRole('button', { name: 'Save & Connect', exact: true })
      .click();
    await expect(frame.locator('#status')).toHaveText('Connected');
    await frame
      .getByRole('button', { name: 'Create string', exact: true })
      .click();
    await frame
      .getByLabel('Key name', { exact: true })
      .fill('kubiki-ui-integration');
    await frame.getByLabel('String value', { exact: true }).fill('hello 🌍');
    await frame
      .getByRole('button', { name: 'Review new key', exact: true })
      .click();
    await expect(frame.locator('#review-text')).toContainText(
      'CREATE kubiki-ui-integration',
    );
    await frame
      .getByRole('button', { name: 'Confirm change', exact: true })
      .click();
    await frame
      .getByRole('button', { name: 'kubiki-ui-integration', exact: true })
      .click();
    await expect(frame.getByLabel('Value', { exact: true })).toHaveValue(
      'hello 🌍',
    );
    await frame.getByLabel('Value', { exact: true }).fill('edited');
    await frame
      .getByRole('button', { name: 'Review string change', exact: true })
      .click();
    await frame
      .getByRole('button', { name: 'Confirm change', exact: true })
      .click();
    await frame
      .getByRole('button', { name: 'kubiki-ui-integration', exact: true })
      .click();
    await expect(frame.getByLabel('Value', { exact: true })).toHaveValue(
      'edited',
    );
    await frame
      .getByRole('button', { name: 'Review deletion', exact: true })
      .click();
    await frame
      .getByRole('button', { name: 'Confirm change', exact: true })
      .click();
    await expect(
      frame.getByRole('button', { name: 'kubiki-ui-integration', exact: true }),
    ).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
