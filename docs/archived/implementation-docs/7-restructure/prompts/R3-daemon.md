# Phase R3: Daemon Decomposition

**Wave 2 (Parallel) -- Can run alongside R1, R2a, R2b, R2c, R4.**

---

## Worktree Setup (DO THIS FIRST)

This phase runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-R3 -b layer7/R3 main
cd ../engineer-R3
```

**Rules:**
- Work ONLY in this worktree (`../engineer-R3/`)
- Commit your changes to the `layer7/R3` branch
- Do NOT push — the merge prompt will collect this branch
- Do NOT modify files outside the scope listed in this prompt
- When done: commit, verify tests pass, stop. The merge wave handles the rest.

---

You are an autonomous software engineering agent working on The Engineer project. This prompt is fully self-contained -- you have zero prior context. Follow every step precisely.

---

## 1. Identity Preamble

Before making any changes, read these files to understand who The Engineer is:

- `docs/persona.md` -- The Engineer's identity and characteristics
- `docs/philosophy.md` -- Core beliefs: agent-agnostic protocol, minimalism, real engineer behavior, modular everything
- `implementation-docs/0-foundation/philosophy.md` -- Builder-specific principles (say it once, collaboration, no premature artifacts)

Internalize: The Engineer is the 100,000x engineer. Every line earns its place. Simplicity is the goal. Full names, no abbreviations.

---

## 2. Architecture Catchup

Read these docs to understand the system architecture relevant to this phase:

- `implementation-docs/1-system/overview.md` -- System overview, three-tier model
- `implementation-docs/1-system/task-states.md` -- CPU-derived state machine (critical for Daemon scheduling)
- `implementation-docs/2-components/daemon.md` (if it exists) -- Daemon component design
- `implementation-docs/3-interactions/protocols.md` -- Protocols P1 (startup), P8 (preemption), P15 (shutdown)
- `implementation-docs/3-interactions/event-catalog.md` -- Event catalog (30 events)
- `implementation-docs/3-interactions/lifecycle.md` -- Lifecycle traces
- `implementation-docs/4-implementation/operations.md` -- Deployment & operations decisions (D109-D118)
- `implementation-docs/7-restructure/assessment.md` -- Layer 7 assessment (Daemon identified as worst god object: 1,964 LOC, 70+ functions, 10 concerns mixed)
- `implementation-docs/7-restructure/decisions.md` -- Layer 7 decisions (D166+)

---

## 3. Decision Log Review

Read `implementation-docs/decisions.md` and understand these specific decisions:

- **D109**: PID file management
- **D110**: Pino logging with rolling JSON
- **D111**: Structured logging patterns
- **D112**: Tick interval configuration
- **D124**: Factory function pattern (Daemon uses `createDaemon()`)
- **D128**: Build order (Phase 12 = Daemon)
- **D137-D142**: Layer 6 assessment decisions
- **D144**: Workspace-first pipeline
- **D147-D154**: Workspace/PR/notifications/cleanup/sanitization

Also check `implementation-docs/7-restructure/decisions.md` for any D166+ decisions that affect Daemon decomposition.

---

## 4. Current Code Deep-Read

Read ALL of these files completely before making any changes:

### Source files (the files being decomposed)
- `src/core/daemon/index.ts` -- **The main file** (1,964 LOC, `createDaemon()` factory + 5 exported pure functions)
- `src/core/daemon/query-handler.ts` -- Already extracted query handling
- `src/core/daemon/logging.ts` -- Already extracted logging setup

### Schema files
- `src/schemas/config.ts` -- `DaemonConfig` schema
- `src/schemas/adapters.ts` -- `TriggerEvent`, adapter types
- `src/schemas/ephemeral.ts` -- `Dispatch` type
- `src/schemas/events.ts` -- All event types and payloads (especially `TaskStateChangedPayload`, `TaskChildrenAllDonePayload`, `TaskFeedbackReceivedPayload`, `EventPayloads`)
- `src/schemas/task.ts` -- Task type, `TaskState`, `ChildEntry`

### Dependencies (interfaces consumed)
- `src/core/event-bus/index.ts` -- `EventBus`, `PublishInput`
- `src/core/orchestrator/index.ts` -- `Orchestrator`, `ExecuteTaskResult`
- `src/core/task-engine/index.ts` -- `TaskEngine` interface
- `src/core/safety-layer/index.ts` -- `SafetyLayer` interface
- `src/core/session-memory/index.ts` -- `SessionMemory` interface
- `src/core/workspace-manager/index.ts` -- `WorkspaceManager` interface
- `src/core/people-directory/index.ts` -- `PeopleDirectory` interface
- `src/core/registry/index.ts` -- `Registry` class
- `src/core/action-pipeline/index.ts` -- `ActionPipeline` interface
- `src/plugins/github-shared/index.ts` -- `parseGitHubUrl`, `toExternalRef`

### Test files
- `src/core/daemon/index.test.ts` -- Main Daemon tests (42 tests)
- `src/core/daemon/notifications.test.ts` -- Notification tests
- `src/core/daemon/decomposition.test.ts` -- Decomposition handling tests
- `src/core/daemon/query-handler.test.ts` -- Query handler tests

### Test helpers
- `test/helpers/test-daemon.ts` -- `createTestDaemon()` helper
- `test/helpers/fake-clock.ts` -- `Clock` interface, `FakeClock`
- `test/helpers/mock-factories.ts` -- Mock factories
- `test/helpers/integration-context.ts` -- Integration context

---

## 5. Exact Specifications

> **SOURCE OF TRUTH:** The method names, signatures, and structures in this prompt are approximate guidance. You MUST read the actual source code first (Step 4) and derive your implementation from what's really there. If the code differs from this prompt, **the code is the source of truth**.

### Goal
Decompose the monolithic `createDaemon()` factory (1,964 LOC, 70+ functions) into 6 focused subsystems. The `createDaemon()` function remains as the public entry point but delegates to subsystems. Each subsystem is a factory function returning an object with methods.

### New file structure

```
src/core/daemon/
  index.ts              -- createDaemon() facade + Daemon interface + exported pure functions + barrel
  trigger-poller.ts     -- Trigger polling subsystem
  task-scheduler.ts     -- Task scheduling, dispatch, completion handling
  preemption-manager.ts -- Preemption evaluation and timeout handling
  notification-router.ts -- All notification and communication logic
  review-handler.ts     -- Review feedback detection, merge detection, approval/rework handling
  health-monitor.ts     -- Stuck detection, blocked escalation, review reminders, cost limits
  query-handler.ts      -- (already extracted, keep as-is)
  logging.ts            -- (already extracted, keep as-is)
  index.test.ts         -- Existing tests (update imports if needed)
