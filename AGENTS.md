# Agent guide

## Project overview

Kubiki is a Kubernetes desktop workspace built with React, TypeScript, Tauri and
Rust. Use the repository's existing components and service boundaries. This file
applies repository-wide; more specific `AGENTS.md` files may refine local guidance.

## Start with the documentation

- Read [the documentation index](docs/README.md) and
  [project structure](docs/STRUCTURE.md) before searching broadly or choosing a module.
- Read the relevant topic guide before changing behavior. Check
  [ADRs](docs/decisions/README.md) for why a boundary or technology was chosen and
  [development plans](docs/plans/README.md) for proposed work.
- Confirm documented behavior against code, tests, schemas and workflow files.
  A proposal or historical ADR example is not an implemented API. If they disagree,
  establish the intended behavior and correct the documentation with the change.
- Use `rg` and `rg --files` for targeted searches. Follow the module map instead
  of assuming that an unfamiliar feature needs a new service or abstraction.

## Repository map

| Location | Responsibility |
| --- | --- |
| `src/` | React UI, state, providers and frontend resource logic |
| `src-tauri/` | Native IPC, credentials, consent and desktop lifecycle |
| `crates/kubiki-core/` | Shared Kubernetes connections, reads, mutations and sessions |
| `crates/kubiki-tools/` | Agent tools, policy, projection, receipts and verification |
| `crates/kubiki-ai/` | Provider protocols, conversation context and agent loop |
| `crates/kubiki-mcp/` | Embedded MCP, standalone stdio server and attached bridges |
| `packages/`, `extensions/` | Public extension SDK/tools, runtime and bundled packages |
| `tests/`, `.github/workflows/` | Frontend/desktop checks and CI/release orchestration |

## Setup and development

Use Node.js 24, the pnpm version pinned in `package.json`, stable Rust supporting
edition 2024, and the [native prerequisites](README.md#build-requirements).
Run commands from the repository root unless a guide says otherwise.

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

For browser-only demo development, run `pnpm dev` and open
`http://localhost:1420/?demo=1`. Native operations require the desktop backend.
On a clean checkout, run `pnpm extensions:build` before standalone type checks.
Before direct desktop Cargo checks, also run `pnpm desktop:prepare` to create
bundled resources. Tauri hooks perform preparation for normal desktop startup.

## Implementation conventions

- Follow nearby TypeScript and Rust conventions; keep changes focused and preserve
  unrelated user work. Avoid repository-wide formatting or dependency churn.
- Keep reusable Kubernetes logic in core and policy/tool logic in the portable
  crates. Tauri adapters own window lifecycle, IPC, credentials and consent.
- Reuse shared UI components, theme tokens and resource identity helpers. Read the
  relevant UI documentation before adding another styling or navigation pattern.
- Preserve cancellation, context/namespace/UID isolation, bounded reads and honest
  partial/unknown states. API acceptance does not establish workload health.
- Treat extension Node backends as trusted local code; iframe isolation is not a
  backend sandbox. Keep public SDK contracts separate from application internals.

## Testing and verification

Use [Testing](docs/TESTING.md) to select checks for the changed behavior. Add or
update regression coverage for meaningful behavior changes; avoid tests that
only reproduce implementation details. Start with affected suites and expand
when dependencies, failures or unresolved risks justify it.

| Change | Relevant checks |
| --- | --- |
| Frontend types and logic | `pnpm typecheck`; `pnpm exec vitest run <test-file>` |
| Browser interaction or layout | `pnpm test:e2e <spec-file>` |
| Release scripts or workflow | `pnpm test:desktop` |
| Extension contracts or runtime | `pnpm test:extensions` |
| Rust crate | `cargo test --locked --manifest-path crates/<crate>/Cargo.toml` |
| Native desktop adapter | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` |
| Frontend packaging | `pnpm build` |

There is no root Cargo workspace: select the affected manifest explicitly.
Do not use paid providers or write to a live cluster as an implicit test step.
Distinguish fixture/browser results from installed native behavior. Report what
ran, failures or blockers, and any important unverified platform behavior.
Documentation-only edits require link/example checks and `git diff --check`,
not an application rebuild unless executable examples or generated assets changed.

## Documentation is part of the change

- Update documentation in the same change as behavior, commands, defaults,
  configuration, UI labels, architecture or security boundaries. Follow
  [documentation conventions](docs/DOCUMENTATION.md).
- Keep operating guides and references current. Update README summaries and links
  when affected; link to canonical detail instead of duplicating it.
- Record significant architectural choices with context, alternatives and costs
  using the [ADR template](docs/decisions/TEMPLATE.md). Preserve previous rationale;
  mark superseded decisions and link their replacements in both directions.
- Keep unimplemented work in `docs/plans/` with explicit status and acceptance
  criteria. When work ships, update the plan and current reference documentation.
- Do not store review transcripts, private conversations, temporary logs or
  one-off measurements in `docs/`. Preserve useful rationale in ADRs and
  reproducible diagnostic instructions in the relevant guide.
- Check local file/heading links and examples after moving or deleting documents.
  Keep this guide current when the repository's commands or boundaries change.

## Security and delivery

- Keep credentials, kubeconfigs, Secret values, signing keys and private transcripts
  out of commits, fixtures, logs and documentation. Use synthetic examples.
- Preserve backend authorization and confirmation checks; model output and
  frontend flags cannot grant permissions. See [AI planning](docs/AI_PLAN_CONTRACT.md).
- Follow [Releasing](docs/RELEASING.md) for publication. Updater signing is separate
  from OS code signing; VirusTotal reports are advisory and must retain detections.
- Before finishing, inspect the diff, run `git diff --check`, and summarize the
  behavior change, documentation updates, verification and remaining limitations.
  Use focused `type(scope): description` commit messages when a commit is requested.
