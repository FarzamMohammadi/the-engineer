# Status

## Current Phase

**RRPIR Design — DONE.** Full methodology designed: Requirements Gathering → Research → Planning → Implementation → Review. CLI-native agent architecture. Universal requirements fallback. Multi-phase configurable review pipeline. See [rrpir-design.md](rrpir-design.md).

## Last Session

Session 068 (2026-03-22): CLI-native philosophy pivot + RRPIR methodology design. Researched RPI ecosystem (HumanLayer, Goose, Burleigh RPIR, patrob). Designed The Engineer's own RRPIR methodology. Four new architecture decisions. Six design concerns flagged with resolution plans. See `sessions/068.md`.

## Next

1. **Session 069 — Requirements Gathering + Research** — Rename intake_analysis, signal protocol, People Directory wiring, thoughts/ setup, CLI-native prompts, requirements ↔ research loop. First live test of RRPIR.
2. **Session 070 — Planning + Implementation + Universal Fallback** — Plan file with checkboxes, implementation reads plan, any-phase-to-requirements routing, crash recovery.
3. **Session 071 — Review Pipeline + Demo/PR** — Configurable multi-phase review, refinement pass, PR with thoughts/ files.

See [roadmap.md](roadmap.md) for full session plan through 073+.

## Open Questions

None currently. All RPI design questions resolved in Session 068 design process.

## Architecture Knowledge

Permanent discoveries that affect how we build. Resolved bugs removed — they're in the code now.

### RRPIR Methodology
- RRPIR = Requirements Gathering → Research → Planning → Implementation → Review
- Each phase = one CLI session. Fresh context window. File-based handoffs via `thoughts/` directory.
- Requirements Gathering is a universal fallback — any phase can invoke it when stuck
- Review is a configurable pipeline of focused sub-phases (requirements check, security, code quality)
- Plan file checkboxes are crash-safe progress trackers
- Signal protocol: `ENGINEER_SIGNAL: {"status": "ready"}` at end of CLI output for reliable parsing
- `thoughts/` files appear in PRs by default (configurable via `rrpir.include_thoughts_in_pr`)

### CLI-Native Architecture (Revises D143)
- CLI tools are full agents, not inference providers — they run natively in the worktree
- The Orchestrator provides prompts + reads deliverable files, doesn't parse JSON actions
- Agent loop (`agent-loop.ts`, `action-executor.ts`, `phase-tools.ts`) to be removed in Session 072
- The Engineer's value is orchestration, not reimplementing CLI capabilities

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