```

### Shared Dependencies Interface

All subsystems receive a shared dependencies object. Define it in `index.ts`:

```typescript
/** Shared dependencies available to all Daemon subsystems. */
export interface DaemonContext {
  config: DaemonConfig;
  eventBus: EventBus;
  registry: Registry;
  taskEngine: TaskEngine;
  safetyLayer: SafetyLayer;
  orchestrator: Orchestrator;
  sessionMemory: SessionMemory;
  workspaceManager: WorkspaceManager;
  peopleDirectory: PeopleDirectory;
  clock: Clock;
  logger: Logger;
}
```

### Module: `trigger-poller.ts`

Extract trigger polling logic:

```typescript
export interface TriggerPoller {
  /** Poll all registered triggers and process new events. */
  poll(now: number): Promise<void>;
  /** Get the current count of seen (deduped) trigger keys. */
  getSeenKeyCount(): number;
  /** Get failure counts per trigger plugin. */
  getTriggerFailures(): Record<string, number>;
  /** Clean up expired seen keys. */
  cleanupExpiredKeys(now: number): void;
}

export function createTriggerPoller(ctx: DaemonContext): TriggerPoller
```

Functions to move here:
- `pollTriggers()`, `pollSingleTrigger()`, `processNewTriggerEvent()`
- `cleanupSeenKeys()`
- `emitHealthTriggerFailure()`
- State: `triggerLastPoll`, `triggerFailures`, `seenTriggerKeys` maps

**Improvement -- Adaptive polling**: When `triggerFailures` count exceeds threshold, apply exponential backoff to that trigger's poll interval (double the interval on each failure, cap at 5 minutes, reset on success). This prevents hammering a failing API. Implement as:
```typescript
function getEffectivePollInterval(pluginId: string): number {
  const failures = triggerFailures.get(pluginId) ?? 0;
  if (failures === 0) return ctx.config.trigger_poll_interval_ms;
  const backoff = ctx.config.trigger_poll_interval_ms * Math.pow(2, Math.min(failures, 8));
  return Math.min(backoff, 300_000); // Cap at 5 minutes
}
```

**Improvement -- N+1 batch fetch**: The current `pollTriggers()` iterates triggers sequentially with `await`. Change to `Promise.allSettled()` for parallel polling of all triggers:
```typescript
async function poll(now: number): Promise<void> {
  const triggers = ctx.registry.getPluginsByType<TriggerAdapter>("trigger");
  await Promise.allSettled(triggers.map(t => pollSingleTrigger(t, now)));
}
```

### Module: `task-scheduler.ts`

Extract task scheduling and dispatch:

```typescript
export interface TaskScheduler {
  /** Schedule eligible queued tasks into available slots. */
  scheduleNext(): void;
  /** Dispatch a specific task to the Orchestrator. */
  dispatchTask(task: SchedulableTask): void;
  /** Get currently active dispatch task IDs. */
  getActiveTaskIds(): string[];
  /** Get count of completed tasks. */
  getTasksCompleted(): number;
  /** Get available concurrency slots. */
  getAvailableSlots(): number;
  /** Track a base priority for aging. */
  trackBasePriority(taskId: string, priority: number): void;
  /** Remove an active dispatch (for preemption/shutdown). */
  removeActiveDispatch(taskId: string): void;
  /** Get the active dispatches map (for shutdown drain). */
  getActiveDispatches(): Map<string, Promise<ExecuteTaskResult>>;
}

