# Future Considerations

Decisions that are intentionally deferred — not because they're uncertain, but because the v1 design explicitly doesn't need them yet. Each item describes when it becomes relevant and what the migration path looks like.

---

## Monorepo Evolution

**Current state (v1):** Single package. `src/core/`, `src/adapters/`, `src/plugins/`, `src/schemas/` are directory boundaries, not package boundaries.

**When it becomes relevant:** When third-party plugins need a separate, publishable SDK package they can `import` from — just the adapter interfaces, shared types, and event schemas. Not the entire Core internals.

**What a monorepo enables:**

```
packages/
  core/                  # The brain — depends on plugin-sdk
    src/
      task-engine/
      orchestrator/
      daemon/
      ...
  plugin-sdk/            # Publishable package — curated exports for plugin authors
    src/
      index.ts           # Re-exports adapter interfaces + shared schemas + event types
  plugins/               # Each plugin depends only on plugin-sdk
    github-trigger/
    telegram-comm/
    ...
```

**Migration path:** The v1 source layout is designed so that this extraction is a move-and-rename, not a restructure:
- `src/adapters/index.ts` already acts as the plugin-sdk re-export boundary → becomes `packages/plugin-sdk/src/index.ts`
- `src/schemas/` contains all shared types → moves to `packages/plugin-sdk/src/schemas/`
- `src/core/` → `packages/core/src/`
- `src/plugins/` → individual packages or `packages/plugins/` workspace

