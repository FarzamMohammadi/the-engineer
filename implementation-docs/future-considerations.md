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

## OS-Specific Plugin Selection

**Current state (v1):** All plugins are built and tested on macOS. Platform-specific functionality (macOS Keychain for credential access, `security` CLI for OAuth token reading) works on macOS only. Linux and Windows users may need to adapt credential access methods.

**When it becomes relevant:** When users on Linux or Windows want to run The Engineer with full plugin functionality, including quota tracking that requires provider credential access.

**What it enables:** OS-aware plugin installation flow:
1. Detect user's operating system during `engineer init` or plugin setup
2. Filter available plugins to those compatible with the detected OS
3. Present only compatible options, with clear warnings for partial support
4. Platform-specific credential access abstracted per OS (macOS Keychain, Linux libsecret/file, Windows Credential Manager/file)

**Current workaround:** The `contribution-docs/how-tos/plugins/` directory includes LLM-guided setup prompts. Users point their LLM CLI at the setup prompt, and the LLM detects their OS and guides them through platform-appropriate setup — including adapting credential access for their platform.

**Migration path:**
1. Abstract credential access into a `CredentialProvider` interface with OS-specific implementations
2. Add OS detection to plugin manifests (`supported_platforms: ["darwin", "linux", "win32"]`)
3. `engineer init` filters plugins by `process.platform` before presenting options
4. Each plugin's `doInitialize()` validates platform compatibility and warns on unsupported OS
5. Document per-platform setup in each adapter's README (or rely on LLM-guided setup)

---

## Decomposition Detection from plan.md

**Current state:** Decomposition triggers from `planningOutput.data.decomposition_plan` (agent loop structured output). With CLI-native planning (Session 070), this field is absent — CLI-native PhaseOutput contains `deliverable_path`, `status`, `next_phase`, `summary` instead.

**When it becomes relevant:** When a task is complex enough to require decomposition into child tasks and planning is CLI-native.

**What it enables:** The planning phase CLI writes a `## Decomposition` section in plan.md with a JSON code block containing the decomposition plan. The Orchestrator parses this and feeds it to the existing `handleDecomposition()` pipeline.

**Migration path:**
1. Add `parseDecompositionFromPlanFile()` function to `decomposition-handler.ts` — reads plan.md, extracts `## Decomposition` section, parses JSON code block, validates against `LLMDecompositionPlanSchema`
2. Update planning prompt (`prompts/planning.ts`) to include JSON template for the decomposition section
3. In `phase-runner.ts` planning check: detect CLI-native output (has `deliverable_path`, no `decomposition_plan`), read plan.md, parse, inject into output before calling `handleDecomposition()`
4. Existing `handleDecomposition()` stays unchanged — it still expects `decomposition_plan` in output data

---

## Automatic Unblocking on Response

**IMPLEMENTED** (Session 071). Trigger poller checks blocked tasks before creating new tasks. Matching on `external_ref` (repo + number). `blocked → queued` transition added. Health monitor timeout escalation kept as fallback.

---

## Telegram Receive Capability

**Current state:** Telegram plugin is send-only. The Engineer can message people but can't receive replies via Telegram. Responses currently come through trigger polling (e.g., GitHub issue comments detected by TriggerAdapter).

**Design:** Add `receive` capability to CommunicationAdapter contract. Telegram plugin implements via webhook or long-polling. Received messages routed through the same `comm.message_received` event the daemon already subscribes to. The daemon matches incoming messages to blocked tasks and unblocks them.

**Principle:** Goes through CommunicationAdapter contract, not Telegram-specific code. Any future comm plugin (Slack, Discord, email) that implements `receive` capability works the same way.

---

## `engineer telegram-setup` CLI Command

**Current state:** Users must manually get their `TELEGRAM_CHAT_ID` by messaging the bot and calling Telegram's `getUpdates` API.

**Design:** `engineer telegram-setup` command that:
1. Prompts user: "Send /start to @YourBotName on Telegram"
2. Polls `getUpdates` for ~60 seconds
3. When message arrives, extracts `chat.id`
4. Writes to plugin config automatically
5. Done — never needs manual `TELEGRAM_CHAT_ID` again

---

## Plugin How-To Guides

Each adapter type needs a "How to build a plugin" guide so contributors can add new integrations without reading Core code. One guide per adapter type:

