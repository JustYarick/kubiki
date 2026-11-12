import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import path from 'node:path';
import os from 'node:os';
import { extensionRuntimeTarget } from './extension-runtime-target.mjs';

const version = '24.22.1';
const { platform, arch, target } = extensionRuntimeTarget();
const archive = `node-v${version}-${platform}-${arch}${platform === 'win' ? '.zip' : '.tar.gz'}`;
const mirrors = [
  ...(process.env.NODEJS_ORG_MIRROR ? [process.env.NODEJS_ORG_MIRROR.replace(/\/+$/, '') + `/v${version}/`] : []),
  ...(process.env.NODE_MIRROR ? [process.env.NODE_MIRROR.replace(/\/+$/, '') + `/v${version}/`] : []),
  `https://nodejs.org/dist/v${version}/`,
  `https://npmmirror.com/mirrors/node/v${version}/`,
];
const baseUrls = [...new Set(mirrors)];

await mkdir('.kubiki-build/runtime', { recursive: true });
const binary = path.resolve(
  '.kubiki-build/runtime',
  platform === 'win' ? 'node.exe' : 'node',
);
const record = '.kubiki-build/runtime/runtime.json';

// A cross-build must not package an executable left over from the other OS.
await rm(path.resolve('.kubiki-build/runtime', platform === 'win' ? 'node' : 'node.exe'), { force: true });

try {
  const info = JSON.parse(await readFile(record, 'utf8'));
  if (
    info.version === version &&
    info.archive === archive &&
    info.sha256 ===
      createHash('sha256')
        .update(await readFile(binary))
        .digest('hex')
  ) {
    await readFile('.kubiki-build/runtime/LICENSE');
    console.log(`Verified bundled Node ${version}`);
    process.exit(0);
  }
} catch {}

if (process.env.KUBIKI_NODE_BINARY) {
  const customBinary = path.resolve(process.env.KUBIKI_NODE_BINARY);
  await writeFile(binary, await readFile(customBinary));
  await chmod(binary, 0o755);
  try {
    await writeFile('.kubiki-build/runtime/LICENSE', 'Bundled from KUBIKI_NODE_BINARY\n');
  } catch {}
  await writeFile(
    record,
    JSON.stringify({
      version,
      archive: 'custom-binary',
      target,
      sha256: createHash('sha256')
        .update(await readFile(binary))
        .digest('hex'),
    }),
  );
  console.log(`Prepared bundled Node from KUBIKI_NODE_BINARY: ${customBinary}`);
  process.exit(0);
}

async function fetchChecksums(urls) {
  let lastError;
  for (const base of urls) {
    const url = base + 'SHASUMS256.txt';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Timeout after 30000ms')), 30000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (err) {
        lastError = err;
        console.warn(`[SHASUMS256] Attempt ${attempt} failed from ${url}: ${err.message}`);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt * 1500));
        }
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(`Failed to fetch SHASUMS256.txt from all mirrors: ${lastError?.message}`);
}

// Pinned official SHA-256 checksums from https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
// to protect against compromised mirrors or supply-chain tampering.
const PINNED_NODE_CHECKSUMS = {
  'node-v24.22.1-darwin-arm64.tar.gz': '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
  'node-v24.22.1-darwin-x64.tar.gz': 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
  'node-v24.22.1-linux-arm64.tar.gz': '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
  'node-v24.22.1-linux-x64.tar.gz': 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
  'node-v24.22.1-win-arm64.zip': 'a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171',
  'node-v24.22.1-win-x64.zip': 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
};

const pinnedExpected = PINNED_NODE_CHECKSUMS[archive];
if (!pinnedExpected) {
  throw new Error(`No pinned SHA-256 checksum defined for target archive: ${archive}`);
}

let expected = pinnedExpected;
try {
  const checksums = await fetchChecksums(baseUrls);
  const remoteChecksum = checksums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === archive)?.[0];
  if (remoteChecksum && remoteChecksum !== expected) {
    throw new Error(`Remote SHASUMS256.txt checksum (${remoteChecksum}) does not match pinned official checksum (${expected})! Potential supply-chain tampering.`);
  }
} catch (err) {
  if (err.message.includes('Potential supply-chain tampering')) throw err;
  console.warn(`[SHASUMS256] Could not verify remote checksums file (${err.message}), relying on pinned SHA-256.`);
}

const userCacheDir = process.env.KUBIKI_CACHE_DIR || path.join(os.homedir(), '.cache', 'kubiki', 'node');
const cachedArchivePath = path.join(userCacheDir, archive);
const temp = path.resolve('.kubiki-build/runtime', platform === 'win' ? 'download.zip' : 'download.tar.gz');

