# Future Considerations

Decisions that are intentionally deferred — not because they're uncertain, but because the v1 design explicitly doesn't need them yet.

> **Before adding or editing an entry, read this guide.**

## How to Write an Entry

This file stores ideas we might build months or years from now. The codebase will change underneath these entries constantly — file paths move, functions rename, phases renumber. **Write for durability, not precision.**

**What matters most:** the *context* around the idea. Why does it exist? What problem does it solve? What signals tell us it's time to build it? What constraints or lessons should the future builder know? These rarely go stale.

**What goes stale fast:** specific file paths, function names, phase/slice/decision numbers, migration steps that name concrete implementations. These rot within weeks of a refactor.

**Entry structure** (flexible, not dogmatic):
- **Current state** — what exists today, described conceptually (avoid specific file paths)
- **Why deferred** — why we're not building it now (optional, when the reason isn't obvious)
- **When it becomes relevant** — the signal that tells us it's time
- **What it enables** — the capability, described by what it does, not how it's coded
- **Key context** — lessons learned, incidents observed, constraints discovered, patterns worth referencing — anything that helps the future builder avoid our past mistakes or leverage our past thinking
- **Migration path** — high-level approach (concepts, boundaries, architectural layers), not implementation steps with file names

**The test:** if a refactor renames every file in `src/`, does the entry still make sense? If not, lift it higher.

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

**Migration path:** The source layout is designed so that this extraction is a move-and-rename, not a restructure. The adapters barrel already acts as the plugin-sdk re-export boundary. Schemas are in their own directory. Core and plugins are separate directory trees. Each maps cleanly to a workspace package.

**Tools needed:** pnpm workspaces, separate tsconfig per package (tsconfig references), potentially separate Vitest configs per package.

**Pattern reference:** OpenClaw uses a curated re-export package for plugin authors — similar idea to what our adapters barrel does today.

---

## Live Test Tier

**Current state (v1):** All tests run locally with fake plugins. No tests hit real external APIs (GitHub, Telegram, agent plugins).

**When it becomes relevant:** When CI is established and real API integration validation is needed beyond fake-based testing.

**What it enables:** A `vitest.live.config.ts` that runs tests against real external services, gated behind `ENGINEER_LIVE_TESTS=1`. Would run on a schedule (daily/weekly) in CI, not on every PR. Validates that real API responses still match our expectations.

**Migration path:** The test infrastructure (fake plugins, injectable clock) already supports this — live tests would use real plugins instead of fakes, but the same test harness and assertion patterns.

---

## Monorepo Test Configuration

**Current state (v1):** Single `vitest.config.ts` at project root. All tests in one package.

**When it becomes relevant:** When the single package is split into `core`, `plugin-sdk`, and individual plugin packages (see Monorepo Evolution above).

**What it enables:** Per-package Vitest configs with `vitest.workspace.ts` orchestration at the root. Each package runs its own unit tests. Integration tests that cross package boundaries live in a top-level `tests/integration/` directory.

**Migration path:** The test directory structure is designed for this — co-located unit tests move with their source files, cross-cutting tests stay in a shared test directory. Contract compliance suites move into the plugin-sdk package.

---

## Standing System-Prompt Context (Repo + Owner Preferences)

**Current state (v1):** The system prompt for every CLI session is built by a pure function
that concatenates four hardcoded constants (identity, operating standards, RRPIR methodology,
security boundary) plus a per-phase line. There is no injection point for owner-authored
standing context. No config field accepts free-form prompt text; no file on disk gets read
into the system prompt at session startup.

**Why deferred:** v1's system prompt is intentionally fixed — the same standards apply to
every task in every repo. Owner-authored standing context is a real capability, but earning
its place needs concrete signal from real autonomous sessions (the agent missed something
the owner could have said once and had stick) rather than speculative pre-design. Adding a
config-driven injection point without a clear use case shape would lock in the wrong shape.

**Distinct from cross-task memory.** This is *not* the cross-task memory layer described
above. That one is dynamic, agent-produced, queried by scope and similarity. This one is
**static, owner-authored, injected as-is** — closer to a CLAUDE.md / GEMINI.md / .cursor/rules
pattern, but plugin-agnostic. Two separate features that may eventually coexist.

