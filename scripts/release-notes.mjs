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

/**
 * Promote non-empty `## [Unreleased]` entries to a stable `## [X.Y.Z] - YYYY-MM-DD` section
 * when `## [X.Y.Z]` has not been created yet, leaving a fresh empty `## [Unreleased]` heading
 * and updating the bottom comparison links.
 */
export function promoteUnreleasedChangelog(changelog, tag, date = new Date().toISOString().slice(0, 10)) {
  if (updateChannel(tag) !== 'stable') return null;
  const release = desktopRelease(tag);
  const version = release.version;
  const eol = changelog.includes('\r\n') ? '\r\n' : '\n';
  const normalized = changelog.replace(/\r\n/g, '\n');

  const existingHeading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, 'm');
  if (existingHeading.test(normalized)) return null;

  const unreleased = extractChangelogSection(normalized, 'Unreleased');
  if (!unreleased) return null;

  const headingPattern = /^## \[Unreleased\][ \t]*\n+/m;
  if (!headingPattern.test(normalized)) return null;
  let updated = normalized.replace(
    headingPattern,
    `## [Unreleased]\n\n## [${version}] - ${date}\n\n`,
  );

  let compareUrl = null;
  const unreleasedLinkPattern = /^(\[unreleased\]:[ \t]+)(https?:\/\/\S+\/compare\/)([^/\s]+)\.\.\.HEAD[ \t]*$/mi;
  const versionLinkPattern = new RegExp(`^\\[${escapeRegExp(version)}\\]:\\s+\\S+\\s*$`, 'mi');
  const linkMatch = unreleasedLinkPattern.exec(updated);
  if (linkMatch) {
    const [, prefix, base, previousRef] = linkMatch;
    compareUrl = `${base}${previousRef}...${tag}`;
    const replacement = versionLinkPattern.test(updated)
      ? `${prefix}${base}${tag}...HEAD`
      : `${prefix}${base}${tag}...HEAD\n[${version}]: ${compareUrl}`;
    updated = updated.replace(unreleasedLinkPattern, replacement);
  }

  return {
    version,
    date,
    compareUrl,
    changelog: eol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated,
  };
}

function resolveChangelogSection(changelog, tag, { fallbackToUnreleased = false } = {}) {
  const release = desktopRelease(tag);
  const channel = updateChannel(tag);
  if (channel === 'stable') {
    const section = extractChangelogSection(changelog, release.version);
    if (section) return { release, channel, section, promotedFromUnreleased: false };
    if (!fallbackToUnreleased) return null;
    const unreleased = extractChangelogSection(changelog, 'Unreleased');
    if (!unreleased) return null;
    const compareUrl = unreleased.compareUrl
      ? unreleased.compareUrl.replace(/\.\.\.HEAD$/, `...${tag}`)
      : null;
    return { release, channel, section: { ...unreleased, version: release.version, compareUrl }, promotedFromUnreleased: true };
  }
  if (channel === 'dev') {
    const section = extractChangelogSection(changelog, 'Unreleased');
    if (!section) return null;
    const compareUrl = section.compareUrl
      ? section.compareUrl.replace(/\.\.\.HEAD$/, `...${tag}`)
      : null;
    return { release, channel, section: { ...section, compareUrl }, promotedFromUnreleased: false };
  }
  return null;
}

/** Build the canonical GitHub Release summary for stable (vX.Y.Z) and dev (vX.Y.Z-dev.N) tags from docs/CHANGELOG.md. */
export function formatReleaseNotes(changelog, tag, options = {}) {
  const resolved = resolveChangelogSection(changelog, tag, options);
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
export function formatUpdaterNotes(changelog, tag, options = {}) {
  const resolved = resolveChangelogSection(changelog, tag, options);
  if (!resolved) return null;
  return resolved.section.body;
}

export async function readChangelog(root = process.cwd()) {
  try {
    return await readFile(path.join(root, 'docs/CHANGELOG.md'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadReleaseNotes(tag, root = process.cwd(), options = {}) {
  if (!updateChannel(tag)) return null;
  const changelog = await readChangelog(root);
  if (!changelog) return null;
  return formatReleaseNotes(changelog, tag, options);
}

export async function loadUpdaterNotes(tag, root = process.cwd(), options = {}) {
  if (!updateChannel(tag)) return null;
  const changelog = await readChangelog(root);
  if (!changelog) return null;
  return formatUpdaterNotes(changelog, tag, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const fallbackToUnreleased = args.includes('--fallback-unreleased');
  const tag = args.find(arg => !arg.startsWith('--'));
  if (!tag) {
    console.error('Usage: node scripts/release-notes.mjs <vX.Y.Z|vX.Y.Z-dev.N> [--fallback-unreleased]');
    process.exit(1);
  }
  const notes = await loadReleaseNotes(tag, process.cwd(), { fallbackToUnreleased });
  if (!notes) {
    console.error(`No changelog entry found in docs/CHANGELOG.md for ${tag}.`);
    process.exit(1);
  }
  process.stdout.write(notes);
}
