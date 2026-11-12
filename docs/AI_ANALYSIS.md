# Investigating a resource with AI

## Start an investigation

1. Select the resource and open its **What's wrong** diagnostics.
2. Choose **Investigate with AI**.
3. Review the initial request in the AI workspace and continue with the selected agent.

Kubiki attaches resource identity: API version, kind, namespace, name and UID.
It does not attach the resource body, logs, Secret/ConfigMap values or a diagnostic
snapshot. The request asks the agent to collect permitted evidence, starting with
`diagnose_resource`, then explain diagnosis, uncertainty and any required next steps.
A missing or filtered result is not evidence of health.

## Integrated agent

Select **Kubiki** in **Settings → AI assistant → Agent** and configure a provider
and model. Investigations start in Plan + Ask. Native policy controls every live
read and mutation. Plans are discussed in Markdown; execution requires Action
and permitted mutation tools. See [AI agent](AI_AGENT.md) and
[Planning and execution](AI_PLAN_CONTRACT.md).

## External agents

Select **OpenCode**, **Codex** or **Claude Code** and configure its executable and
workspace. The CLI must be installed and authenticated. Kubiki starts it in a PTY,
passes the initial request as a separate argument and connects Kubiki cluster tools
through an authenticated attached MCP bridge.

The external CLI owns its model, credentials, conversation and local tool permissions.
Kubiki's MCP policy and server phase govern the exposed cluster tools. They do not
sandbox arbitrary host operations performed by the CLI. The initial request tells
the agent to stop if cluster tools are unavailable instead of inspecting host
credentials or sockets. This prompt is guidance, not a host security boundary.

Data returned by tools can be sent to the CLI's configured model provider. Review
MCP data-access settings before starting an investigation. The server phase defaults
to Plan and is independent of the CLI's own planning/execution mode. See
[External CLIs](AI_AGENT.md#agent-selection-and-external-clis) for lifecycle,
permissions and cancellation behavior.

Launching providers and terminal processes requires the desktop app; browser
preview does not execute them.
