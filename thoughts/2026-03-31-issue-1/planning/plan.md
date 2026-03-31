# Plan: Fix failing pipeline on github

## Approach
Fix the GitHub CI pipeline by adding the missing `response_poll_interval_ms: 5_000` property to daemon configuration objects in test files. This is a mechanical fix that addresses TypeScript compilation errors introduced when the schema was updated in commit `d1077cb` but test configurations weren't updated accordingly.

## Phases

### Phase 1: Update Test Files (Main Focus) ✅
- [x] **src/cli/commands/doctor.test.ts** — Add `response_poll_interval_ms: 5_000` to `makeSafeBundle()` function's daemon config object (after line 500)
- [x] **src/core/daemon/health-monitor.test.ts** — Add `response_poll_interval_ms: 5_000` to `makeDaemonConfig()` function's daemon config object
- [x] **src/core/daemon/preemption-manager.test.ts** — Add `response_poll_interval_ms: 5_000` to daemon config object
- [x] **src/core/daemon/review-handler.test.ts** — Add `response_poll_interval_ms: 5_000` to daemon config object
- [x] **src/core/daemon/task-scheduler.test.ts** — Add `response_poll_interval_ms: 5_000` to daemon config object
- [x] **src/core/daemon/trigger-poller.test.ts** — Add `response_poll_interval_ms: 5_000` to daemon config object
- **Verify:** Run `pnpm lint` locally — should pass TypeScript compilation without errors ✅

### Phase 2: Update Template File ✅
- [x] **src/cli/templates.ts** — Add `response_poll_interval_ms: 5000` to YAML daemon config template
- **Verify:** Template includes the new property for future user setups ✅

### Phase 3: Final Validation ✅
- [x] Run full CI pipeline locally: `pnpm install`, `pnpm lint`, `pnpm test`, `pnpm build`
- [x] Commit changes with descriptive message
- [x] Push to trigger CI and verify pipeline passes
- **Verify:** GitHub Actions CI pipeline completes successfully (all 4 steps: install → lint → test → build) ✅

## Risks & Mitigations
- **Risk:** Missing additional files that also need the property → **Mitigation:** Research phase identified all affected files; pattern is consistent across codebase
- **Risk:** Incorrect value for response_poll_interval_ms → **Mitigation:** Use 5_000 which matches schema default and already-updated files
- **Risk:** Breaking existing test logic → **Mitigation:** This property only affects polling intervals, not test logic; tests already have trigger_poll_interval_ms
- **Risk:** Placement affects object structure → **Mitigation:** Place after trigger_poll_interval_ms following established pattern from working files

## Test Strategy
- **Local Validation:** Run `pnpm lint` after each file update to catch TypeScript errors immediately
- **Incremental Testing:** Update files in small batches to isolate any issues
- **Full Pipeline Test:** Run complete local CI sequence before pushing
- **No New Tests Required:** This fixes existing tests rather than adding functionality

## Success Criteria ✅
- [x] `pnpm lint` passes locally without TypeScript errors
- [x] GitHub Actions CI pipeline passes all 4 steps (install → lint → test → build)
- [x] All test files have consistent daemon config structure with both polling interval properties
- [x] Template file includes new property for future user setups
- [x] No runtime behavior changes (purely compilation/type fix)