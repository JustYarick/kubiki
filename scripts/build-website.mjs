import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = new URL('../', import.meta.url);
await build({ configFile: fileURLToPath(new URL('website/vite.config.ts', root)) });
await writeFile(new URL('dist/website/.nojekyll', root), '');
