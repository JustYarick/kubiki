# GLib 0.18 compatibility backport

This directory contains the crates.io `glib` 0.18.5 source, checksum
`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`.
The authoritative checksum is recorded in the original dependency lockfile history.
The upstream source revision is `42b9caf98e03ded086362d9653ca58fe94dc8658`.

Tauri's GTK3 dependencies require glib 0.18; upgrading only glib to 0.20
would create incompatible binding types. The sole source modification is
the upstream fix from https://github.com/gtk-rs/gtk-rs-core/pull/1343:
`VariantStrIter::impl_get` passes a mutable pointer to GLib's out-parameter.
This addresses https://rustsec.org/advisories/RUSTSEC-2024-0429.html.

The crate keeps its original version and license. Version-only advisory scanners
may still flag 0.18.5; do not suppress the advisory globally. Remove this local
patch when the desktop GTK stack supports a fixed upstream release.
