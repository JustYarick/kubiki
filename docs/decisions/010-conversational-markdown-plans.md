# 010: Conversational Markdown plans

Status: accepted and implemented in 1.3.1. Supersedes the model-facing structured
planning workflow in [ADR-006](006-reviewed-ai-plans-and-transcript-history.md).
The transcript storage decision in that ADR remains valid.

## Context

Planning needs to support direct answers, investigation and iterative discussion
in the same conversation. The structured plan registry adds a separate proposal
schema, versions and step selection to that interaction. The release adopts a
conversational planning flow aligned with the external agent experience.

## Decision

The model writes diagnosis, uncertainty, ordered steps, risk and verification in
Markdown. `propose_plan` and `get_plan` are not offered. Plan remains read-only;
the user switches to Action and requests execution through permitted mutation
tools. Native authorization, Ask confirmation, receipts and fresh verification
remain the execution boundary.

## Alternatives and consequences

- Keeping model-facing structured artifacts would preserve exact versioned step
  selection, but retain a separate planning interface and schema.
- Markdown keeps planning and revisions in the conversation. It gives up executable
  plan cards and versioned step selection; asking to execute requires the model to
  translate the discussed steps into mutation calls, each subject to backend checks.
- Markdown and model thinking do not authorize writes. A completed API request
  still requires verification, and uncertain writes cannot be retried automatically.

Backend artifact APIs and card rendering remain for compatibility. New plans use
the [current planning and execution contract](../AI_PLAN_CONTRACT.md).