**When it becomes relevant:** When the owner finds themselves correcting the same
repo-specific pattern or stating the same standing preference across multiple tasks —
the kind of thing they would have said in CLAUDE.md if there were one. That recurring
correction is the signal.

**What it enables:** Two pieces of owner-authored standing context, injected into the
system prompt of every CLI session at startup:

- **Repo knowledge** — per-repository conventions, gotchas, architectural facts the agent
  should know before reading a single file. Example: "this repo uses pnpm workspaces with
  a shared tsconfig.base.json; never run npm." Reduces wasted exploration on facts that
  never change.
- **Owner preferences** — standing personal preferences that apply across all tasks.
  Example: "always prefer named exports; never use `default`." Captures the kind of
  guidance that today lives implicitly in the owner's head and gets surfaced only via
  code review.

Both are pure text. The owner writes them once, edits them when they change. No schema,
no confidence levels, no supersession — that complexity belongs to the dynamic memory
layer, not this one.

**Key context — agent-agnostic, not CLAUDE.md.** Project philosophy explicitly rules out
per-tool instruction files (no CLAUDE.md, no GEMINI.md, no .cursor/rules). This feature
must respect that: the standing context lives in **The Engineer's** config and is fed into
the system prompt regardless of which agent plugin is running. The CLI plugin sees the
finished system prompt; it does not read a `CLAUDE.md` from the worktree.

**Migration path (high-level).**

1. **Where the owner writes it.** Two options the future builder picks between:
   - Inline text fields in an existing config (e.g., orchestrator config) — fine for short
     content.
   - File-path references in config pointing to markdown files the owner edits separately —
     better for long content; lets editor tooling apply.
   Per-repo overrides may emerge as a third axis (a repo-specific extension to the
   global repo-knowledge string).
2. **How it reaches the prompt.** The system-prompt builder takes the standing context as
   an input (instead of being parameterless beyond the phase). The orchestrator (or the
   layer that constructs the orchestrator context) loads the text once at startup and
   passes it through.
3. **Plugin-agnostic.** The standing context is appended to the system prompt at the Core
   level. Every agent plugin receives the same finished prompt — no plugin-specific shim,
   no CLAUDE.md-style on-disk file the plugin loads itself.
4. **Audit trail.** The standing context is part of the system prompt, so it lands in
   whatever transcript / observation the agent run produces. Owner can see what the agent
   actually saw.

---

## Cross-Task & Cross-Session Memory (supplementary)

**Current state (v1):** Per-task continuity between phases is handled entirely by the
file-based `thoughts/` protocol. Each phase prompt embeds the previous phases' deliverable
paths with explicit read-this-before-you-start instructions; the agent uses its native Read
tool to pull content. Files are filesystem-resident, survive crashes, ship with the PR for
reviewer context, and get cleanly removed from the branch before merge. No structured store
of "what we learned" persists across tasks or across sessions on different tasks.

**Why deferred — the pivot story:** An earlier design wired a consumer surface
(`KnowledgeStore` reads on every dispatch, threaded into every RRPIR prompt builder) for a
cross-task pattern-recall layer. **No producer was ever built** — nothing in the agent loop
ever decided "this fact is worth remembering" and persisted it. The reads returned empty
every dispatch for thirty sessions; the section never rendered. Rather than keep dead
consumer code waiting on a producer that did not exist, v1 removes the whole subsystem.
The files-as-primary approach already covers the *per-task* memory problem cleanly; the
knowledge layer was the unbuilt *cross-task* half.

**When it becomes relevant:** Post-v1, when real autonomous sessions show that the agent
would have made a different (better) decision had it known what an earlier task on this
repo learned, what an earlier session on this task tried, or what the owner's standing
preferences are — and that signal recurs often enough that recomputing from scratch each
time is a real cost. Speculative recall before that signal is just infrastructure without a
user.

**What it enables:** A supplementary memory layer on top of files. Three rough capability
shapes a future design might cover, individually or together:

- **Cross-task pattern recall** — "we faced this kind of bug last quarter; here's how it
  was solved." Persists across tasks on the same repo.
- **Cross-session continuity** — "you started this task two days ago and the codebase has
  shifted since; here is what you knew then versus now." Persists across resumes on the
  same task.
- **Owner preferences** — "the owner has corrected this pattern three times; default to
  the corrected form." Persists across tasks across repos.

