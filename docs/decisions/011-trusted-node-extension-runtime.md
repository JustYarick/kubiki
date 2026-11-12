# 011: Trusted Node.js extension runtime

## Status

Accepted. Records the existing extension architecture; it does not introduce a
new runtime. Current contracts: [Extension runtime](../EXTENSION_PLATFORM.md).

## Context and constraints

Users should discover official extensions in Kubiki and install community
extensions by pasting a GitHub repository URL. Authors should develop independently
of Kubiki's internal React components and Rust implementation. Redis and Kafka
are the initial use cases. No application server, account system or paid marketplace
is required. GitHub provides hosting; installed packages and execution remain local.

`workspace_panels.tsx` supports trusted bundled components and host-owned adapters
for installed panels. The package installer and local runtime live outside that
registry: Rust's `extension_commands.rs` brokers requests to the Node controller,
and `packages/extension-sdk` and `packages/extension-tools` define the external
contract and author workflow. Tauri Rust plugins remain application integration
crates, separate from installable `.kubiki-extension` packages.

## Decision and alternatives

| Option | Advantages | Costs and limits |
| --- | --- | --- |
| Load external React modules into the main renderer | Smallest prototype; shares components | Couples authors to application internals; exposes the main renderer; cannot by itself implement ordinary Redis/Kafka TCP clients |
| Local Node.js extension host plus isolated panel UI | Familiar TypeScript tooling; existing protocol libraries; independent packages | Adds a bundled runtime, per-platform packaging and process management; trusts installed backend code |
| WASM or restricted JS runtime with brokered I/O | Can support a narrower, enforceable host API | More SDK and networking work; Node libraries cannot generally be reused unchanged |

The implementation uses the second option with a **trusted-extension model**: one
controller process and one worker per active extension, shared across its tabs. The
observed reasons for the process boundary are external release cadence, protocol
library compatibility and containing extension crashes or event-loop stalls.
Measure actual memory costs before expanding the model. A host crash must leave
Kubernetes tables and other extension hosts operational.

Bundle the Node runtime with the desktop application; do not depend on the user's
Node installation. A regular runtime plus a bootstrap loader is preferable to a
packaging mechanism that prevents loading later-installed modules. Tauri supports
[bundled external executables](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/sidecar.mdx).

This isolates failures, **not malicious code**. Ordinary Node extensions execute
with the OS user's privileges. Declared capabilities can govern Kubiki's SDK calls,
but do not prevent backend code using its own filesystem or network APIs. VS Code
also documents a trusted extension host with application-level permissions:
[extension runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security).
A strict sandbox would require a different runtime boundary or platform-specific
OS isolation; it is a separate requirement, not something a permission dialog supplies.

## Consequences

- Extension authors can reuse Node protocol libraries and release independently
  of the desktop application. End users do not install Node or compile packages.
- Worker separation contains crashes and event-loop stalls, at the cost of bundled
  runtime size, memory per active extension and process lifecycle management.
- Opaque-origin iframe panels restrict frontend access; Node backend code remains
  trusted and has the user's OS privileges. SDK permissions are not an OS sandbox.
- Installation must validate package paths, compatibility and checksums; cleanup
  must cover disable, last-view close, uninstall and application shutdown.

Expanded SDK capabilities and stronger backend isolation are separate proposals,
not implied by this accepted runtime choice. See [development plans](../plans/README.md).