// Callback for task completion/error (injected by createDaemon)
export interface SchedulerCallbacks {
  onTaskCompleted(taskId: string, result: ExecuteTaskResult): void;
  onTaskError(taskId: string, error: unknown): void;
}

export function createTaskScheduler(
  ctx: DaemonContext,
  callbacks: SchedulerCallbacks,
): TaskScheduler
```

Functions to move here:
- `getAvailableSlots()`, `isTaskEligible()`, `scheduleNext()`, `dispatchTask()`
- `handleTaskCompletion()`, `handleTaskError()`
- `checkAndEmitChildrenAllDone()`
- `applyPriorityAging()`
- State: `activeDispatches`, `basePriorities`, `tasksCompleted`

**Improvement -- Lifecycle events**: Emit `task.dispatched` event when a task is dispatched (currently only logs). This enables the War Room dashboard to show real-time dispatch activity:
```typescript
ctx.eventBus.publish({
  type: "task.dispatched",
  source: "daemon",
  task_id: candidate.id,
  payload: { task_id: candidate.id, title: candidate.title, resumed: !!checkpoint },
});
```
Note: You may need to add `task.dispatched` to the event schema if it doesn't exist. If adding schema changes feels too invasive for this phase, add a TODO comment instead.

### Module: `preemption-manager.ts`

Extract preemption logic:

```typescript
export interface PreemptionManager {
  /** Evaluate whether preemption should occur. */
  evaluate(now: number): void;
  /** Get the current pending preemption (if any). */
  getPending(): PendingPreemption | null;
  /** Clear the pending preemption (called after preemption completes). */
  clearPending(): void;
}