- **TriggerAdapter** — How to build a trigger plugin (poll for events, produce `TriggerEvent[]` with `external_ref`, idempotency keys, watermarks). Example: building a GitLab MR trigger, a Jira ticket trigger, or a webhook receiver.
- **CommunicationAdapter** — How to build a comm plugin (send messages, format for your platform, capability gates for send/receive/sync/issue_management). Example: building a Slack plugin, a Discord plugin, an email plugin.
- **LLMAdapter** — How to build an LLM plugin (spawn CLI process, pipe prompt via stdin, parse output, report cost/tokens, detect rate limits). Example: building a plugin for a new CLI tool.
- **ToolAdapter** — How to build a tool plugin (describe capabilities, execute within workspace confinement, ToolExecutionContext). Example: building a custom tool plugin.
- **GitHostingAdapter** — How to build a git hosting plugin (PR lifecycle: create, update, merge, get status, list comments). Example: building a GitLab hosting plugin.

**Format:** Each guide should include the adapter interface, required vs optional methods, capability gates, manifest format (`engineer.plugin.yaml`), config schema, a minimal working example, and how to register/test.

**Location:** `docs/plugins/` or `implementation-docs/plugin-guides/`

---

## Interactive Reconfiguration via `engineer start`

**Current state:** First-run setup is handled by `engineer start` with auto-detection + guided plugin selection. To change configuration after initial setup, users must `engineer stop`, manually edit YAML files in `~/.engineer/config/`, and `engineer start` again.

**When it becomes relevant:** When users frequently change plugin selections, add/remove repos, or switch LLM providers and want a guided experience instead of manual YAML editing.

**What it enables:** `engineer start --reconfigure` (or auto-detection of config changes) that:
1. Detects existing config and shows current state
2. Prompts: "Modify current configuration?" with options per category (plugins, core, safety)
3. Walks through only the changed sections, preserving everything else
4. Handles plugin additions/removals gracefully (deregister old, register new)

**Migration path:** The schema-driven prompt infrastructure built for first-run setup is reusable. The main complexity is diffing current config against desired state and handling partial changes without breaking running state. Requires careful handling of plugin lifecycle (shutdown old plugin before removing config, initialize new plugin after writing config).

---

## Sandboxed Task Execution

**Current state (v1):** Claude CLI runs as a direct child process of the Daemon, sharing the host filesystem and network. It has full access to `~/.engineer`, the `engineer` CLI, and any system command.

**Observed incident:** Task "Update seed-example config claude code model to opus" was assigned to work on The Engineer's own repo. Claude CLI's planning phase wrote a plan that included `Run scripts/reset.sh` as a test step. During execution, it ran the script — which calls `engineer stop`, killing its own parent daemon. The daemon restarted via crash recovery, resumed the task, and Claude ran the same plan again — killing itself a second time. Repeated 3 times before manual intervention.

**Why sandboxing is needed:**
1. **Self-harm:** Tasks on The Engineer's own repo can kill the parent daemon (`engineer stop`, `scripts/reset.sh`, PID file manipulation).
2. **Cross-task interference:** Concurrent tasks sharing the host filesystem can collide — one task modifying files, installing packages, or killing processes that another task depends on. Without isolation, concurrent execution is inherently unsafe.
3. **Untrusted input:** Task descriptions come from GitHub issues (external input). A malicious issue could craft instructions that manipulate the host system.
4. **Unbounded access:** The CLI can read `~/.engineer/config/`, access API keys in `.env`, modify the database, or interact with any host service.

**What it enables:** Full process isolation via OS-agnostic containerization (Docker). Each CLI invocation runs inside a container with:
1. The worktree mounted as a volume (read-write)
2. Git credentials injected via env vars (not host SSH agent)
3. Claude CLI binary + API key available inside the container
4. No access to `~/.engineer`, PID files, or the host daemon process
5. `--dangerously-skip-permissions` enabled (safe because the container IS the sandbox)
6. Network access scoped to git push/pull and LLM API calls

**Architecture:**
- Base Docker image: Node.js + Claude CLI + git (built/pulled once, cached)
- The Engineer's WorkspaceManager creates the worktree on the host, then mounts it into the container
- Container runs the Claude CLI command, streams NDJSON output back to the host via stdout
- Container is ephemeral — destroyed after each CLI invocation
- Fallback to direct spawn if Docker is unavailable (with a warning)

