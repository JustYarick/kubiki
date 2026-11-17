import { describe, expect, it } from 'vitest';
import { detectPlatform, parseRelease, preferredDownload } from '../../website/downloads';

function fixture(names: string[]) {
  return { tag_name: 'v1.4.0', draft: false, prerelease: false, assets: names.map(name => ({ name, size: 100_000_000, browser_download_url: `https://github.com/JustYarick/kubiki/releases/download/v1.4.0/${encodeURIComponent(name)}` })) };
}
const release = parseRelease(fixture([
  'kubiki_1.4.0_aarch64.dmg', 'kubiki_1.4.0_x64.dmg',
  'kubiki_1.4.0_x64-setup.exe', 'kubiki_1.4.0_x64_en-US.msi',
  'kubiki_1.4.0_amd64.AppImage', 'kubiki_1.4.0_amd64.deb', 'kubiki-1.4.0-1.x86_64.rpm',
  'kubiki-cli-windows-amd64.exe', 'kubiki_1.4.0_x64-setup.exe.sig', 'kubiki_aarch64.app.tar.gz', 'latest.json',
]));

describe('website release downloads', () => {
  it('offers installers rather than CLI executables, signatures or updater archives', () => {
    expect(release.downloads).toHaveLength(7);
    expect(preferredDownload(release, { os: 'macos', arch: 'arm64' })?.name).toBe('kubiki_1.4.0_aarch64.dmg');
    expect(preferredDownload(release, { os: 'macos', arch: 'x64' })?.name).toBe('kubiki_1.4.0_x64.dmg');
    expect(preferredDownload(release, { os: 'windows', arch: 'x64' })?.format).toBe('EXE');
    expect(preferredDownload(release, { os: 'linux', arch: 'x64' })?.format).toBe('AppImage');
    expect(release.downloads.find(item => item.format === 'RPM')?.arch).toBe('x64');
  });
  it('never substitutes an unavailable or unknown architecture', () => {
    expect(preferredDownload(release, { os: 'windows', arch: 'arm64' })).toBeUndefined();
    expect(preferredDownload(release, { os: 'macos', arch: null })).toBeUndefined();
  });
  it('rejects prereleases, drafts and malformed data', () => {
    expect(() => parseRelease({ ...fixture([]), prerelease: true })).toThrow();
    expect(() => parseRelease({ ...fixture([]), draft: true })).toThrow();
    expect(() => parseRelease({ ...fixture([]), tag_name: 'v1.5.0-dev.1' })).toThrow();
    expect(() => parseRelease(null)).toThrow();
  });
  it('ignores asset URLs outside the exact repository release and invalid sizes', () => {
    const data = fixture(['kubiki_1.4.0_x64.dmg']);
    data.assets[0].browser_download_url = 'https://example.com/kubiki_1.4.0_x64.dmg';
    expect(parseRelease(data).downloads).toEqual([]);
    data.assets[0].browser_download_url = 'https://github.com/JustYarick/kubiki/releases/download/v1.3.0/kubiki_1.4.0_x64.dmg';
    expect(parseRelease(data).downloads).toEqual([]);
    expect(parseRelease({ ...fixture(['kubiki_1.4.0_x64.dmg']), assets: [null] }).downloads).toEqual([]);
  });
  it('detects desktop platforms conservatively and excludes mobile devices', () => {
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toEqual({ os: 'linux', arch: 'x64' });
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toEqual({ os: 'windows', arch: 'x64' });
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toEqual({ os: 'macos', arch: null });
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5).os).toBeNull();
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; ARM64)').os).toBeNull();
    expect(detectPlatform('unknown')).toEqual({ os: null, arch: null });
  });
});
