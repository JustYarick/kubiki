import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import process from 'node:process';
import { createRequire } from 'node:module';
import { createK8sMiddleware } from './server/k8s_bridge.ts';
import { createHelmMiddleware } from './server/helm_bridge.ts';

const host = process.env.TAURI_DEV_HOST;
function k8sDevServerPlugin(): Plugin {
  return { name: 'k8s-dev-server-plugin', configureServer(server) {
    server.middlewares.use(createHelmMiddleware());
    server.middlewares.use(createK8sMiddleware());
  } };
}

export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), k8sDevServerPlugin()],
  // Lazy editor/graph chunks must share the renderer's React dispatcher in dev and desktop.
  resolve: {
    dedupe: ['react', 'react-dom'],
    // Monaco also vendors DOMPurify. Updating its npm dependency alone leaves
    // that vulnerable copy in the renderer; use the maintained ESM build instead.
    alias: [{ find: /^\.\/dompurify\/dompurify\.js$/, replacement: createRequire(import.meta.url).resolve('dompurify').replace(/purify\.cjs\.js$/, 'purify.es.mjs') }],
  },
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'elkjs/lib/elk-worker.min.js'] },
  clearScreen: false,
  server: {
    port: 1420, strictPort: true, host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
}));
