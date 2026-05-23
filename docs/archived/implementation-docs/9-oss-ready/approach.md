# Approach

## How We Work Together

Two co-founders. Equal ownership. Farzam brings taste, product vision, decision-making, and the final call on every tradeoff. The agent brings refactoring ability, pattern recognition, proactive problem-finding, and relentless attention to detail.

### Co-Founder Rules

- **Never assume.** When uncertain, ask. When "pretty sure," still ask. Assumptions become bugs.
- **Push back.** If something smells wrong, say so. If a better approach exists, propose it. Silence is not agreement.
- **Be proactive.** Don't wait to be asked "anything else?" Think ahead. Raise concerns. Find gaps. More is always better than less — even if some get discarded.
- **Human time is sacred.** Never make Farzam repeat himself. Everything valuable gets documented. Context is preserved across sessions.
- **Every commit is a ready-to-go package.** Never commit broken code. Within a session, things can be temporarily broken mid-refactor — but every commit is green, every slice ends complete.
- **No coming back.** Every slice is done fully and completely before moving on. There are no follow-ups, no "we'll fix it later." Do it right now or don't do it.
- **Pragmatic, not pedantic.** Don't do things for the sake of doing them. Tests that test nothing useful get deleted. Abstractions that serve no one get removed. Every line earns its place.

### RRPIR for Each Slice

Each slice follows The Engineer's own methodology:

1. **Requirements Gathering** — Probe for scope, edge cases, acceptance criteria. Use the requirements-gathering skill mindset. One question at a time. Never volunteer to stop.
2. **Research** — Read actual source code. Assess current state. Don't trust old docs — verify against reality. Ask Farzam when docs conflict with code.
3. **Planning** — Propose approach. Walk through each step via Q&A before finalizing. Get explicit agreement.
4. **Implementation** — Refactor, rewrite, test, document. Each commit is green.
5. **Review** — Step back. Is it beautiful? Is it simple? Would a stranger understand it? Does it pass the lenses?

### Tangents Are Welcome

During any slice, discoveries will surface that belong to other slices or need immediate attention. When this happens:

1. Flag it clearly
2. Decide together: handle now or park it?
3. If handling now: update active.md with "paused slice X at step Y, handling tangent Z"
4. Complete the tangent
5. Return to the slice, picking up exactly where we left off
6. Log the tangent in the session file

active.md is the single source of truth for "where are we."

---

## Strategy

### Vertical Slices

The system has a finite set of flows. Every line of code serves one of them. If every flow is perfect, the system is perfect. Nothing hides outside a flow.

