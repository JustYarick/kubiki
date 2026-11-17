import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Maintenance only: the generated WebP files are versioned; CI needs no ImageMagick.
const root = new URL('../', import.meta.url);
await mkdir(new URL('website/media/', root), { recursive: true });
for (const name of ['overview', 'resources', 'topology', 'yaml', 'agent']) {
  for (const small of [false, true]) {
    const input = fileURLToPath(new URL(`docs/media/${name}.png`, root));
    const output = fileURLToPath(new URL(`website/media/${name}${small ? '-960' : ''}.webp`, root));
    const result = spawnSync('magick', [input, ...(small ? ['-resize', '960x'] : []), '-strip', '-quality', small ? '90' : '94', output], { stdio: 'inherit' });
    if (result.error) throw new Error('Install ImageMagick to regenerate website screenshots.', { cause: result.error });
    if (result.status !== 0) throw new Error(`Image conversion failed: ${name}`);
  }
}
