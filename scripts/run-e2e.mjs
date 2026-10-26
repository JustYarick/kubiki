import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const fullLayout = args.includes('--full-layout');
const result = spawnSync(process.execPath, [createRequire(import.meta.url).resolve('@playwright/test/cli'),
  'test', ...args.filter(arg => arg !== '--full-layout')], {
  stdio: 'inherit', env: { ...process.env, ...(fullLayout ? { E2E_FULL_LAYOUT: '1' } : {}) },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
