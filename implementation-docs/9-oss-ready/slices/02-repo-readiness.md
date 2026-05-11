# Slice 2: Repo Readiness

## Status: COMPLETE

## What Was Done

### Biome Configuration Alignment
- `lineWidth`: 100 → 120 (matches coding standards)
- `noDefaultExport`: `"off"` → `"error"` (enforced, vitest configs exempted via override)
- Function naming: allows both `camelCase` and `PascalCase` (supports branded type smart constructors)
- Enum member naming: `PascalCase` only (aligned with standards, future-proofed)
- Full codebase reformatted to 120-char lines (181 files)

### Lint Script Split
- `pnpm lint` — check-only, no writes (used by CI)
- `pnpm lint:fix` — applies auto-fixes (developer workflow)

### CI Pipeline Parallelization
- Split single `check` job into 3 parallel jobs: `lint`, `test`, `build`
- Each fails independently for faster feedback

### Test Infrastructure Restructure
- Renamed `test/` → `tests/`
- Created `tests/unit/` mirroring `src/` structure
- Moved 98 colocated `.test.ts` files from `src/` to `tests/unit/`
- Preserved `tests/boundary/`, `tests/integration/`, `tests/e2e/`, `tests/helpers/`
- Updated all import paths, vitest configs, tsconfig, biome overrides
- Cleaned up stale TODO comments in `tests/setup.ts`

### Migration Consolidation
- Consolidated 13 incremental migrations into 2 cohesive files:
  - `001_schema.sql` — 7 core domain tables with all columns and indexes
  - `002_observations.sql` — observability table with indexes
- Column order preserved to match historical schema

### Dependency Cleanup
- Removed unused exports: `WorkspaceEscapeError`, `resetTraceStepCounters`
- Removed dead `@` path alias from vitest config
- Verified `@types/node-fetch` is needed (grammy transitive dependency) — kept

### Safe Package Updates
- `hono` 4.12.7 → 4.12.18
- `yaml` 2.8.2 → 2.8.4
- `@inquirer/prompts` 8.3.0 → 8.4.3
- `grammy` 1.41.1 → 1.42.0
- `knip` 6.0.2 → 6.12.2

### Polish
- Fixed hardcoded home path in `scripts/e2e-run.ts` → uses `os.homedir()`

## Major Version Upgrades (Deferred)

These need individual evaluation — breaking changes in each:
- Biome 1.x → 2.x (config format changes)
- TypeScript 5.x → 6.x (new language features)
- Vitest 3.x → 4.x (API changes)
- Zod 3.x → 4.x (complete rewrite)
- pino 9.x → 10.x (breaking changes)
- better-sqlite3 11.x → 12.x (native module rebuild)
- lefthook 1.x → 2.x (config format changes)
- commander 13.x → 14.x
- ulid 2.x → 3.x
- @hono/node-server 1.x → 2.x
- tsdown 0.12.x → 0.22.x

## Verification

All passed at completion:
- `pnpm lint` — clean
- `pnpm test` — 2547 tests, 106 files, all passing
- `pnpm typecheck` — clean
- `pnpm build` — succeeds
- `pnpm knip` — no issues
- `pnpm check:circular` — no circular deps
