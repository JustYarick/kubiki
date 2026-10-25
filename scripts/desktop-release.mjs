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

/** Only numbered dev builds (and the legacy bare -dev) have a preview updater. */
export function updateChannel(tag) {
  const release = desktopRelease(tag);
  if (!release.prerelease) return 'stable';
  return /^\d+\.\d+\.\d+-dev(?:\.(0|[1-9]\d*))?$/.test(release.version) ? 'dev' : null;
}

export function compareDevTags(a, b) {
  const parts = tag => {
    if (updateChannel(tag) !== 'dev') throw new Error(`Not a dev update version: ${tag}`);
    const [, major, minor, patch, number] = /^v(\d+)\.(\d+)\.(\d+)-dev(?:\.(\d+))?$/.exec(tag);
    return [major, minor, patch, number ?? '-1'].map(BigInt);
  };
  const av = parts(a), bv = parts(b);
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  }
  return 0;
}

/** Normalizes and validates the Tauri updater public key into the single-line
 * base64 format required by Tauri's updater configuration. */
export function normalizeUpdaterPublicKey(rawKey) {
  const trimmed = rawKey?.trim();
  if (!trimmed) {
    throw new Error('KUBIKI_UPDATER_PUBLIC_KEY is missing or empty. See docs/APP_UPDATES.md.');
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

export async function prepareDesktopRelease(root, tag, env, { signed = true } = {}) {
  const release = desktopRelease(tag);
  if (signed && (!env.KUBIKI_UPDATER_PUBLIC_KEY?.trim() || !env.TAURI_SIGNING_PRIVATE_KEY?.trim())) {
    throw new Error('Desktop releases require KUBIKI_UPDATER_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY. See docs/APP_UPDATES.md.');
  }
  const pubkey = signed ? normalizeUpdaterPublicKey(env.KUBIKI_UPDATER_PUBLIC_KEY) : '';
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
        bundle: { createUpdaterArtifacts: signed },
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
    await appendFile(env.GITHUB_ENV, `KUBIKI_UPDATER_PUBLIC_KEY=${pubkey}\n`);
  }
  return release;
}

export const UPDATE_TARGETS = ['linux-x86_64', 'darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'];

/** Build once, after all matrix jobs finish. Never infer one Mac architecture
 * from the other, or use a DMG as an updater archive. */
export function reconcileUpdateManifest(manifest, tag, assets, signatures = {}) {
  const release = desktopRelease(tag);
  const result = {
    version: release.version,
    notes: manifest?.notes || `Kubiki ${tag}`,
    pub_date: manifest?.pub_date || new Date().toISOString(),
    platforms: {},
  };
  const patterns = {
    'linux-x86_64': /\.AppImage$/,
    'darwin-aarch64': /_aarch64\.app\.tar\.gz$/,
    'darwin-x86_64': /_x64\.app\.tar\.gz$/,
    'windows-x86_64': /[-_]setup\.exe$/,
  };
  for (const target of UPDATE_TARGETS) {
    const packages = assets.filter(a => patterns[target].test(a.name) && a.size > 0);
    if (packages.length !== 1) throw new Error(`Expected exactly one updater package for ${target}, found ${packages.length}.`);
    const pkg = packages[0];
    const signature = signatures[`${pkg.name}.sig`]?.trim();
    if (!signature) throw new Error(`Missing signature contents for ${pkg.name}.`);
    result.platforms[target] = {
      signature,
      url: `https://github.com/JustYarick/kubiki/releases/download/${tag}/${encodeURIComponent(pkg.name)}`,
    };
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
  await prepareDesktopRelease(process.cwd(), process.argv[2], process.env, { signed: !process.argv.includes('--unsigned') });
}
