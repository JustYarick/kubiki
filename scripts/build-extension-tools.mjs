import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'packages/extension-tools/dist'), {
  recursive: true,
});
for (const [entry, file] of [
  ['controller', 'development'],
  ['entry', 'extension-host'],
])
  await build({
    absWorkingDir: root,
    entryPoints: [`packages/extension-host/src/${entry}.mjs`],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: path.join(root, `packages/extension-tools/dist/${file}.cjs`),
  });
