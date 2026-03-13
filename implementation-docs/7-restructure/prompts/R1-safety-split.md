# R1 — Safety Layer Split (CostTracker + PolicyEngine)

**Wave 2 (Parallel) — Depends on R0 (Interface Foundation) being complete.**

---

## Worktree Setup (DO THIS FIRST)

This phase runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-R1 -b layer7/R1 main
cd ../engineer-R1
```

**Rules:**
- Work ONLY in this worktree (`../engineer-R1/`)
- Commit your changes to the `layer7/R1` branch
- Do NOT push — the merge prompt will collect this branch
- Do NOT modify files outside the scope listed in this prompt
- When done: commit, verify tests pass, stop. The merge wave handles the rest.

---

You are implementing a structural restructuring phase for The Engineer, an autonomous software engineering agent. This phase splits the SafetyLayer god object (~992 LOC, ~20 methods, 2 distinct concerns) into focused modules. No new features, no behavior changes. Every test that passes before must pass after.

---

## 1. Identity Preamble

Before writing any code, read these files to understand the project's identity and principles:

- `docs/persona.md` — who The Engineer is
- `docs/philosophy.md` — core beliefs driving every decision
- `implementation-docs/0-foundation/philosophy.md` — builder-specific principles

Key takeaways:
- Minimalism: each module should have a single clear responsibility
- Modularity: components are swappable, interfaces define contracts
- Derive from Proven Systems: the safety layer derives from OS process permissions and CI/CD pipeline gates

---

## 2. Architecture Catchup

Read these docs:

- `implementation-docs/1-system/architecture-tiers.md` — three-tier model
- `implementation-docs/2-components/safety-layer.md` — Safety Layer design (Gate 2 + passive consultation + cost tracking)
- `implementation-docs/3-interactions/protocols.md` — Protocol P6 (Safety Evaluation), Protocol P7 (Cost Tracking)
- `implementation-docs/3-interactions/event-catalog.md` — `cost.incurred`, `cost.limit_reached` events
- `implementation-docs/4-implementation/schemas/` — schemas relevant to safety (config.md)
- `implementation-docs/7-restructure/assessment.md` — SafetyLayer identified as god object (992 LOC, mixed cost accounting + policy evaluation)

---

## 3. Decision Log Review

- `implementation-docs/7-restructure/decisions.md` — Layer 7 decisions
- `implementation-docs/decisions.md` — historical (skim for safety-related)

Key decisions:
- D82-D83: Safety config (scope boundaries, autonomy levels, cost limits)
- D84: Merge policy
- D126: per_repo cost limit removed (L4 holistic review)
- D146: Dual-mode cost tracking (API spend + CLI usage)

---

## 4. Current Code Deep-Read

Read ALL of these files before making any changes:

### The file being split
- `src/core/safety-layer/index.ts` — the entire SafetyLayer class (992 LOC)
- `src/core/safety-layer/index.test.ts` — all existing tests

### Interface (created by R0)
- `src/core/interfaces/safety-layer.interface.ts` — ISafetyLayer contract
- `src/core/interfaces/index.ts` — barrel

### Schemas
- `src/schemas/config.ts` — SafetyConfig, CostLimitsSchema, ScopeBoundariesSchema, AutonomyBoundariesSchema, ResponseTimeoutSchema, MergePolicySchema
- `src/schemas/events.ts` — CostIncurredPayload, EventPayloads, EventTypes
- `src/schemas/task.ts` — ActionClass, TaskStates, ActionClasses

### Consumers (files that import from safety-layer)
- `src/core/action-pipeline/index.ts` — imports SafetyLayer, SafetyVerdict
- `src/core/orchestrator/index.ts` — imports SafetyLayer, uses consultJudgment, getCostStatus
- `src/core/daemon/index.ts` — imports SafetyLayer, uses getTimeoutPolicy, getCostStatus
- `src/cli/bootstrap.ts` — creates SafetyLayer instance

### Test infrastructure
- `test/helpers/test-safety-layer.ts` — createTestSafetyLayer()
- `test/helpers/integration-context.ts` — integration test setup
- `test/helpers/test-orchestrator.ts`
- `test/helpers/test-daemon.ts`

---

## 5. Exact Specifications

### 5A. New File Structure

Transform `src/core/safety-layer/` from a single file to a module directory:

```
src/core/safety-layer/
  index.ts           — SafetyLayer facade (re-exports, implements ISafetyLayer, delegates)
  cost-tracker.ts    — CostTracker class (cost accumulation, snapshots, replay, limit checks)
  policy-engine.ts   — PolicyEngine class (scope checks, autonomy evaluation, merge policy)
  errors.ts          — Tagged error classes for safety-related errors
  index.test.ts      — existing tests (update imports)
  cost-tracker.test.ts  — new tests for CostTracker in isolation
  policy-engine.test.ts — new tests for PolicyEngine in isolation
