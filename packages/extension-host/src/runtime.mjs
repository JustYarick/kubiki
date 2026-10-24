import { fork } from 'node:child_process';
export class Runtime {
  constructor(script, service, timeoutMs = 30000) {
    this.script = script;
    this.service = service;
    this.timeoutMs = timeoutMs;
    this.hosts = new Map();
    this.logs = new Map();
    this.errors = new Map();
  }
  log(id, value) {
    const list = this.logs.get(id) ?? [];
    list.push(String(value).slice(0, 2000));
    this.logs.set(id, list.slice(-100));
  }
  async start(id, folder, manifest, canStart) {
    if (canStart && !canStart())
      throw new Error('Extension is disabled or unavailable');
    if (this.hosts.has(id)) return this.hosts.get(id).ready;
    const child = fork(
      this.script,
      ['--worker', folder, JSON.stringify(manifest)],
      {
        execArgv: ['--max-old-space-size=192'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          TEMP: process.env.TEMP ?? '',
          TMPDIR: process.env.TMPDIR ?? '',
        },
      },
    );
    const host = { child, pending: new Map(), stopping: false, sequence: 0 };
    this.hosts.set(id, host);
    this.errors.delete(id);
    host.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Extension activation timed out'));
        child.kill();
      }, 15000);
      host.rejectReady = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.on('message', async (message) => {
        if (message.ready) {
          clearTimeout(timer);
          resolve(host);
          return;
        }
        if (message.failed) {
          host.rejectReady(new Error(message.failed));
          child.kill();
          return;
        }
        if (message.service) {
          try {
            const result = await this.service(
              id,
              manifest,
              message.service,
              message.params,
            );
            if (child.connected)
              child.send({ serviceResult: true, id: message.id, result });
          } catch (e) {
            if (child.connected)
              child.send({
                serviceResult: true,
                id: message.id,
                error: e.message,
              });
          }
          return;
        }
        const p = host.pending.get(message.id);
        if (!p) return;
        host.pending.delete(message.id);
        p.cleanup();
        if (message.error) p.reject(new Error(message.error));
        else p.resolve(message.result);
      });
    });
    // Always consume readiness rejection, including failure before the first caller awaits it.
    host.ready.catch(() => {});
    const failed = (error) => {
      host.rejectReady(error);
      for (const p of host.pending.values()) {
        p.cleanup();
        p.reject(error);
      }
      host.pending.clear();
      if (this.hosts.get(id) === host) this.hosts.delete(id);
      if (!host.stopping) this.errors.set(id, error.message);
      this.log(id, error.message);
    };
    child.on('error', failed);
    child.on('exit', (code, signal) =>
      failed(
        new Error(
          host.stopping
            ? 'Extension stopped'
            : `Extension host exited (${signal ?? code})`,
        ),
      ),
    );
    child.stdout.on('data', (data) => this.log(id, data.toString()));
    child.stderr.on('data', (data) => this.log(id, data.toString()));
    return host.ready;
  }
  async call(id, folder, manifest, method, params, signal, canStart) {
    if (!/^[a-z][a-zA-Z0-9.]{0,79}$/.test(method))
      throw new Error('Invalid extension method');
    const host = await this.start(id, folder, manifest, canStart);
    signal?.throwIfAborted();
    if (host.pending.size >= 32) throw new Error('Too many extension requests');
    return new Promise((resolve, reject) => {
      const request = ++host.sequence;
      const abort = () => {
        if (!host.pending.delete(request)) return;
        cleanup();
        if (host.child.connected) host.child.send({ cancel: request });
        reject(new Error('Extension request cancelled'));
      };
      const timer = setTimeout(() => {
        abort();
        void this.stop(id);
        this.errors.set(
          id,
          'Extension request timed out; restart the extension',
        );
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      signal?.addEventListener('abort', abort, { once: true });
      host.pending.set(request, { resolve, reject, cleanup });
      host.child.send({ id: request, method, params });
    });
  }
  async stop(id) {
    const host = this.hosts.get(id);
    if (!host) return;
    host.stopping = true;
    this.hosts.delete(id);
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        host.child.kill('SIGKILL');
        resolve();
      }, 1500);
      host.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (host.child.connected) host.child.send({ stop: true });
      else host.child.kill();
    });
  }
  async close() {
    await Promise.all([...this.hosts.keys()].map((id) => this.stop(id)));
  }
}
