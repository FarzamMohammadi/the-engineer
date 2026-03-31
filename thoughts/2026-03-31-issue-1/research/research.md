# Research: Fix failing pipeline on github

## Task Context
GitHub CI pipeline is failing at the `pnpm lint` step due to TypeScript compilation errors. The root cause is that multiple test files are missing the `response_poll_interval_ms` property in their daemon configuration objects after a recent schema change.

## Codebase Analysis

### CI Configuration
- **File**: `.github/workflows/ci.yml`
- **Process**: Simple 4-step pipeline (install → lint → test → build)
- **Failure Point**: `pnpm lint` which runs `tsc --noEmit` along with other checks
- **Error**: TypeScript compilation failing due to type mismatches

### Schema Definition
- **File**: `src/schemas/config.ts` (lines 118-125)
- **Property**: `response_poll_interval_ms: z.number().int().positive().default(5_000)`
- **Purpose**: Controls how often daemon polls communication adapters for responses and /start handshakes
- **Default Value**: 5000ms (5 seconds)
- **Added in**: Commit `d1077cb` for separate response polling interval

### Current Type Error Pattern
TypeScript errors show that daemon configuration objects in tests are missing the required `response_poll_interval_ms` property. All affected configs have the related `trigger_poll_interval_ms` property but lack the new one.

## Relevant Files

### Files Needing Updates (Test Files)
- `src/cli/commands/doctor.test.ts` — `makeSafeBundle()` function (lines 489-528)
- `src/core/daemon/health-monitor.test.ts` — `makeDaemonConfig()` function (lines 11-50)
- `src/core/daemon/preemption-manager.test.ts` — daemon config object
- `src/core/daemon/review-handler.test.ts` — daemon config object
- `src/core/daemon/task-scheduler.test.ts` — daemon config object
- `src/core/daemon/trigger-poller.test.ts` — daemon config object

### Files Already Correctly Updated
- `src/core/daemon/response-poller.test.ts` — correctly includes `response_poll_interval_ms: 5_000`
- `test/helpers/test-daemon.ts` — `defaultTestConfig()` function already has the property
- `test/helpers/integration-context.ts` — already includes the property

### Template File Also Needing Update
- `src/cli/templates.ts` — YAML daemon config template is missing the property

## Patterns & Conventions

### Test Configuration Pattern
Daemon configurations in tests follow a consistent pattern with hardcoded values:
```typescript
{
  max_concurrent: 1,
  tick_interval_ms: 5_000,
  // ... other properties ...
  trigger_poll_interval_ms: 30_000,
  response_poll_interval_ms: 5_000,  // ← This is missing
  // ... remaining properties
}
```

### Correct Value to Use
Based on the schema default and existing correctly updated files:
- **Value**: `5_000` (5 seconds)
- **Placement**: After `trigger_poll_interval_ms` and before `seen_keys_ttl_ms`

### Testing Approach
- All test files use inline daemon config objects
- No shared config factory is used across these specific failing tests
- `test/helpers/test-daemon.ts` provides the correct pattern to follow

## Dependencies & Integration Points

### Schema Dependencies
- All daemon config objects must conform to `DaemonConfigSchema` in `src/schemas/config.ts`
- The property is required (not optional) in the type system
- Zod provides the default value, but TypeScript requires explicit declaration in test objects

### CI Impact
- Pipeline blocks on TypeScript compilation
- No runtime impact since this only affects test configurations
- Fix enables all subsequent CI steps (test, build)

### No Breaking Changes
- This is purely additive to existing test configurations
- No changes to runtime behavior or public APIs
- Template update improves user experience for new setups

## Complexity Assessment
**Simple** — This is a straightforward mechanical fix involving adding the same missing property across multiple test files with the correct value (5000ms).

## Open Questions
None - the issue is fully understood and the solution is clear.

## Key Findings

1. **Root Cause Confirmed**: Recent commit `d1077cb` added `response_poll_interval_ms` to the schema but test configurations weren't updated
2. **Precise Fix Required**: Add `response_poll_interval_ms: 5_000` to 6 test files + 1 template file
3. **No Side Effects**: This is purely a developer experience fix with no runtime or user-facing changes
4. **Pattern Consistency**: All fixes follow the same pattern used in already-updated files
5. **CI Unblocking**: This fix will immediately resolve the failing pipeline and restore CI functionality