# Status

## Current Phase

**AI-as-Judge Evaluation System — DONE.** Config-gated (`evaluation.enabled`) quality assessment. Two independent CLI sessions per completed task: Session 1 (blind plan — judge gets only the ticket, explores codebase read-only) → Session 2 (comparison — judge sees its plan + The Engineer's full output, produces 1-5 verdict). Results at `~/.engineer/evaluations/{task-id}/`. Fire-and-forget with shutdown drain. D178.

Previous: **RRPIR Implementation — Session 071 DONE.** All 7/7 phases CLI-native. Configurable multi-phase review pipeline.

## Last Session

Session 071 (2026-03-22): Review pipeline + CLI-native migration of remaining 3 phases. `ReviewPhaseNameSchema` + `review_phases` config (default: `["requirements_check"]`). New `prompts/review.ts` (review sub-phase + refinement builders). `overridePhaseDir` on `runPhaseWithCli`. self_review handler runs N review sub-phases + 1 refinement, maps next_phase → quality_assessment for loopback compatibility. demo_prep → narrative-only (pr-manager reads pr-description.md from deliverable file). integration → CLI-native. Defense-in-depth loopback check. `pnpm lint` = biome + typecheck + knip + circular. 4 new tests, 2289 total. See `sessions/071.md`.

## Next

1. **Session 072 — Agent Loop Removal** — Remove agent-loop.ts, action-executor.ts, phase-tools.ts, json-parser.ts. Simplify llm-caller.ts. Update/remove ~200+ agent loop tests.
2. **Session 073+ — RRPIR Refinement** — Live testing, prompt tuning, cross-CLI validation.

See [roadmap.md](roadmap.md) for full session plan through 073+.

## Open Questions

None currently. All RPI design questions resolved in Session 068 design process.

## Mandatory Principles for ALL Layer 8 Work

These two principles apply to every session, every decision, every line of code from now through the end of the Layer 8 roadmap. They were learned the hard way in Session 079 (Trigger & Requirements Flow) and codified to prevent repeated violations.

### 1. Plugin Opacity — Core Sees Only Adapters

Fully documented in `docs/philosophy.md`. The single most important architectural discipline.

**Core never knows which plugins exist.** No hardcoded plugin names, no hardcoded tokens, no platform-specific checks in Core. Core speaks exclusively through adapter contracts. The test: "If I deleted every plugin and replaced them with completely different implementations, would Core still compile and function?"

This was violated repeatedly in earlier sessions — hardcoded GitHub tokens in setup validation, plugin names in doctor checks, platform-specific type-string checks (`"github_issue"`) scattered across Core files. Session 079's panel review found 6 active violations in production Core code. All are now on the plan for remediation.

**Every remaining roadmap phase must apply this lens:** Scheduling & Dispatch, Workspace & Session, Demo & PR, Review & Feedback, Completion & Cleanup, Communication, Background Services. Any decision that names a specific plugin or assumes a specific platform exists is a violation.

### 2. Fresh Project, Local-Only — No Backward Compatibility Tax

The Engineer is a fresh project. Each user/team runs their own instance locally on their own machine, with their own plugins, config, and data. There is no shared infrastructure, no multi-tenant deployment, no production data to migrate.

**What this means for every decision:**
- Schema changes are clean breaks. No dual-format unions, no migration scripts for old data, no backward compatibility shims.
- DB schema changes just update the SQL. No versioned migration chains needed for "existing users" — there are none at this stage.
- Config format changes just update the defaults. No deprecation periods.
- Event payload format changes just update the schema. No historical event replay concerns.
- Test fixtures update directly. No "support both old and new format" test matrices.

**This eliminates an entire category of complexity** that the expert panels kept raising (dual-format ExternalRef, event payload migration, response file format transition). The answer is always: clean break, update everything, move on.

**When this changes:** When The Engineer has external users with persistent data. At that point, backward compatibility becomes real. Until then, every minute spent on migration strategies is wasted. Document the eventual need in `future-considerations.md`, not in the current plan.

---

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
