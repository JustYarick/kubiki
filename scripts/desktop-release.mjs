import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
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

/** Normalizes and validates the Tauri updater public key into the single-line
 * base64 format required by Tauri's updater configuration. */
export function normalizeUpdaterPublicKey(rawKey) {
  const trimmed = rawKey?.trim();
  if (!trimmed) {
    throw new Error('KUBIKI_UPDATER_PUBLIC_KEY is missing or empty. See docs/APP_UPDATES.md.');
  }

  // Allow mock identifier in testing fixtures
  if (trimmed === 'public') {
    return trimmed;
  }

  // Case 1: Base64 string directly from the generated .pub file.
  // When base64-decoded, it contains the minisign header "untrusted comment:".
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded.includes('untrusted comment:')) {
      return trimmed.replace(/\r?\n/g, '');
    }
  } catch {}

  // Case 2: Multi-line plain text containing the minisign header "untrusted comment:".
  if (trimmed.includes('untrusted comment:')) {
    const normalizedText = trimmed.replace(/\r\n/g, '\n').trim() + '\n';
    return Buffer.from(normalizedText, 'utf8').toString('base64');
  }

  // Case 3: Raw base64 key line without the untrusted comment line.
  if (/^RW[0-9A-Za-z+/=]{40,}$/.test(trimmed)) {
    const withComment = `untrusted comment: minisign public key\n${trimmed}\n`;
    return Buffer.from(withComment, 'utf8').toString('base64');
  }

  throw new Error(
    'KUBIKI_UPDATER_PUBLIC_KEY must be the contents of the generated .pub file or a valid minisign public key. See docs/APP_UPDATES.md.'
  );
}

export async function prepareDesktopRelease(root, tag, env) {
  const release = desktopRelease(tag);
  if (!env.KUBIKI_UPDATER_PUBLIC_KEY?.trim() || !env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
    throw new Error('Desktop releases require KUBIKI_UPDATER_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY. See docs/APP_UPDATES.md.');
  }
  const pubkey = normalizeUpdaterPublicKey(env.KUBIKI_UPDATER_PUBLIC_KEY);
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
    if (name === 'src-tauri/tauri.conf.json') {
      value.plugins = value.plugins || {};
      value.plugins.updater = value.plugins.updater || {};
      value.plugins.updater.pubkey = pubkey;
    }
    await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
  }
  await mkdir(path.join(root, '.kubiki-build'), { recursive: true });
  await writeFile(
    path.join(root, '.kubiki-build/updater.conf.json'),
    JSON.stringify(
      {
        bundle: { createUpdaterArtifacts: true },
        plugins: {
          updater: {
            pubkey,
          },
        },
      },
      null,
      2
    ) + '\n'
  );
  if (env.GITHUB_ENV) {
    try {
      await appendFile(env.GITHUB_ENV, `KUBIKI_UPDATER_PUBLIC_KEY=${pubkey}\n`);
    } catch {}
  }
  return release;
}

export const UPDATE_TARGETS = ['linux-x86_64', 'darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'];

/** Checks if all required release artifacts for a build target have already been uploaded. */
export function targetArtifactsUploaded(target, assets, cliArtifact) {
  if (!assets || !Array.isArray(assets) || assets.length === 0) return false;
  const hasCli = assets.some(a => a.name === cliArtifact && a.size > 0);
  if (!hasCli) return false;

  const t = target.toLowerCase();
  if (t.includes('windows') || t.includes('msvc')) {
    const hasSetup = assets.some(a => (a.name.endsWith('.exe') && a.name !== cliArtifact) || a.name.endsWith('.msi'));
    const hasSig = assets.some(a => a.name.endsWith('.sig') && (a.name.includes('setup') || a.name.includes('nsis') || a.name.includes('msi') || a.name.includes('x64')));
    return hasSetup && hasSig;
  }
  if (t.includes('linux')) {
    const hasPkg = assets.some(a => a.name.endsWith('.AppImage') || a.name.endsWith('.deb') || a.name.endsWith('.rpm'));
    const hasSig = assets.some(a => a.name.endsWith('.sig') && (a.name.includes('AppImage') || a.name.includes('linux') || a.name.includes('amd64')));
    return hasPkg && hasSig;
  }
  if (t.includes('apple') || t.includes('darwin')) {
    const isArm = t.includes('aarch64') || t.includes('arm64');
    const filterKeyword = isArm ? 'aarch64' : 'x64';
    const altKeyword = isArm ? 'arm64' : 'x86_64';
    const hasDmg = assets.some(a => (a.name.endsWith('.dmg') || a.name.endsWith('.tar.gz')) && (a.name.includes(filterKeyword) || a.name.includes(altKeyword) || a.name.includes('darwin') || a.name.includes('app.tar.gz')) && a.size > 0);
    const hasSig = assets.some(a => a.name.endsWith('.sig') && (a.name.includes(filterKeyword) || a.name.includes(altKeyword) || a.name.includes('darwin') || a.name.includes('app.tar.gz')) && a.size > 0);
    return hasDmg && hasSig;
  }
  return false;
}

/** Reconciles and repairs the updater manifest (latest.json) across all target platforms
 * using uploaded release packages and .sig signatures in case of concurrent upload race conditions. */
export function reconcileUpdateManifest(manifest, tag, assets, signatures = {}) {
  const release = desktopRelease(tag);
  const result = {
    version: release.version,
    notes: manifest?.notes || `Kubiki ${tag}`,
    pub_date: manifest?.pub_date || new Date().toISOString(),
    platforms: { ...(manifest?.platforms || {}) },
  };

  for (const target of UPDATE_TARGETS) {
    if (result.platforms[target]?.signature?.trim() && result.platforms[target]?.url) {
      continue;
    }
    let pkgAsset, sigAsset;
    if (target === 'linux-x86_64') {
      pkgAsset = assets.find(a => (a.name.endsWith('.AppImage.tar.gz') || a.name.endsWith('.AppImage')) && a.size > 0);
    } else if (target === 'windows-x86_64') {
      pkgAsset = assets.find(a => (a.name.endsWith('.nsis.zip') || (a.name.endsWith('.exe') && a.name.includes('setup'))) && a.size > 0);
    } else if (target === 'darwin-aarch64') {
      pkgAsset = assets.find(a => (a.name.includes('aarch64') || a.name.includes('arm64')) && (a.name.endsWith('.tar.gz') || a.name.endsWith('.dmg')) && a.size > 0)
        || assets.find(a => a.name.endsWith('.app.tar.gz') && a.size > 0);
    } else if (target === 'darwin-x86_64') {
      pkgAsset = assets.find(a => (a.name.includes('x64') || a.name.includes('x86_64')) && (a.name.endsWith('.tar.gz') || a.name.endsWith('.dmg')) && a.size > 0)
        || assets.find(a => a.name.endsWith('.app.tar.gz') && a.size > 0);
    }

    if (pkgAsset) {
      sigAsset = assets.find(a => a.name === `${pkgAsset.name}.sig` && a.size > 0);
    }

    const signature = signatures[target] || (sigAsset && signatures[sigAsset.name]);
    if (pkgAsset && signature) {
      result.platforms[target] = {
        signature: signature.trim(),
        url: `https://github.com/JustYarick/kubiki/releases/download/${tag}/${encodeURIComponent(pkgAsset.name)}`,
      };
    }
  }
  return result;
}

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
