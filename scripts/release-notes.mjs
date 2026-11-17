import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopRelease } from './desktop-release.mjs';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract the Keep a Changelog section and reference link for a released version. */
export function extractChangelogSection(changelog, version) {
  const normalized = changelog.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const headingPattern = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s+-\\s+(\\d{4}-\\d{2}-\\d{2}))?\\s*$`);
  const startIndex = lines.findIndex(line => headingPattern.test(line));
  if (startIndex < 0) return null;

  const date = headingPattern.exec(lines[startIndex])?.[1] ?? null;
  const bodyLines = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^## \[/.test(line) || /^\[[^\]]+\]:\s+\S+/.test(line)) break;
    bodyLines.push(line);
  }
  const body = bodyLines.join('\n').trim();
  if (!body) return null;

  const linkPattern = new RegExp(`^\\[${escapeRegExp(version)}\\]:\\s+(\\S+)\\s*$`, 'm');
  const compareUrl = linkPattern.exec(normalized)?.[1] ?? null;
  return { version, date, body, compareUrl };
}

/** Build the canonical GitHub Release summary for a stable tag from docs/CHANGELOG.md. */
export function formatReleaseNotes(changelog, tag) {
  const release = desktopRelease(tag);
  if (release.prerelease) return null;
  const section = extractChangelogSection(changelog, release.version);
  if (!section) return null;

  const blocks = [
    `## Kubiki ${release.version}`,
    section.body,
    [
      '### Release Artifacts',
      '',
      '- Desktop packages: Linux (DEB, RPM, AppImage), macOS (ARM64/x64 DMG and updater `.app.tar.gz`), Windows (NSIS EXE, MSI), and standalone `kubiki-cli` binaries.',
      '- Verification & updates: `SHA256SUMS`, signed updater manifest `latest.json`, and advisory `VIRUSTOTAL-REPORT.md` / `VIRUSTOTAL-REPORT.json`.',
    ].join('\n'),
  ];
  if (section.compareUrl) {
    blocks.push(`**Full Changelog**: ${section.compareUrl}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

export async function loadReleaseNotes(tag, root = process.cwd()) {
  const release = desktopRelease(tag);
  if (release.prerelease) return null;
  let changelog;
  try {
    changelog = await readFile(path.join(root, 'docs/CHANGELOG.md'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return formatReleaseNotes(changelog, tag);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2];
  if (!tag) {
    console.error('Usage: node scripts/release-notes.mjs <vX.Y.Z>');
    process.exit(1);
  }
  const notes = await loadReleaseNotes(tag);
  if (!notes) {
    console.error(`No stable changelog entry found in docs/CHANGELOG.md for ${tag}.`);
    process.exit(1);
  }
  process.stdout.write(notes);
}