**Tools needed:** pnpm workspaces (already chosen, Decision #67), separate tsconfig per package (tsconfig references), potentially separate Vitest configs per package.

**Pattern reference:** OpenClaw uses `openclaw/plugin-sdk` as a curated re-export package for plugin authors. See [`4-implementation/openclaw-review.md`](4-implementation/openclaw-review.md) § Plugin SDK as curated re-export.

---

## Live Test Tier

**Current state (v1):** All tests run locally with fake plugins. No tests hit real external APIs (GitHub, Telegram, LLM providers).

**When it becomes relevant:** When CI is established and real API integration validation is needed beyond fake-based testing.

**What it enables:** A `vitest.live.config.ts` that runs tests against real external services, gated behind `ENGINEER_LIVE_TESTS=1`. Would run on a schedule (daily/weekly) in CI, not on every PR. Validates that real API responses still match our expectations.

**Migration path:** The test infrastructure (fake plugins, injectable clock) already supports this — live tests would use real plugins instead of fakes, but the same test harness and assertion patterns.

---

## CI Pipeline

**Current state (v1):** Enforcement via local git hooks only (lefthook: pre-commit Biome + tsc, pre-push unit tests).

**When it becomes relevant:** When the project is hosted on GitHub and automated PR validation is needed.

**What it enables:** Full test pipeline on every PR:
1. `pnpm biome check` (lint + format)
2. `pnpm tsc --noEmit` (type check)
3. `pnpm test:coverage` (unit tests + coverage enforcement)
4. `pnpm test:integration` (integration tests)
5. `pnpm test:e2e` (e2e tests)

**Migration path:** The three-tier Vitest configs (Decision #119) and coverage thresholds (Decision #121) are ready for CI. Just needs a workflow file (GitHub Actions or equivalent).

---

## Event Bus Runtime Payload Validation

**Current state (v1):** The Event Bus does not validate event payloads at runtime. Publishers are trusted internal components; type safety is enforced at compile time via `PublishInput<T>`. Per event-catalog.md (L3): "Schema validation is a development-time concern (tests), not a runtime concern."

**When it becomes relevant:** When third-party plugins can publish events, or when debugging payload mismatches becomes a recurring issue.

**What it enables:** Optional runtime validation using the `eventPayloadSchemas` registry (already exists in `src/schemas/events.ts`). Could be enabled per-environment (e.g., development mode only) or as a constructor option on `EventBus`.

**Migration path:** The `eventPayloadSchemas` record maps every `EventType` to its Zod schema. Adding validation to `publish()` is a single `safeParse()` call. Performance impact is negligible for development mode; production can skip it.

---

## Monorepo Test Configuration

**Current state (v1):** Single `vitest.config.ts` at project root. All tests in one package.

**When it becomes relevant:** When the single package is split into `core`, `plugin-sdk`, and individual plugin packages (see Monorepo Evolution above).

**What it enables:** Per-package Vitest configs with `vitest.workspace.ts` orchestration at the root. Each package runs its own unit tests. Integration tests that cross package boundaries live in a top-level `tests/integration/` directory.

**Migration path:** The test directory structure (Decision #120) is designed for this — co-located unit tests move with their source files, cross-cutting tests stay in `test/`. Contract compliance suites (Decision #122) move into the `plugin-sdk` package.

---

## Hybrid Semantic Memory Search

**Current state (v1):** Knowledge entries stored in SQLite, queried by structured fields (task, time range). No semantic search.

**When it becomes relevant:** When cross-task learning matures and the system needs to answer "what approach did we use for similar problems?" — queries that require semantic similarity, not exact field matching.

**What it enables:** Hybrid vector (70%) + BM25 keyword (30%) search over knowledge entries and journal, with temporal decay and MMR diversity for result quality. Pattern reference: OpenClaw's memory system (see [`considered-projects/openclaw.md`](considered-projects/openclaw.md) § Memory & Learning).

**Migration path:** Knowledge entries already have structured text fields. Add an embedding column, index with sqlite-vec (or equivalent), implement hybrid scoring. The knowledge table schema supports this without breaking changes.

---

## Context Budget Management

**Current state (v1):** No context window management designed yet. Orchestrator (Phase 11) will invoke LLMs but context budgeting is not specified.

**When it becomes relevant:** Immediately when the Orchestrator is built (Phase 11). Every LLM call burns tokens; context management is the primary cost lever.

**What it enables:** Prompt caching (80-90% cost reduction on supported providers), file truncation caps, on-demand loading (only include what the current phase needs), compaction of stale context. Pattern reference: OpenClaw's context management philosophy — "smarter prompting routinely outperforms larger models with dumb prompting."

**Migration path:** Design into the Orchestrator from Phase 11, not as a bolt-on. LLMAdapter contract already supports token tracking; add context budget as an Orchestrator concern that assembles LLM input per-phase.

---

## Deterministic Sub-Engine for Operational Tasks

**Current state (v1):** All Orchestrator phases are LLM-driven. Appropriate for engineering judgment (research, planning, code review), but wasteful for deterministic sequences (deploy steps, CI commands, test suites).

**When it becomes relevant:** When The Engineer handles operational side-tasks alongside engineering work — deploy sequences, CI/CD orchestration, repetitive multi-step procedures.

**What it enables:** YAML/JSON-defined pipelines for deterministic work: step sequencing, approval gates, resume tokens, retry + error handling. LLM handles creative work; deterministic engine handles plumbing. Pattern reference: OpenClaw's Lobster workflow engine (see [`considered-projects/openclaw.md`](considered-projects/openclaw.md) § Lobster).

**Migration path:** Implement as an optional ToolAdapter plugin. Orchestrator delegates deterministic sub-tasks to the engine; results feed back into the phase pipeline. Does not require Core changes.

---

## Mid-Phase Communication Interrupt Handling

**Current state (v1):** No defined semantics for what happens when a user sends feedback while the agent is mid-phase.

**When it becomes relevant:** When the Orchestrator is running real tasks and users send messages (Telegram, GitHub comments) during execution.

**What it enables:** Defined interrupt modes: steer (inject into current phase), queue as followup (process after current phase), collect and coalesce (batch related messages), interrupt (abort current phase, process new input). Pattern reference: OpenClaw's Lane Queue modes (see [`considered-projects/openclaw.md`](considered-projects/openclaw.md) § Lane Queue).

**Migration path:** Define as Orchestrator-level policy, configurable per communication channel. CommunicationAdapter already supports receive capability; add an interrupt routing layer between inbound messages and the active phase.

---

## Enum Constants from Zod Schemas

**Current state (v1):** Zod enum schemas (`TaskStateSchema`, `SubStateSchema`, `PluginHealthStateSchema`, `ActionClassSchema`, etc.) define the valid values, and TypeScript types are derived via `z.infer<>`. However, consuming code references values as raw strings — `"queued"`, `"healthy"`, `"working"`, etc. — scattered across `src/core/task-engine/`, `src/core/registry/`, `src/schemas/task.ts`, and tests.

**When it becomes relevant:** As the codebase grows beyond the current phases and more components reference state values. Raw strings become harder to track, refactor, and autocomplete.

**What it enables:** Zod's `.enum` property provides a const object for free. Exporting `const TaskState = TaskStateSchema.enum` alongside the existing `type TaskState` (TypeScript allows a type and const to share the same name) gives typed constants: `TaskState.intake`, `TaskState.queued`, `TaskState.active`, etc. Zero runtime overhead, full autocomplete, and typo-proof. Same pattern applies to `SubState`, `ActionClass`, `PluginHealthState`, `AdapterType`, `CascadePolicy`, and all other Zod enums in `src/schemas/`.

**Migration path:** Mechanical refactor — no logic changes:
1. In each schema file, add `export const X = XSchema.enum` for each Zod enum (e.g., `export const TaskState = TaskStateSchema.enum`)
2. Replace all raw string references with the const (e.g., `"queued"` → `TaskState.queued`)
3. Covers: `src/schemas/task.ts`, `src/schemas/adapters.ts`, `src/schemas/events.ts`, `src/core/task-engine/`, `src/core/registry/`, and all corresponding test files
4. The `ValidTransitions` and `PermissionTable` const arrays in `task.ts` benefit the most — currently ~80 raw string references

---

## GitHubCommPlugin `receive` Capability

**Current state (v1):** GitHubCommPlugin supports `send`, `sync`, and `issue_management` capabilities. The `receive` capability is omitted.

**What `receive` enables:** People in the People Directory communicating *with* The Engineer via GitHub issue/PR comments mid-flow. This is human-to-agent communication — interrupts, questions, direction, feedback — not triggering (that's TriggerAdapter's domain). Examples: a reviewer commenting "hold off on merging, I want to rethink the API" mid-execution, or the owner asking "what's the status of this?" on a tracked issue.

**Why it's deferred:** The full inbound communication flow requires several pieces that haven't been collaboratively designed yet:
1. **People Directory auth check** — inbound messages must be authenticated against the directory. Only recognized people can communicate with The Engineer.
2. **Message routing** — how inbound messages reach the Daemon/Orchestrator. The Daemon subscribes to `comm.message_received` events (Phase 14b implemented the query handler for this), but routing mid-flow messages to the correct active Orchestrator phase is a deeper design question (see "Mid-Phase Communication Interrupt Handling" above).
3. **Polling vs. webhooks** — receiving GitHub comments requires either polling issue/PR comment timelines or setting up GitHub webhooks. Decision #74 chose polling-only for triggers; the same question applies to inbound communication.

**When it becomes relevant:** When the system handles real tasks with human oversight — people wanting to steer, interrupt, or provide guidance to The Engineer through the same GitHub issues/PRs it's working on.

**Migration path:** The `CommunicationAdapter` base class already defines `receive` as an optional capability with `doReceiveMessages()`. Adding it to GitHubCommPlugin requires:
1. Implement `doReceiveMessages()` — poll issue/PR comment timelines for new comments from People Directory members
2. Filter out The Engineer's own comments and non-directory authors
3. Emit `comm.message_received` events (the Daemon subscription already exists from Phase 14b)
4. Design interrupt routing in the Orchestrator (see "Mid-Phase Communication Interrupt Handling")

---

## TelegramCommPlugin `receive` Capability

**Current state (v1):** TelegramCommPlugin supports `send` capability only. The `receive` capability is omitted.

**What `receive` enables:** People in the People Directory communicating *with* The Engineer via Telegram messages mid-flow. Same use case as GitHub `receive` — interrupts, questions, direction, feedback — but via Telegram's real-time chat interface.

**Why it's deferred:** Same unresolved design questions as the GitHub `receive` capability:
1. **People Directory auth check** — inbound messages must be authenticated against the directory. Only recognized people can communicate with The Engineer.
2. **Message routing** — how inbound messages reach the Daemon/Orchestrator during active task execution (mid-phase interrupt handling).
3. **Polling lifecycle** — grammy's `bot.start()` runs long-polling in the background. Managing this alongside the Daemon's tick loop requires careful coordination (start on init, stop on shutdown, error recovery).

**When it becomes relevant:** When bidirectional Telegram communication is needed — people wanting to steer, interrupt, or query The Engineer through the same chat where it sends notifications.

**Migration path:** The `CommunicationAdapter` base class already defines `receive` as an optional capability with `doStartListening()`/`doStopListening()`. Adding it to TelegramCommPlugin requires:
1. Implement `doStartListening()` — call `bot.start()` with grammy's long-polling, wrap inbound messages in `InboundMessage`
2. Implement `doStopListening()` — call `bot.stop()`
3. Authenticate inbound messages against People Directory (match Telegram user ID to directory entries)
4. Emit `comm.message_received` events (the Daemon subscription already exists from Phase 14b)
5. Design interrupt routing in the Orchestrator (shared with GitHub — see "Mid-Phase Communication Interrupt Handling")

---