**Key context — the producer is the hard problem.** The consumer side is straightforward:
inject relevant entries into prompts, let the agent read. The hard design problems all live
on the producer side: who extracts (the agent inline? a dedicated post-task pass?), with
what confidence semantics, how the owner rejects or supersedes wrong inferences, how stale
entries decay, how to avoid the agent gaming the layer by storing flattering self-quotes.
These earn answers from real demand, not pre-design. The dead consumer code shipped before
any producer was attempted should be a cautionary tale: design the producer first, and
only then a consumer shaped to match it.

**Migration path (open-ended).** Storage and retrieval are deliberately not prescribed —
the right shape is determined by the producer's output. Options the future builder may
consider:

- **Structured fields** — natural-key lookups (scope + key) over typed rows. Simple,
  exact, no embeddings needed.
- **Vector / hybrid search** — semantic similarity over entry bodies, optionally weighted
  with keyword search and temporal decay.
- **Knowledge graphs** — relationships between entries (this pattern supersedes that one;
  this gotcha applies in this codebase).

Pick the shape that fits the producer's output, not the other way around. The shape that
fit the v1 KnowledgeStore is no constraint — start fresh from what the producer actually
emits.

---

## Context Budget Management

**Current state:** The Orchestrator invokes the agent per phase but has no context budget — every call gets whatever context is assembled, with no cap or optimization.

**When it becomes relevant:** When token costs become a real concern or when prompts grow large enough that context window limits are hit. Every agent run burns tokens; context management is the primary cost lever.

**What it enables:** Prompt caching (significant cost reduction on supported providers), file truncation caps, on-demand loading (only include what the current phase needs), compaction of stale context. "Smarter prompting routinely outperforms larger models with dumb prompting."

**Migration path:** Context budgeting is an Orchestrator concern — it decides what goes into each agent run per phase. The AgentAdapter contract supports token tracking; the budget layer sits between "what context is available" and "what gets sent."

---

## Deterministic Sub-Engine for Operational Tasks

**Current state (v1):** All Orchestrator phases are agent-driven. Appropriate for engineering judgment (research, planning, code review), but wasteful for deterministic sequences (deploy steps, CI commands, test suites).

**When it becomes relevant:** When The Engineer handles operational side-tasks alongside engineering work — deploy sequences, CI/CD orchestration, repetitive multi-step procedures.

**What it enables:** Declarative pipelines for deterministic work: step sequencing, approval gates, resume tokens, retry + error handling. The agent handles creative work; deterministic engine handles plumbing. Pattern reference: OpenClaw's Lobster workflow engine uses a similar split.

**Migration path:** Implement as an optional ToolAdapter plugin. Orchestrator delegates deterministic sub-tasks to the engine; results feed back into the phase pipeline. Does not require Core changes.

---

## Mid-Phase Communication Interrupt Handling

**Current state (v1):** No defined semantics for what happens when a user sends feedback while the agent is mid-phase.

**When it becomes relevant:** When the Orchestrator is running real tasks and users send messages (Telegram, GitHub comments) during execution.

**What it enables:** Defined interrupt modes: steer (inject into current phase), queue as followup (process after current phase), collect and coalesce (batch related messages), interrupt (abort current phase, process new input). Pattern reference: OpenClaw's Lane Queue modes use a similar taxonomy.

**Migration path:** Interrupt handling is an Orchestrator-level policy, configurable per communication channel. The CommunicationAdapter contract supports receive; the missing piece is a routing layer between inbound messages and the active phase that decides which mode applies.

---

## GitHubCommPlugin `receive` Capability

**Current state (v1):** GitHubCommPlugin supports `send`, `sync`, and `issue_management` capabilities. The `receive` capability is omitted.

**What `receive` enables:** People in the People Directory communicating *with* The Engineer via GitHub issue/PR comments mid-flow. This is human-to-agent communication — interrupts, questions, direction, feedback — not triggering (that's TriggerAdapter's domain). Examples: a reviewer commenting "hold off on merging, I want to rethink the API" mid-execution, or the owner asking "what's the status of this?" on a tracked issue.

**Why it's deferred:** The full inbound communication flow requires several pieces that haven't been collaboratively designed yet:
1. **People Directory auth check** — inbound messages must be authenticated against the directory. Only recognized people can communicate with The Engineer.
2. **Message routing** — how inbound messages reach the Daemon/Orchestrator. The Daemon already handles some inbound events, but routing mid-flow messages to the correct active Orchestrator phase is a deeper design question (see "Mid-Phase Communication Interrupt Handling" above).
3. **Polling vs. webhooks** — receiving GitHub comments requires either polling issue/PR comment timelines or setting up GitHub webhooks. Triggers use polling-only today; the same question applies to inbound communication.

