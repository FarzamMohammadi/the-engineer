# Status

## Current Phase

**Multi-CLI Plugin Integration — DONE.** Three LLM plugins (Claude Code, OpenCode, Gemini CLI) all working with live testing. Rate limit detection, dashboard visibility, `engineer init` single-select for LLM provider.

## Last Session

Session 067 (2026-03-22): S066 code quality review + Multi-CLI Plugin Integration + dashboard polish + contribution guide refinement. See `sessions/067.md`.

## Next

1. **RPI Integration** — Research/planning produce real files in workspace. Execution reads plan file. Files appear in PRs. Key decisions: file location (`thoughts/`?), template structure, cleanup config, crash-safe checkpoints via file-based progress. See roadmap.md "RPI Integration" section.
2. **Runtime Phase Refinement** — after RPI, refine each phase with dashboard visibility. Priority-driven order.

## Open Questions

- RPI file location: `thoughts/` directory (like Goose) or different convention?

## Architecture Knowledge

Permanent discoveries that affect how we build. Resolved bugs removed — they're in the code now.

### LLM Plugin Contract
- Always pipe prompts via stdin — orchestrator prompts are 50KB+ and hit OS `ARG_MAX`
- CLIs without `--system-prompt` flag: prepend with `[SYSTEM INSTRUCTIONS]...[END SYSTEM INSTRUCTIONS]` delimiters
- Rate limit detection varies by CLI: Claude uses `rate_limit_event` in stdout stream, Gemini returns `status: "error"` in result event (exits code 0!), both Gemini/OpenCode may retry infinitely — monitor stderr and kill
- Plugin discovery: config file exists in `~/.engineer/config/plugins/{id}.yaml` = enabled. Manifest `enabled` field only controls `engineer init` pre-check state
- Claude CLI: `--output-format stream-json --verbose` gives both result + rate_limit_event data
- Anthropic `/api/oauth/usage`: real quota percentages but ~5 requests per token before 429. Cached 30 min.
- Claude Code credentials: macOS Keychain (`Claude Code-credentials`), fallback `~/.claude/.credentials.json`
- OpenCode `--model` requires provider config in target dir. Built-in provider: `opencode/gemini-3.1-pro`
- Gemini CLI: `-p ""` + stdin for non-interactive mode with large prompts

### Observability
- `observe()` stores data in `input` field, `span.end()` in `output`. Dashboard reads both.
- Observer: 13 observation types, EventBus: 35 event types. All with trace_id, task_id, phase, session_id.
- Blocked task reasons: stored in `state_transitions` table, surfaced to dashboard kanban + task detail
- Blob store deduplication for LLM prompts — linked via `/api/blob/:prefix/:hash`

### Validated Flows
- Happy path: trigger → intake → all 7 phases → PR creation → feedback rework (S064)
- Multi-CLI: Claude Code, OpenCode, Gemini CLI all complete tasks end-to-end (S067)
- Rate limit: Gemini detected, task blocked with reason visible on dashboard (S067)
