import { createHash } from 'node:crypto';
import { MAX_PACKAGE, unpackPackage } from './packages.mjs';
const HOSTS = new Set([
  'api.github.com',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
export function repository(input) {
  const url = new URL(input);
  const parts = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    parts.length < 2 ||
    !/^[\w.-]+$/.test(parts[0]) ||
    !/^[\w.-]+$/.test(parts[1])
  )
    throw new Error('Enter an HTTPS GitHub repository or release URL');
  if (
    parts.length !== 2 &&
    !(parts[2] === 'releases' && parts[3] === 'tag' && parts.length >= 5)
  )
    throw new Error('Use a repository URL or a specific release URL');
  return {
    repo: `${parts[0]}/${parts[1].replace(/\.git$/, '')}`,
    tag: parts.length > 2 ? decodeURIComponent(parts.slice(4).join('/')) : null,
  };
}
export async function download(url, signal, max = MAX_PACKAGE) {
  for (let redirects = 0; redirects < 6; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      !HOSTS.has(parsed.hostname) ||
      parsed.port ||
      parsed.username ||
      parsed.password
    )
      throw new Error('Unexpected GitHub download location');
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(20000),
      ]),
      headers: {
        'User-Agent': 'Kubiki-Extensions',
        Accept: 'application/vnd.github+json',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(response.headers.get('location'), url).href;
      await response.body?.cancel();
      continue;
    }
    if (!response.ok)
      throw new Error(
        response.status === 403 || response.status === 429
          ? 'GitHub request limit reached. Retry later; installed extensions remain available.'
          : `GitHub returned HTTP ${response.status}`,
      );
    if (Number(response.headers.get('content-length')) > max) {
      await response.body?.cancel();
      throw new Error('Download exceeds size limit');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) throw new Error('Download exceeds size limit');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many GitHub redirects');
}
export async function inspectGithub(input, signal) {
  const source = repository(input);
  const release = JSON.parse(
    (
      await download(
        `https://api.github.com/repos/${source.repo}/releases/${source.tag ? `tags/${encodeURIComponent(source.tag)}` : 'latest'}`,
        signal,
        1024 * 1024,
      )
    ).toString(),
  );
  if (release.draft || !Array.isArray(release.assets))
    throw new Error('No published extension release');
  const assets = release.assets.filter((a) =>
    a.name?.endsWith('.kubiki-extension'),
  );
  if (assets.length !== 1)
    throw new Error(
      'Release must contain exactly one .kubiki-extension package',
    );
  const asset = assets[0];
  let digest = asset.digest?.replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/i.test(digest ?? '')) {
    const checksum = release.assets.find(
      (a) => a.name === `${asset.name}.sha256`,
    );
    if (!checksum)
      throw new Error(
        'Publisher must provide a SHA-256 checksum alongside the package',
      );
    digest = (await download(checksum.browser_download_url, signal, 4096))
      .toString()
      .trim()
      .split(/\s+/)[0];
  }
  if (!/^[a-f0-9]{64}$/i.test(digest))
    throw new Error('Invalid package checksum');
  const bytes = await download(asset.browser_download_url, signal);
  if (createHash('sha256').update(bytes).digest('hex') !== digest.toLowerCase())
    throw new Error('Package checksum mismatch');
  const { manifest } = unpackPackage(bytes);
  return {
    manifest,
    bytes,
    source: { type: 'github', repo: source.repo.toLowerCase() },
    tag: release.tag_name,
    digest: digest.toLowerCase(),
  };
}
