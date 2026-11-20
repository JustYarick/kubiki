import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractChangelogSection, formatReleaseNotes, formatUpdaterNotes, loadReleaseNotes, loadUpdaterNotes } from '../../scripts/release-notes.mjs';

const SAMPLE_CHANGELOG = `# Changelog

## [Unreleased]

### Added
- Pending work

### Fixed
- Dev preview fix

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

test('formatReleaseNotes builds the canonical stable GitHub Release summary without kubiki-cli', () => {
  const notes = formatReleaseNotes(SAMPLE_CHANGELOG, 'v1.4.0');
  assert.ok(notes);
  assert.match(notes, /^## Kubiki 1\.4\.0\n\n### Added\n- Loopback HTTP MCP server\.\n\n### Fixed\n- Partial namespace read handling\./);
  assert.match(notes, /### Release Artifacts/);
  assert.doesNotMatch(notes, /kubiki-cli/);
  assert.match(notes, /\*\*Full Changelog\*\*: https:\/\/github\.com\/JustYarick\/kubiki\/compare\/v1\.3\.1\.\.\.v1\.4\.0\n$/);
  assert.doesNotMatch(notes, /Pending work/);
  assert.doesNotMatch(notes, /Earlier fix/);
});

test('formatReleaseNotes uses ## [Unreleased] for dev preview releases and pins the compare link to the dev tag', () => {
  const notes = formatReleaseNotes(SAMPLE_CHANGELOG, 'v1.5.0-dev.42');
  assert.ok(notes);
  assert.match(notes, /^## Kubiki 1\.5\.0-dev\.42 \(Dev Preview\)\n\n> Development preview build/);
  assert.match(notes, /### Added\n- Pending work\n\n### Fixed\n- Dev preview fix/);
  assert.match(notes, /### Release Artifacts/);
  assert.match(notes, /\*\*Full Changelog\*\*: https:\/\/github\.com\/JustYarick\/kubiki\/compare\/v1\.4\.0\.\.\.v1\.5\.0-dev\.42\n$/);
  assert.doesNotMatch(notes, /Loopback HTTP MCP server/);

  // Updater manifest notes contain the concise changelog entries without the release artifacts footer.
  const updaterNotes = formatUpdaterNotes(SAMPLE_CHANGELOG, 'v1.5.0-dev.42');
  assert.equal(updaterNotes, '### Added\n- Pending work\n\n### Fixed\n- Dev preview fix');
});

test('formatReleaseNotes skips non-dev prereleases, empty Unreleased sections, and missing versions', () => {
  assert.equal(formatReleaseNotes(SAMPLE_CHANGELOG, 'v1.4.0-rc.1'), null);
  assert.equal(formatReleaseNotes(SAMPLE_CHANGELOG, 'v1.4.0-beta.1'), null);
  assert.equal(formatReleaseNotes(SAMPLE_CHANGELOG, 'v9.9.9'), null);
  assert.equal(formatReleaseNotes('## [Unreleased]\n\n## [1.4.0] - 2026-11-17\n\n### Fixed\n- Fix.\n', 'v1.5.0-dev.1'), null);
  assert.equal(extractChangelogSection('## [1.4.0] - 2026-11-17\n\n## [1.3.1] - 2026-11-12\n', '1.4.0'), null);
});

test('loadReleaseNotes and loadUpdaterNotes read docs/CHANGELOG.md and ignore missing files', async () => {
  const repoNotes = await loadReleaseNotes('v1.4.0');
  assert.ok(repoNotes);
  assert.match(repoNotes, /^## Kubiki 1\.4\.0/);
  assert.match(repoNotes, /\*\*Full Changelog\*\*: https:\/\/github\.com\/JustYarick\/kubiki\/compare\/v1\.3\.1\.\.\.v1\.4\.0/);

  const repoDevNotes = await loadReleaseNotes('v1.5.0-dev.1');
  assert.ok(repoDevNotes);
  assert.match(repoDevNotes, /^## Kubiki 1\.5\.0-dev\.1 \(Dev Preview\)/);
  assert.match(repoDevNotes, /\.\.\.v1\.5\.0-dev\.1\n$/);

  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'kubiki-notes-'));
  try {
    assert.equal(await loadReleaseNotes('v1.4.0', emptyRoot), null);
    assert.equal(await loadUpdaterNotes('v1.5.0-dev.1', emptyRoot), null);
    await mkdir(path.join(emptyRoot, 'docs'));
    await writeFile(path.join(emptyRoot, 'docs/CHANGELOG.md'), SAMPLE_CHANGELOG);
    assert.match(await loadReleaseNotes('v1.4.0', emptyRoot), /^## Kubiki 1\.4\.0/);
    assert.match(await loadReleaseNotes('v1.5.0-dev.5', emptyRoot), /^## Kubiki 1\.5\.0-dev\.5 \(Dev Preview\)/);
    assert.match(await loadUpdaterNotes('v1.5.0-dev.5', emptyRoot), /Pending work/);
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }
});