Each slice is "done done" when:
- Code is refactored and beautiful
- Tests are solid (document behavior, not checkbox coverage)
- Permanent documentation exists in `docs/` for that area
- A stranger could read that slice's docs, understand it, and contribute to it
- All three lenses pass (see below)
- **A closing standards sweep has run.** As the final step before the slice is marked done, every file
  the slice created or changed is audited line-by-line against [`coding-standards.md`](../../../coding-standards.md),
  [`anti-patterns.md`](../../../anti-patterns.md), and [`philosophy.md`](../../../philosophy.md), and
  refactored where it falls short. Feature work passing is not the finish line — this sweep is. It runs
  as its own focused session (or sessions) so a clean context budget can do it justice. Never mark a
  slice done without it.

  **The sweep is not just "read every file against the standards."** Line-by-line reading is necessary
  but not sufficient — past sweeps have read carefully and still missed real defects. The principles
  below are what a reader misses unless they actively hunt for them; treat each one as a deliberate
  check, not a passive expectation:

  - **Every documented reference must match the code as it is now.** Paths, filenames, config keys,
    model identifiers, default values, function names, capability names — verified by grep against the
    actual codebase, not by reading the doc and assuming. Bundled docs (`src/cli/bundled/plugin-docs.ts`)
    must match their source under `docs/` *and* the source under `src/`. A doc that tells a contributor
    to import from a path that does not exist is worse than no doc.
  - **Every plugin manifest must match the implementation's behavior.** If an `override hasCapability`
    or a `do*` method claims a capability, the manifest's `adapter_meta.capabilities` must include it.
    The manifest is the source of truth Core reads — the override is a fallback for genuine dynamic
    cases, not a substitute for fixing the manifest.
  - **Every swallowed error must be logged.** A `try { ... } catch { /* non-fatal */ }` is a silent
    degradation unless a `warn` or `info` line names what failed and what capability was reduced. Bare
    catches without logs violate § 15 of the coding standards and § Fail Loud of the philosophy. The
    comment explaining the swallow stays — the log makes the swallow *visible*.
  - **`manifest` is read-only to the plugin.** Core injects it as identity; plugins read it and never
    assign to fields on it. Any `this.manifest.X = ...` is a contract violation, even if the value is
    only slightly customized at runtime — propose a Core-side setter instead.
  - **Every constant value lives in one place.** A model id, a default port, a magic threshold — if it
    appears in two files, the second must be a derived computation or an import, never a literal repeat.
    Coding standards § 11.
  - **No stale counts in docs.** "All N methods are implemented", "7 categories", "5 sub-states" — these
    rot the moment the underlying enum grows. Enumerate by name or behavior, never by count. See
    `feedback_no_stale_counts.md`.
  - **No vestigial scaffolding.** A function exported but only used by tests, a config field parsed but
    never read, an event type declared but never published or subscribed — delete it. Honest code over
    tested-but-dead infrastructure.
  - **Update memory when the sweep finds something new.** Any class of defect the line-by-line read
    missed but the principle-driven check caught becomes a permanent addition to
    `feedback_slice_closing_standards_sweep.md` so the next sweep starts from this baseline, not from
    scratch.

  These are derived from defects past sweeps missed and a later session caught. Every item below was
  once "a line-by-line read should have caught it" — and didn't, because reading carefully is not the
  same as hunting deliberately. The next sweep starts here, not from the standards files alone.

### The Slices

1. **Standards Alignment** — Probe Farzam for coding style, naming, patterns, expectations. Establish the law for all subsequent slices.
2. **Repo Readiness** — CI, git hooks, linters, dependency audit, migration consolidation, quality guardrails. The enforcement layer everything else benefits from.
3. **Dashboard** — Complete rewrite. Exposes all API/data gaps that inform later slices.
4. **Startup & Configuration** — CLI entry, bootstrap, plugin loading, daemon startup. First impressions.
5. **Trigger & Requirements Flow** — Trigger polling, dedup, task creation, requirements gathering contacts.
6. **Scheduling & Dispatch** — Priority, eligibility, slot management, concurrency.
7. **Workspace & Session** — Worktree lifecycle, session setup, resume, thoughts/ directory.
8. **RRPIR Phases** — Requirements → Research → Planning → Implementation → Review pipeline.
9. **Demo & PR** — Commit, push, draft PR, PR narrative from thoughts/ files.
10. **Review & Feedback (External)** — External review polling, feedback detection, rework loop.
11. **Completion & Cleanup** — Terminal states, notifications, workspace cleanup, parent integration.
12. **Communication** — Notification wiring, message formatting, channel routing.
13. **Background Services** — Cost tracking, data lifecycle, health monitoring.
14. **Agent Readiness** — All docs work as agent prompts. Contribution guides are executable.
15. **Dashboard Revisit + Final Polish** — Docs site (VitePress on GitHub Pages), demo mode, license, design-history archive.
16. **npm Publish Readiness** — Build output, public API surface, exports, package structure, metadata, registry prep. Real engineering if restructuring is needed.

### Cross-Slice Discovery

Each slice has its own file in `slices/`. When working on one slice reveals issues belonging to another:
- Add a note in the affected slice's file under "Discovered from other slices"
- Decide together whether to handle now (tangent) or when we reach that slice

---

## Lenses

Applied to every slice. Not phases — perspectives. Every piece of work is evaluated through all of them.

