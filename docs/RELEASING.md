# Desktop builds and releases

CI and Release share the [desktop pipeline](../.github/workflows/release.yml)
and offer two entry points: CI runs tests before building; a manual Release
builds and publishes without tests by default. Both build all four desktop
targets and validate the release artifacts before publishing.

## Run from GitHub Actions

Open **Actions → CI → Run workflow** and select the source branch.

- Leave **trigger_release** enabled to publish after all checks and builds pass.
  It is enabled by default for manual runs.
- Leave **custom_tag** empty for automatic version selection. **main** gets the
  next stable version; other branches get `vX.Y.Z-dev.NUMBER`. The number starts
  from the workflow run counter and is raised above existing dev tags for that
  version, so CI and Release's separate counters do not reuse a published tag.
- Choose **bump** (`patch`, `minor`, `major`) to select the next version. The base
  is the highest existing stable tag, sorted numerically; with no stable tags,
  the base is `0.1.0`.
- Set **custom_tag**, for example `v1.0.1` or `v1.0.1-rc.1`, to select an exact
  version. An existing tag always selects its own commit.
- Disable **trigger_release** for tests and downloadable installers without
  publishing. Pushes and pull requests targeting branches other than `dev`/`main`
  use this mode automatically. Pushes to `dev`/`main` and pull requests targeting
  either branch do not start CI; launch it manually from Actions when needed.

For **build and publish without tests**, open **Actions → Release → Run workflow**:

- Select the source branch, leave **run_tests** disabled (the default), and leave
  **publish** enabled (the default). Frontend, browser, extension and Rust test
  suites are skipped; installer builds start after version/signing preparation.
- Set **run_tests** to true if this release should also run the full test suite.
- Use **custom_tag** and **bump** as in CI. Optional **target_commit** must be a
  full commit SHA and must match an existing custom tag.
- Disable **publish** if only downloadable installer artifacts are needed.

| Entry point | Tests | Build installers | Publish |
| --- | --- | --- | --- |
| Push to `dev`/`main` or PR targeting either branch | No run | No | No |
| Other branch push / PR → CI | Always | Yes | No |
| Manual CI (`trigger_release=true`, default) | Always | Yes | Yes |
| Manual Release (`run_tests=false`, default) | Skipped | Yes | Yes, unless `publish=false` |
| Manual Release (`run_tests=true`) | All | Yes | Yes, unless `publish=false` |
| Push a `v*` tag | Skipped | Yes | Yes |

Skipping tests does not require a previous successful CI run. Frontend/extension
compilation, type checking needed by the build, signing and artifact validation
still run. The summary records the selected test mode. **Re-run jobs** preserves
the original inputs; select **Run workflow** to change modes. The VirusTotal
scan is an optional report; it never blocks publication.

Pushing a `v*` tag builds signed packages, publishes them and runs the optional
VirusTotal report scan afterwards. Tag pushes do not implicitly enable tests. To
run tests before publication, manually start **CI**, or start **Release** and
enable **run_tests**.
For tag-triggered publication:

```sh
git tag -a v1.0.1-rc.1 -m "Kubiki 1.0.1 release candidate 1"
git push origin v1.0.1-rc.1
```

An explicit tag selects the channel regardless of branch. Plain `vX.Y.Z` tags
are stable. Tags with prerelease suffixes or build metadata are prereleases and
never become Latest. An older stable release does not replace a newer Latest.
There is no approval step after successful validation.

Signed `-dev.NUMBER` releases also advance the separate dev update feed. The
number distinguishes builds of the same upcoming version: `v1.0.1-dev.10` is
newer than `v1.0.1-dev.9`. Bare `-dev` remains supported, but repeating the same
tag is not a new version. RC/test/alpha/beta builds have no automatic update channel.

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

## VirusTotal setup

The scan is an **optional, report-only job**. Enable or disable it per run with
the `virustotal_scan` input (default: enabled); it runs alongside publication
and its verdicts, failures and errors never block or fail the release. To
rescan an already published payload, use **Re-run jobs** on that publishing
run: the original inputs are preserved, so the scan repeats on the same files.