export interface PendingPreemption {
  targetTaskId: string;
  replacementTaskId: string;
  requestedAt: number;
  retried: boolean;
}

export function createPreemptionManager(
  ctx: DaemonContext,
  getActiveTaskIds: () => string[],
): PreemptionManager
```

Functions to move here:
- `evaluatePreemption()`, `findAndInitiatePreemption()`, `initiatePreemption()`
- `checkPreemptionTimeout()`
- State: `pendingPreemption`

The `getActiveTaskIds` callback avoids coupling to the scheduler directly.

### Module: `notification-router.ts`

Extract ALL notification and communication logic:

```typescript
export interface NotificationRouter {
  /** Send completion notification to owner. */
  sendCompletion(taskId: string, taskTitle: string): void;
  /** Send review-pending notification to owner. */
  sendReviewPending(taskId: string, taskTitle: string): void;
  /** Send task error notification to owner. */
  sendTaskError(taskId: string, taskTitle: string, reason: string): void;
  /** Send cost limit notification to owner. */
  sendCostLimit(taskId: string, taskTitle: string): void;
  /** Send blocked reminder to owner. */
  sendBlockedReminder(taskId: string, taskTitle: string): void;
  /** Send escalation alert to owner + reviewers. */
  sendEscalationAlert(taskId: string, taskTitle: string): void;
  /** Send review reminder to reviewers. */
  sendReviewReminder(taskId: string, taskTitle: string, elapsedMs: number): void;
  /** Comment on a task's source GitHub issue. */
  commentOnTaskIssue(taskId: string, message: string): void;
  /** Sync task state change to communication plugins. */
  syncStateToCommPlugin(payload: TaskStateChangedPayload): void;
}

export function createNotificationRouter(ctx: DaemonContext): NotificationRouter
```

Functions to move here:
- `sendCompletionNotification()`, `sendReviewPendingNotification()`, `sendTaskErrorNotification()`, `sendCostLimitNotification()`
- `sendBlockedReminder()`, `sendEscalationAlert()`, `sendReviewReminder()`
- `commentOnTaskIssue()`
- `syncStateToCommPlugin()`

**Improvement -- Notification templates as data**: Replace the hardcoded string templates with a data structure:
```typescript
const NOTIFICATION_TEMPLATES: Record<string, {
  format: (vars: Record<string, string>) => string;
  messageType: "milestone" | "notification" | "alert";
  recipients: "owner" | "reviewers" | "owner_and_reviewers";
}> = {
  completion: {
    format: (v) => `Task "${v.title}" completed successfully.`,
    messageType: "milestone",
    recipients: "owner",
  },
  // ... etc
};
```

Then the individual send functions become thin wrappers around a generic `sendNotification(templateKey, vars)`.

### Module: `review-handler.ts`

Extract review feedback detection and handling:

```typescript
export interface ReviewHandler {
  /** Check for PR merges on review-pending tasks. */
  checkMerges(): Promise<void>;
  /** Check for PR review feedback on review-pending tasks. */
  checkFeedback(): Promise<void>;
  /** Handle a feedback event (called from EventBus subscription). */
  handleFeedbackEvent(payload: TaskFeedbackReceivedPayload): void;
}

export interface ReviewHandlerCallbacks {
  /** Called when a task should be completed (PR merged or code approved). */
  onTaskComplete(taskId: string, taskTitle: string): void;
}

