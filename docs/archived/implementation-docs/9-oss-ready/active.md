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
**State:** Session 19 complete. **Plan Session 2 COMPLETE** — dedup → Core + review-scaffolding deletion shipped, all gates green (typecheck, lint, 2466 tests). Next: Plan Session 3 (trigger plugin refinement, D6 + D7 + D8).
**Plan:** `.claude/temp/create-plan/slice-05-trigger.md` — Status: **Panel-Reviewed**. 9 decisions, 4-session task breakdown.

**What Session 19 shipped (Plan Session 2 — dedup → Core, D1 + D4):**
6 commits, all green:
- **Dedup → Core** (`3ba2dc5`) — `idempotency_key` is now a first-class `NOT NULL` task field with an active-scoped unique partial index (`idx_tasks_idempotency_key_active`). `trigger-poller`'s DB cold path keys on it for *every* event regardless of `external_ref` → crash-safe exactly-once for all triggers. Deleted dead `findByExternalRef` + its index; `external_ref` is descriptive-only. Decomposition mints deterministic child keys (`decomposition:{parentId}:{index}`).
- **Delete `trigger.pr_review`** (`62b4842`) — dead event removed end-to-end (schema/maps/manifest/JSDoc/live docs + bundled mirrors); `grep pr_review` clean. Dropped two brittle "exactly 42" count tests.
- **Task-intake flow doc** (`90e73e5`) — `docs/user-flows/task-intake/overview.md`: polling loop, two-tier dedup, idempotency_key (identity) vs external_ref (descriptive) contract, re-trigger walkthrough.
- **`seen_keys_ttl_ms` doc fix** (`9926667`) — now a hot-cache perf knob, not a correctness one.
- **future-considerations promoted + synced** (`1ead92d`, `a4d5963`) — brought the rich doc out of archived to live (`docs/future-considerations.md`), repointed links, consolidated the trigger-reversal entry, pruned 4 already-shipped entries (CI, event-bus validation, enum consts, telegram receive).

**Key decisions:** active-scoped (not global) uniqueness so reopened issues re-trigger cleanly; strict `NOT NULL` identity over nullable placeholder fills; deterministic decomposition keys.

**Cross-slice handoffs (unchanged):** #9 reply-token + #10 unblock check → Slice 12; trivial-skip → Slice 8; review polling → Slice 10.

**Next step — Plan Session 3 (trigger plugin refinement, D6 + D7 + D8):**
- **D6** — per-plugin poll cadence: formalize numeric `poll_interval_ms` as a typed manifest field, daemon honors it as the plugin default with global `trigger_poll_interval_ms` fallback; delete the dead Zod `poll_interval_ms` from github-trigger config.
- **D7** — configurable work selection: assignee OR label OR both, require ≥1 via Zod, rename `event_type` to reflect what matched.
- **D8** — Core-owned backoff: plugin reports rate-limit via `AdapterError.retry_after_ms`, daemon honors it (else exponential backoff); remove the plugin's `retryAfterUntil`.
- Plus github-trigger docs refresh. Each task: code + tests + docs + standards pass.

**Known issue:** `orchestrator/index.test.ts > resolveStartState — feedback rework` is flaky (passes on rerun). Pre-existing, unrelated. Worth a separate look.

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4–8 — detail in `slices/03-dashboard.md`.
- **Slice 4 — Startup & Configuration:** Getting-started path (`pnpm run setup` → `engineer start`), OS detection gate, seed-example sanitization + dogfooding, removals (checkCliArtifacts, config-version machinery, Output.table, quiet mode), CLI restructure (Screaming Architecture), original coding standards audit (1–11), new coding standards added (§4 expanded, §5 expanded, §7 framing, §12–§15), six post-bootstrap infrastructure gaps closed (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs), and new standards applied across slice 4 in-scope files. "Apply with judgment, never mechanically" principle codified. Sessions 9–16 — detail in `slices/04-startup.md`.
