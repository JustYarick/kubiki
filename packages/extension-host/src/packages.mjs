import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { HOST_API, packagePath, validateManifest } from '@kubiki/extension-sdk';

export const MAX_PACKAGE = 20 * 1024 * 1024;
const MAX_EXTRACTED = 80 * 1024 * 1024;
export function unpackPackage(bytes) {
  if (bytes.length > MAX_PACKAGE || bytes.length < 22)
    throw new Error('Package must be a ZIP archive smaller than 20 MiB');
  // Validate central-directory sizes and Unix file types BEFORE allocating inflated data.
  const b = Buffer.from(bytes);
  let end = b.length - 22;
  while (
    end >= Math.max(0, b.length - 65557) &&
    b.readUInt32LE(end) !== 0x06054b50
  )
    end--;
  if (
    end < 0 ||
    end < b.length - 65557 ||
    end + 22 + b.readUInt16LE(end + 20) !== b.length
  )
    throw new Error('Invalid ZIP directory');
  const count = b.readUInt16LE(end + 10);
  let offset = b.readUInt32LE(end + 16);
  let total = 0;
  if (
    !count ||
    count > 1000 ||
    b.readUInt16LE(end + 4) ||
    b.readUInt16LE(end + 6)
  )
    throw new Error('Unsupported ZIP archive');
  const expected = new Map();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || b.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('Invalid ZIP entry');
    const size = b.readUInt32LE(offset + 24),
      n = b.readUInt16LE(offset + 28),
      extra = b.readUInt16LE(offset + 30),
      comment = b.readUInt16LE(offset + 32);
    const type = (b.readUInt32LE(offset + 38) >>> 16) & 0o170000;
    const name = b.subarray(offset + 46, offset + 46 + n).toString('utf8');
    const normalized = name.endsWith('/') ? name.slice(0, -1) : name;
    if (
      !packagePath(normalized) ||
      expected.has(name) ||
      [0o120000, 0o060000, 0o020000].includes(type) ||
      ![0, 0o100000, 0o040000].includes(type) ||
      b.readUInt16LE(offset + 8) & 1 ||
      name.endsWith('.node') ||
      size > MAX_PACKAGE
    )
      throw new Error('Unsafe or unsupported package entry');
    total += size;
    if (total > MAX_EXTRACTED)
      throw new Error('Extracted package exceeds 80 MiB');
    expected.set(name, size);
    offset += 46 + n + extra + comment;
  }
  if (offset !== end) throw new Error('Unsupported ZIP directory layout');
  const files = unzipSync(bytes);
  if (Object.keys(files).length !== expected.size)
    throw new Error('ZIP directory mismatch');
  for (const [name, data] of Object.entries(files))
    if (!expected.has(name) || expected.get(name) !== data.length)
      throw new Error('ZIP entry size mismatch');
  if (!files['extension.json'] || files['extension.json'].length > 16384)
    throw new Error('Missing extension.json');
  const manifest = validateManifest(
    JSON.parse(Buffer.from(files['extension.json']).toString('utf8')),
  );
  if (!semver.satisfies(HOST_API, manifest.hostApi))
    throw new Error(
      `Extension requires host API ${manifest.hostApi}; this host provides ${HOST_API}`,
    );
  for (const entry of [
    manifest.main,
    ...manifest.contributes.panels.map((p) => p.entry),
  ])
    if (!files[entry]) throw new Error(`Missing package entry: ${entry}`);
  return {
    manifest,
    files,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
}
export class PackageStore {
  constructor(root) {
    this.root = root;
    this.entries = {};
    this.lock = Promise.resolve();
  }
  async load() {
    await mkdir(this.root, { recursive: true });
    try {
      this.entries = JSON.parse(
        await readFile(path.join(this.root, 'installed.json'), 'utf8'),
      );
    } catch (e) {
      if (e.code !== 'ENOENT')
        throw new Error(
          'Extension installation registry is damaged; restore installed.json before continuing',
        );
    }
    for (const [id, entry] of Object.entries(this.entries)) {
      if (
        !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(id) ||
        !semver.valid(entry.version) ||
        (entry.previous && !semver.valid(entry.previous))
      )
        throw new Error('Invalid extension installation registry');
    }
  }
  folder(id, version = this.entries[id]?.version) {
    if (!this.entries[id] || !semver.valid(version))
      throw new Error('Extension is not installed');
    return path.join(this.root, 'packages', id, version);
  }
  async manifest(id) {
    return validateManifest(
      JSON.parse(
        await readFile(path.join(this.folder(id), 'extension.json'), 'utf8'),
      ),
    );
  }
  async save() {
    await atomicJson(path.join(this.root, 'installed.json'), this.entries);
  }
  async serialize(operation) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async install(bytes, origin, signal) {
    return this.serialize(async () => {
      const { manifest, files, digest } = unpackPackage(bytes);
      const old = this.entries[manifest.id];
      if (old && JSON.stringify(old.origin) !== JSON.stringify(origin))
        throw new Error('This extension ID is already owned by another source');
      if (old && !semver.gt(manifest.version, old.version))
        throw new Error('Choose a newer extension version');
      const destination = path.join(
        this.root,
        'packages',
        manifest.id,
        manifest.version,
      );
      const staging = `${destination}.staging`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      try {
        for (const [name, data] of Object.entries(files)) {
          if (name.endsWith('/')) continue;
          const target = path.join(staging, name);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, data, { mode: 0o600 });
        }
        signal?.throwIfAborted();
        // An old rollback directory may already contain this version. Never replace it silently.
        await rename(staging, destination);
        this.entries[manifest.id] = {
          version: manifest.version,
          previous: old?.version ?? null,
          enabled: old?.enabled ?? true,
          origin,
          digest,
        };
        try {
          await this.save();
        } catch (e) {
          if (old) this.entries[manifest.id] = old;
          else delete this.entries[manifest.id];
          throw e;
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      return manifest.id;
    });
  }
  async bundled(directory) {
    const names = await readdir(directory);
    for (const name of names.filter((n) => n.endsWith('.kubiki-extension'))) {
      const bytes = await readFile(path.join(directory, name));
      const { manifest } = unpackPackage(bytes);
      const old = this.entries[manifest.id];
      if (
        !old ||
        (old.origin.type === 'builtin' &&
          semver.gt(manifest.version, old.version))
      )
        await this.install(bytes, { type: 'builtin' });
    }
  }
}