export function createReviewHandler(
  ctx: DaemonContext,
  notifications: NotificationRouter,
  callbacks: ReviewHandlerCallbacks,
): ReviewHandler
```

Functions to move here:
- `checkReviewPendingMerges()`, `checkSingleTaskMerge()`, `completeTaskOnMerge()`
- `checkReviewPendingFeedback()`, `checkSingleTaskReviewFeedback()`
- `fetchPRCommentStrings()`, `resolveAggregateState()`, `emitFeedbackIfNew()`
- `handleFeedbackEvent()`, `storeFeedbackRound()`, `handleReviewApproval()`, `handleDemoApproval()`, `handleCodeApproval()`, `handleFeedbackRework()`
- `ENGINEER_COMMENT_MARKERS` constant
- State: `processedReviewStates` map

**Improvement -- Time-windowed failure counting**: Track review API failures with timestamps, not just counts. If failures occur within a window (e.g., 5 minutes), back off. If they're spread over hours, don't penalize:
```typescript
const reviewApiFailures: { timestamp: number }[] = [];
function shouldSkipReviewPolling(): boolean {
  const recentWindow = ctx.clock.now() - 300_000; // 5 min
  const recentFailures = reviewApiFailures.filter(f => f.timestamp > recentWindow);
  return recentFailures.length >= 3;
}
```

### Module: `health-monitor.ts`

Extract health/stuck/escalation/reminder monitoring:

```typescript
export interface DaemonHealthMonitor {
  /** Check stuck tasks, blocked escalation, review reminders. */
  checkAll(now: number): void;
  /** Process cost limit events. */
  processCostLimits(): void;
  /** Register a cost limit task (called from EventBus subscription). */
  addCostLimitTask(taskId: string): void;
}

export function createDaemonHealthMonitor(
  ctx: DaemonContext,
  notifications: NotificationRouter,
  getActiveTaskIds: () => string[],
): DaemonHealthMonitor
```

Functions to move here:
- `checkStuckTasks()`, `checkSingleTaskStuck()`, `emitStuckDetected()`
- `checkBlockedEscalation()`, `processBlockedStages()`, `shouldFireStage()`, `executeBlockedStageAction()`
- `checkReviewPendingReminders()`, `cleanupStaleReminderTimes()`, `evaluateReviewReminder()`
- `processCostLimits()`
- State: `blockedEscalationState`, `reviewReminderTimes`, `costLimitTasks`

### Updated `index.ts` (createDaemon facade)

The `createDaemon()` factory becomes a thin coordinator:

```typescript
export function createDaemon(config: DaemonConfig, deps: DaemonDependencies): Daemon {
  const ctx: DaemonContext = { config, ...deps };

  // Create subsystems
  const notifications = createNotificationRouter(ctx);
  const scheduler = createTaskScheduler(ctx, {
    onTaskCompleted: (taskId, result) => handleTaskCompletion(taskId, result),
    onTaskError: (taskId, error) => handleTaskError(taskId, error),
  });
  const preemption = createPreemptionManager(ctx, () => scheduler.getActiveTaskIds());
  const triggerPoller = createTriggerPoller(ctx);
  const reviewHandler = createReviewHandler(ctx, notifications, {
    onTaskComplete: (taskId, title) => { /* completion logic */ },
  });
  const healthMonitor = createDaemonHealthMonitor(ctx, notifications, () => scheduler.getActiveTaskIds());

  // handleTaskCompletion dispatches to notifications, scheduler, reviewHandler as needed
  // tick() calls subsystems in order
  // start()/stop() manage PID, signals, subscriptions, intervals

  return { start, stop, tick, getState };
}
```

The `handleTaskCompletion()` and `handleChildrenAllDone()` functions remain in `index.ts` because they coordinate across subsystems (scheduler + notifications + review handler).

**Keep in `index.ts`**:
- `Clock`, `RealClock`, `DaemonDependencies`, `DaemonState`, `Daemon` interfaces
- Exported pure functions: `isSlotConsuming()`, `shouldPreempt()`, `computeAgedPriority()`, `deriveAggregateReviewState()`, `evaluateTaskStuckness()`
- `isProcessAlive()` private function
- PID file management: `checkAndWritePidFile()`, `removePidFile()`
- EventBus subscription registration/unregistration
- `start()`, `stop()`, `tick()`, `getState()`, `drainActiveDispatches()`
- `rebuildStateFromTaskEngine()`
- `handleTaskCompletion()`, `handleTaskError()`, `handleChildrenAllDone()`

### Barrel exports

Re-export from subsystem modules as needed:

```typescript
export { createTriggerPoller, type TriggerPoller } from "./trigger-poller.js";
export { createTaskScheduler, type TaskScheduler } from "./task-scheduler.js";
export { createPreemptionManager, type PreemptionManager, type PendingPreemption } from "./preemption-manager.js";
export { createNotificationRouter, type NotificationRouter } from "./notification-router.js";
export { createReviewHandler, type ReviewHandler } from "./review-handler.js";
export { createDaemonHealthMonitor, type DaemonHealthMonitor } from "./health-monitor.js";
```

---

## 6. Refinement Checklist

Apply these improvements during the decomposition:

- [ ] **Adaptive polling**: Exponential backoff on trigger poll failures (see trigger-poller.ts spec)
- [ ] **N+1 batch fetch**: Parallel trigger polling via `Promise.allSettled()`
- [ ] **Time-windowed failure counting**: Review API failures tracked by timestamp (see review-handler.ts spec)
- [ ] **Notification templates as data**: Centralize notification message templates (see notification-router.ts spec)
- [ ] **Lifecycle events**: Emit events at dispatch time for observability
- [ ] **Trace context propagation**: Each subsystem method that could benefit should accept an optional `traceId` parameter for correlation. At minimum, log the trace ID in all structured log calls.
- [ ] **Data retention**: `cleanupExpiredKeys()` already exists. Add cleanup for stale `blockedEscalationState` entries (tasks that are no longer blocked) and `processedReviewStates` entries (tasks no longer in review_pending). This already partially exists -- verify it's complete in the new modules.
- [ ] **No circular imports**: Subsystems depend on `DaemonContext` (defined in index.ts). They do NOT import each other directly. Cross-subsystem communication goes through callbacks or the coordinator in `index.ts`.
- [ ] **Consistent error handling**: All fire-and-forget `.catch()` blocks should log with structured data (`{ taskId, err }`) consistently

---

## 7. Verification Steps

After completing all changes, run these commands and verify they pass:

```bash
# 1. Type check
pnpm tsc --noEmit

