# Agent Adapter Plugin Setup

This per-adapter prompt has been folded into the one unified methodology that covers all four adapter types.

**To author an agent plugin (Claude Code, OpenCode, Gemini CLI, or a new coding-agent CLI), follow [Authoring a Plugin](../authoring.md).** Pick the **agent** adapter in Step 1 — every step then sends you to the [agent adapter contract](../../../../plugins/agent/README.md) for the agent-specific detail: the `doRun` output-parsing pattern, the mandatory stdin piping and subprocess-environment sanitization, rate-limit detection, quota reporting, and the per-CLI output-format differences.

There is no separate agent-only flow to maintain — the methodology and the agent contract page together cover what this prompt used to.
