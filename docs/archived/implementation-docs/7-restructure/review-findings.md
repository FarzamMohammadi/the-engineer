# Wave 5: REVIEW — Findings Summary

**Reviewed:** 2026-03-14
**Branch:** `layer7/wave3` → `main`
**Reviewer:** Claude Opus 4.6

---

## Health Before Review

| Metric | Before | After |
|--------|--------|-------|
| Tests | 2,355 passing (111 files) | 2,355 passing (111 files) |
| TypeScript (prod) | 0 errors | 0 errors |
| TypeScript (test) | 145 errors | 0 errors |
| Biome (errors) | 0 | 0 |
| Biome (warnings) | 42 | 0 |
| Bare `throw new Error()` (core) | 23 | 0 |
| Regression (3 runs) | — | 3/3 pass, identical count |

---

## 11 Verification Steps

### Step 1: Interface Compliance — PASS
All 5 core interfaces (`IEventBus`, `ITaskEngine`, `ISafetyLayer`, `ISessionMemory`, `IActionPipeline`) have correct implementations:
- `EventBus implements IEventBus`
- `TaskEngine implements ITaskEngine`
- `SafetyLayer implements ISafetyLayer`
- `SessionMemory implements ISessionMemory`
- `ActionPipeline implements IActionPipeline`

No concrete class imports found where interfaces should be used.

### Step 2: Event Topology — PASS
- `EventTopology` class in `src/core/event-bus/topology.ts` provides declarative registration
- All `subscribe()` calls in Daemon use named IDs (daemon:cost, daemon:comm, daemon:state-sync, daemon:children-done, daemon:feedback)
- Events in `src/schemas/events.ts` are registered via topology during bootstrap

### Step 3: Security Hardening — PASS
- **Command injection**: BashTool validates commands against configurable `blocked_patterns` regex list
- **Workspace escape**: `realpathSync()` used in both WorkspaceManager and BashTool for symlink canonicalization
- **Secret sanitization**: `sanitizeSecrets()` called at 16 chokepoints (agent-loop prompts/responses/errors, journal entries, PR descriptions)
- **GIT_ env**: ENV_ALLOWLIST uses specific variables (GIT_AUTHOR_NAME, GIT_COMMITTER_NAME, etc.), not wildcards
- **Token access**: No direct `process.env.GITHUB_TOKEN` access in production code (only in plugin configs where it's read at init time)

### Step 4: Dead Code — PASS
- Biome catches unused imports (0 after fixes)
- No significant dead exports found
- `create-plugin.ts` has intentional "Not implemented" placeholders (10 stubs for future adapter scaffolding)

### Step 5: Test Coverage — PASS
- 2,355 tests across 111 files (1,378 unit + 42 integration + 17 E2E + 918 from Layer 7)
- Every Layer 7 decomposed sub-module has its own test file
- Contract suites cover all 5 adapter types
- No coverage regressions

### Step 6: Import Graph Integrity — PASS
- `test/boundary/tier-import-rules.test.ts` passes (3 rules enforced)
- Plugins never import from `src/core/` (verified via grep — 0 matches)
- No circular imports detected between core components

### Step 7: Config Schema Completeness — PASS (minor gap noted)
- All new fields (`data_lifecycle`, `database`, `subscriber_warn_threshold_ms`) have Zod schemas with defaults
- Template configs in `engineer init` don't explicitly include R10 fields — acceptable because `.default({})` handles this
- Doctor checks validate config structure via Zod parse

### Step 8: Error Handling Consistency — FIXED
- 23 bare `throw new Error()` in core replaced with typed error classes (6 new error files)
- All adapter errors use `createAdapterError()` through the SDK boundary
- No empty catch blocks found
- Remaining bare throws: 14 in CLI (10 "Not implemented" stubs, 3 bootstrap, 1 dir-exists check) — acceptable for CLI-layer code

### Step 9: Documentation Accuracy — PASS
- `CONTRIBUTING.md`: All commands verified (`pnpm test`, `test:integration`, `test:e2e`, `test:all`, `test:coverage`, `test:watch`, `lint`, `typecheck`)
- `docs/architecture.md`: Component descriptions present
- `docs/plugin-development.md`: Plugin development guide present
- `CHANGELOG.md`: Standard format
- `.github/`: Issue templates, PR template, and workflows present

### Step 10: Performance — PASS
- `src/core/data-lifecycle/` retention cleanup module present with configurable intervals and table-level retention
- Database PRAGMAs (WAL mode, synchronous=NORMAL) applied in migration runner
- EventBus subscriber timeout guard configurable via `subscriber_warn_threshold_ms`

### Step 11: Regression Check — PASS
```
Run 1: 111 files, 2355 tests — PASS (4.85s)
Run 2: 111 files, 2355 tests — PASS (4.81s)
Run 3: 111 files, 2355 tests — PASS (4.96s)
```
No flaky tests. Consistent test count across all runs.

---

## Issues Found and Fixed

### Critical (0)
None.

### High (1)
- **145 TypeScript test errors**: Missing required properties in fixtures after R10 added `data_lifecycle`, `database`, and `subscriber_warn_threshold_ms` to DaemonConfig. Fixed by adding these fields to all test config factories.

### Medium (2)
- **23 bare `throw new Error()` in core**: Replaced with 14 typed error classes across 6 new error files. Enables discriminated error matching at catch sites.
- **42 Biome warnings**: Mix of stale suppression comments (from biome.json override change), empty blocks, async-without-await, and inline regex. All resolved.

### Low (1)
- **Stray `~/` directory**: 3.8MB leftover worktree artifacts from a live E2E test. Deleted and added `"~"` to biome.json ignore.

---

## Issues Deferred

1. **Template configs don't include R10 fields** (data_lifecycle, database, subscriber_warn_threshold_ms): Low priority — Zod defaults handle this. Can be added when templates are next updated.

2. **CLI bare throws** (14 in create-plugin.ts and bootstrap.ts): These are user-facing startup/scaffolding errors where plain `Error` is appropriate. Not worth introducing typed errors for CLI-only paths.

---

## Final State

```
npx tsc --noEmit                        → 0 errors
npx tsc -p tsconfig.test.json --noEmit  → 0 errors
npx biome check src/ test/              → 0 errors, 0 warnings
pnpm test (3x)                          → 2,355 tests, 111 files, all passing
```

Total commits: 3
- `review: clean up stray worktree artifacts and harden biome config`
- `review: fix 145 TypeScript errors and 42 Biome warnings in test files`
- `review: introduce typed error classes for all core domains`