```

### 5B. `src/core/safety-layer/errors.ts`

Create tagged error classes. Every error must have a `readonly tag` discriminant for exhaustive matching:

```typescript
/** Base class for all safety-layer errors. */
export abstract class SafetyError extends Error {
  abstract readonly tag: string;
}

/** Cost limit has been exceeded. */
export class CostLimitExceededError extends SafetyError {
  readonly tag = "CostLimitExceeded" as const;
  constructor(
    readonly limitType: "per_task" | "daily" | "monthly",
    readonly spent: number,
    readonly limit: number,
  ) {
    super(`${limitType} cost limit reached ($${spent.toFixed(2)} / $${limit.toFixed(2)})`);
    this.name = "CostLimitExceededError";
  }
}

/** An action was denied by scope policy. */
export class ScopeDeniedError extends SafetyError {
  readonly tag = "ScopeDenied" as const;
  constructor(
    readonly scopeType: "repo" | "branch" | "file" | "merge",
    readonly detail: string,
  ) {
    super(`${scopeType} scope denied: ${detail}`);
    this.name = "ScopeDeniedError";
  }
}

/** Snapshot data was corrupt and could not be restored. */
export class CorruptSnapshotError extends SafetyError {
  readonly tag = "CorruptSnapshot" as const;
  constructor(message: string) {
    super(message);
    this.name = "CorruptSnapshotError";
  }
}
```

### 5C. `src/core/safety-layer/cost-tracker.ts`

Extract ALL cost-related logic from SafetyLayer into CostTracker:

```typescript
import type Database from "better-sqlite3";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { CostLimits } from "../../schemas/config.js";
// ... other imports

/**
 * Tracks cumulative costs across API spend windows and CLI usage.
 *
 * Responsibilities:
 * - Subscribe to cost.incurred events and accumulate
 * - Maintain daily/monthly spend windows with automatic rollover
 * - Snapshot accumulators to _meta for crash recovery
 * - Restore from snapshot + replay missed events on startup
 * - Emit cost.limit_reached when thresholds are hit
 * - Provide getCostStatus() for passive queries
 */
export class CostTracker {
  // ... move all cost-related private fields here:
  // accumulators, lastSequence, getSnapshotStmt, saveSnapshotStmt

  constructor(db: Database.Database, eventBus: IEventBus, costLimits: CostLimits) {
    // ... move initialization, restoreFromSnapshot, replayEvents, subscribe here
  }

  /** Get current cost status. */
  getCostStatus(taskId?: string): CostStatus { /* move from SafetyLayer */ }

  /** Check if any cost limit is breached for the given task. */
  checkCostLimits(taskId: string, warnings: string[]): SafetyVerdict | null { /* move */ }

  /** Update cost limits (hot-reload). */
  updateLimits(newLimits: CostLimits): void { /* new */ }

