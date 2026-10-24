import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import path from 'node:path';
import { extensionRuntimeTarget } from './extension-runtime-target.mjs';
const version = '24.22.1';
const { platform, arch, target } = extensionRuntimeTarget();
const archive = `node-v${version}-${platform}-${arch}${platform === 'win' ? '.zip' : '.tar.gz'}`;
const base = `https://nodejs.org/dist/v${version}/`;
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
const fetchBytes = async (name) => {
  const r = await fetch(base + name, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`Node download failed: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
const checksums = (await fetchBytes('SHASUMS256.txt')).toString();
const expected = checksums
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .find(([, file]) => file === archive)?.[0];
if (!expected) throw new Error('Official Node checksum not found');
const bytes = await fetchBytes(archive);
if (createHash('sha256').update(bytes).digest('hex') !== expected)
  throw new Error('Node archive checksum mismatch');
const prefix = `node-v${version}-${platform}-${arch}`;
if (platform === 'win') {
  const files = unzipSync(bytes);
  await writeFile(binary, files[`${prefix}/node.exe`]);
  await writeFile('.kubiki-build/runtime/LICENSE', files[`${prefix}/LICENSE`]);
} else {
  const temp = '.kubiki-build/runtime/download.tar.gz';
  await writeFile(temp, bytes);
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
  await rm(temp);
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
