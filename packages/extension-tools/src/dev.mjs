import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildExtension } from './build.mjs';
export async function develop(folder) {
  folder = path.resolve(folder);
  const temporary = await mkdtemp(path.join(tmpdir(), 'kubiki-extension-dev-'));
  const require = createRequire(import.meta.url);
  const { ExtensionController } = require('../dist/development.cjs');
  const secrets = new Map();
  const token = randomUUID();
  let revision = 0;
  let html = '';
  let extensionId = '';
  let error = '';
  let building = false;
  let again = false;
  const pending = new Map();
  const controller = new ExtensionController(
    path.join(temporary, 'data'),
    fileURLToPath(new URL('../dist/extension-host.cjs', import.meta.url)),
    async (id, method, p) => {
      if (method === 'notify') {
        console.log(`[${id}] ${p.message}`);
        return null;
      }
      const key = `${id}:${p.key}`;
      if (method === 'secrets.get') return secrets.get(key) ?? null;
      if (method === 'secrets.set') secrets.set(key, p.value);
      else if (method === 'secrets.delete') secrets.delete(key);
      return null;
    },
  );
  await controller.init();
  const rebuild = async () => {
    if (building) {
      again = true;
      return;
    }
    building = true;
    do {
      again = false;
      try {
        const file = await buildExtension(
          folder,
          path.join(temporary, 'build'),
        );
        await controller.runtime.close();
        if (extensionId && controller.store.entries[extensionId])
          await controller.request('uninstall', { id: extensionId });
        const manifest = JSON.parse(
          await readFile(path.join(folder, 'extension.json'), 'utf8'),
        );
        const preview = await controller.request('inspect.file', {
          data: (await readFile(file)).toString('base64'),
        });
        extensionId = await controller.request('install', {
          token: preview.token,
        });
        html = await controller.request('view.open', {
          id: extensionId,
          panel: manifest.contributes.panels[0].id,
          view: 'development',
        });
        error = '';
        revision++;
        console.log(`Built ${manifest.id} · revision ${revision}`);
      } catch (e) {
        error = e.message;
        console.error(error);
      }
    } while (again);
    building = false;
  };
  await rebuild();
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/revision') {
        response.end(String(revision));
        return;
      }
      if (
        request.method === 'POST' &&
        request.url === '/rpc' &&
        request.headers['x-kubiki-dev'] === token
      ) {
        let data = '';
        for await (const chunk of request) {
          data += chunk;
          if (data.length > 512 * 1024) throw Error('Request too large');
        }
        const p = JSON.parse(data);
        let result;
        if (p.type === 'cancel') {
          pending.get(p.id)?.abort();
          response.end('{}');
          return;
        }
        const abort = new AbortController();
        pending.set(p.id, abort);
        try {
          if (p.method === 'call')
            result = await controller.request(
              'call',
              { ...p.params, id: extensionId },
              abort.signal,
            );
          else if (
            ['settings.get', 'settings.set', 'notify'].includes(p.method)
          )
            result = await controller.request('service', {
              id: extensionId,
              method: p.method,
              params: p.params,
            });
          else throw Error('Unsupported panel request');
        } finally {
          pending.delete(p.id);
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ result }));
        return;
      }
      if (request.method !== 'GET' || request.url !== '/') {
        response.writeHead(404);
        response.end();
        return;
      }
      const embedded = JSON.stringify(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';img-src data:;connect-src 'none';form-action 'none'">${html}`,
      ).replace(/</g, '\\u003c');
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('Cache-Control', 'no-store');
      response.end(
        `<!doctype html><title>Kubiki extension development</title><style>body{margin:0;font:13px system-ui;background:#18181b;color:#ddd}header{padding:10px}iframe{width:100%;height:calc(100vh - 45px);border:0}</style><header>Development host · credentials are session-only · automatic reload</header><iframe sandbox="allow-scripts allow-forms" title="Development extension"></iframe><script>const frame=document.querySelector('iframe');frame.onload=()=>{const c=new MessageChannel();c.port1.onmessage=async({data:p})=>{try{const r=await(await fetch('/rpc',{method:'POST',headers:{'X-Kubiki-Dev':${JSON.stringify(token)}},body:JSON.stringify(p)})).json();c.port1.postMessage({id:p.id,...r});}catch(e){c.port1.postMessage({id:p.id,error:e.message});}};frame.contentWindow.postMessage({type:'kubiki:init',theme:{},visible:true},'*',[c.port2]);};frame.srcdoc=${embedded};setInterval(async()=>{if(Number(await(await fetch('/revision')).text())!==${revision})location.reload();},1500);</script>`,
      );
    } catch (e) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: e.message }));
    }
  });
  server.listen(0, '127.0.0.1', () =>
    console.log(
      `Open http://127.0.0.1:${server.address().port} · Ctrl+C to stop`,
    ),
  );
  let timer;
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 200);
  };
  const source = watch(path.join(folder, 'src'), { recursive: true }, onChange);
  const manifest = watch(path.join(folder, 'extension.json'), onChange);
  const stop = async () => {
    source.close();
    manifest.close();
    clearTimeout(timer);
    server.close();
    await controller.runtime.close();
    secrets.clear();
    await rm(temporary, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