**When it becomes relevant:** When the system handles real tasks with human oversight — people wanting to steer, interrupt, or provide guidance to The Engineer through the same GitHub issues/PRs it's working on.

**Migration path:** The CommunicationAdapter base class already defines `receive` as an optional capability. Adding it to GitHubCommPlugin requires:
1. Poll issue/PR comment timelines for new comments from People Directory members
2. Filter out The Engineer's own comments and non-directory authors
3. Emit receive events so the Daemon can route them
4. Design interrupt routing in the Orchestrator (see "Mid-Phase Communication Interrupt Handling")

---

## Full Cross-Platform Support

**Current state (v1):** OS detection is built into first-run setup. macOS is fully supported, Linux is preview (works but not thoroughly tested), and unsupported platforms warn but allow the user to proceed. All built-in plugins are developed and tested on macOS. Platform-specific functionality (macOS Keychain for credential access, `security` CLI for OAuth token reading) works on macOS only.

**When it becomes relevant:** When users on Linux or Windows want to run The Engineer with full plugin functionality, including credential access and quota tracking.

**What it enables:**
1. Per-plugin OS compatibility filtering — add `supported_platforms` to plugin manifests, filter during setup
2. Platform-specific credential access abstracted per OS (macOS Keychain, Linux libsecret/file, Windows Credential Manager/file) behind a `CredentialProvider` interface
3. Thorough Linux testing and promotion from "preview" to "full" support
4. Windows support via POSIX compatibility layer or native adaptation

**Current workaround:** The plugin how-to guides include agent-guided setup prompts. Users point their agent CLI at the setup prompt, and the agent detects their OS and guides them through platform-appropriate setup.

**Migration path:**
1. Abstract credential access behind a provider interface with OS-specific implementations
2. Add platform compatibility to plugin manifests so setup can filter by OS
3. Plugin initialization validates platform compatibility and warns on unsupported OS
4. Invest in Linux CI and testing to promote to full support
5. Evaluate Windows POSIX options (WSL, Cygwin) for v2+ scope

---

## Task Decomposition (Parent → Children)

**Current state (v1):** Decomposition is **deliberately not in v1**. An earlier design wired a consumer surface across the scheduler, state machine, and event topology to handle a parent task splitting into children, but no producer was ever built — the CLI-native planning phase never emitted the structured decomposition plan the consumer expected. Rather than keep dead consumer code waiting on a producer that did not exist, v1 removes the whole subsystem.

**Why deferred:**
- **Never operational.** Zero real tasks have ever exercised decomposition. It only ever fired in unit and integration tests that injected the decomposition plan directly.
- **Philosophy alignment.** "Single agent per task, full context" beats committees of specialists. Phase handoffs lose context; parallel children on a shared repo invite merge conflicts.
- **YAGNI.** A meaningful slice of scheduler, state-machine, and event-bus code existed only to serve a feature that did not fire.
- **Reversibility.** Pre-v1, no backward compatibility. When decomposition becomes valuable post-v1, the right shape will be informed by real demand — not pre-baked guesses from before any user has tried it.

**When it becomes relevant:** Post-v1, when parallel sub-task execution has a concrete user scenario — not a speculative one. Likely indicators: recurring tasks that genuinely span independent areas of change, demand for explicit sub-task tracking, or a sub-agent / parallel-CI pattern that benefits from per-child isolation.

**What it would enable:** A parent task splits into N children. Each child runs the full RRPIR pipeline independently. When all children reach a terminal state, the parent resumes for integration — verifying the children compose and shipping coordinated output (one integrated PR, N coordinated PRs, or whatever the design lands on).

**Migration path (high-level):**

