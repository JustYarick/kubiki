import { createRequire } from 'node:module';
export async function workerMain(folder, manifest) {
  const pending = new Map();
  const active = new Map();
  let sequence = 0;
  let backend;
  const subscriptions = [];
  let stopping = false;
  const service = (method, params) =>
    new Promise((resolve, reject) => {
      if (!process.connected) {
        reject(new Error('Host disconnected'));
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Host service timed out'));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      process.send({ service: method, params, id });
    });
  const context = {
    subscriptions,
    settings: {
      get: (key) => service('settings.get', { key }),
      set: (key, value) => service('settings.set', { key, value }),
    },
    secrets: {
      get: (key) => service('secrets.get', { key }),
      set: (key, value) => service('secrets.set', { key, value }),
      delete: (key) => service('secrets.delete', { key }),
    },
    notify: (message) => service('notify', { message }),
  };
  const send = (value) => {
    const json = JSON.stringify(value);
    process.send(
      json.length < 1024 * 1024
        ? value
        : { id: value.id, error: 'Extension response exceeds 1 MiB' },
    );
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(0), 1400);
    deadline.unref();
    for (const controller of active.values()) controller.abort();
    try {
      for (const disposable of subscriptions.reverse())
        await disposable.dispose();
      await backend?.deactivate?.();
    } finally {
      process.exit(0);
    }
  };
  process.on('disconnect', stop);
  process.on('SIGTERM', stop);
  process.on('message', async (message) => {
    if (message.serviceResult) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error) p.reject(new Error(message.error));
      else p.resolve(message.result);
      return;
    }
    if (message.cancel) {
      active.get(message.cancel)?.abort();
      return;
    }
    if (message.stop) {
      await stop();
      return;
    }
    const abort = new AbortController();
    active.set(message.id, abort);
    try {
      if (
        !backend?.methods ||
        !Object.hasOwn(backend.methods, message.method) ||
        typeof backend.methods[message.method] !== 'function'
      )
        throw new Error('Unknown extension method');
      const result = await backend.methods[message.method](
        message.params ?? null,
        { signal: abort.signal },
      );
      send({ id: message.id, result: result ?? null });
    } catch (e) {
      send({
        id: message.id,
        error: e instanceof Error ? e.message : 'Extension request failed',
      });
    } finally {
      active.delete(message.id);
    }
  });
  try {
    const module = createRequire(folder + '/extension.json')(
      folder + '/' + manifest.main,
    );
    if (typeof module.activate !== 'function')
      throw new Error('Backend must export activate(context)');
    backend = await module.activate(context);
    process.send({ ready: true });
  } catch (e) {
    process.send({ failed: String(e.message ?? e) });
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100);
  }
}