**Migration path:**
1. Abstract CLI spawning behind a `SpawnStrategy` interface (direct vs. containerized)
2. Build a `DockerSpawnStrategy` that wraps the existing `spawnAndParse()` logic
3. Add `sandbox.enabled` and `sandbox.image` to config
4. `doctor` checks Docker availability when sandbox is enabled
5. Existing `ClaudeCodeLLMPlugin.spawnAndParse()` delegates to the active strategy

---

## Session Evaluation & Benchmarking

**Current state (v1):** No way to measure whether prompt or strategy changes improve or degrade session quality. Changes are evaluated by gut feel — run a task, eyeball the result, hope it's better.

**Why this matters — observed problems (Session 069, April 2026):**

Trace analysis of real autonomous sessions revealed severe inefficiencies compared to interactive Claude Code sessions:

1. **Output per turn: 12 tokens (autonomous) vs 342–520 tokens (interactive).** The autonomous model enters a pure tool-call loop — one Read, one Grep, one tool per turn — with no batching, no synthesis between reads, no planning. Each turn re-sends the full conversation history (~35k avg) for 1 token of output.

2. **Input:output ratio: 2,748:1 (autonomous) vs 618:1 (interactive).** The autonomous sessions consume 4.5x more input per unit of output. A simple config flag research phase burned 5M tokens across 137 turns to produce a 10k-char research.md.

3. **Prompts don't scale with task complexity.** The research prompt has a 13-section template and instructs "trace execution paths end-to-end," "inventory every instance," "challenge what you found" — the same heavyweight checklist regardless of whether the task is adding one boolean config field or redesigning the architecture. The model obeys: it explores exhaustively because the prompt says to.

4. **Sub-agent duplication.** Research spawned 3 parallel sub-agents that independently read the same files (`phase-runner.ts` read 9 times, `config.ts` 7 times, `pr-manager.ts` 6 times). The parent agent then re-read key files because sub-agent results are compressed summaries. ~70% of the research cost was duplication.

5. **Discovery of known context.** Demo-prep wasted 19 turns (7 failed path guesses + 12-turn sub-agent) discovering the worktree path and thoughts directory structure — information the Orchestrator already has but doesn't inject.

Without measurement, we can't tell whether fixes to these problems actually work. A prompt change might cut turns by 30% but miss a key file. Complexity-adaptive routing might route incorrectly. We need a feedback loop.

**When it becomes relevant:** Before any further prompt or session strategy refinement. Every change from here should be measurable.

**What it enables:**

1. **Frozen benchmark tasks** — 3 task definitions stored in the repo (not GitHub issues) at different complexity levels: simple (config flag addition), moderate (new feature touching 5–6 files), complex (cross-cutting change). Fixed descriptions, fixed codebase snapshot (git tag). Same input every time so the only variable is the prompt/strategy.

2. **Metrics extraction** — a script that reads any trace directory (`~/.engineer/traces/sessions/`) and outputs a structured scorecard: turns, total tokens, output/turn ratio, file re-read count, cost estimate, peak context, files read list. The trace infrastructure already captures everything needed (NDJSON with full usage data per turn).

3. **Results history** — each benchmark run appends to a log with: date, benchmark task, prompt/strategy version, the scorecard. This is the trend line — did the last change help or hurt?

4. **Quality assessment** — starts with human review (pass/fail + one-line note on the deliverable). LLM-as-judge or golden-output diffing can be added later, but human judgment is the ground truth for v1.

**Workflow:** Make a prompt change → run the simple benchmark → check the scorecard → check the deliverable → log it. ~10 minutes per iteration.

**Migration path:**
1. Create `test/benchmarks/tasks/` with 3 frozen task definitions (title, description, acceptance criteria)
2. Tag a codebase snapshot (`git tag benchmark-v1`) as the fixed evaluation target
3. Build `scripts/analyze-trace.ts` — reads trace NDJSON, outputs JSON scorecard (turns, tokens, output/turn, re-reads, cost, peak context, files list)
4. Build `scripts/run-benchmark.sh` — runs a benchmark task through The Engineer against the tagged snapshot, captures trace
5. Create `test/benchmarks/results/` — append-only log of run results with scorecard + human notes
6. Add `scripts/compare-runs.ts` — side-by-side comparison of two benchmark runs

---
