import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractChangelogSection, formatReleaseNotes, loadReleaseNotes } from '../../scripts/release-notes.mjs';

const SAMPLE_CHANGELOG = `# Changelog

## [Unreleased]

### Added
- Pending work

## [1.4.0] - 2026-11-17

### Added
- Loopback HTTP MCP server.

### Fixed
- Partial namespace read handling.

## [1.3.1] - 2026-11-12

### Fixed
- Earlier fix.

[unreleased]: https://github.com/JustYarick/kubiki/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/JustYarick/kubiki/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/JustYarick/kubiki/compare/v1.3.0...v1.3.1
`;

test('formatReleaseNotes builds the canonical stable GitHub Release summary', () => {
  const notes = formatReleaseNotes(SAMPLE_CHANGELOG, 'v1.4.0');
  assert.ok(notes);
  assert.match(notes, /^## Kubiki 1\.4\.0\n\n### Added\n- Loopback HTTP MCP server\.\n\n### Fixed\n- Partial namespace read handling\./);
  assert.match(notes, /### Release Artifacts/);
  assert.match(notes, /\*\*Full Changelog\*\*: https:\/\/github\.com\/JustYarick\/kubiki\/compare\/v1\.3\.1\.\.\.v1\.4\.0\n$/);
  assert.doesNotMatch(notes, /Pending work/);
  assert.doesNotMatch(notes, /Earlier fix/);
});

test('formatReleaseNotes skips prereleases and missing versions', () => {
  assert.equal(formatReleaseNotes(SAMPLE_CHANGELOG, 'v1.4.0-dev.39'), null);
  assert.equal(formatReleaseNotes(SAMPLE_CHANGELOG, 'v1.4.0-rc.1'), null);
  assert.equal(formatReleaseNotes(SAMPLE_CHANGELOG, 'v9.9.9'), null);
  assert.equal(extractChangelogSection('## [1.4.0] - 2026-11-17\n\n## [1.3.1] - 2026-11-12\n', '1.4.0'), null);
});

test('loadReleaseNotes reads docs/CHANGELOG.md and ignores missing files', async () => {
  const repoNotes = await loadReleaseNotes('v1.4.0');
  assert.ok(repoNotes);
  assert.match(repoNotes, /^## Kubiki 1\.4\.0/);
  assert.match(repoNotes, /\*\*Full Changelog\*\*: https:\/\/github\.com\/JustYarick\/kubiki\/compare\/v1\.3\.1\.\.\.v1\.4\.0/);

  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'kubiki-notes-'));
  try {
    assert.equal(await loadReleaseNotes('v1.4.0', emptyRoot), null);
    await mkdir(path.join(emptyRoot, 'docs'));
    await writeFile(path.join(emptyRoot, 'docs/CHANGELOG.md'), SAMPLE_CHANGELOG);
    assert.match(await loadReleaseNotes('v1.4.0', emptyRoot), /^## Kubiki 1\.4\.0/);
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }
});
