# Status

## Current Phase

**RRPIR Implementation — Session 070 DONE.** Planning + execution wired to CLI-native (4/7 phases). Universal fallback routing: any phase → requirements_gathering → return to calling phase. External blocking with persistent `return_to_phase` (DB migration 007). Crash recovery via session-result.json detection. Key design decision: session-result.json is pure routing, .md files carry all rich context. Post-commit triple review → refinement pass (schema validation, state mutation safety, test deduplication).

## Last Session

Session 070 (2026-03-22): Planning + execution → CLI-native. Universal fallback routing (returnToPhase on PipelineState). External blocking with return_to_phase persistence (migration 007, task schema, row mapper, task engine). Crash recovery prompt. Separation of concerns documented in rrpir-design.md. Decomposition from plan.md deferred to future-considerations.md. 5 new tests, 2285 total. Triple review (simplify + persona + PR reviewer) → refinement pass. See `sessions/070.md`.

## Next

1. **Session 071 — Review Pipeline + Demo/PR** — Configurable multi-phase review, refinement pass, PR with thoughts/ files.
2. **Session 072 — Agent Loop Removal** — Remove agent-loop.ts, action-executor.ts, phase-tools.ts, migrate remaining phases to CLI-native.
3. **Session 073+ — RRPIR Refinement** — Live testing, prompt tuning, cross-CLI validation.

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
- File-first routing: session-result.json (status, next_phase, summary) replaces signal protocol
- thoughts/ directory is task-scoped: `thoughts/{date}-{thoughts_id}/` with phase subdirs
- thoughts_id flows from trigger plugin → task → workspace → orchestrator (Core never derives it)
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
