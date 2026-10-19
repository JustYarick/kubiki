import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const host = process.env.TAURI_DEV_HOST;
const resources: Record<string, string> = {
  Pod: 'pods', Deployment: 'deployments', ReplicaSet: 'replicasets', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets',
  Job: 'jobs', CronJob: 'cronjobs', Service: 'services', Ingress: 'ingresses', ConfigMap: 'configmaps', Secret: 'secrets',
  PersistentVolumeClaim: 'persistentvolumeclaims', PersistentVolume: 'persistentvolumes', StorageClass: 'storageclasses',
  Node: 'nodes', Namespace: 'namespaces', Event: 'events', CustomResourceDefinition: 'customresourcedefinitions',
};
const clusterScoped = new Set(['Node', 'Namespace', 'PersistentVolume', 'StorageClass', 'CustomResourceDefinition']);

function k8sDevServerPlugin(): Plugin {
  return { name: 'k8s-dev-server-plugin', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/api/k8s/')) return next();
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Content-Type', 'application/json');
      const send = (data: unknown) => res.end(JSON.stringify(data));
      // No shell interpolation: names/contexts are passed as literal argv entries.
      const kubectl = async (args: string[]) => (await execFileAsync('kubectl', [...args, '--request-timeout=10s'], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 })).stdout;
      const context = url.searchParams.get('context');
      const contextArgs = context ? ['--context', context] : [];
      try {
        if (url.pathname === '/api/k8s/contexts' && req.method === 'GET') {
          const data = JSON.parse(await kubectl(['config', 'view', '-o', 'json']));
          return send((data.contexts ?? []).map((c: any) => ({ name: c.name, cluster: c.context?.cluster, user: c.context?.user, namespace: c.context?.namespace, is_current: c.name === data['current-context'] })));
        }
        if (!context) throw new Error('A Kubernetes context is required');
        if (url.pathname === '/api/k8s/ping' && req.method === 'GET') {
          const data = JSON.parse(await kubectl([...contextArgs, 'version', '-o', 'json']));
          if (!data.serverVersion) throw new Error('The API server did not return its version');
          return send({ status: 'connected', version: data.serverVersion });
        }
        if (url.pathname === '/api/k8s/namespaces' && req.method === 'GET') {
          const data = JSON.parse(await kubectl([...contextArgs, 'get', 'namespaces', '-o', 'json']));
          return send((data.items ?? []).map((ns: any) => ns.metadata.name));
        }
        if (url.pathname === '/api/k8s/resources' && req.method === 'GET') {
          const kind = url.searchParams.get('kind') ?? '';
          const plural = resources[kind];
          if (!plural) throw new Error(`Unsupported resource kind: ${kind}`);
          const namespace = url.searchParams.get('namespace');
          const nsArgs = clusterScoped.has(kind) ? [] : namespace && namespace !== 'all' ? ['-n', namespace] : ['-A'];
          const data = await kubectl([...contextArgs, 'get', plural, ...nsArgs, '-o', 'json']);
          return res.end(data);
        }
        if (url.pathname === '/api/k8s/logs' && req.method === 'GET') {
          const name = url.searchParams.get('name');
          const namespace = url.searchParams.get('namespace');
          const container = url.searchParams.get('container');
          if (!name || !namespace) throw new Error('Pod name and namespace are required');
          return send(await kubectl([...contextArgs, 'logs', `pod/${name}`, '-n', namespace, ...(container ? ['-c', container] : []), '--tail=500', '--timestamps=true']));
        }
        if (url.pathname === '/api/k8s/scale' && req.method === 'POST') {
          if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) { res.statusCode = 403; return send({ error: 'Cross-origin mutations are forbidden' }); }
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('Request body too large'); }
          const { kind, name, namespace, replicas, context: targetContext } = JSON.parse(body);
          if (!['Deployment', 'StatefulSet'].includes(kind) || !Number.isInteger(replicas) || replicas < 0 || replicas > 100000 || !name || !namespace || targetContext !== context) throw new Error('Invalid scale request');
          await kubectl([...contextArgs, 'scale', resources[kind], String(name), '-n', String(namespace), `--replicas=${replicas}`]);
          return send({ success: true });
        }
        res.statusCode = 404;
        return send({ error: 'Endpoint not found' });
      } catch (error) {
        res.statusCode = 500;
        return send({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  } };
}

export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), k8sDevServerPlugin()],
  // Lazy editor/graph chunks must share the renderer's React dispatcher in dev and desktop.
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'] },
  clearScreen: false,
  server: {
    port: 1420, strictPort: true, host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
}));