  // Move ALL private methods:
  // onCostEvent, accumulateApiSpend, accumulateCliUsage, rolloverWindows,
  // checkAndEmitLimitBreaches, checkApiLimitBreach, checkCliLimitBreach,
  // checkSingleCostLimit, isAnyLimitBreached,
  // saveSnapshot, restoreFromSnapshot, replayEvents, replayApiEvent
}
```

**Move these pure functions to cost-tracker.ts** (they are only used by cost tracking):
- `getDailyWindowStart()`
- `getMonthlyWindowStart()`

**Performance optimization: Paginated replay.**
The current `replayEvents()` calls `eventBus.getEventsSince(this.lastSequence)` which loads ALL events since the snapshot into memory. Add a LIMIT variant:

```typescript
private replayEvents(): void {
  const PAGE_SIZE = 1000;
  let lastSeq = this.lastSequence;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const events = this.eventBus.getEventsSince(lastSeq, PAGE_SIZE);
    if (events.length === 0) break;
    for (const event of events) {
      if (event.type !== EventTypes["cost.incurred"]) continue;
      // ... process
      lastSeq = event.sequence;
    }
    this.lastSequence = lastSeq;
    if (events.length < PAGE_SIZE) break;
  }
}
```

This requires adding an optional `limit` parameter to `IEventBus.getEventsSince()`:

```typescript
// In src/core/interfaces/event-bus.interface.ts
getEventsSince(afterSequence: number, limit?: number): Event[];
```

And updating `EventBus` to support it:

```typescript
// In src/core/event-bus/index.ts — add a second prepared statement
private readonly getEventsSinceLimitStmt: Database.Statement;
// In constructor:
this.getEventsSinceLimitStmt = db.prepare(
  "SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?"
);
// In getEventsSince:
getEventsSince(afterSequence: number, limit?: number): Event[] {
  const rows = limit != null
    ? this.getEventsSinceLimitStmt.all(afterSequence, limit) as EventRow[]
    : this.getEventsSinceStmt.all(afterSequence) as EventRow[];
  return rows.map(rowToEvent);
}
```

### 5D. `src/core/safety-layer/policy-engine.ts`

Extract ALL policy evaluation logic:

```typescript
import type { ActionClass } from "../../schemas/task.js";
import type { SafetyConfig } from "../../schemas/config.js";
import type { SafetyQuery, SafetyVerdict, ParsedThreshold } from "./index.js"; // or from interfaces

/**
 * Evaluates safety policies: scope boundaries, autonomy decisions, merge policy.
 *
 * Pure logic — no database, no event bus. Takes config, returns verdicts.
 * Hot-reloadable via updateConfig().
 */
export class PolicyEngine {
  private config: SafetyConfig;

  constructor(config: SafetyConfig) {
    this.config = config;
  }

  /** Gate 2 scope evaluation (repo, branch, file, merge). */
  evaluateScope(actionClass: ActionClass, details: Record<string, unknown>): SafetyVerdict | null {
    // Move: checkRepoScope, checkBranchScope, checkFileScope, checkMergePolicy
    // Return null if all checks pass, or a deny/ask_human verdict
  }

  /** Autonomy evaluation for should_i_ask queries. */
  evaluateAutonomy(query: SafetyQuery): SafetyVerdict {
    // Move: evaluateAutonomy, findRepoOverride
  }

  /** Check if auto-merge is allowed for a repo. */
  checkAutoMergeAllowed(repo: string): boolean {
    // Move from SafetyLayer
  }

  /** Get response timeout policy. */
  getTimeoutPolicy(): import("../../schemas/config.js").ResponseTimeout {
    return this.config.response_timeout;
  }

  /** Hot-reload config. */
  updateConfig(newConfig: SafetyConfig): void {
    this.config = newConfig;
  }
}
```

**Move these pure functions to policy-engine.ts** (they are only used by policy evaluation):
- `matchesPathPattern()` and its helpers (`simpleGlob`, `matchSegments`, `matchDoublestar`, `basename`)
- `parseThreshold()`
- `evaluateThreshold()`

### 5E. `src/core/safety-layer/index.ts` — Facade

The SafetyLayer class becomes a thin facade that delegates to CostTracker and PolicyEngine:

```typescript
import type Database from "better-sqlite3";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { ISafetyLayer, SafetyQuery, SafetyVerdict, CostStatus } from "../interfaces/safety-layer.interface.js";
import type { ActionClass } from "../../schemas/task.js";
import type { ResponseTimeout, SafetyConfig } from "../../schemas/config.js";
import { CostTracker } from "./cost-tracker.js";
import { PolicyEngine } from "./policy-engine.js";

// Re-export types for backward compatibility
export type { SafetyQuery, SafetyVerdict, CostStatus } from "../interfaces/safety-layer.interface.js";
export type { ParsedThreshold } from "./policy-engine.js";

// Re-export pure functions for backward compatibility
export { matchesPathPattern, parseThreshold, evaluateThreshold } from "./policy-engine.js";
export { getDailyWindowStart, getMonthlyWindowStart } from "./cost-tracker.js";

export class SafetyLayer implements ISafetyLayer {
  private readonly costTracker: CostTracker;
  private readonly policyEngine: PolicyEngine;

  constructor(db: Database.Database, eventBus: IEventBus, config: SafetyConfig) {
    this.costTracker = new CostTracker(db, eventBus, config.cost_limits);
    this.policyEngine = new PolicyEngine(config);
  }

