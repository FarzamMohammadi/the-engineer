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

## Monorepo Test Configuration

**Current state (v1):** Single `vitest.config.ts` at project root. All tests in one package.

**When it becomes relevant:** When the single package is split into `core`, `plugin-sdk`, and individual plugin packages (see Monorepo Evolution above).

**What it enables:** Per-package Vitest configs with `vitest.workspace.ts` orchestration at the root. Each package runs its own unit tests. Integration tests that cross package boundaries live in a top-level `tests/integration/` directory.

**Migration path:** The test directory structure (Decision #120) is designed for this — co-located unit tests move with their source files, cross-cutting tests stay in `test/`. Contract compliance suites (Decision #122) move into the `plugin-sdk` package.
