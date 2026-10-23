import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateManifest } from '@kubiki/extension-sdk';
export async function buildExtension(
  folder,
  output = path.join(folder, 'dist'),
) {
  folder = path.resolve(folder);
  output = path.resolve(output);
  const manifest = validateManifest(
    JSON.parse(await readFile(path.join(folder, 'extension.json'), 'utf8')),
  );
  await mkdir(output, { recursive: true });
  const backend = await build({
    absWorkingDir: folder,
    entryPoints: ['src/backend.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    write: false,
    metafile: true,
    legalComments: 'inline',
  });
  const ui = await build({
    absWorkingDir: folder,
    entryPoints: ['src/panel.ts'],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    outfile: 'panel.js',
    jsx: 'automatic',
    loader: {
      '.svg': 'dataurl',
      '.png': 'dataurl',
      '.jpg': 'dataurl',
      '.woff2': 'dataurl',
    },
    write: false,
    metafile: true,
    legalComments: 'inline',
  });
  let css = '';
  try {
    css = await readFile(path.join(folder, 'src/panel.css'), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  css += ui.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
  // Panels are self-contained. The host supplies the CSP at display time.
  const javascript = ui.outputFiles.find((file) =>
    file.path.endsWith('.js'),
  ).text;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>${javascript.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  const files = {
    'extension.json': strToU8(JSON.stringify(manifest, null, 2)),
    [manifest.main]: backend.outputFiles[0].contents,
  };
  for (const panel of manifest.contributes.panels)
    files[panel.entry] = strToU8(html);
  let license = 'Extension dependencies retain their respective licenses.\n';
  try {
    license = await readFile(path.join(folder, 'LICENSE'), 'utf8');
  } catch {}
  files['LICENSE'] = strToU8(license);
  const notices = [],
    visited = new Set();
  for (const entry of new Set([
    ...Object.keys(backend.metafile.inputs),
    ...Object.keys(ui.metafile.inputs),
  ])) {
    let directory = path.dirname(path.resolve(folder, entry));
    while (directory !== path.dirname(directory)) {
      if (visited.has(directory)) break;
      visited.add(directory);
      let pkg;
      try {
        pkg = JSON.parse(
          await readFile(path.join(directory, 'package.json'), 'utf8'),
        );
      } catch {
        directory = path.dirname(directory);
        continue;
      }
      for (const filename of [
        'LICENSE',
        'LICENSE.md',
        'LICENSE.txt',
        'license',
        'COPYING',
      ]) {
        try {
          notices.push(
            `${pkg.name} ${pkg.version}\n${await readFile(path.join(directory, filename), 'utf8')}`,
          );
          break;
        } catch {}
      }
      break;
    }
  }
  files['THIRD-PARTY-LICENSES.txt'] = strToU8(notices.join('\n\n'));

  const bytes = zipSync(files, { level: 6 });
  const filename = `${manifest.id}-${manifest.version}.kubiki-extension`;
  await writeFile(path.join(output, filename), bytes);
  await writeFile(
    path.join(output, `${filename}.sha256`),
    `${createHash('sha256').update(bytes).digest('hex')}  ${filename}\n`,
  );
  return path.join(output, filename);
}
