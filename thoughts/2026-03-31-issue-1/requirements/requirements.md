# Requirements: Fix failing pipeline on github

## Task Description
Fix failing pipeline on github - "we have a pipeline on github that's failing. find the cause and fix it."

## Gathered Context

### Issue Identified
The GitHub CI pipeline (.github/workflows/ci.yml) is failing during the `pnpm lint` step due to TypeScript compilation errors. The specific error is that multiple test files are missing the `response_poll_interval_ms` property in their daemon configuration objects.

### Root Cause Analysis
- **Recent Change**: Commit `d1077cb` added a new `response_poll_interval_ms` property to the daemon configuration schema with a default value of 5000ms
- **Schema Definition**: The property is defined in `src/schemas/config.ts` as a required integer with default 5000
- **Type Mismatch**: Test files have hardcoded daemon config objects that predate this change and don't include the new property
- **Affected Files**: Multiple test files including:
  - `src/cli/commands/doctor.test.ts` (makeSafeBundle function)
  - `src/core/daemon/health-monitor.test.ts`
  - `src/core/daemon/preemption-manager.test.ts`
  - `src/core/daemon/review-handler.test.ts`
  - `src/core/daemon/task-scheduler.test.ts`
  - `src/core/daemon/trigger-poller.test.ts`

### CI Pipeline Details
The failing pipeline runs:
1. `pnpm install --frozen-lockfile` ✅
2. `pnpm lint` ❌ (fails on TypeScript compilation)
3. `pnpm test` (doesn't reach this step)
4. `pnpm build` (doesn't reach this step)

### Current Property Definition
```typescript
response_poll_interval_ms: z
  .number()
  .int()
  .positive()
  .default(5_000)
  .describe(
    "How often the daemon polls communication adapters for responses and /start handshakes. Default: 5 seconds.",
  ),
```

## Questions Asked
No questions needed - the issue is clear and self-contained.

## Assessment
**Ready to proceed to research phase.**

This is a straightforward TypeScript compilation error caused by a missing property in test configurations. The fix is clear:
1. Add `response_poll_interval_ms: 5000` to all test daemon configurations that are missing it
2. The value should be 5000 (5 seconds) to match the schema default
3. Some files are already updated correctly (test-daemon.ts, response-poller.test.ts)

The task is well-scoped, has no ambiguous requirements, and doesn't affect any external systems or users. It's purely a developer experience fix to get the CI pipeline working again.

## Team Contacts Referenced
None required - issue is technical and self-contained.