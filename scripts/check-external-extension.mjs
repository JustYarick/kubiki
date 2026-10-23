import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = process.cwd();
const temporary = await mkdtemp(path.join(tmpdir(), 'kubiki-independent-sdk-'));
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
try {
  const destination = path.join(root, '.kubiki-build/sdk');
  for (const name of ['extension-sdk', 'extension-tools'])
    run('pnpm', [
      '--filter',
      `@kubiki/${name}`,
      'pack',
      '--pack-destination',
      destination,
    ]);
  const project = path.join(temporary, 'independent');
  run(process.execPath, [
    'packages/extension-tools/src/cli.mjs',
    'init',
    project,
    '--sdk',
    path.join(destination, 'kubiki-extension-sdk-0.1.0.tgz'),
  ]);
  const file = path.join(project, 'package.json');
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  pkg.devDependencies['@kubiki/extension-tools'] =
    `file:${path.join(destination, 'kubiki-extension-tools-0.1.0.tgz')}`;
  await writeFile(file, JSON.stringify(pkg));
  const panel = path.join(project, 'src/panel.ts');
  await writeFile(
    panel,
    "import './extra.css';\n" + (await readFile(panel, 'utf8')),
  );
  await writeFile(
    path.join(project, 'src/extra.css'),
    'body { --sdk-css-check: 1; }',
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--package-lock=false',
      '--no-audit',
      '--no-fund',
    ],
    project,
  );
  run('npm', ['run', 'build'], project);
  const { unpackPackage } = await import(
    '../packages/extension-host/src/packages.mjs'
  );
  const parsed = unpackPackage(
    await readFile(
      path.join(project, 'dist/example.hello-0.1.0.kubiki-extension'),
    ),
  );
  if (parsed.manifest.id !== 'example.hello')
    throw Error('External template package failed validation');
  if (
    !Buffer.from(parsed.files['ui/index.html'])
      .toString()
      .includes('--sdk-css-check')
  )
    throw Error('Imported panel CSS was not bundled');
  console.log(
    'External template builds with packaged SDK/tools and no application source imports.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
