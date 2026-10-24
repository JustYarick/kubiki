# Desktop application updates

Status: implemented. Ownership: Kubiki desktop/release maintainers. This module
lives in the existing repository and desktop process; it adds no hosted service.

## Release policy

Every newer stable version is eligible, including minor and patch releases.
Stable tags use plain `vMAJOR.MINOR.PATCH`. Tags containing a prerelease suffix
(`-dev`, `-test`, `-alpha`, `-beta`, `-rc`, etc.) or build metadata (`+...`) are
published as GitHub prereleases and never promoted to Latest. Native version
comparison independently rejects these versions and downgrades.

The app checks `https://github.com/JustYarick/kubiki/releases/latest/download/latest.json`
after the first render, independently of Kubernetes connectivity. The workflow
keeps releases as drafts until the combined manifest contains all four supported
OS/architecture combinations and their packages and signatures. Package URLs
must point to the exact release tag. Do not mark a CLI-only or preview release
as Latest manually.

## Signing setup (once, before the first release)

Generate a key using the installed Tauri CLI, writing the private key outside
the repository, for example:

```sh
pnpm tauri signer generate -w /secure/location/kubiki-updater.key
```

Configure these GitHub repository settings:

| Kind | Name | Value |
| --- | --- | --- |
| Actions variable | `KUBIKI_UPDATER_PUBLIC_KEY` | Contents of the generated `.pub` file |
| Actions secret | `TAURI_SIGNING_PRIVATE_KEY` | Contents of the private key file |
| Actions secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Key password, when configured |

Back up the private key securely. Losing it breaks the trust chain for installed
clients; a new key requires a separately planned key migration. Keep it out of
git, build artifacts and logs. Artifact signing is separate from Windows code
signing and macOS signing/notarization.

The public key is embedded in Rust at build time via
`KUBIKI_UPDATER_PUBLIC_KEY`; it is never loaded from an end user's environment.
The empty plugin configuration key is intentional for unsigned local builds:
they report updates as unavailable, and signature verification is never bypassed.
CI requires both keys, synchronizes the tag into package.json, tauri.conf.json,
Cargo.toml and the desktop Cargo.lock entry, and enables updater artifacts with
an additional generated Tauri configuration. Local builds do not require keys.

Debug builds, preview builds, browsers and Linux deb/rpm installations do not
self-update. Linux in-app updates use AppImage; deb/rpm users keep their package
manager's ownership. Windows uses the native installer and macOS updates the app
bundle. The first release containing this feature must be installed normally.

## Module boundaries and lifecycle

`src/core/app_updates.ts` owns the state machine and single-flight operations.
`src/providers/app_updates.ts` adapts the native commands; `src/state/update_store.ts`
composes it with local preferences and the editor preflight. React displays state
and invokes actions. `src-tauri/src/update_commands.rs` owns the trusted feed,
SemVer policy, package download, signature verification, installation and restart.
Direct updater plugin permissions are not granted to the renderer; installation
must pass through Kubiki's guarded native command.

Checks time out after 15 seconds; downloads after 10 minutes. Offline startup
failures remain quiet. About → Application updates provides manual checks and
retries. Skip applies to that exact version; Later postpones automatic prompts
for 24 hours. Manual checks override both preferences.

Downloads are verified before becoming installable. A selected release and its
bytes remain pinned in memory for the session. They are not persisted across
process restarts. Installation is a separate explicit action. Unsaved YAML drafts
or dirty workspace tabs block it, rather than persisting potentially sensitive
manifests. Finish or revert those edits first.

The native installer acquires the same nonblocking gate as cluster mutations and
checks pending confirmation dialogs. It refuses installation while a change is
running and holds the gate through cleanup, installation and restart. It awaits
native extension-host, watch, terminal, node-debug and port-forward cleanup before
the installer can terminate the process on Windows. Running interactive sessions
are closed, as described in the installation prompt.

## Failure handling and verification

A failed check/download does not close sessions or change the installed app.
Signature failure never produces an installable package. Installation errors are
shown with a retry action; sessions may already have closed during preparation,
so reconnect the cluster to restore watches after a failed installation.

Validate policy, concurrency, notification preferences and failures with Vitest;
validate tag handling and complete release publication with `pnpm test:desktop`;
validate native policy and mutual exclusion with Cargo tests. Browser tests mock
the native boundary to cover the offer, progress and explicit restart action.

Before promoting the first production update, install release N and update it
to N+1 on Windows, macOS Intel/ARM and Linux AppImage. Verify a tampered package
is rejected, offline startup stays usable, and an active cluster mutation blocks
installation. Browser mocks and compilation cannot validate native OS installers.

Track check/download/install failures in native logs and compare successful
update rate and recovery time with the first rollout baseline. Release maintainers
own signing and failed update recovery. Initial recovery is manual reinstallation
of a known working signed package, preserving compatible user settings; automatic
rollback, delta updates, staged rollouts and an update server are deferred.
