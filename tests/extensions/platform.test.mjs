import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import {
  unpackPackage,
  PackageStore,
} from '../../packages/extension-host/src/packages.mjs';
import { ExtensionController } from '../../packages/extension-host/src/controller.mjs';
import { repository } from '../../packages/extension-host/src/github.mjs';
const script = path.resolve('.kubiki-build/extension-host.cjs');
const manifest = {
  manifestVersion: 1,
  id: 'example.test',
  name: 'Test extension',
  description: 'SDK integration fixture',
  version: '0.1.0',
  hostApi: '^1.0.0',
  main: 'backend/index.cjs',
  contributes: {
    panels: [{ id: 'test', title: 'Test', entry: 'ui/index.html' }],
  },
  requestedCapabilities: ['settings'],
};
function pack(
  patch = {},
  backend = `exports.activate = c => ({methods:{echo:p=>p, store:async p=>{await c.settings.set('test',p);return c.settings.get('test')}, fail:()=>{throw Error('expected failure')}, wait:(_p,{signal})=>new Promise((resolve,reject)=>{let t=setTimeout(()=>resolve('late'),5000); signal.addEventListener('abort',()=>{clearTimeout(t);reject(Error('cancelled'))},{once:true})})}});`,
) {
  return zipSync({
    'extension.json': strToU8(JSON.stringify({ ...manifest, ...patch })),
    'backend/index.cjs': strToU8(backend),
    'ui/index.html': strToU8('<h1>Test</h1>'),
  });
}
async function controller(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'kubiki-extensions-'));
  const c = new ExtensionController(root, script, async () => {
    throw Error('Secret service unavailable in test');
  });
  await c.init();
  t.after(async () => {
    await c.runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return c;
}
async function install(c, bytes = pack()) {
  const p = await c.preview({
    bytes,
    manifest: unpackPackage(bytes).manifest,
    source: { type: 'local' },
  });
  return c.request('install', { token: p.token });
}

test('rejects traversal, links, oversized directories, incompatible APIs and missing entrypoints', () => {
  assert.equal(unpackPackage(pack()).manifest.id, manifest.id);
  assert.throws(
    () => unpackPackage(pack({ main: '../outside.cjs' })),
    /manifest/,
  );
  assert.throws(
    () => unpackPackage(pack({ hostApi: '^2.0.0' })),
    /requires host API/,
  );
  assert.throws(
    () => unpackPackage(pack({ main: 'missing.cjs' })),
    /Missing package entry/,
  );
  const b = Buffer.from(pack());
  let i = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  b.writeUInt32LE((0o120777 << 16) >>> 0, i + 38);
  assert.throws(() => unpackPackage(b), /Unsafe/);
  b.writeUInt32LE(0, i + 38);
  b.writeUInt32LE(100 * 1024 * 1024, i + 24);
  assert.throws(() => unpackPackage(b), /Unsafe|exceeds/);
});
test('GitHub resolution accepts repository and pinned release URLs only', () => {
  assert.deepEqual(repository('https://github.com/example/redis.git'), {
    repo: 'example/redis',
    tag: null,
  });
  assert.equal(
    repository('https://github.com/example/redis/releases/tag/v1.0.0').tag,
    'v1.0.0',
  );
  for (const url of [
    'http://github.com/a/b',
    'https://github.com.evil/a/b',
    'https://github.com/a/b/tree/main',
    'https://github.com/a/b?q=1',
  ])
    assert.throws(() => repository(url));
});
test('installs immutable reviewed bytes, executes JSON RPC and persists namespaced settings', async (t) => {
  const c = await controller(t);
  await install(c);
  const p = { id: manifest.id };
  assert.deepEqual(
    await c.request('call', {
      ...p,
      method: 'echo',
      params: { unicode: 'Привет 🌍' },
    }),
    { unicode: 'Привет 🌍' },
  );
  assert.deepEqual(
    await c.request('call', { ...p, method: 'store', params: ['one', 2] }),
    ['one', 2],
  );
  await assert.rejects(
    c.request('call', { ...p, method: 'fail' }),
    /expected failure/,
  );
  await c.request('enable', { ...p, enabled: false });
  assert.equal(c.runtime.hosts.size, 0);
  await assert.rejects(c.request('call', { ...p, method: 'echo' }), /disabled/);
  await c.request('enable', { ...p, enabled: true });
  assert.deepEqual(
    await c.request('service', {
      ...p,
      method: 'settings.get',
      params: { key: 'test' },
    }),
    ['one', 2],
  );
  await assert.rejects(
    c.request('service', {
      ...p,
      method: 'secrets.get',
      params: { key: 'password' },
    }),
    /did not request/,
  );
});
test('cancels active calls and releases the last panel host without losing settings', async (t) => {
  const c = await controller(t);
  await install(c);
  await c.request('view.open', { id: manifest.id, panel: 'test', view: 'one' });
  await c.request('view.open', { id: manifest.id, panel: 'test', view: 'two' });
  const abort = new AbortController();
  const p = c.request(
    'call',
    { id: manifest.id, method: 'wait' },
    abort.signal,
  );
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(p, /cancel/);
  assert.equal(
    await c.request('call', {
      id: manifest.id,
      method: 'echo',
      params: 'alive',
    }),
    'alive',
  );
  await c.request('view.close', { view: 'one' });
  assert.equal(c.runtime.hosts.size, 1);
  await c.request('view.close', { view: 'two' });
  assert.equal(c.runtime.hosts.size, 0);
});
test('failed activation restores an installed version and rollback selects an older package', async (t) => {
  const c = await controller(t);
  await install(c);
  await assert.rejects(
    install(
      c,
      pack(
        { version: '0.2.0' },
        `exports.activate=()=>{throw Error('broken update')}`,
      ),
    ),
    /broken update/,
  );
  assert.equal(c.store.entries[manifest.id].version, '0.1.0');
  assert.equal(
    await c.request('call', { id: manifest.id, method: 'echo', params: 'old' }),
    'old',
  );
  await install(c, pack({ version: '0.3.0' }));
  await c.request('rollback', { id: manifest.id });
  assert.equal(c.store.entries[manifest.id].version, '0.1.0');
  await c.request('uninstall', { id: manifest.id });
  assert.deepEqual(await c.request('list'), []);
});
test('aborted preparation leaves the registry and active version unchanged', async (t) => {
  const c = await controller(t);
  await install(c);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    c.store.install(
      pack({ version: '0.4.0' }),
      { type: 'local' },
      abort.signal,
    ),
  );
  const disk = JSON.parse(
    await readFile(path.join(c.store.root, 'installed.json'), 'utf8'),
  );
  assert.equal(disk[manifest.id].version, '0.1.0');
  await assert.rejects(
    c.store.install(pack({ version: '0.5.0' }), {
      type: 'github',
      repo: 'other/repo',
    }),
    /another source/,
  );
});
test('a blocked extension times out without stopping another extension host', async (t) => {
  const c = await controller(t);
  await install(c);
  await install(
    c,
    pack(
      { id: 'example.blocked' },
      `exports.activate=()=>({methods:{block:()=>{while(true){}}}})`,
    ),
  );
  c.runtime.timeoutMs = 150;
  await assert.rejects(
    c.request('call', { id: 'example.blocked', method: 'block' }),
    /cancelled/,
  );
  assert.equal(
    await c.request('call', {
      id: manifest.id,
      method: 'echo',
      params: 'still alive',
    }),
    'still alive',
  );
  assert.match(c.runtime.errors.get('example.blocked'), /timed out/);
});
test('activation and disposal can access settings during rollback and disable', async (t) => {
  const c = await controller(t);
  const backend = `exports.activate=async c=>{await c.settings.get('startup');c.subscriptions.push({dispose:()=>c.settings.set('disposed',true)});return {methods:{ready:()=>true}}};`;
  await install(c, pack({}, backend));
  await install(c, pack({ version: '0.2.0' }, backend));
  await c.request('rollback', { id: manifest.id });
  assert.equal(
    await c.request('call', { id: manifest.id, method: 'ready' }),
    true,
  );
  await c.request('enable', { id: manifest.id, enabled: false });
  await c.request('enable', { id: manifest.id, enabled: true });
  assert.equal(
    await c.request('service', {
      id: manifest.id,
      method: 'settings.get',
      params: { key: 'disposed' },
    }),
    true,
  );
});