function downloadWithCurl(url, destPath) {
  try {
    const res = spawnSync('curl', [
      '-fSL',
      '--retry', '3',
      '--retry-delay', '2',
      '--retry-connrefused',
      '--connect-timeout', '30',
      '-m', '300',
      '--silent',
      '--show-error',
      url,
      '-o', destPath,
    ], { stdio: 'inherit' });
    return res.status === 0;
  } catch {
    return false;
  }
}

async function downloadWithFetch(url, destPath, timeoutMs = 300000, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Download timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      console.log(`[Attempt ${attempt}/${maxRetries}] Fetching ${url}...`);
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const fileStream = createWriteStream(destPath);
      await pipeline(Readable.fromWeb(res.body), fileStream, { signal: controller.signal });
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[Attempt ${attempt}/${maxRetries}] Download failed: ${err.message}`);
      await rm(destPath, { force: true });
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function verifyFileChecksum(filePath, expectedSha256) {
  try {
    const hash = createHash('sha256').update(await readFile(filePath)).digest('hex');
    return hash === expectedSha256;
  } catch {
    return false;
  }
}

let archiveFound = false;

// 1. Check user-provided KUBIKI_NODE_ARCHIVE
if (process.env.KUBIKI_NODE_ARCHIVE) {
  const manualArchive = path.resolve(process.env.KUBIKI_NODE_ARCHIVE);
  if (await verifyFileChecksum(manualArchive, expected)) {
    console.log(`Using archive from KUBIKI_NODE_ARCHIVE: ${manualArchive}`);
    await writeFile(temp, await readFile(manualArchive));
    archiveFound = true;
  } else {
    console.warn(`KUBIKI_NODE_ARCHIVE at ${manualArchive} does not match expected checksum`);
  }
}

// 2. Check local persistent cache
if (!archiveFound) {
  if (await verifyFileChecksum(cachedArchivePath, expected)) {
    console.log(`Using cached Node archive: ${cachedArchivePath}`);
    await writeFile(temp, await readFile(cachedArchivePath));
    archiveFound = true;
  }
}

// 3. Download if not found locally
if (!archiveFound) {
  let downloadSuccess = false;
  let lastError;
  for (const base of baseUrls) {
    const url = base + archive;
    console.log(`Downloading ${archive} from ${base}...`);
    await rm(temp, { force: true });

    if (downloadWithCurl(url, temp)) {
      if (await verifyFileChecksum(temp, expected)) {
        console.log(`Successfully downloaded and verified ${archive} via curl`);
        downloadSuccess = true;
        break;
      }
      console.warn(`Checksum mismatch for file downloaded via curl from ${url}`);
      await rm(temp, { force: true });
    }

    try {
      await downloadWithFetch(url, temp, 300000, 3);
      if (await verifyFileChecksum(temp, expected)) {
        console.log(`Successfully downloaded and verified ${archive} via fetch`);
        downloadSuccess = true;
        break;
      }
      console.warn(`Checksum mismatch for file downloaded via fetch from ${url}`);
      await rm(temp, { force: true });
    } catch (err) {
      lastError = err;
      console.warn(`Mirror ${base} failed: ${err.message}`);
    }
  }

  if (!downloadSuccess) {
    throw new Error(`Failed to download valid ${archive} from all mirrors: ${lastError?.message}`);
  }

  // Save valid archive to userCacheDir for future builds
  try {
    await mkdir(userCacheDir, { recursive: true });
    await writeFile(cachedArchivePath, await readFile(temp));
  } catch {}
}

const prefix = `node-v${version}-${platform}-${arch}`;
if (platform === 'win') {
  const bytes = await readFile(temp);
  const files = unzipSync(bytes);
  await writeFile(binary, files[`${prefix}/node.exe`]);
  await writeFile('.kubiki-build/runtime/LICENSE', files[`${prefix}/LICENSE`]);
  await rm(temp, { force: true });
} else {
  execFileSync('tar', [
    '-xzf',
    path.resolve(temp),
    '-C',
    path.dirname(binary),
    '--strip-components=2',
    `${prefix}/bin/node`,
  ]);
  await writeFile(
    '.kubiki-build/runtime/LICENSE',
    execFileSync('tar', ['-xOzf', path.resolve(temp), `${prefix}/LICENSE`]),
  );
  await rm(temp, { force: true });
  await chmod(binary, 0o755);
}

await writeFile(
  record,
  JSON.stringify({
    version,
    archive,
    target,
    sha256: createHash('sha256')
      .update(await readFile(binary))
      .digest('hex'),
  }),
);
console.log(`Prepared bundled Node ${version}`);