# 2. Run Daemon unit tests
pnpm vitest run src/core/daemon/

# 3. Run full test suite to catch any consumer breakage
pnpm vitest run

# 4. Biome lint + format
pnpm biome check --write .

# 5. Verify no new lint errors
pnpm biome check .
```

All existing tests (42 Daemon tests + notification tests + decomposition tests + query handler tests + all consumer tests) MUST pass without modification to test assertions. If any test imports internal functions that moved, update the imports only.

Additionally, write NEW tests for each extracted subsystem:

- `src/core/daemon/trigger-poller.test.ts` -- Test polling, dedup, adaptive backoff, batch fetch (at least 10 tests)
- `src/core/daemon/task-scheduler.test.ts` -- Test scheduling, eligibility, dispatch, completion handling (at least 10 tests)
- `src/core/daemon/preemption-manager.test.ts` -- Test evaluation, initiation, timeout handling (at least 6 tests)
- `src/core/daemon/notification-router.test.ts` -- Test each notification type, template rendering, channel routing (at least 8 tests)
- `src/core/daemon/review-handler.test.ts` -- Test merge detection, feedback detection, dedup, approval/rework flows (at least 10 tests)
- `src/core/daemon/health-monitor.test.ts` -- Test stuck detection, blocked escalation, review reminders, cost limits (at least 8 tests)

Use `vi.fn()` mocks for dependencies. Follow the existing test patterns in `src/core/daemon/index.test.ts`.

---

## Commit

When all verification passes, run `/commit` to stage and commit your changes.
