# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, 16-slice roadmap, session protocol
- Current slice: `slices/04-startup.md`

## How This File Works

This file answers one question: **where are we right now?** Nothing more.

- **Current** holds the active slice — its state, plan, and the immediate next step.
- When a slice finishes, recap it as **one line** under **Completed Slices**, then advance
  **Current** to the next slice.
- Depth lives elsewhere: per-session detail in `sessions/N.md`, per-slice decisions in that
  slice's file. Do not duplicate that depth here.

## Current

**Slice:** 04-startup — Startup & Configuration
**State:** Phase 4 complete (Session 14). CLI restructured — `commands/start/` groups 6 files, shutdown handler extracted, "Structure Reveals Intent" standard added. Phase 5 is next.
**Plan:** `.claude/temp/create-plan/slice-04-startup.md` — 5 phases, panel-reviewed, 11 decisions.

**What just happened (current session):**
- Reviewed all four governance docs (AGENT-README, philosophy.md, coding-standards.md, anti-patterns.md)
- Full review saved to `docs-review-notes.md` (root, uncommitted) — findings on redundancy,
  aspirational vs. current-state tension, cross-document gaps. Come back to this later.
- Added 7 new subsections to `docs/coding-standards.md`:
  - Section 4: Immutability by Default, Parse Don't Validate
  - Section 5: Propagation Through Boundaries, Cause Chains, Error Categorization (expanded)
  - Section 7: Modularity framing (opening paragraph)
  - New sections 12-15: Logging, Async Discipline, Observability & Tracing, Graceful Degradation
- Research identified infrastructure gaps (logging/tracing/error handling) — see gap list below

**Next step — Session N+1: Infrastructure Gap Fixes (one session).**
Address gaps found between the new standards and the existing observability/error infrastructure.
Read `docs-review-notes.md` (root) for full gap analysis from the Explore agent research.

Specific gaps to fix:
- Log-to-trace correlation: thread `trace_id` into every pino log message via observer facade
- Error cause chains: audit catch blocks, ensure `cause` is always preserved (not just message)
- Error categorization: add `retryable` boolean to domain error hierarchies
- Floating promise audit: find and fix unhandled async calls across the codebase
- Span-to-log correlation: embed span context in pino output
- Graceful degradation: verify plugin failures don't crash daemon, add recovery logging

**Session N+2: Phase 5 — New Standards Audit (one session).**
The original coding standards (sections 1-11) were already applied across all slice 4 in-scope
files during Phases 1-4 (Sessions 10-14): newspaper order, `function` declarations, return-type
annotations, JSDoc on exports, guard clauses, `import type` separation, abbreviation renames,
doctor.ts fixes, CLI version from `package.json`, stale doc fixes — all addressed.

This final audit is exclusively for the **new standards added this session**:
- Section 4 additions: immutability by default (`readonly`, `as const`, no parameter mutation),
  parse-don't-validate (validation at boundaries, trust types inward)
- Section 5 additions: error propagation through three-tier boundaries, cause chains always
  preserved, error categorization with `retryable` flag
- Section 7 addition: modularity framing (module understandable without external context)
- Section 12: logging — decisions not actions, structured data, level discipline
- Section 13: async discipline — no floating promises, bounded parallel, cleanup
- Section 14: observability — span lifecycle, trace correlation, record decisions explicitly
- Section 15: graceful degradation — degrade don't crash, log it, auto-recover
- In-scope files: `src/cli/`, `src/config/`, `src/plugins/loader.ts`, `src/plugins/builtin.ts`
- **Bootstrap boundary matters:** `src/cli/` and `src/config/` run before the observer exists —
  logging (§12), tracing (§14), and span lifecycle do NOT apply there. Focus on error handling,
  immutability, async discipline, parse-don't-validate, and graceful degradation for pre-bootstrap
  code. `src/plugins/loader.ts` and `src/plugins/builtin.ts` run post-bootstrap — all standards apply.
- Final green sweep (build + lint + tests)

**Remaining:** Infrastructure gaps (1 session) + New Standards Audit (1 session).

**Slice 4 decisions (Session 9):**
- Getting-started: new `pnpm run setup` → `scripts/setup.sh` (confirm + install + build + link), then `engineer start`
- OS gate: macOS continues, Linux warns+confirms, Windows blocks; macOS/Linux POSIX-compatible, Windows out of scope for v1
- Seed (Option A): sanitize tracked `seed-example/` to generic placeholders; personal seeds in gitignored `seed-example-*`; dogfood the seed feature
- Removals: `checkCliArtifacts` (Plugin Blindness), config-version machinery (verified dead), `Output.table()`, `"quiet"` mode
- CLI restructure (Screaming Architecture) is its own phase, before the audit so the audit sees the final shape
- New coding standards to add: "Single Source of Truth", "Structure Reveals Intent"
- Cross-cutting: nice, actionable error handling across all user flows

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4-8 — detail in `slices/03-dashboard.md`.
