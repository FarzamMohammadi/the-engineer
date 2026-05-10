# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, session protocol
- Current slice: `slices/01-standards-alignment.md` (not yet created — first session work)

## Current State

**Phase:** 9 — OSS Ready
**Session:** 2 (Standards Alignment complete)
**Slice:** 01-standards-alignment — COMPLETE
**Next slice:** `slices/02-repo-readiness.md` (not yet created)

### What's Done

- Vision, approach, and active files created
- 16-slice roadmap defined
- Lenses established (resilience, plugin integrity, plugin authoring simplicity, UX quality)
- Co-founder dynamic agreed
- Strategy agreed: vertical slices, RRPIR per slice, tangents welcome, no coming back
- **Slice 1 COMPLETE:** `docs/standards.md` written — 10 categories of coding standards decided via deep Q&A

### What's Next

**Session 3: Repo Readiness (Slice 2)**

CI, git hooks, linters, Biome setup, dependency audit, migration consolidation, quality guardrails. The enforcement layer everything else benefits from.

Topics:
- Biome configuration (matches our standards: 120 chars, double quotes, semicolons, trailing commas, 2-space)
- ESLint rules (if any beyond Biome — TypeScript-specific rules)
- Git hooks (pre-commit: format + lint + typecheck)
- CI pipeline (GitHub Actions: test, lint, typecheck, build)
- Dependency audit (outdated, unused, security)
- Migration consolidation (single clean schema)
- Test infrastructure (move tests to `tests/` mirroring `src/`)

### Decisions Made This Session

- Newspaper order with `function` declarations (hoisting enables caller-above-callee)
- Strict FCIS (pure decision functions, thin imperative shells)
- Branded types by default for all domain IDs
- Always annotate return types — explicit, intentful
- Results for expected failures, exceptions for unexpected
- Tests in separate `tests/` mirroring `src/`, fixtures colocated with tests
- Biome formatter, 120 chars, semicolons, trailing commas, double quotes, 2-space indent
- One concept per file, split on change-reason divergence
- JSDoc one-liner on every export
- No default exports, barrels for public API only
