import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desktopRelease, prepareDesktopRelease, normalizeUpdaterPublicKey, reconcileUpdateManifest, validateUpdateManifest, UPDATE_TARGETS } from '../../scripts/desktop-release.mjs';

const publicKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQzMTMxRkEzNTgwNUQzNzQKUldSMDB3VllveDhUMDZRSmVhaUh0c2x6ci95YlY2YUZkcW9qcnJESGpOVWhTbGdQRG4vaXhqZHUK';

test('stable feed excludes dev, test, alpha, beta, rc and build metadata tags', () => {
  for (const version of ['0.1.0', '0.1.1', '0.2.0', '1.10.0']) assert.equal(desktopRelease(`v${version}`).prerelease, false);
  for (const version of ['0.2.0-dev.1', '0.2.0-test', '0.2.0-alpha', '0.2.0-beta.2', '0.2.0-rc.1', '0.2.0+dev']) {
    assert.equal(desktopRelease(`v${version}`).prerelease, true);
  }
  for (const tag of ['main', 'test', 'v1.2', 'v01.2.3', 'v1.2.3-01', 'v1.2.3-dev..1', 'v1.2.3\n']) assert.throws(() => desktopRelease(tag));
});

test('release preparation synchronizes embedded versions and locked package identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kubiki-release-'));
  try {
    await mkdir(path.join(root, 'src-tauri'));
    await writeFile(path.join(root, 'package.json'), '{"name":"kubiki","version":"0.1.0"}');
    await writeFile(path.join(root, 'src-tauri/tauri.conf.json'), '{"version":"0.1.0","bundle":{"resources":{"keep":"keep"}}}');
    await writeFile(path.join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "kubiki"\nversion = "0.1.0"\n');
    await writeFile(path.join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "kubiki"\nversion = "0.1.0"\n\n[[package]]\nname = "other"\nversion = "1.0.0"\n');
    await assert.rejects(prepareDesktopRelease(root, 'v0.2.0', {}), /require/);
    await prepareDesktopRelease(root, 'v0.2.0', { KUBIKI_UPDATER_PUBLIC_KEY: publicKey, TAURI_SIGNING_PRIVATE_KEY: 'private' });
    assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'))).version, '0.2.0');
    const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json')));
    assert.equal(config.version, '0.2.0');
    assert.deepEqual(config.bundle.resources, { keep: 'keep' });
    assert.match(await readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8'), /version = "0.2.0"/);
    assert.match(await readFile(path.join(root, 'src-tauri/Cargo.lock'), 'utf8'), /name = "kubiki"\nversion = "0.2.0"/);
    assert.match(await readFile(path.join(root, 'src-tauri/Cargo.lock'), 'utf8'), /name = "other"\nversion = "1.0.0"/);
    assert.equal(config.plugins?.updater?.pubkey, publicKey);
    const updaterConf = JSON.parse(await readFile(path.join(root, '.kubiki-build/updater.conf.json')));
    assert.equal(updaterConf.bundle.createUpdaterArtifacts, true);
    assert.equal(updaterConf.plugins.updater.pubkey, publicKey);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('normalizeUpdaterPublicKey normalizes base64, plaintext, and raw key formats', () => {
  const validBase64 = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQzMTMxRkEzNTgwNUQzNzQKUldSMDB3VllveDhUMDZRSmVhaUh0c2x6ci95YlY2YUZkcW9qcnJESGpOVWhTbGdQRG4vaXhqZHUK';
  const decodedText = 'untrusted comment: minisign public key: D3131FA35805D374\nRWR00wVYox8T06QJeaiHtslzr/ybV6aFdqojrrDHjNUhSlgPDn/ixjdu\n';
  const rawKey = 'RWR00wVYox8T06QJeaiHtslzr/ybV6aFdqojrrDHjNUhSlgPDn/ixjdu';

  // Base64 from .pub file
  assert.equal(normalizeUpdaterPublicKey(validBase64), validBase64);
  assert.equal(normalizeUpdaterPublicKey(`\n  ${validBase64}\r\n`), validBase64);

  // Multiline plain text with untrusted comment
  const normalizedFromText = normalizeUpdaterPublicKey(decodedText);
  assert.match(Buffer.from(normalizedFromText, 'base64').toString('utf8'), /^untrusted comment:/);
  assert.match(Buffer.from(normalizedFromText, 'base64').toString('utf8'), /RWR00wVYox/);

  // Raw key without comment
  const normalizedFromRaw = normalizeUpdaterPublicKey(rawKey);
  assert.match(Buffer.from(normalizedFromRaw, 'base64').toString('utf8'), /^untrusted comment: minisign public key\n/);
  assert.match(Buffer.from(normalizedFromRaw, 'base64').toString('utf8'), /RWR00wVYox/);

  // Invalid inputs throw
  assert.throws(() => normalizeUpdaterPublicKey(''), /missing or empty/);
  assert.throws(() => normalizeUpdaterPublicKey('   '), /missing or empty/);
  assert.throws(() => normalizeUpdaterPublicKey('not-a-minisign-key'), /valid minisign public key/);
});

function fixture() {
  const platforms = Object.fromEntries(UPDATE_TARGETS.map(target => [target, {
    url: `https://github.com/JustYarick/kubiki/releases/download/v0.2.0/kubiki-${target}`,
    signature: 'signed',
  }]));
  const assets = UPDATE_TARGETS.flatMap(target => [{ name: `kubiki-${target}`, size: 100 }, { name: `kubiki-${target}.sig`, size: 100 }]);
  return { manifest: { version: '0.2.0', platforms }, assets };
}

test('publication requires matching version, all platforms, signatures and tag-pinned packages', () => {
  const { manifest, assets } = fixture();
  assert.doesNotThrow(() => validateUpdateManifest(manifest, 'v0.2.0', assets));
  assert.throws(() => validateUpdateManifest({ ...manifest, version: '0.1.0' }, 'v0.2.0', assets), /version/);
  assert.throws(() => validateUpdateManifest(manifest, 'v0.2.0', assets.slice(1)), /Missing update package/);
  assert.throws(() => validateUpdateManifest(manifest, 'v0.2.0', assets.filter(asset => !asset.name.endsWith('.sig'))), /Missing signature/);
  delete manifest.platforms['darwin-aarch64'];
  assert.throws(() => validateUpdateManifest(manifest, 'v0.2.0', assets), /darwin-aarch64/);
  const other = fixture();
  other.manifest.platforms['linux-x86_64'].url = 'https://github.com/JustYarick/kubiki/releases/latest/download/package';
  assert.throws(() => validateUpdateManifest(other.manifest, 'v0.2.0', other.assets), /pinned/);
});

test('manifest requires distinct Mac archives and a matching signature for each platform', () => {
  const packages = ['kubiki_0.2.0_amd64.AppImage', 'kubiki_0.2.0_x64-setup.exe', 'kubiki_aarch64.app.tar.gz', 'kubiki_x64.app.tar.gz'];
  const assets = packages.flatMap(name => [{ name, size: 1000 }, { name: `${name}.sig`, size: 100 }]);
  const signatures = Object.fromEntries(packages.map(name => [`${name}.sig`, `sig-${name}`]));
  const manifest = reconcileUpdateManifest(null, 'v0.2.0', assets, signatures);
  validateUpdateManifest(manifest, 'v0.2.0', assets);
  assert.match(manifest.platforms['darwin-aarch64'].url, /_aarch64\.app\.tar\.gz$/);
  assert.match(manifest.platforms['darwin-x86_64'].url, /_x64\.app\.tar\.gz$/);
  assert.throws(() => reconcileUpdateManifest(manifest, 'v0.2.0', assets.filter(a => !a.name.includes('_x64.app')), signatures), /darwin-x86_64/);
  assert.throws(() => reconcileUpdateManifest(null, 'v0.2.0', assets, {}), /signature contents/);
  assert.throws(() => reconcileUpdateManifest(null, 'v0.2.0', [...assets, { name: 'old.AppImage', size: 10 }], signatures), /exactly one/);
});
