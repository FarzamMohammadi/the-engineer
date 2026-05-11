# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, session protocol
- Current slice: `slices/03-dashboard.md` (not yet created — next session)

## Current State

**Phase:** 9 — OSS Ready
**Session:** 3 (Repo Readiness complete)
**Slice:** 02-repo-readiness — COMPLETE
**Next slice:** `slices/03-dashboard.md` (not yet created)

### What's Done

- Vision, approach, and active files created
- 16-slice roadmap defined
- Lenses established (resilience, plugin integrity, plugin authoring simplicity, UX quality)
- Co-founder dynamic agreed
- Strategy agreed: vertical slices, RRPIR per slice, tangents welcome, no coming back
- **Slice 1 COMPLETE:** `docs/coding-standards.md` written — 10 categories of coding standards decided via deep Q&A
- **Slice 2 COMPLETE:** Repo readiness — Biome aligned (120 chars, noDefaultExport, PascalCase enums, smart constructor naming), lint split (check-only vs fix), CI parallelized (3 jobs), tests restructured (tests/unit/ mirroring src/), 13 migrations consolidated to 2, unused exports removed, safe deps updated, hardcoded paths fixed

### What's Next

**Session 4: Dashboard (Slice 3)**

Complete rewrite. Exposes all API/data gaps that inform later slices. The dashboard is the first thing a user sees — it should be portfolio-quality.

### Decisions Made This Session

- Biome `lineWidth` → 120 (was 100)
- `noDefaultExport` → error (vitest configs exempted)
- Function naming allows PascalCase (for smart constructors like `TaskId()`)
- Enum member naming: PascalCase only
- `pnpm lint` is check-only; `pnpm lint:fix` applies fixes
- CI: 3 parallel jobs (lint, test, build)
- Test structure: `tests/unit/` mirrors `src/`, `tests/boundary/`, `tests/integration/`, `tests/e2e/` as siblings
- Migrations consolidated to 2 files: `001_schema.sql` (domain tables), `002_observations.sql` (observability)
- Major version upgrades deferred — need individual evaluation (Biome 2, TS 6, Vitest 4, Zod 4, pino 10, etc.)
- `@types/node-fetch` kept — required by grammy's type declarations
