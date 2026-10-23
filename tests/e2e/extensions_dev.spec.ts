import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

test('extension development host renders SDK diagnostics and reloads source changes', async ({
  page,
}) => {
  const directory = await mkdtemp(path.resolve('.kubiki-build/dev-fixture-'));
  await cp('extensions/sdk-test', directory, { recursive: true });
  const child = spawn(
    process.execPath,
    ['packages/extension-tools/src/cli.mjs', 'dev', directory],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => reject(new Error(`Dev host did not start: ${output}`)),
        15000,
      );
      child.stdout.on('data', (data) => {
        output += data;
        const found = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (found) {
          clearTimeout(timer);
          resolve(found[0]);
        }
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(output));
      });
    });
    await page.goto(url);
    const frame = page.frameLocator('iframe[title="Development extension"]');
    await expect(frame.getByRole('status')).toContainText(
      'Panel ↔ backend RPC and Unicode: PASS',
    );
    await expect(frame.getByRole('status')).toContainText('Cancellation: PASS');
    const file = path.join(directory, 'src/panel.ts');
    const source = await readFile(file, 'utf8');
    await writeFile(
      file,
      source.replace(
        "heading.textContent = 'SDK Diagnostics'",
        "heading.textContent = 'Reloaded diagnostics'",
      ),
    );
    await expect(
      frame.getByRole('heading', { name: 'Reloaded diagnostics' }),
    ).toBeVisible({ timeout: 15000 });
    await expect(frame.getByRole('status')).toContainText(
      'Error propagation: PASS',
    );
  } finally {
    await page.close();
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    await rm(directory, { recursive: true, force: true });
  }
});
