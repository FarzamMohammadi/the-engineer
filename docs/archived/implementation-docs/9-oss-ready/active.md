# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, 16-slice roadmap, session protocol
- Current slice: `slices/05-trigger.md` (not yet created — write during requirements gathering)

## How This File Works

This file answers one question: **where are we right now?** Nothing more.

- **Current** holds the active slice — its state, plan, and the immediate next step.
- When a slice finishes, recap it as **one line** under **Completed Slices**, then advance
  **Current** to the next slice.
- Depth lives elsewhere: per-session detail in `sessions/N.md`, per-slice decisions in that
  slice's file. Do not duplicate that depth here.

## Current

**Slice:** 05-trigger — Trigger & Requirements (Contacts) Flow
**State:** Plan Sessions 1–4 COMPLETE and green (PluginContext + StateStore, dedup → Core, trigger refinement, single-user contacts). **Slice NOT closed** — the closing **standards sweep** remains (the same way Slice 4 ended with a full standards pass over its in-scope files). All gates green (typecheck, lint, 2497 tests).
**Plan:** `.claude/temp/create-plan/slice-05-trigger.md`. Sweep inventory + checklist: `slices/05-trigger.md` → "Closing Standards Sweep".

**Next — Plan Session 5: Closing Standards Sweep (Slice 5 only).** A full audit/refine pass over every
file Slice 5 created or changed across Sessions 17–21, against `docs/coding-standards.md`,
`docs/anti-patterns.md`, and `docs/philosophy.md`. Each in-scope file read line-by-line, assessed, and
refactored where it falls short. Inventory + tiering live in the slice file. Excludes other slices and
process/meta docs (session logs, plan, research, build journal). The slice closes only after the sweep
lands and all gates are green — then advance to Slice 6 (Scheduling & Dispatch).

**What Session 21 shipped (Plan Session 4 — Contacts: single-user constraint, D9):**
- **T4.1 — `docs/constraints.md`:** new home for deliberate v1 scope narrowings; documents the single-user constraint (the human side is one person — the owner), the owner being **assumed, not required** (missing → warn naming the consequence, never fail), and the two non-relaxations (one user ≠ one task, one user ≠ one plugin). Referenced from the always-read AGENT-README table, the README docs list, and philosophy.md's "Every Decision Earned".
- **T4.2 — `inspectPeopleDirectory(people, availableChannels)`:** pure function in the people-directory module returning typed warnings (`no_owner`, `multiple_people`, `unreachable_owner_channel`). Warnings only — never throws/blocks. Daemon bootstrap logs them once comm plugins load (channels from the live registry). `PeopleDirectory` stays pure; `getOwner()` reuses the new `OWNER_ROLE` constant.
- **T4.3 — `engineer doctor` "People Directory" category:** renders the same warnings; fixes a latent bug (old owner check read singular `role` vs schema `roles[]` → always reported "no owner"). Stripped positional "Category N:" labels from check JSDocs, the "8 base + 1 conditional" comment, the "categories 1-7" pre-flight note, and the "9 categories" cli.md table (no-stale-counts). Tests assert categories by name.
- **T4.4 — people docs:** rewrote `configuration/people.md` around the single-user model (owner-only outreach, warnings, vestigial multi-person framing, links constraints.md). Corrected the hot-reload claim — see finding below.

**Key decisions:** owner is **assumed, not required** (warn, never fail — confirmed with Farzam); single dedicated doctor "People Directory" category (consolidates owner+single-user+channel checks, fixes the role bug); channel validation runs at **both** startup and doctor; pure inspect-fn + thin shells (FCIS) over injecting an observer into the pure `PeopleDirectory`.

**Finding for follow-up (raised, not fixed — out of single-user scope):** config **hot-reload is unwired**. `createConfigWatcher` (`src/config/watcher.ts`), `PeopleDirectory.updateConfig`, and `SafetyLayer.updateConfig` are exercised **only by tests** — nothing instantiates the watcher in the daemon. So no config hot-reloads at runtime, yet `configuration/README.md` still claims safety.yaml does (500ms debounce). Decide: wire the watcher into bootstrap, or delete the dead infra and correct the safety.yaml/README claims. people.yaml docs already corrected to "on restart".

**Cross-slice handoffs (unchanged):** #9 reply-token + #10 unblock check → Slice 12; trivial-skip → Slice 8; review polling → Slice 10.

**Known issue:** `orchestrator/index.test.ts > resolveStartState — feedback rework` is flaky (passes on isolated rerun). Pre-existing, unrelated. Worth a separate look.

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4–8 — detail in `slices/03-dashboard.md`.
- **Slice 4 — Startup & Configuration:** Getting-started path (`pnpm run setup` → `engineer start`), OS detection gate, seed-example sanitization + dogfooding, removals (checkCliArtifacts, config-version machinery, Output.table, quiet mode), CLI restructure (Screaming Architecture), original coding standards audit (1–11), new coding standards added (§4 expanded, §5 expanded, §7 framing, §12–§15), six post-bootstrap infrastructure gaps closed (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs), and new standards applied across slice 4 in-scope files. "Apply with judgment, never mechanically" principle codified. Sessions 9–16 — detail in `slices/04-startup.md`.

> **Slice 5 — Trigger & Requirements (Contacts) Flow** is **not** listed here yet: its feature work
> (Plan Sessions 1–4) is done and green, but the closing standards sweep (Plan Session 5) is still
> pending. It moves here once that sweep lands. See **Current** above.
