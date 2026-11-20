import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopRelease, updateChannel } from './desktop-release.mjs';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract the Keep a Changelog section and reference link for a heading (e.g. `1.4.0` or `Unreleased`). */
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

  const linkPattern = new RegExp(`^\\[${escapeRegExp(version)}\\]:\\s+(\\S+)\\s*$`, 'mi');
  const compareUrl = linkPattern.exec(normalized)?.[1] ?? null;
  return { version, date, body, compareUrl };
}

function resolveChangelogSection(changelog, tag) {
  const release = desktopRelease(tag);
  const channel = updateChannel(tag);
  if (channel === 'stable') {
    const section = extractChangelogSection(changelog, release.version);
    return section ? { release, channel, section } : null;
  }
  if (channel === 'dev') {
    const section = extractChangelogSection(changelog, 'Unreleased');
    if (!section) return null;
    const compareUrl = section.compareUrl
      ? section.compareUrl.replace(/\.\.\.HEAD$/, `...${tag}`)
      : null;
    return { release, channel, section: { ...section, compareUrl } };
  }
  return null;
}

/** Build the canonical GitHub Release summary for stable (vX.Y.Z) and dev (vX.Y.Z-dev.N) tags from docs/CHANGELOG.md. */
export function formatReleaseNotes(changelog, tag) {
  const resolved = resolveChangelogSection(changelog, tag);
  if (!resolved) return null;
  const { release, channel, section } = resolved;

  const blocks = channel === 'dev'
    ? [
        `## Kubiki ${release.version} (Dev Preview)`,
        '> Development preview build from `dev` containing accumulated unreleased changes targeting the next stable release.',
        section.body,
      ]
    : [
        `## Kubiki ${release.version}`,
        section.body,
      ];

  blocks.push([
    '### Release Artifacts',
    '',
    '- Desktop packages: Linux x64/ARM64 (DEB, RPM, AppImage), macOS Apple Silicon/Intel (DMG and updater `.app.tar.gz`), Windows x64 (NSIS EXE, MSI) and Windows ARM64 (NSIS EXE).',
    '- Verification & updates: `SHA256SUMS`, signed updater manifest `latest.json`, and advisory `VIRUSTOTAL-REPORT.md` / `VIRUSTOTAL-REPORT.json`.',
  ].join('\n'));

  if (section.compareUrl) {
    blocks.push(`**Full Changelog**: ${section.compareUrl}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

/** Extract clean changelog notes for the in-app updater manifest (`latest.json`). */
export function formatUpdaterNotes(changelog, tag) {
  const resolved = resolveChangelogSection(changelog, tag);
  if (!resolved) return null;
  return resolved.section.body;
}

async function readChangelog(root = process.cwd()) {
  try {
    return await readFile(path.join(root, 'docs/CHANGELOG.md'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadReleaseNotes(tag, root = process.cwd()) {
  if (!updateChannel(tag)) return null;
  const changelog = await readChangelog(root);
  if (!changelog) return null;
  return formatReleaseNotes(changelog, tag);
}

export async function loadUpdaterNotes(tag, root = process.cwd()) {
  if (!updateChannel(tag)) return null;
  const changelog = await readChangelog(root);
  if (!changelog) return null;
  return formatUpdaterNotes(changelog, tag);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2];
  if (!tag) {
    console.error('Usage: node scripts/release-notes.mjs <vX.Y.Z|vX.Y.Z-dev.N>');
    process.exit(1);
  }
  const notes = await loadReleaseNotes(tag);
  if (!notes) {
    console.error(`No changelog entry found in docs/CHANGELOG.md for ${tag}.`);
    process.exit(1);
  }
  process.stdout.write(notes);
}
