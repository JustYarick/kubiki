#!/usr/bin/env node
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension } from './build.mjs';
const [command, folder, ...options] = process.argv.slice(2);
try {
  if (command === 'init' && folder) {
    const target = path.resolve(folder);
    await mkdir(target); // Existing directories are never overwritten.
    await cp(fileURLToPath(new URL('../template', import.meta.url)), target, {
      recursive: true,
    });
    const file = path.join(target, 'package.json');
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    if (options[0] === '--sdk' && options[1])
      pkg.dependencies['@kubiki/extension-sdk'] =
        `file:${path.resolve(options[1])}`;
    await writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
    console.log(
      `Created ${target}. Install dependencies, then run kubiki-extension pack ${target}.`,
    );
  } else if (command === 'dev' && folder)
    await (await import('./dev.mjs')).develop(folder);
  else if (['pack', 'build'].includes(command) && folder)
    console.log(await buildExtension(folder));
  else
    throw new Error(
      'Usage: kubiki-extension init <new-folder> [--sdk sdk.tgz] | pack <folder> | dev <folder>',
    );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