1. **Producer.** Decide how the planning phase emits a structured decomposition plan and teach the agent when/how to produce one. Today there is no producer surface at all.
2. **Consumer.** Re-introduce parent-aware scheduling: children gate on the parent's state, slot accounting distinguishes parent supervising vs child working, the parent resumes for integration when children finish, and re-queue paths land the parent back in the correct sub-state.
3. **State machine.** Give the parent the sub-states it needs (supervising while children run, integrating while combining their work, or whatever shape the design lands on) and make sure every queue ↔ active transition exists so a re-queued parent can resume correctly.
4. **Workspace boundary.** Decide whether each child gets its own isolated worktree or whether children serialize on a shared workspace. This is a workspace-layer decision; the scheduler should not pre-judge it.
5. **Cascade policy.** Re-introduce only the policies that have concrete user scenarios. Each one added should be driven by real demand, not by enum symmetry.
6. **Trigger thresholds.** If decomposition should auto-trigger above some complexity or time threshold, design the trigger surface deliberately. (The earlier `auto_threshold_ms` / `suggest_threshold_ms` config existed but was never read; treat that as a cautionary tale, not a starting point.)

---

## Plugin How-To Guides

Each adapter type needs an agent-executable "How to build a plugin" guide so contributors can add new integrations without reading Core code. The **AgentAdapter** guide exists and is the reference pattern. Three remain:

- **TriggerAdapter** — poll for events, produce `TriggerEvent[]` with a stable `idempotency_key` (identity/dedup) and optional `external_ref` (descriptive), plus watermarks. Example: a GitLab MR trigger, a Jira ticket trigger, or a webhook receiver.
- **CommunicationAdapter** — send messages, format for your platform, capability gates for send/receive/sync/issue_management. Example: a Slack, Discord, or email plugin.
- **GitHostingAdapter** — PR lifecycle (create, update, merge, get status, list comments). Example: a GitLab hosting plugin.

**Format:** follow the AgentAdapter guide — adapter interface, required vs optional methods, capability gates, manifest format, config schema, a minimal working example, and how to register/test, written as an agent-executable prompt. Guides live alongside the existing AgentAdapter guide in the contribution docs.

---

## Interactive Reconfiguration via `engineer start`

**Current state:** First-run setup is handled by `engineer start` with auto-detection + guided plugin selection. To change configuration after initial setup, users must `engineer stop`, manually edit YAML files in `~/.engineer/config/`, and `engineer start` again.

**When it becomes relevant:** When users frequently change plugin selections, add/remove repos, or switch agent plugins and want a guided experience instead of manual YAML editing.

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

**What it enables:** Each CLI invocation runs inside a sandbox confined to its worktree plus the specific network endpoints it needs (agent provider API, git remote). The sandbox prevents access to `~/.engineer`, the daemon's PID file, host SSH keys, other tasks' workspaces, and any host process beyond the agent itself. `--dangerously-skip-permissions` stays safe because the sandbox becomes the real boundary.

**Mechanism — deliberately open.** The right isolation mechanism depends on platform and workload. Candidates worth weighing when this lands:

- **Docker / OCI containers** — well-understood, cross-platform, but heavy (daemon dependency, per-invocation startup cost, file I/O penalty on macOS via 9p/virtiofs).
- **OS-native sandboxing** — `sandbox-exec` on macOS, `bubblewrap` or `firejail` on Linux. Lightweight, no extra runtime, native file I/O, but mechanism differs per OS.
- **Linux namespaces directly** — PID/mount/network namespaces give precise control with no extra dependency, but Linux-only.
- **Microvirtualization** — Firecracker, Apple Virtualization.framework. Strong isolation with fast startup; heavier than a container, lighter than a full VM.

The choice should be made when scoping the work, against real constraints (startup latency budget, host platforms, file I/O patterns of an agent that reads the worktree constantly). A single mechanism may not be optimal across every OS we support.

**Migration path:** Abstract CLI spawning behind a strategy interface (direct vs. sandboxed). The sandboxed strategy wraps the existing spawn logic with whichever mechanism is chosen. Config enables/disables sandboxing per task or globally. Doctor verifies the chosen sandbox is available before tasks run. Fall back to direct spawn (with a prominent warning) when the sandbox is unavailable.

---

## Session Evaluation & Benchmarking

**Current state (v1):** No way to measure whether prompt or strategy changes improve or degrade session quality. Changes are evaluated by gut feel — run a task, eyeball the result, hope it's better.

**Why this matters — observed problems:**

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

2. **Metrics extraction** — a script that reads trace data and outputs a structured scorecard: turns, total tokens, output/turn ratio, file re-read count, cost estimate, peak context, files read list. The trace infrastructure already captures everything needed.

