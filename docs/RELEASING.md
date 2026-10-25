# Desktop builds and releases

CI and Release use the same [pipeline](../.github/workflows/release.yml): frontend
and extension tests, browser tests, native tests, four desktop builds, artifact
validation, then publication when requested. A green build includes installers,
not just `cargo check` or a web bundle.

## Run from GitHub Actions

Open **Actions → CI → Run workflow** and select the source branch.

- Leave **trigger_release** enabled to publish after all checks and builds pass.
  It is enabled by default for manual runs.
- Leave **custom_tag** empty for automatic version selection. **main** gets the
  next stable version; other branches get `vX.Y.Z-dev.RUN_NUMBER`.
- Choose **bump** (`patch`, `minor`, `major`) to select the next version. The base
  is the highest existing stable tag, sorted numerically; with no stable tags,
  the base is `0.1.0`.
- Set **custom_tag**, for example `v1.0.1` or `v1.0.1-rc.1`, to select an exact
  version. An existing tag always selects its own commit.
- Disable **trigger_release** for tests and downloadable installers without
  publishing. Pushes to branches and pull requests use this mode automatically.

**Actions → Release → Run workflow** runs the same pipeline directly. Its
**publish** switch also defaults to true. It additionally accepts **target_commit**,
which must be a full commit SHA and must match an existing custom tag.

Pushing a `v*` tag also runs the complete pipeline and publishes on success:

```sh
git tag -a v1.0.1-rc.1 -m "Kubiki 1.0.1 release candidate 1"
git push origin v1.0.1-rc.1
```

An explicit tag selects the channel regardless of branch. Plain `vX.Y.Z` tags
are stable. Tags with prerelease suffixes or build metadata are prereleases and
never become Latest. An older stable release does not replace a newer Latest.
There is no approval step after successful validation.

Ordinary CI runs use a preview version to exercise prerelease packaging and
require no signing secrets. Their final publication job is intentionally skipped;
the run summary explicitly says **Build only**. Manual CI runs with
**trigger_release** enabled publish through the reusable pipeline in the same run;
there is no second workflow dispatch to find or wait for.

## Signing setup

Generate and back up the updater key outside the repository, then configure
**Settings → Secrets and variables → Actions**:

| Kind | Name | Contents |
| --- | --- | --- |
| Variable | `KUBIKI_UPDATER_PUBLIC_KEY` | Generated `.pub` file |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Generated private key file |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password, if configured |

See [signing setup](APP_UPDATES.md#signing-setup-once-before-the-first-release).
Signed runs reject missing keys before the expensive jobs start. Build-only runs
receive no signing keys. Updater signing is separate from Windows code signing
and macOS signing/notarization, which are not configured here.

## What is built

| Runner | Target | Installers and updater package |
| --- | --- | --- |
| Ubuntu 22.04 | Linux x86_64 | DEB, RPM, AppImage |
| macOS 15 ARM | macOS Apple Silicon | DMG, signed app archive for releases |
| macOS 15 Intel | macOS Intel | DMG, signed app archive for releases |
| Windows 2022 | Windows x86_64 | NSIS EXE, MSI |

Every target also builds a standalone CLI and runs its native tests. All jobs
check out the same resolved commit SHA. Node.js 24 and the pnpm version pinned in
`package.json` are used throughout. Cargo builds/tests use committed lockfiles.

The pipeline synchronizes `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` and the desktop entry in `src-tauri/Cargo.lock` within the
runner checkout. It does not commit version changes to the branch or change the
independently versioned SDK/core crate.

RPM cannot use a SemVer prerelease directly as its Version. The shared build
command first builds the application with the full version, then bundles that
existing binary as an RPM with numeric Version and a separate Release. For
`1.0.1-dev`, these are `Version=1.0.1`, `Release=0.dev`; stable `1.0.1` uses
`Release=1`. The application's embedded version remains `1.0.1-dev`. RPM updater
artifacts are disabled; Linux self-updates use AppImage. MSI uses a separate
numeric WiX version (`1.0.1` for `1.0.1-dev`), and macOS uses a numeric bundle
build version. Full SemVer stays embedded in the application. Versions beyond
MSI limits (`255.255.65535`) are rejected during planning.

Each matrix job stages only distributable packages, signatures and CLI binaries.
It verifies all required formats and writes a build record containing target,
commit, tag and SHA-256 hashes. Download these files from the run's **Artifacts**
section (`kubiki-TARGET`, retained for 14 days), including build-only runs.

## Publication and retries

Only the final publish job writes GitHub release assets. It:

1. Downloads all four matrix artifacts and checks their source SHA, tag, target,
   signed mode, package presence and file hashes.
2. Creates one updater manifest from matching package/signature pairs. macOS ARM
   and Intel require distinct app archives; Windows uses NSIS; Linux uses AppImage.
3. Creates the tag if needed and creates or reuses an unpublished draft.
4. Uploads packages, signatures, `SHA256SUMS` and a single `latest.json`, then
   verifies the uploaded package sizes and tag-pinned updater URLs.
5. Publishes the draft. Stable versions become Latest only if newer than the
   current Latest; previews remain prereleases.

A failed test/build never publishes. A failed upload leaves an unpublished draft.
Use **Re-run failed jobs** for a transient failure, or rerun the workflow with the
same **custom_tag** for a complete rebuild. The publish job replaces incomplete
assets on that draft. There is no heuristic that silently skips a platform based
on a few similarly named assets. Published releases are refused rather than
modified; select a new version for changes to an already published release.

For a source fix, commit the fix and use a new tag. Retrying an existing tag builds
its original source; it cannot include later changes to the release scripts.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:desktop
pnpm desktop:prepare
pnpm test:extensions
node scripts/check-external-extension.mjs
cargo test --locked --manifest-path crates/kubiki-core/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm exec playwright install chromium
pnpm test:e2e
pnpm desktop:build
```

Install native platform dependencies first. `pnpm desktop:build` uses the same
packaging code as CI, including the Linux OpenSSL workaround and RPM version
handling. It does not require updater keys for an ordinary local build.

Linux packages are verified locally; macOS and Windows builds must run on their
respective runners. Compilation and browser mocks do not prove native installer
or updater behavior. Install and exercise the packages on each OS. The first
updater-enabled stable release is installed normally; then test an update to a
newer signed stable release. See [application updates](APP_UPDATES.md) for runtime
checks and recovery. Linux DEB/RPM users retain package-manager ownership.