  evaluateAction(taskId: string, actionClass: ActionClass, details: Record<string, unknown>): SafetyVerdict {
    const warnings: string[] = [];

    // 1. Scope checks (policy)
    const scopeResult = this.policyEngine.evaluateScope(actionClass, details);
    if (scopeResult) return scopeResult;

    // 2. Cost limit check
    const costResult = this.costTracker.checkCostLimits(taskId, warnings);
    if (costResult) return costResult;

    const result: SafetyVerdict = { allowed: true, action: "proceed", reason: "within policy" };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  consultJudgment(query: SafetyQuery): SafetyVerdict {
    switch (query.type) {
      case "can_i":
        return this.evaluateAction(query.context.task_id, query.context.action_class ?? "read", {
          ...query.context.details, repo: query.context.repo,
        });
      case "should_i_ask":
        return this.policyEngine.evaluateAutonomy(query);
      case "cost_check":
        return this.evaluateCostStatus(query.context.task_id);
      default:
        return { allowed: false, action: "deny", reason: "unknown query type" };
    }
  }

  getCostStatus(taskId?: string): CostStatus {
    return this.costTracker.getCostStatus(taskId);
  }

  getTimeoutPolicy(): ResponseTimeout {
    return this.policyEngine.getTimeoutPolicy();
  }

  updateConfig(newConfig: SafetyConfig): void {
    this.costTracker.updateLimits(newConfig.cost_limits);
    this.policyEngine.updateConfig(newConfig);
  }

  checkAutoMergeAllowed(repo: string): boolean {
    return this.policyEngine.checkAutoMergeAllowed(repo);
  }

  private evaluateCostStatus(taskId: string): SafetyVerdict {
    const status = this.costTracker.getCostStatus(taskId);
    const breached = this.costTracker.isAnyLimitBreached(taskId);
    const result: SafetyVerdict = breached
      ? { allowed: false, action: "deny", reason: "cost limit breached" }
      : { allowed: true, action: "proceed", reason: "cost within limits" };
    if (status.warnings.length > 0) result.warnings = status.warnings;
    return result;
  }
}
```

### 5F. Update Consumers

**`src/core/action-pipeline/index.ts`:**
- Change `import type { SafetyLayer, SafetyVerdict } from "../safety-layer/index.js"` to import `ISafetyLayer` and `SafetyVerdict` from interfaces
- Constructor parameter type changes from `SafetyLayer` to `ISafetyLayer`

**`src/cli/bootstrap.ts`:**
- No changes needed (still `new SafetyLayer(...)`)

**`src/core/orchestrator/index.ts`:**
- Change SafetyLayer import to `ISafetyLayer` from interfaces

**`src/core/daemon/index.ts`:**
- Change SafetyLayer import to `ISafetyLayer` from interfaces

### 5G. Update Test Helper

**`test/helpers/test-safety-layer.ts`:**
- Update to expose `costTracker` and `policyEngine` for isolated testing if needed
- Keep the same public API for backward compatibility

### 5H. New Test Files

**`src/core/safety-layer/cost-tracker.test.ts`:**
- Test CostTracker in isolation (create directly, not through SafetyLayer)
- Test paginated replay (create >1000 cost events, verify pagination works)
- Test snapshot save/restore cycle
- Test window rollover
- Test CLI usage tracking

**`src/core/safety-layer/policy-engine.test.ts`:**
- Test PolicyEngine in isolation (no DB, no EventBus)
- Test each scope check type
- Test autonomy evaluation with thresholds
- Test repo overrides
- Test merge policy

---

## 6. Refinement Checklist

- [ ] CostTracker has zero knowledge of policy/scope — only costs
- [ ] PolicyEngine has zero database access — pure config + logic
- [ ] SafetyLayer facade delegates correctly, no duplicated logic
- [ ] Tagged errors are used in appropriate places (CostLimitExceededError, ScopeDeniedError)
- [ ] Paginated replay is implemented with LIMIT in EventBus.getEventsSince
- [ ] All pure functions that were exported from the old index.ts are still exported (backward compat)
- [ ] All type exports that were available from the old index.ts are still available
- [ ] The `ActionClasses.read` constant is used instead of `"read"` string in action-pipeline (from R0)
- [ ] No circular imports between cost-tracker.ts, policy-engine.ts, and index.ts

---

## 7. Verification Steps

```bash
# Type checking
npx tsc --noEmit

# All tests (existing + new)
pnpm test

# Run only safety-layer tests to verify split
pnpm test src/core/safety-layer/

# Lint
pnpm lint
```

---

## Commit

When all verification passes, run `/commit` to stage and commit your changes.
