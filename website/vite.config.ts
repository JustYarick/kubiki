import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/website', import.meta.url)),
    emptyOutDir: true,
  },
});
