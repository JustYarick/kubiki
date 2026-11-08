import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const script = fileURLToPath(new URL('../../scripts/desktop-build.mjs', import.meta.url));
const resources = ['dist/index.html', '.kubiki-build/extension-host.cjs', '.kubiki-build/extensions/sdk-test.kubiki-extension', '.kubiki-build/runtime/HOST-LICENSES.txt'];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kubiki-build-'));
  async function write(file, text) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  await write('src-tauri/tauri.conf.json', JSON.stringify({ version: '1.2.3-dev.4' }));
  await write('src-tauri/Cargo.toml', 'original manifest');
  await write('src-tauri/Cargo.lock', 'original lock');
  // Capture real wrapper invocations without compiling/installing a desktop app.
  await write('node_modules/@tauri-apps/cli/tauri.js', `
    const fs = require('node:fs');
    fs.appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
  `);
  for (const file of resources) await write(file, 'shared build resource');
  return root;
}

function run(root, args = []) {
  return spawnSync(process.execPath, [script, '--target', 'x86_64-unknown-linux-gnu', ...args], {
    cwd: root, encoding: 'utf8',
  });
}

test('prebuilt frontend preserves signing configuration and reuses the binary for RPM bundling', async () => {
  const root = await fixture();
  try {
    const result = run(root, ['--prebuilt-frontend', '--config', 'signing.conf.json']);
    assert.equal(result.status, 0, result.stderr);
    const calls = (await readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call[0]), ['build', 'bundle']);
    for (const call of calls) {
      const configs = call.filter((_, index) => call[index - 1] === '--config');
      assert.equal(configs[1], 'signing.conf.json');
      assert.deepEqual(JSON.parse(configs[2]), { build: { beforeBuildCommand: 'pnpm desktop:prepare' } });
    }
    assert.deepEqual(calls[0].slice(-2), ['--', '--locked']);
    assert.equal(await readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8'), 'original manifest');
    assert.equal(await readFile(path.join(root, 'src-tauri/Cargo.lock'), 'utf8'), 'original lock');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prebuilt frontend rejects missing UI or extension resources before invoking Tauri', async () => {
  const root = await fixture();
  try {
    for (const file of resources) {
      await rm(path.join(root, file));
      const result = run(root, ['--prebuilt-frontend']);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(file), result.stderr);
      await assert.rejects(readFile(path.join(root, 'calls.jsonl')), { code: 'ENOENT' });
      await writeFile(path.join(root, file), 'restored resource');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ordinary local desktop builds keep the default frontend build hook', async () => {
  const root = await fixture();
  try {
    await rm(path.join(root, 'dist'), { recursive: true });
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const calls = (await readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.every(call => !call.some(arg => arg.includes('beforeBuildCommand'))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the workflow archive transfers shared resources without the build host Node executable', async () => {
  const root = await fixture();
  try {
    const jobs = parse(await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')).jobs;
    const packageStep = jobs.web_assets.steps.find(step => step.run?.startsWith('tar -czf'));
    const restoreStep = jobs.desktop.steps.find(step => step.run?.startsWith('tar -xzf'));
    await writeFile(path.join(root, '.kubiki-build/runtime/node'), 'Linux binary must not ship to other platforms');
    const [command, ...args] = packageStep.run.trim().split(/\s+/);
    const packed = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const destination = path.join(root, 'restored');
    await mkdir(destination);
    const [restoreCommand, ...restoreArgs] = restoreStep.run.trim().split(/\s+/);
    restoreArgs[1] = path.join(root, restoreArgs[1]);
    const restored = spawnSync(restoreCommand, restoreArgs, { cwd: destination, encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stderr);
    for (const file of resources) {
      assert.equal(await readFile(path.join(destination, file), 'utf8'), 'shared build resource');
    }
    await assert.rejects(readFile(path.join(destination, '.kubiki-build/runtime/node')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
