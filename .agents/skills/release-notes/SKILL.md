---
name: release-notes
description: >-
  Write and maintain Kubiki changelog entries in docs/CHANGELOG.md and generate
  formatted GitHub Release summaries. Use when the user asks to update the
  changelog, record changes under Unreleased, prepare release notes for a
  stable vX.Y.Z release, or format a GitHub Release summary.
---

# Kubiki Release Notes & Changelog

Maintain [docs/CHANGELOG.md](../../../docs/CHANGELOG.md) in **Keep a Changelog 1.1.0** + **Semantic Versioning 2.0.0** format and produce consistent GitHub Release summaries via [scripts/release-notes.mjs](../../../scripts/release-notes.mjs).

## Rules

- **Stable releases only**: Only stable `vX.Y.Z` releases get versioned sections (`## [X.Y.Z] - YYYY-MM-DD`). Never create changelog sections for `-dev.NUMBER`, `-rc`, or other prereleases—those stay under `## [Unreleased]`.
- **User-facing scope**: Write concise bullets describing user-visible behavior, CLI/config changes, bug fixes, or security hardening. Skip purely internal refactors, formatting, or test-only tweaks unless they alter documented behavior.
- **Standard categories**: Use only `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security` (omit empty sections).
- **Verified facts only**: Base every bullet on actual commits (`git log`), diffs (`git diff`), or observed workspace changes. Keep credentials, tokens, and private transcripts out of entries.

## Workflow

### 1. Choose the action

- **Add ongoing work** (`## [Unreleased]`): When landing features, fixes, or security changes between releases.
- **Promote a stable release** (`vX.Y.Z`): When preparing a stable `vX.Y.Z` tag.
- **Preview GitHub Release summary**: When inspecting or copying the release page body for an existing `## [X.Y.Z]` entry.

### 2. Inspect actual changes

Run targeted git checks from the repository root:

```sh
git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 5
git log <prev-stable-tag>..HEAD --oneline
git status --short
```

If uncommitted changes are part of the release, inspect `git diff` as well before summarizing.

### 3. Update `docs/CHANGELOG.md`

- **Adding to `## [Unreleased]`**:
  - Insert concise bullets under the matching `### Added` / `### Changed` / `### Deprecated` / `### Removed` / `### Fixed` / `### Security` heading inside `## [Unreleased]`.
  - Do not bind entries to a target version number prematurely.
- **Promoting a stable release `vX.Y.Z`**:
  1. Move all `## [Unreleased]` entries under a new `## [X.Y.Z] - YYYY-MM-DD` heading directly below `## [Unreleased]`.
  2. Leave `## [Unreleased]` empty at the top.
  3. Update the reference links at the bottom of `docs/CHANGELOG.md`:
     ```markdown
     [unreleased]: https://github.com/JustYarick/kubiki/compare/vX.Y.Z...HEAD
     [X.Y.Z]: https://github.com/JustYarick/kubiki/compare/vPREV...vX.Y.Z
     ```

### 4. Generate & verify

1. For a stable release `vX.Y.Z`, preview the exact GitHub Release page summary (also used automatically by [scripts/publish-desktop-release.mjs](../../../scripts/publish-desktop-release.mjs)):
   ```sh
   node scripts/release-notes.mjs vX.Y.Z
   ```
2. Check whitespace and links:
   ```sh
   git diff --check
   ```
3. If `scripts/` or release tests were modified, run:
   ```sh
   pnpm test:desktop
   ```
