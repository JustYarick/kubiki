# AI planning and execution

## Planning

The agent writes its diagnosis, uncertainty and ordered remediation or investigation
steps directly in Markdown. Each proposed change should identify the resource,
action, risk and verification. Missing or filtered evidence means uncertainty;
it does not prove that a resource is healthy.

Plan is read-only. The agent gathers permitted evidence and discusses or revises
the plan in chat. `propose_plan` and `get_plan` are not offered to the model.
Markdown is explanatory text and does not authorize execution.

## Execution

To execute changes, switch to Action and ask the agent to proceed. The agent calls
permitted mutation tools sequentially. In Ask mode, each mutation opens native
confirmation; Auto accept still requires the configured operation permissions.

The backend validates scope, permissions, manifest and resource identity before
sending a write. Stop, connection invalidation and permission changes revoke
pending authorization. After a write receipt, the agent must verify fresh state:
API acceptance alone is not completion. Failed, declined or uncertain changes
stop further writes. An ambiguous write must not be retried automatically.

## Display and persistence

Plans render as chat Markdown; they have no executable step selection or Apply
button. Thinking is displayed separately. HTML is sanitized and external images
are not loaded.

Conversation transcripts are sanitized before storage. Tool payloads and approvals
are not persisted. Restoring a conversation starts in Plan + Ask and does not
resume a running operation or replay the transcript to the model automatically.
