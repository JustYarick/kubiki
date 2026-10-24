# Publishing desktop releases

The [Release workflow](../.github/workflows/release.yml) builds Linux x86_64,
macOS Apple Silicon, macOS Intel and Windows x86_64 packages plus standalone CLI
binaries. All commands below run from the Kubiki repository root. Example version
numbers must be replaced with the version you intend to publish.

## One-time setup

Use the Node.js and pnpm versions in the [build requirements](../README.md#build-requirements).
Generate and back up the updater signing key outside the repository, then configure
the GitHub repository's Actions settings as described in [signing setup](APP_UPDATES.md#signing-setup-once-before-the-first-release).

| Repository setting | Name |
| --- | --- |
| Actions variable, public key contents | `KUBIKI_UPDATER_PUBLIC_KEY` |
| Actions secret, private key contents | `TAURI_SIGNING_PRIVATE_KEY` |
| Actions secret, private key password when set | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |

The workflow rejects missing public/private updater keys before creating a draft.
The same key pair is used for stable and prerelease builds. The workflow currently
supplies updater signing credentials only; Windows code-signing and macOS app
signing/notarization are separate distribution tasks and are not configured here.
The workflow grants its `GITHUB_TOKEN` repository contents write permission to
create releases and upload assets.

## Validate the release commit

Commit the intended source and documentation changes and push the branch. Wait
for its CI run to pass before pushing a release tag: the Release workflow is
independent of branch CI and does not wait for it.

Useful local checks on a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm extensions:build
pnpm desktop:prepare
pnpm typecheck
pnpm test
pnpm test:desktop
pnpm test:extensions
node scripts/check-external-extension.mjs
pnpm build
cargo test --locked --manifest-path crates/kubiki-core/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm exec playwright install chromium
pnpm test:e2e
```

Native platform dependencies must be installed for Cargo/Tauri checks. Build and
exercise the installer on the target OS; on Linux use `pnpm desktop:build:linux`.
Record the platforms actually tested. The rendering investigation's Linux
measurements and browser tests do not certify Windows/macOS installation or the
end-to-end updater. Confirm release notes describe user-visible behavior and any
known platform limits.

## Choose the channel and push a tag

| Tag example | GitHub release | Promoted to Latest | Offered by the stable updater |
| --- | --- | --- | --- |
| `v0.2.0`, `v0.2.1` | Stable | Yes | Yes, when newer than the installed version |
| `v0.3.0-dev.1`, `v0.3.0-test.1` | Prerelease | No | No |
| `v0.3.0-alpha.1`, `v0.3.0-beta.1`, `v0.3.0-rc.1` | Prerelease | No | No |
| `v0.3.0+build.1` | Prerelease under Kubiki's policy | No | No |

Tags must be valid SemVer prefixed with `v`. The channel comes from the tag; a
plain stable tag on `dev` still publishes a stable release. Pushing an ordinary
commit to `dev` or `main` runs CI but does not create a release.

For a preview of the selected, tested commit:

```sh
git tag -a v0.2.0-rc.1 -m "Kubiki 0.2.0 release candidate 1"
git push origin v0.2.0-rc.1
```

After validating the candidate and selecting the final commit:

```sh
git tag -a v0.2.0 -m "Kubiki 0.2.0"
git push origin v0.2.0
```

Preview builds allow installer testing but have in-app update checks disabled.
Publish stable tags in increasing version order and finish one stable release
before starting another: the current workflow promotes every successful plain
stable tag and does not enforce monotonic Latest selection across workflow runs.

## What happens after the tag

1. The workflow checks out the tag, validates its format and signing configuration,
   and creates a GitHub draft release with generated notes.
2. Each build sets the desktop version in `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml` and the desktop package entry in `src-tauri/Cargo.lock`.
   This happens in the CI checkout; it does not commit version changes back to
   the branch or change the independently versioned SDK/core crate.
3. The build prepares the target's Node runtime and produces installers, updater
   signatures and CLI binaries. Tauri Action combines updater entries in
   `latest.json` on the draft release. Windows updater entries prefer NSIS.
4. After all four builds succeed, the publish job verifies the manifest version,
   four platform entries, package/signature asset presence and URLs pinned to
   that exact tag.
5. The publish job clears `draft` automatically. Stable releases become Latest;
   prereleases retain `prerelease: true` and are excluded from Latest.

There is no manual approval/promotion job between successful validation and
publication. Pushing a stable tag starts a workflow that will publish it.
Review generated notes while the release is a draft if needed; the workflow
does not wait for that review.

Manual dispatch accepts an existing tag and checks out that tag. It runs the
same pipeline and also publishes automatically on success. Use it for a tag
whose release has not already been created, not as a channel selector.

## Verify publication and handle failures

Check the workflow result and release assets. A stable release must expose
`latest.json` and the signed packages for `linux-x86_64`, `darwin-aarch64`,
`darwin-x86_64` and `windows-x86_64`. See [installation formats](../README.md#installation)
for the downloadable installers. Do not manually mark CLI-only or preview
releases as Latest; the application expects a complete desktop manifest there.

The first updater-enabled stable release is installed normally. A subsequent
newer signed stable release provides the first N → N+1 update to test on each OS.
Confirm startup discovery, download, signature rejection, unsaved-edit and
running-mutation protection, and restart. Linux self-updates currently use
AppImage; deb/rpm installations continue to use their package manager.

Failed builds or manifest validation leave the release as a draft. Inspect the
failed job and draft assets before retrying. The create job uses GitHub's create
release API and does not reuse an existing release: rerunning the entire workflow
for a tag that already has a draft can fail with an existing-release error. For
an unpublished failed attempt, clean up that draft before a full rerun or choose
a new unique tag. Do not move or replace a published stable tag or mix package
assets from different commits.

Initial failed-update recovery is manual installation of a known working package
with compatible settings. Moving Latest back does not downgrade installed apps.
The application does not implement automatic rollback or staged rollout control.
