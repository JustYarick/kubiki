import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  PackageStore,
  atomicJson,
  MAX_PACKAGE,
  unpackPackage,
} from './packages.mjs';
import { inspectGithub } from './github.mjs';
import { Runtime } from './runtime.mjs';

export class ExtensionController {
  constructor(root, script, nativeService) {
    this.store = new PackageStore(root);
    this.nativeService = nativeService;
    this.runtime = new Runtime(script, (...args) => this.service(...args));
    this.previews = new Map();
    this.views = new Map();
    this.settingsLock = Promise.resolve();
  }
  async serializeSettings(operation) {
    const previous = this.settingsLock;
    let release;
    this.settingsLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async init(bundled) {
    await this.store.load();
    if (bundled) await this.store.bundled(bundled);
  }
  async service(id, manifest, method, params) {
    const capability = method.startsWith('secrets.')
      ? 'secrets'
      : method.startsWith('settings.')
        ? 'settings'
        : method === 'notify'
          ? 'notifications'
          : '';
    if (!manifest.requestedCapabilities.includes(capability))
      throw new Error(`Extension did not request ${capability || method}`);
    if (method === 'notify') {
      if (typeof params?.message !== 'string' || params.message.length > 1000)
        throw new Error('Invalid notification');
      return this.nativeService(id, method, params);
    }
    if (typeof params?.key !== 'string' || !/^[\w.-]{1,120}$/.test(params.key))
      throw new Error('Invalid storage key');
    if (method.startsWith('secrets.')) {
      if (
        !['secrets.get', 'secrets.set', 'secrets.delete'].includes(method) ||
        (method === 'secrets.set' &&
          (typeof params.value !== 'string' || params.value.length > 65536))
      )
        throw new Error('Invalid secret operation');
      return this.nativeService(id, method, params);
    }
    if (!['settings.get', 'settings.set'].includes(method))
      throw new Error('Unknown storage method');
    return this.serializeSettings(async () => {
      const file = path.join(this.store.root, 'settings', `${id}.json`);
      let settings = {};
      try {
        settings = JSON.parse(await readFile(file, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (method === 'settings.get')
        return Object.hasOwn(settings, params.key)
          ? settings[params.key]
          : null;
      Object.defineProperty(settings, params.key, {
        value: params.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      if (JSON.stringify(settings).length > 65536)
        throw new Error('Extension settings exceed 64 KiB');
      await atomicJson(file, settings);
      return null;
    });
  }
  async enabled(id) {
    const entry = this.store.entries[id];
    if (!entry?.enabled)
      throw new Error('Extension is disabled or unavailable');
    return this.store.manifest(id);
  }
  async preview(prepared) {
    for (const [token, entry] of this.previews)
      if (entry.expires < Date.now()) this.previews.delete(token);
    if (this.previews.size >= 2)
      this.previews.delete(this.previews.keys().next().value);
    const token = randomUUID();
    this.previews.set(token, { ...prepared, expires: Date.now() + 120000 });
    return {
      token,
      manifest: prepared.manifest,
      source: prepared.source,
      tag: prepared.tag ?? null,
      digest: prepared.digest,
    };
  }
  async request(method, p = {}, signal = new AbortController().signal) {
    if (method === 'list')
      return Promise.all(
        Object.entries(this.store.entries).map(async ([id, entry]) => ({
          ...entry,
          manifest: await this.store.manifest(id),
          status: !entry.enabled
            ? 'disabled'
            : this.runtime.errors.has(id)
              ? 'failed'
              : this.runtime.hosts.has(id)
                ? 'running'
                : 'enabled',
          error: this.runtime.errors.get(id) ?? null,
        })),
      );
    if (method === 'inspect.github')
      return this.preview(await inspectGithub(p.url, signal));
    if (method === 'inspect.file') {
      const bytes = Buffer.from(p.data ?? '', 'base64');
      const { manifest, digest } = unpackPackage(bytes);
      return this.preview({
        bytes,
        manifest,
        digest,
        source: { type: 'local' },
      });
    }
    if (method === 'install') {
      const candidate = this.previews.get(p.token);
      if (!candidate || candidate.expires < Date.now())
        throw new Error('Package preview expired. Check the package again.');
      this.previews.delete(p.token);
      const id = candidate.manifest.id;
      const old = this.store.entries[id];
      await this.runtime.stop(id);
      try {
        await this.store.install(candidate.bytes, candidate.source, signal);
        if (this.store.entries[id].enabled)
          await this.runtime.start(
            id,
            this.store.folder(id),
            await this.store.manifest(id),
          );
      } catch (e) {
        await this.runtime.stop(id);
        if (old && this.store.entries[id]?.version !== old.version) {
          const failed = this.store.folder(id);
          this.store.entries[id] = old;
          await this.store.save();
          await rm(failed, { recursive: true, force: true });
          if (old.enabled)
            await this.runtime.start(
              id,
              this.store.folder(id),
              await this.store.manifest(id),
            );
        } else if (!old && this.store.entries[id]) {
          this.store.entries[id].enabled = false;
          await this.store.save();
        }
        throw e;
      }
      return id;
    }
    if (method === 'enable') {
      return this.store.serialize(async () => {
        const entry = this.store.entries[p.id];
        if (!entry) throw new Error('Extension not installed');
        if (!p.enabled) await this.runtime.stop(p.id);
        entry.enabled = !!p.enabled;
        await this.store.save();
        return null;
      });
    }
    if (method === 'restart') {
      await this.enabled(p.id);
      await this.runtime.stop(p.id);
      await this.runtime.start(
        p.id,
        this.store.folder(p.id),
        await this.store.manifest(p.id),
      );
      return null;
    }
    if (method === 'logs') return this.runtime.logs.get(p.id) ?? [];
    if (method === 'rollback')
      return this.store.serialize(async () => {
        const entry = this.store.entries[p.id];
        if (!entry?.previous) throw new Error('No previous version');
        await this.runtime.stop(p.id);
        const oldVersion = entry.version;
        entry.version = entry.previous;
        try {
          if (entry.enabled)
            await this.runtime.start(
              p.id,
              this.store.folder(p.id),
              await this.store.manifest(p.id),
            );
          entry.previous = oldVersion;
          await this.store.save();
        } catch (e) {
          await this.runtime.stop(p.id);
          entry.version = oldVersion;
          throw e;
        }
        return null;
      });
    if (method === 'uninstall')
      return this.store.serialize(async () => {
        const entry = this.store.entries[p.id];
        if (!entry || entry.origin.type === 'builtin')
          throw new Error('Built-in extensions can be disabled');
        await this.runtime.stop(p.id);
        const folder = path.dirname(this.store.folder(p.id));
        delete this.store.entries[p.id];
        try {
          await this.store.save();
        } catch (e) {
          this.store.entries[p.id] = entry;
          throw e;
        }
        await rm(folder, { recursive: true, force: true });
        return null;
      });
    if (method === 'view.open') {
      const manifest = await this.enabled(p.id);
      const panel = manifest.contributes.panels.find(
        (panel) => panel.id === p.panel,
      );
      if (!panel || typeof p.view !== 'string' || p.view.length > 180)
        throw new Error('Unknown extension panel');
      await this.runtime.start(p.id, this.store.folder(p.id), manifest);
      this.views.set(p.view, p.id);
      const html = await readFile(
        path.join(this.store.folder(p.id), panel.entry),
        'utf8',
      );
      if (html.length > 2 * 1024 * 1024)
        throw new Error('Panel HTML exceeds 2 MiB');
      return html;
    }
    if (method === 'view.close') {
      const id = this.views.get(p.view);
      this.views.delete(p.view);
      if (id && ![...this.views.values()].includes(id))
        await this.runtime.stop(id);
      return null;
    }
    if (method === 'call') {
      const manifest = await this.enabled(p.id);
      return this.runtime.call(
        p.id,
        this.store.folder(p.id),
        manifest,
        p.method,
        p.params,
        signal,
      );
    }
    if (method === 'service')
      return this.service(p.id, await this.enabled(p.id), p.method, p.params);
    if (method === 'shutdown') {
      await this.runtime.close();
      return null;
    }
    throw new Error('Unknown extension host request');
  }
}

export async function controllerMain() {
  const [, , root, bundled] = process.argv;
  if (!root || !bundled)
    throw new Error(
      'Extension host requires data and bundled package directories',
    );
  const pendingServices = new Map();
  let seq = 0;
  const send = (message) =>
    process.stdout.write(JSON.stringify(message) + '\n');
  const controller = new ExtensionController(
    root,
    __filename,
    (extensionId, method, params) =>
      new Promise((resolve, reject) => {
        const id = `service-${++seq}`;
        const timer = setTimeout(() => {
          pendingServices.delete(id);
          reject(new Error('Native service timed out'));
        }, 15000);
        pendingServices.set(id, { resolve, reject, timer });
        send({ service: method, extensionId, params, id });
      }),
  );
  await controller.init(bundled);
  const requests = new Map();
  const input = createInterface({ input: process.stdin });
  input.on('line', async (line) => {
    let message;
    try {
      if (line.length > MAX_PACKAGE * 1.4)
        throw new Error('Host request is too large');
      message = JSON.parse(line);
      if (message.serviceResult) {
        const p = pendingServices.get(message.id);
        if (!p) return;
        pendingServices.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) p.reject(new Error(message.error));
        else p.resolve(message.result);
        return;
      }
      if (message.method === 'cancel') {
        requests.get(message.params?.id)?.abort();
        return;
      }
      if (
        typeof message.id !== 'string' ||
        message.id.length > 100 ||
        requests.has(message.id) ||
        requests.size >= 64
      )
        throw new Error('Invalid or excessive host requests');
      const abort = new AbortController();
      requests.set(message.id, abort);
      const result = await controller.request(
        message.method,
        message.params,
        abort.signal,
      );
      send({ id: message.id, result: result ?? null });
    } catch (e) {
      send({
        id: message?.id ?? null,
        error: e instanceof Error ? e.message : 'Extension host failure',
      });
    } finally {
      if (message?.id) requests.delete(message.id);
    }
  });
  const stop = async () => {
    await controller.runtime.close();
    process.exit(0);
  };
  input.on('close', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
