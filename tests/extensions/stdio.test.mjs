import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const binary = path.resolve('.kubiki-build/runtime', process.platform === 'win32' ? 'node.exe' : 'node');
test('bundled Node runs the real controller, backend IPC and clean shutdown', { skip: !existsSync(binary) }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kubiki-stdio-'));
  const child = spawn(binary, [path.resolve('.kubiki-build/extension-host.cjs'), folder, path.resolve('.kubiki-build/extensions')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const message = JSON.parse(line); const p = pending.get(message.id); if (!p) return; pending.delete(message.id); clearTimeout(p.timer); if (message.error) p.reject(Error(message.error)); else p.resolve(message.result); });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = String(++sequence); const timer = setTimeout(() => reject(Error('Bundled runtime did not respond')), 10000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    const list = await request('list'); assert.ok(list.some(entry => entry.manifest.id === 'kubiki.sdk-test'));
    const result = await request('call', { id: 'kubiki.sdk-test', method: 'check', params: null }); assert.match(result, /PASS/);
    await request('shutdown'); child.stdin.end(); await new Promise(resolve => child.once('exit', resolve));
    assert.equal(child.exitCode, 0);
  } finally { child.kill(); lines.close(); for (const p of pending.values()) clearTimeout(p.timer); await rm(folder, { recursive: true, force: true }); }
});
