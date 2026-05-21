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
**State:** RRPIR planning complete (Session 17). Requirements + research + plan all written. **No code yet.** Implementation begins next session.
**Plan:** `.claude/temp/create-plan/slice-05-trigger.md` — Status: **Draft, expert-panel pending**. 9 decisions, 4-session task breakdown.

**Where Session 17 left us:**
Full requirements → research → planning pass for Slice 5. Scope = audit/refactor/complete ("fix everything"), under a new **single-user v1 constraint**. Artifacts produced:
- `slices/05-trigger.md` — 13 decisions, single-user constraint, verified scope boundary, cross-slice handoffs, session breakdown.
- `.claude/temp/research/slice-05-trigger.md` — implementation-surface research (DB layer, config knobs, registry injection, doctor, bootstrap, deletion sets).
- `.claude/temp/create-plan/slice-05-trigger.md` — 4-session plan (Draft — panel pending).
- Memory: `feedback_single_user_constraint.md`.

Headline decisions: dedup → Core via `idempotency_key` (Option A); Core **StateStore** + consolidated **PluginContext** (the centerpiece foundation — principled split keeping `this.manifest`); delete vestigial `trigger.pr_review`; per-plugin poll cadence (numeric ms, no override map); configurable work selection; Core-owned backoff; single-user constraint → new `docs/constraints.md` (referenced from README + AGENT-README). Discovered telegram-comm independently reinvented plugin-state persistence (2nd StateStore consumer — migrating in Slice 5). Corrected an earlier wrong finding (#6c: plugins DO have an injected observer, just `unknown`-typed).

Cross-slice handoffs designed-but-deferred: #9 reply-token correlation + #10 unblock sender check → Slice 12; trivial-skip handoff → Slice 8; review polling → Slice 10.

**Next step — Slice 5 implementation:**
1. Run `/expert-panel-review` on `.claude/temp/create-plan/slice-05-trigger.md` FIRST (deferred from Session 17 for fresh context). Incorporate findings.
2. Begin **Session 1 of the plan** — PluginContext + StateStore foundation (the centerpiece everything builds on). Docs are first-class at every step. No sub-agents — work directly.

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4–8 — detail in `slices/03-dashboard.md`.
- **Slice 4 — Startup & Configuration:** Getting-started path (`pnpm run setup` → `engineer start`), OS detection gate, seed-example sanitization + dogfooding, removals (checkCliArtifacts, config-version machinery, Output.table, quiet mode), CLI restructure (Screaming Architecture), original coding standards audit (1–11), new coding standards added (§4 expanded, §5 expanded, §7 framing, §12–§15), six post-bootstrap infrastructure gaps closed (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs), and new standards applied across slice 4 in-scope files. "Apply with judgment, never mechanically" principle codified. Sessions 9–16 — detail in `slices/04-startup.md`.
