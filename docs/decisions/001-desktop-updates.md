# 001: Signed stable updates inside the desktop application

Status: accepted. Owner: Kubiki desktop/release maintainers.

## Context

Kubiki needs to offer newer stable GitHub releases at startup and install them
after consent. It already ships a Tauri 2 desktop runtime and a four-target
GitHub release matrix. No independent deployment, ownership or scaling pressure
justifies another runtime.

## Decision

Use Tauri's updater behind guarded native commands. Keep a small application
service/state machine, adapter and UI in the current desktop application. Host
the platform manifest and signed packages in GitHub Releases. Promote only plain
SemVer stable tags after the full manifest has passed validation.

The signing public key is embedded at build time and becomes a trust contract
with installed clients. CI owns the private key. Installation shares the cluster
mutation gate and awaits session cleanup. Dirty editors block installation.

## Alternatives

A custom downloader/installer duplicates signature verification and OS-specific
replacement behavior. A dedicated update service adds hosting and operational
ownership before staged rollouts or custom distribution are required. A
download-page notification alone does not meet the in-app installation goal.

## Consequences

No additional server or repository is introduced. GitHub outages only affect
update discovery and download. Linux self-updates initially support AppImage;
deb/rpm remain package-manager owned. Signing key rotation and automatic rollback
need explicit follow-up designs. There is no promise of restoring interactive
terminal sessions after restart.

Roll out in two releases: install the first updater-enabled version normally,
then verify an N → N+1 update on each target before broader promotion. Recover
failed releases through manual installation of a compatible known working
package. Reconsider a server if actual rollout-control requirements cannot be
satisfied by a static feed. See [operating instructions](../APP_UPDATES.md).
