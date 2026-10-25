import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopRelease, updateChannel } from './desktop-release.mjs';

export const DESKTOP_TARGETS = {
  'x86_64-unknown-linux-gnu': { cli: 'kubiki-cli-linux-amd64', bundles: ['deb', 'rpm', 'appimage'], updater: '.AppImage' },
  'aarch64-apple-darwin': { cli: 'kubiki-cli-macos-arm64', bundles: ['dmg'], updater: '_aarch64.app.tar.gz' },
  'x86_64-apple-darwin': { cli: 'kubiki-cli-macos-amd64', bundles: ['dmg'], updater: '_x64.app.tar.gz' },
  'x86_64-pc-windows-msvc': { cli: 'kubiki-cli-windows-amd64.exe', bundles: ['nsis', 'msi'], updater: '-setup.exe' },
};

export function compareStableTags(a, b) {
  const av = a.slice(1).split('.').map(BigInt);
  const bv = b.slice(1).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  }
  return 0;
}

export function nextReleaseTag(tags, { bump = 'patch', branch, runNumber, fallback = '0.1.0' }) {
  if (!['patch', 'minor', 'major'].includes(bump)) throw new Error(`Invalid bump: ${bump}`);
  const stable = tags.filter(t => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(t)).sort(compareStableTags);
  const base = stable.at(-1) || `v${fallback}`;
  desktopRelease(base);
  const parts = base.slice(1).split('.').map(BigInt);
  const index = { major: 0, minor: 1, patch: 2 }[bump];
  parts[index]++;
  for (let i = index + 1; i < 3; i++) parts[i] = 0n;
  const version = parts.join('.');
  if (branch === 'main') return `v${version}`;
  let number = BigInt(runNumber ?? 1);
  if (number < 1n) throw new Error('Dev build number must be positive.');
  // CI and Release have separate run counters. Published tags establish a
  // shared lower bound so switching workflows cannot reuse an older number.
  for (const tag of tags.filter(tag => tag.startsWith(`v${version}-dev.`))) {
    try {
      if (updateChannel(tag) !== 'dev') continue;
      const previous = BigInt(tag.split('-dev.')[1]);
      if (previous >= number) number = previous + 1n;
    } catch { /* Ignore malformed tags. */ }
  }
  return `v${version}-dev.${number}`;
}

/** WiX rejects nonnumeric prereleases/build metadata. Keep that installer
 * version separate from the application's full SemVer. */
export function installerBundleConfig(version) {
  desktopRelease(`v${version}`);
  const base = version.match(/^\d+\.\d+\.\d+/)[0];
  const [major, minor, patch] = base.split('.').map(BigInt);
  if (major > 255n || minor > 255n || patch > 65535n) throw new Error('Desktop release exceeds MSI version limits (255.255.65535).');
  return { bundle: { windows: { wix: { version: base } }, macOS: { bundleVersion: base } } };
}

/** RPM forbids '-' in Version. Bundle the existing SemVer binary with a
 * numeric package Version and a prerelease Release lower than stable's 1.
 * This override is only used by `tauri bundle`, never by the compiler. */
export function rpmBundleConfig(version) {
  const release = desktopRelease(`v${version}`);
  const base = version.match(/^\d+\.\d+\.\d+/)[0];
  const suffix = version.slice(base.length).replace(/^[-+]/, '').replace(/-/g, '_');
  return {
    version: base,
    bundle: { createUpdaterArtifacts: false, linux: { rpm: { release: release.prerelease ? `0.${suffix}` : '1' } } },
  };
}

const extensions = { deb: '.deb', rpm: '.rpm', appimage: '.AppImage', dmg: '.dmg', nsis: '-setup.exe', msi: '.msi' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateTargetAssets(target, assets, signed) {
  const spec = DESKTOP_TARGETS[target];
  if (!spec) throw new Error(`Unsupported desktop target: ${target}`);
  for (const suffix of [spec.cli, ...spec.bundles.map(b => extensions[b]), ...(signed ? [spec.updater, `${spec.updater}.sig`] : [])]) {
    if (!assets.some(a => a.name.endsWith(suffix) && a.size > 0)) throw new Error(`Missing ${suffix} for ${target}`);
  }
}

/** Only stage distributable files, never the bundled runtime or intermediate
 * installer files. Mac archive names must be unique across matrix artifacts. */
export async function stageDesktopArtifacts(root, target, { tag, sha, signed }) {
  const spec = DESKTOP_TARGETS[target];
  if (!spec) throw new Error(`Unsupported desktop target: ${target}`);
  const out = path.join(root, '.kubiki-build/artifacts');
  await mkdir(out, { recursive: true });
  const files = [];
  const bundleRoot = path.join(root, 'src-tauri/target', target, 'release/bundle');
  for (const kind of ['deb', 'rpm', 'appimage', 'dmg', 'nsis', 'msi', 'macos']) {
    const dir = path.join(bundleRoot, kind);
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(deb|rpm|AppImage|dmg|exe|msi|app\.tar\.gz)(\.sig)?$/.test(entry.name)) continue;
      let name = entry.name;
      if (name.includes('.app.tar.gz')) name = name.replace('.app.tar.gz', `${target.startsWith('aarch64') ? '_aarch64' : '_x64'}.app.tar.gz`);
      files.push({ source: path.join(dir, entry.name), name });
    }
  }
  files.push({ source: path.join(root, 'crates/kubiki-core/target', target, 'release', target.includes('windows') ? 'kubiki-cli.exe' : 'kubiki-cli'), name: spec.cli });
  const assets = [];
  for (const file of files) {
    const bytes = await readFile(file.source);
    if (assets.some(a => a.name === file.name)) throw new Error(`Duplicate artifact: ${file.name}`);
    assets.push({ name: file.name, size: bytes.length, sha256: digest(bytes) });
    await copyFile(file.source, path.join(out, file.name));
  }
  validateTargetAssets(target, assets, signed);
  await writeFile(path.join(out, `build-${target}.json`), JSON.stringify({ target, tag, sha, signed, assets }, null, 2) + '\n');
  return assets;
}

export async function verifyDesktopArtifacts(dir, tag, sha) {
  const assets = [];
  for (const target of Object.keys(DESKTOP_TARGETS)) {
    const record = JSON.parse(await readFile(path.join(dir, `build-${target}.json`), 'utf8'));
    if (record.target !== target || record.tag !== tag || record.sha !== sha || record.signed !== true) throw new Error(`Artifact provenance mismatch for ${target}`);
    validateTargetAssets(target, record.assets, true);
    for (const asset of record.assets) {
      if (asset.name !== path.basename(asset.name) || assets.some(a => a.name === asset.name)) throw new Error(`Invalid or duplicate asset: ${asset.name}`);
      const file = path.join(dir, asset.name);
      const bytes = await readFile(file);
      if (!(await stat(file)).isFile() || bytes.length !== asset.size || digest(bytes) !== asset.sha256) throw new Error(`Artifact checksum mismatch: ${asset.name}`);
      assets.push(asset);
    }
  }
  return assets;
}