3. **Results history** — each benchmark run appends to a log with: date, benchmark task, prompt/strategy version, the scorecard. This is the trend line — did the last change help or hurt?

4. **Quality assessment** — starts with human review (pass/fail + one-line note on the deliverable). agent-as-judge or golden-output diffing can be added later, but human judgment is the ground truth for v1.

**Workflow:** Make a prompt change → run the simple benchmark → check the scorecard → check the deliverable → log it. ~10 minutes per iteration.

**Migration path:** Frozen task definitions in the repo (not GitHub issues), a tagged codebase snapshot as the fixed evaluation target, a trace analysis script that produces a scorecard, and an append-only results log for trend tracking. The benchmark runner executes a task against the tagged snapshot; the comparison tool diffs two runs side-by-side.

---

## Config Schema Versioning

**Current state (v1):** Config files carry no schema version. There is one latest schema per config file, defined by Zod schemas. When a schema changes, users update their YAML manually to match. Plugin config templates are similarly unversioned.

**Why the earlier machinery was removed:** A `version` field and version-detection existed but did nothing useful — no template ever wrote a version, detection always returned `1`, and nothing consumed it. It was scaffolding without the actual migration logic. For a pre-v1 project with zero backward-compatibility guarantees, it was dead weight.

**When it becomes relevant:** Post-v1, once real users have config files on disk and a schema change would otherwise silently break their setup — i.e. when an upgrade must *migrate* an existing config rather than just expect the user to match the new shape.

**What it enables:** Explicit config-schema versioning — a version field per config file, a current-version constant, and a migration step at startup that detects an older version and either migrates it automatically or prompts the user.

**Migration path:** Add a version field to config schemas, a migration registry (version N → N+1 transforms) invoked at config load time, and a prompt/auto-migrate UX. The field alone is not versioning — the migration path and UX must ship together.

---

## Trigger Reversal / Stale-Work Detection

**Current state (v1):** Dedup is active-scoped — a completed/failed task frees its `idempotency_key`, so a re-triggered source (a reopened issue) spawns a fresh task. This handles the *forward* case. There is no detection for the *inverse*: the signal that created a task is reversed (issue closed/resolved, or a "stop" action that does not exist yet) while the task is still in flight, so the work goes stale.

**Scenario:** A GitHub issue triggers a task; the task reaches `review_pending` with an open PR. Meanwhile the issue is closed, resolved by someone else, or relabeled out of scope. Nothing notices — the task keeps living, the PR sits open and stale, and effort may continue on work nobody wants anymore.

**When it becomes relevant:** When tasks run against real issues with human oversight and sources change state mid-flight.

**What it enables:** Detection of trigger reversal plus a wind-down path — pause, abandon, or close the in-flight task and its PR when the source signal disappears or flips.

**Migration path:**
1. Trigger polling only surfaces open issues, so a close is invisible to the trigger — detection needs a separate signal (issue-state poll, webhook, or a CommunicationAdapter reconciliation pass).
2. A "stop through us" action does not exist yet; if added, it must move the task to a terminal state so active-scoped dedup frees the key for any future re-trigger.
3. PR-staleness reactions belong with review polling in the Daemon.

---

## Smart Reply Correlation

**Current state (v1):** When The Engineer blocks on a question, it appends the full task id to the outbound message with a plain instruction to keep the reference in the reply, and parses that token back to route the answer to the right task. Metadata-rich channels (GitHub issue/PR comments) correlate for free via `task_id` / `external_ref`. There is no inference: on a metadata-less channel (Telegram), a free-form reply that drops the token cannot be matched when more than one task is blocked at once.

**When it becomes relevant:** When the owner routinely replies without the token on a metadata-less channel while several tasks are blocked simultaneously, so the explicit-token fallback starts misrouting or discarding answers.

**What it enables:** A subagent that infers which blocked task a token-less reply belongs to — from the reply's content, the recency and content of each outstanding question, and conversation context — replacing the naive token requirement with a best-effort match (and still asking the owner to disambiguate when confidence is low).

**Migration path:** The naive token approach is implemented across the send side (outbound messages include the token) and the receive/parse side (inbound messages are matched by token). The inference layer slots in at the receive routing step as a fallback that runs only when no token is present — the deterministic path stays the default, so smart correlation is purely additive.

---

## Live Agent Session Transparency

