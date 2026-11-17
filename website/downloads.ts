export const RELEASES = 'https://github.com/JustYarick/kubiki/releases/latest';
export const RELEASE_API = 'https://api.github.com/repos/JustYarick/kubiki/releases/latest';
export type OS = 'macos' | 'windows' | 'linux';
export type Architecture = 'arm64' | 'x64';
export type Platform = { os: OS | null; arch: Architecture | null };
export type Download = { name: string; url: string; size: number; os: OS; arch: Architecture; format: string };
export type Release = { version: string; downloads: Download[] };

export function detectPlatform(ua: string, touchPoints = 0): Platform {
  if (/Android|iPhone|iPad|iPod|CrOS/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1)) return { os: null, arch: null };
  const os = /Windows/i.test(ua) ? 'windows' : /Macintosh|Mac OS X/i.test(ua) ? 'macos' : /Linux/i.test(ua) ? 'linux' : null;
  // macOS browsers often report Intel even on Apple Silicon. Ask rather than guess.
  const arch = os === 'macos' ? null : /aarch64|arm64/i.test(ua) ? 'arm64' : /x86_64|Win64|x64|amd64/i.test(ua) ? 'x64' : null;
  return { os, arch };
}

export function parseRelease(value: unknown): Release {
  if (!value || typeof value !== 'object') throw new Error('Invalid release');
  const release = value as Record<string, unknown>;
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !Array.isArray(release.assets)) throw new Error('No stable release');
  const downloads: Download[] = [];
  for (const asset of release.assets) {
    if (!asset || typeof asset !== 'object') continue;
    const { name, browser_download_url: url, size } = asset;
    if (typeof name !== 'string' || typeof url !== 'string' || typeof size !== 'number' || !Number.isFinite(size) || size < 0) continue;
    const prefix = `https://github.com/JustYarick/kubiki/releases/download/${release.tag_name}/`;
    if (url !== `${prefix}${encodeURIComponent(name)}`) continue;
    const format = name.endsWith('.dmg') ? 'DMG' : name.endsWith('-setup.exe') ? 'EXE' : name.endsWith('.msi') ? 'MSI' : name.endsWith('.AppImage') ? 'AppImage' : name.endsWith('.deb') ? 'DEB' : name.endsWith('.rpm') ? 'RPM' : null;
    if (!format || !/^kubiki[_-]\d/.test(name)) continue;
    const arch = /(?:^|[_\-.])(aarch64|arm64)(?:[_\-.]|$)/i.test(name) ? 'arm64' : /(?:^|[_\-.])(amd64|x86_64|x64)(?:[_\-.]|$)/i.test(name) ? 'x64' : null;
    if (!arch) continue;
    const os = format === 'DMG' ? 'macos' : format === 'EXE' || format === 'MSI' ? 'windows' : 'linux';
    downloads.push({ name, url, size, os, arch, format });
  }
  return { version: release.tag_name, downloads };
}

export function preferredDownload(release: Release | null, platform: Platform): Download | undefined {
  const rank = ['DMG', 'EXE', 'AppImage', 'DEB', 'RPM', 'MSI'];
  return release?.downloads.filter(item => item.os === platform.os && item.arch === platform.arch)
    .sort((a, b) => rank.indexOf(a.format) - rank.indexOf(b.format))[0];
}
