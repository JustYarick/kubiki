import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable is an explicitly published plain vX.Y.Z tag. Any preview or build
 * suffix stays outside the stable feed, even if GitHub was misconfigured. */
export function desktopRelease(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag);
  if (!match || match[0] !== tag || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error('Release tag must be SemVer prefixed with v (for example v0.2.0 or v0.2.0-rc.1).');
  }
  return { tag, version: tag.slice(1), prerelease: Boolean(match[4] || match[5]) };
}

export async function prepareDesktopRelease(root, tag, env) {
  const release = desktopRelease(tag);
  if (!env.KUBIKI_UPDATER_PUBLIC_KEY?.trim() || !env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
    throw new Error('Desktop releases require KUBIKI_UPDATER_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY. See docs/APP_UPDATES.md.');
  }
  const manifestPath = path.join(root, 'src-tauri/Cargo.toml');
  const lockPath = path.join(root, 'src-tauri/Cargo.lock');
  const manifest = await readFile(manifestPath, 'utf8');
  const lock = await readFile(lockPath, 'utf8');
  const manifestVersion = /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+("\s*\n)/;
  const lockVersion = /(\[\[package\]\]\s*\nname = "kubiki"\s*\nversion = ")[^"]+("\s*\n)/;
  if (!manifestVersion.test(manifest) || !lockVersion.test(lock)) throw new Error('Desktop package version was not found.');
  await writeFile(manifestPath, manifest.replace(manifestVersion, (_all, start, end) => `${start}${release.version}${end}`));
  await writeFile(lockPath, lock.replace(lockVersion, (_all, start, end) => `${start}${release.version}${end}`));
  for (const name of ['package.json', 'src-tauri/tauri.conf.json']) {
    const filename = path.join(root, name);
    const value = JSON.parse(await readFile(filename, 'utf8'));
    value.version = release.version;
    await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
  }
  await mkdir(path.join(root, '.kubiki-build'), { recursive: true });
  await writeFile(path.join(root, '.kubiki-build/updater.conf.json'), JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
  return release;
}

export const UPDATE_TARGETS = ['linux-x86_64', 'darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'];

export function validateUpdateManifest(manifest, tag, assets) {
  const release = desktopRelease(tag);
  if (manifest.version !== release.version && manifest.version !== tag) throw new Error('Update manifest version does not match the release tag.');
  for (const target of UPDATE_TARGETS) {
    const platform = manifest.platforms?.[target];
    if (!platform?.signature?.trim() || !platform.url) throw new Error(`Missing signed updater artifact for ${target}.`);
    const url = new URL(platform.url);
    if (url.origin !== 'https://github.com' || !decodeURIComponent(url.pathname).startsWith(`/JustYarick/kubiki/releases/download/${tag}/`)) {
      throw new Error(`Updater URL must be pinned to ${tag}: ${platform.url}`);
    }
    const filename = decodeURIComponent(url.pathname.split('/').at(-1));
    if (!assets.some(asset => asset.name === filename && asset.size > 0)) throw new Error(`Missing update package: ${filename}`);
    if (!assets.some(asset => asset.name === `${filename}.sig` && asset.size > 0)) throw new Error(`Missing signature: ${filename}.sig`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareDesktopRelease(process.cwd(), process.argv[2], process.env);
}