### 1. Resilience

What happens when this breaks? Can it recover? Can the user understand what happened? Can they unstick it?

- Error messages are clear, actionable, diagnosable
- Failures are loud, never swallowed
- Recovery paths exist and are tested
- The owner is never in the dark

### 2. Plugin Integrity

Is this generic? Would Core still work if you swapped every plugin?

**Why this matters:** This is the moat. Agents (including us) constantly forget and hardcode for one specific plugin. This lens actively hunts that pattern.

**What to watch for:**
- Core reaching through adapters to know which plugin is behind them
- Hardcoded plugin names, tokens, or platform-specific logic in Core
- Assumptions about which plugins are installed
- Config that only makes sense for one specific plugin

**The test:** "If I deleted every plugin and replaced them with completely different implementations, would Core still compile and function?"

**Development strategy:** We develop and test with one plugin per adapter type (Claude CLI for LLM, GitHub for trigger/hosting, Telegram for comms). The abstraction stays generic. Others are preview — they should work, but we're honest about what's proven vs. untested.

### 3. Plugin Authoring Simplicity

Is it easy to write a new plugin? Could someone do it in under 50 lines?

- The adapter contract is obvious
- The manifest format is intuitive
- A reference implementation exists and is readable
- The compliance test suite validates correctness automatically
- If it's hard, the abstraction is wrong

### 4. UX Quality

Every error, every message, every CLI output — is it clear to someone with no context?

- Error messages are sentences, not stack traces
- CLI output is scannable
- Configuration has smart defaults
- Setup is path-of-least-resistance
- The "5-minute clone-and-run" experience works

---

## Testing Philosophy

Tests exist to document behavior and catch real regressions. Not for coverage numbers.

- **Delete bullshit tests.** If it tests a constructor call, an obvious getter, or an implementation detail — kill it.
- **Keep behavior tests.** If removing this test means a real bug could ship undetected — keep it.
- **Tests are documentation.** A well-named test tells you what the system guarantees. Read the test names and understand the contract.
- **Pragmatic and efficient.** Don't test for the sake of testing. A pro engineer writes tests that matter.
- **Net count may go down.** That's fine. Fewer, better tests > many meaningless ones.

---

## Trust Hierarchy

When information conflicts:

1. **Actual source code** — always truth
2. **Farzam's words** — intent and direction
3. **docs/ folder** — current documentation (maintained per-slice)
4. **implementation-docs/** — historical context, may be outdated
5. **Memory** — persistent but verify against code

Old implementation-docs are hints, not truth. Always verify against source. When in doubt, ask Farzam.

---

## Universal Rules

These apply to every slice, every session, no exceptions:

- **Zero backward compatibility.** Pre-v1. Clean slate. No migrations, no deprecation paths, no shims.
- **Consolidate migrations.** All database migrations are rewritten as if created in one session.
- **Prompts are preview.** Not perfected. Contributors can refine. We focus on everything else.
- **Main branch.** Branches only when temporarily breaking things. Must be organized.
- **No CLAUDE.md.** Agent-agnostic project. No tool-specific instruction files.
- **One protocol governs all agents.** The system is swap-safe by design.

---

## Session Protocol

### Starting a Session

1. Read `active.md`
2. Read the current slice file
3. Read `approach.md` if it's been a while or context feels thin
4. Confirm understanding with Farzam before doing anything

### Ending a Session

1. Update `active.md` with current state, what's done, what's next
2. Write session log in `sessions/N.md`
3. Update current slice file if needed
4. Update memory if persistent decisions were made

### active.md Rules

- **Permanent header** — always links to vision.md, approach.md, and current slice. Never removed.
- **Current state section** — updated every session end. What slice, what step, what's pending.
- **This is the single source of truth** for "where are we right now."

---

## Future Considerations

Ideas beyond v1 scope are documented in `docs/future-considerations.md` (a fresh file grounded in current reality, replacing the potentially outdated implementation-docs version). Good ideas get captured. Scope stays focused.