**Current state (v1):** The CLI agent runs as a child process. Its output is consumed in two ways: (1) structured NDJSON events are parsed in real-time to extract the final result and rate-limit signals, and (2) raw output is optionally written to a trace file on disk via a configurable path. After execution, the observer stores structured observations (phase transitions, tool executions, agent runs, safety verdicts) in the database, and the dashboard queries them for after-the-fact inspection. What does *not* exist is a live, real-time stream of the agent's full activity visible to the owner while work is happening — the equivalent of watching the agent work.

**Why this matters — the transparency gap:**

Every modern AI application surfaces what the agent is doing as it does it — tool calls, file reads, search queries, reasoning steps, progress indicators. The owner can tell at any moment what the agent is working on, whether it's stuck, and whether it's heading in the right direction. The Engineer has no equivalent. During execution, the owner sees nothing until the phase completes and results appear. For long-running phases (research that takes minutes, implementation that spans many tool calls), this is a black box — exactly what the Radical Observability principle exists to prevent.

This is also a philosophical gap. The Engineer's philosophy demands that "every action, decision, and state change must be visible to the people who need to know — without requiring them to read logs, dig through code, or ask what happened." The structured observations satisfy the *after-the-fact* part of that promise. The *during-execution* part is unaddressed.

**What it enables:** A real-time stream of the CLI agent's full output — every tool call, file read, search, code write, reasoning step — visible to the owner as it happens. Like watching television: a live window into the agent's progress at each moment. The owner can observe, assess, and (combined with future interrupt handling) steer the agent mid-flight.

**Key considerations:**

1. **We don't control the CLI agent's output format.** The CLI tool (Claude Code, Codex, etc.) decides what it emits and how. Our transparency layer works with whatever the tool provides — structured JSON events, raw text, or a mix. The stream-json output format already emits tool calls, results, and text as they happen; the gap is surfacing that to the owner, not capturing it.

2. **Volume is a feature, not a problem.** Full transparency means full output. The owner should see everything the agent sees — not a filtered summary. Filtering, collapsing, or summarizing is a UI/UX concern for the consumer (dashboard, Telegram, etc.), not a capture concern. Capture everything; let the presentation layer decide what to foreground.

3. **Latency is acceptable.** Real-time means "seconds behind," not "zero latency." A small buffer for batching, formatting, or transport is fine. The goal is live awareness, not frame-perfect synchronization.

4. **Multi-task visibility.** When the Daemon runs concurrent tasks, each task's agent stream is independent. The owner should be able to watch one task, switch between tasks, or see an overview of all active sessions.

**When it becomes relevant:** When the system runs real tasks autonomously and the owner needs to monitor, trust, and occasionally intervene in agent behavior during execution — not just review results after the fact.

**Migration path:**

1. **Stream capture layer.** The CLI plugin already reads the child process's stdout in real-time for NDJSON parsing. Extend this to also emit each raw event (or line) through the observer as a streamable observation, not just extract the final result. The trace-file mechanism proves the data is available; the missing piece is routing it to a live consumer instead of (or in addition to) a file.
2. **Transport to the owner.** The dashboard or a communication channel (Telegram, a web socket endpoint) subscribes to the live stream for a given task. This is a new capability on the observer or dashboard layer — real-time event subscription, not just query-after-the-fact.
3. **Presentation.** The consumer decides how to render: a scrolling terminal view in the dashboard, periodic digest messages on Telegram, a full-screen "watch mode." The capture layer is format-agnostic; presentation adapts to the channel.
4. **Agent-agnostic design.** The stream capture works with any CLI tool's output format. When the plugin is swapped (Claude Code → Codex → another tool), the transparency layer adapts to whatever the new tool emits — the contract is "stream the child process output," not "parse Claude-specific events."

---

## Asynchronous Verification Gates

**Current state (v1):** The execution phase's verify step runs the project's verification gates (typecheck, lint, test) synchronously, blocking the daemon's event loop until each gate finishes. Fine at single-task concurrency, where the verifying task is the only thing running.

**When it becomes relevant:** When the daemon runs tasks concurrently, or when a gate is slow enough that stalling the daemon's other work (trigger polling, other tasks) becomes noticeable.

**What it enables:** Running the gates asynchronously so a long verify does not block the rest of the daemon — while the verdict stays orchestrator-owned and unfakeable.

---