Register a free [VirusTotal Community account](https://www.virustotal.com/gui/join-us).
Find the personal API key in your account settings ([official instructions](https://docs.virustotal.com/reference/getting-started)).
In GitHub **Settings → Secrets and variables → Actions → New repository secret**,
save it as **`VIRUSTOTAL_API_KEY`**. Keep the key out of source files and reports.
The scanner receives this secret only in its upload/analysis step. No additional
Node dependencies or hosted application service are needed.

For publishing runs, the scanner downloads and verifies every platform's build
records and scans every installer, updater archive and standalone CLI. Detached
`.sig` files are excluded. Files with identical SHA-256 hashes share one upload,
but each release filename gets a report entry. Build-only CI and local builds
skip the external scan and need no VirusTotal secret.

All API calls share a serial queue, with **at least 16 seconds** between request
starts, including large-file upload URL requests, uploads, status checks and
retries. Files above 32 MiB use the dedicated upload URL (up to 650 MiB). Scanning
jobs in this repository share a concurrency lock. HTTP 429 responses trigger
up to three retries with at least a 60-second delay, honoring a longer
`Retry-After`. A job stops after 45 minutes or 180 requests, whichever comes first.
The [Public API](https://docs.virustotal.com/reference/public-vs-premium-api) also
has a **500-request daily limit** and is restricted to noncommercial use; the
16-second interval does not remove that limit. Other uses of the same key share
its quota, so reserve it for this pipeline when possible.

The scanner waits for completed analyses and checks individual engine verdicts
and file identity. Any malicious/suspicious verdict, missing key, API error,
timeout, inconsistent report, or absence of supported completed engine results
is recorded in the report, but publication never depends on it. Investigate
detections, including possible false positives, yourself; the pipeline does not
ignore them automatically.

The `antivirus-report` workflow artifact contains **`VIRUSTOTAL-REPORT.json`**
and **`VIRUSTOTAL-REPORT.md`**, retained for 14 days even after a scan failure
when the report step can run. They are published separately from the release;
the release contains only packages, signatures, `SHA256SUMS` and `latest.json`.
JSON records hashes, analysis IDs, engine names/versions/verdicts and links to
VirusTotal; Markdown gives a readable table.

Uploaded files become part of VirusTotal's shared dataset. No detections is not
a safety guarantee: some engines cannot inspect every installer format or all
embedded files. This supplements dependency checks and artifact signatures.

## What is built

| Runner | Target | Installers and updater package |
| --- | --- | --- |
| Ubuntu 22.04 | Linux x86_64 | DEB, RPM, AppImage |
| macOS 15 ARM | macOS Apple Silicon | DMG, signed app archive for releases |
| macOS 15 Intel | macOS Intel | DMG, signed app archive for releases |
| Windows 2022 | Windows x86_64 | NSIS EXE, MSI |

Every target also builds a standalone CLI and runs its native tests when
**run_tests** is enabled. All jobs
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
4. Uploads packages, signatures, `SHA256SUMS`
   and a single `latest.json`, then
   verifies the uploaded package sizes and tag-pinned updater URLs.
5. Publishes the draft. Stable versions become Latest only if newer than the
   current Latest; previews remain prereleases.
6. For dev versions, updates the manifest in the `updates-dev` prerelease only
   after the real dev release is published. Packages stay at their exact versioned
   URLs; this feed never becomes Latest and never moves to an older dev version.

A failed required test or build never publishes. In release-only mode, skipped
test jobs allow builds and publication to proceed. The VirusTotal scan is
advisory: its failures and detections never publish-block, and publication runs
independently of it. A failed upload leaves an unpublished draft.
Use **Re-run failed jobs** for a transient failure, or rerun the workflow with the
same **custom_tag** for a complete rebuild. The publish job replaces incomplete
assets on that draft. There is no heuristic that silently skips a platform based
on a few similarly named assets. Published releases are refused rather than
modified; select a new version for changes to an already published release.

Dev feed promotion is the exception for retries: if the versioned release was
published but the feed upload failed, **Re-run failed jobs** repairs only the feed
using the already published manifest and signatures. It does not replace the
published installers. Do not rerun the entire workflow with that published tag;
the preparation job correctly refuses it. The feed's release body records a
monotonic version floor before the manifest is replaced. If an upload is
interrupted, an older job cannot roll it back; retry the same or a newer dev
publication to repair it. A replacement can briefly return 404 while GitHub
replaces the manifest; failed checks remain retryable.

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
updater-enabled release in each channel is installed normally; then test an update
to a newer signed release in that same channel. Old dev builds without channel
support need one manual installation. See [application updates](APP_UPDATES.md) for runtime
checks and recovery. Linux DEB/RPM users retain package-manager ownership.
