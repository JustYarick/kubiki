# Documentation conventions

## Purpose and organization

Use the [documentation index](README.md) as the entry point. Organize content by
reader need, following [Diátaxis](https://diataxis.fr/): getting started, task
instructions, reference and explanation. Files may share a topic, but their
responsibilities must be clear:

| Content | Location | Authority |
| --- | --- | --- |
| Setup and task instructions | README and topic guides | Current executable behavior and supported configuration |
| Structure, contracts and limits | `STRUCTURE.md`, SDK references and topic references | Source modules, schemas and tests |
| Why an architecture was chosen | `decisions/` | Decision context, alternatives, trade-offs and consequences |
| Future capabilities | `plans/` | Explicitly proposed or deferred work, never an implemented API |

Keep stable topic filenames so incoming links continue to work. Link to the
canonical guide rather than copying changing defaults, command tables or SDK
contracts into multiple files. SDK package references own their public API;
release instructions own workflow inputs and secrets.

## Current implementation

Update documentation in the same change as behavior. Verify commands, defaults,
UI labels, filesystem paths, environment variables and security boundaries against
source. State unavailable capabilities and test limits accurately. Distinguish
updater signatures from OS code signing, API acceptance from health verification,
and desktop tests from native target-platform validation.

Do not include dated test transcripts, private conversation exports, temporary
paths or one-off benchmark results as product reference. Keep reproducible test
commands and explain what they establish; retain investigation artifacts in the
workflow or issue where the investigation happened.

## Architecture decision records

Follow the [ADR practice](https://adr.github.io/): one significant decision per
record, with status, context, decision, alternatives and consequences. Use the
[template](decisions/TEMPLATE.md). Number records sequentially and preserve links.
Historical records may cover a broader scope; do not renumber or rewrite their
original rationale to make it look as though the present design was always chosen.

Use `Proposed`, `Accepted`, `Deprecated` or `Superseded by ADR-NNN`. Adoption and
implementation progress are different: an accepted direction can still have
unimplemented parts. Explain partial supersession precisely, linking both records.
Add a status clarification when implementation changes; put supported commands in
reference guides and remaining work in plans. An accepted ADR is not a promise
that every implementation sketch in its original text is a supported interface.

## Development plans

Give each plan a status, current baseline, intended scope, dependencies or open
questions, and acceptance criteria. Use `Proposed`, `Deferred`, `In progress`,
`Completed` or `Dropped`; only claim active work or delivery dates when confirmed.
Mark examples of future commands/configuration as proposed. On completion, update
the operating guide and relevant ADR; keep the plan concise and link to the result.

## Review before committing

Check local file and heading links, code paths, documented commands and consistency
between README, reference guides, ADR status and plans. Run `git diff --check`.
Documentation-only edits do not require application tests unless they change test
fixtures, generated assets or executable examples. Do not claim native verification
from reading source or compiling a browser fixture.
