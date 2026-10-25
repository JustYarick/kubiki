import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { installerBundleConfig, rpmBundleConfig, stageDesktopArtifacts } from './desktop-pipeline.mjs';

const { values } = parseArgs({ options: {
  target: { type: 'string' }, config: { type: 'string' },
  stage: { type: 'boolean' }, signed: { type: 'boolean' },
} });
if (values.stage && (!values.target || !process.env.RELEASE_TAG || !process.env.SOURCE_SHA)) throw new Error('Staging requires --target, RELEASE_TAG and SOURCE_SHA');
const env = { ...process.env, ...(values.target ? { KUBIKI_BUILD_TARGET: values.target } : {}) };
if (process.platform === 'linux') env.OPENSSL_CONF = '/dev/null';
// Invoke the installed CLI through Node so Windows does not need shell quoting.
const cli = path.resolve('node_modules/@tauri-apps/cli/tauri.js');
function tauri(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tauri ${args[0]} failed (${result.status ?? result.signal})`);
}
const { version } = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
await mkdir('.kubiki-build', { recursive: true });
await writeFile('.kubiki-build/installer.conf.json', JSON.stringify(installerBundleConfig(version), null, 2) + '\n');
const configArgs = ['--config', '.kubiki-build/installer.conf.json', ...(values.config ? ['--config', values.config] : [])];
const targetArgs = values.target ? ['--target', values.target] : [];
const linux = (values.target || '').includes('linux') || (!values.target && process.platform === 'linux');
if (values.stage) {
  await rm('.kubiki-build/artifacts', { recursive: true, force: true });
  // Cached build directories must not contribute stale packages to a new release.
  await rm(path.join('src-tauri/target', values.target, 'release/bundle'), { recursive: true, force: true });
}
tauri(['build', ...targetArgs, ...configArgs, ...(linux ? ['--bundles', 'deb,appimage'] : []), '--', '--locked']);
if (linux) {
  const config = rpmBundleConfig(version);
  await writeFile('.kubiki-build/rpm.conf.json', JSON.stringify(config, null, 2) + '\n');
  // Bundling changes package metadata only. Restore the manifest if Tauri rewrites
  // it while applying the temporary numeric version; the binary keeps SemVer.
  const manifest = await readFile('src-tauri/Cargo.toml');
  const lock = await readFile('src-tauri/Cargo.lock');
  try {
    tauri(['bundle', ...targetArgs, ...configArgs, '--config', '.kubiki-build/rpm.conf.json', '--bundles', 'rpm']);
  } finally {
    await writeFile('src-tauri/Cargo.toml', manifest);
    await writeFile('src-tauri/Cargo.lock', lock);
  }
}
if (values.stage) {
  const assets = await stageDesktopArtifacts(process.cwd(), values.target, {
    tag: process.env.RELEASE_TAG, sha: process.env.SOURCE_SHA, signed: Boolean(values.signed),
  });
  console.log(`Verified ${assets.length} distributables for ${values.target}`);
}
