import { build } from 'esbuild';
import './build-extension-tools.mjs';
import { mkdir, copyFile, rm, readFile, writeFile } from 'node:fs/promises';
import { buildExtension } from '../packages/extension-tools/src/build.mjs';
await rm('.kubiki-build/extensions', { recursive: true, force: true });
await mkdir('.kubiki-build/extensions', { recursive: true });
await build({
  entryPoints: ['packages/extension-host/src/entry.mjs'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: '.kubiki-build/extension-host.cjs',
});
const diagnostic = await buildExtension(
  'extensions/sdk-test',
  '.kubiki-build/packages',
);
await copyFile(
  diagnostic,
  '.kubiki-build/extensions/sdk-test.kubiki-extension',
);
await mkdir('.kubiki-build/runtime', { recursive: true });
const licenses = [];
for (const [name, file] of [
  ['fflate', 'node_modules/fflate/LICENSE'],
  ['semver', 'node_modules/semver/LICENSE'],
  ['Kubiki SDK', 'LICENSE'],
])
  licenses.push(name + '\n' + (await readFile(file, 'utf8')));
await writeFile(
  '.kubiki-build/runtime/HOST-LICENSES.txt',
  licenses.join('\n\n'),
);
console.log('Built extension host and bundled SDK diagnostics');
