# System Layer Solutions — Proposed Refactors

> These are proposed solutions based on the gap analysis in `system-layers.md` Parts II and III. Every issue raised by all three reviewers (Torvalds, Hipp, Pike) is addressed with a concrete approach. The co-founders decide which to adopt, modify, or reject.
>
> Solutions are ordered by impact, not difficulty. Each includes what changes, what gets deleted, and what the end state looks like.

---

## Solution 1: Split the Task God Object

**Problem:** `TaskSchema` has 33 fields and 8 JSON columns in one row. `updateTaskField(field, unknown)` bypasses type safety. `children` denormalizes child state into parent JSON. Pipeline-internal counters (`loopback_count`, `requirements_loop_count`) are persisted on the entity.

**Proposed approach:**

Split into focused tables related by `task_id` foreign key:

```
tasks (identity + state — the hot path)
  id, title, description, state, sub_state, phase, priority, version,
  repo, clone_url, parent_id, cascade_policy, external_ref,
  acceptance_criteria, created_at, started_at, completed_at

task_workspace (created when workspace is set up)
  task_id FK, repo, branch, worktree_path, thoughts_dir, base_branch

task_review (created when PR is opened)
  task_id FK, pr_number, pr_state, demo_artifacts, feedback_rounds

task_tracking (cost/compute accumulation)
  task_id FK, total_tokens, total_cost_usd, total_compute_ms

task_blocked (created when task blocks, cleared when unblocked)
  task_id FK, reason, efforts_made, contacted, needed, waiting_for

task_children (one row per child — replaces JSON array)
  parent_id FK, child_id FK, depends_on (JSON array of child_ids)
```

**What changes:**
- `TaskEngine.updateTaskField()` becomes typed methods: `updateWorkspace(taskId, workspace)`, `updateReview(taskId, review)`, etc.
- `rowToTask()` becomes a join query or lazy-loaded sub-records
- `getTask()` can return the core row fast, with optional `{ includeWorkspace, includeReview }` for when callers need the full picture
- Child state is queried from `tasks` table directly (no denormalization)
- `loopback_count` and `requirements_loop_count` move to session/checkpoint data (they're session-scoped, not task-scoped)

**What gets deleted:**
- The `JSON_FIELDS` set and runtime serialization logic
- The `UpdatableField` 21-member string union
- The `children` JSON column and `ChildEntry` denormalization

**Migration:** One SQL migration adding the new tables, one migration script splitting existing JSON columns into rows, then drop the JSON columns.

**Risk:** Every consumer of `getTask()` currently expects the flat 33-field object. This is a significant refactor touching Orchestrator, Daemon, and Dashboard. Break it into phases: add new tables first (write to both), then migrate reads, then drop old columns.

---

## Solution 2: Decompose phase-runner.ts

**Problem:** 1,080 lines, 9 concerns, two biome-ignore suppressions. `handlePostPhaseActions` takes 10 parameters. The `targetIndex - 1` hack appears three times.

**Proposed approach:**

Replace the monolithic function with a **phase completion policy pattern:**

```typescript
// Each phase declares what happens after it completes
type PhaseCompletionRule = (
  output: PhaseOutput,
  state: PipelineState
) => PhaseCompletionResult;

type PhaseCompletionResult =
  | { action: "next" }                           // continue to next phase
  | { action: "jump", target: Phase }             // jump to specific phase
  | { action: "exit", result: ExecuteTaskResult }  // exit pipeline
  | { action: "block", reason: string }            // block task

// Registry of rules per phase
const COMPLETION_RULES: Record<Phase, PhaseCompletionRule[]> = {
  requirements_gathering: [checkNeedsMoreInfo, checkReturnToPhase],
  planning: [checkDecomposition],
  execution: [checkNeedsMoreInfo],
  self_review: [checkLoopback],
  demo_prep: [tryCreatePR],
  integration: [],
  research: [checkNeedsMoreInfo],
};
```

**The pipeline loop becomes ~50 lines:**

```typescript
function runPhasePipeline(phases: Phase[], state: PipelineState): ExecuteTaskResult {
  let i = 0;
  while (i < phases.length) {
    const phase = phases[i];
    const output = await runPhase(phase, state);

    // Check completion rules in order
    const rules = COMPLETION_RULES[phase] ?? [];
    let result: PhaseCompletionResult = { action: "next" };
    for (const rule of rules) {
      result = rule(output, state);
      if (result.action !== "next") break;
    }

    // Check preemption between every phase
    if (isPreempted(state)) return handlePreemption(state);

    switch (result.action) {
      case "next": i++; break;
      case "jump": i = phases.indexOf(result.target); break;
      case "exit": return result.result;
      case "block": return blockTask(state, result.reason);
    }
  }
  return completeTask(state);
}
```

**What gets extracted into separate files/functions:**
- `sendOutreachFromFiles()` → `orchestrator/outreach.ts` (or inline in the requirements completion rule)
- `commentOnSourceIssue()` → already in `orchestrator-notifier.ts`
- `tryCreatePRAndExitForReview()` → a completion rule function
- `checkDecomposition()` → a completion rule function
- `checkSelfReviewLoopback()` → a completion rule function
- `resolveStartState()` stays (resume logic)

**What gets deleted:**
- The `targetIndex - 1` hack (replaced by explicit `{ action: "jump", target: Phase }`)
- `handlePostPhaseActions` entirely (replaced by per-phase completion rules)
- The `PhaseCompletionResult` discriminated union with its 4 mutable fields
- Both `biome-ignore` suppressions

**End state:** `phase-runner.ts` drops from 1,080 to ~300 lines. Each completion rule is a pure function testable in isolation.

---

## Solution 3: Collapse File Count (~160 → ~60)

**Problem:** 160 non-test source files for ~29K lines. Concepts spread across 4-7 files each. The "stranger test" requires opening 10+ files for one bug.

**Proposed collapse map:**

### Delete entirely (0 lines replacing them)
| Current | Reason |
|---------|--------|
| `src/core/hooks/index.ts` | Zero production consumers |
| `src/core/orchestrator/andon-cord.ts` | Zero callers |
| `src/core/event-bus/topology.ts` | Fold useful parts into EventBus |
| `src/schemas/ephemeral.ts` | Replace with TypeScript interfaces |

### Merge interface files into implementations
| Current | Merge into |
|---------|-----------|
| `src/core/interfaces/event-bus.interface.ts` | `src/core/event-bus/index.ts` |
| `src/core/interfaces/task-engine.interface.ts` | `src/core/task-engine/index.ts` |
| `src/core/interfaces/safety-layer.interface.ts` | `src/core/safety-layer/index.ts` |
| `src/core/interfaces/action-pipeline.interface.ts` | `src/core/action-pipeline/index.ts` |
| `src/core/interfaces/session-memory.interface.ts` | `src/core/session-memory/index.ts` |
| `src/core/interfaces/workspace-manager.interface.ts` | `src/core/workspace-manager/index.ts` |
| `src/core/interfaces/people-directory.interface.ts` | `src/core/people-directory/index.ts` |
| `src/core/interfaces/plugin-lookup.interface.ts` | `src/core/registry/index.ts` |

### Collapse internal decomposition
| Current (multiple files) | Collapse to |
|--------------------------|-------------|
| `task-engine/` (6 files + interface) | `task-engine.ts` (~500 lines) |
| `registry/` (3 files + interface) | `registry.ts` (~400 lines) |
| `safety-layer/` (4 files + interface) | `safety-layer.ts` (~500 lines) |
| `action-pipeline/` (1 file + interface) | Inline into safety-layer or orchestrator |
| `people-directory/` (1 file + interface) | `people-directory.ts` (~100 lines) |
| `observer/` (7 files) | 3 files: `observer.ts` (facade + store), `blob-store.ts`, `stream.ts` |
| `adapters/` (7 files) | `adapters.ts` (one file, all 5 types) |

### Collapse error files
| Current | Approach |
|---------|----------|
| 9 separate `errors.ts` files | One `src/errors.ts` with a shared `EngineerError` base + error codes |

### Keep as-is (already right-sized)
- `src/db/` (database.ts, index.ts, migrations/)
- `src/config/` (loader.ts, watcher.ts)
- `src/core/orchestrator/prompts/` (each prompt file is a distinct phase)
- `src/plugins/` (each plugin is a distinct external integration)
- `src/dashboard/` (separate process, separate concern)
- `src/cli/commands/` (each command is independent)

**Estimated end state:** ~55-65 source files. Each file owns one concept end-to-end.

**Approach:** Do this incrementally. Start with the deletes (hooks, andon cord, ephemeral schemas). Then merge interfaces. Then collapse internals one system at a time. Each step is independently committable and testable.

---

## Solution 4: Unify the Event Schema Boilerplate

**Problem:** 34 event types each defined in four parallel structures in `events.ts` (540 lines). Adding one event = touching three locations. Missing one = silent runtime mismatch.

**Proposed approach:**

Single declaration table as source of truth:

```typescript
const EVENT_DEFINITIONS = {
  "task.created": {
    schema: z.object({ task_id: z.string(), title: z.string(), repo: z.string().nullable() }),
    description: "A new task was created",
  },
  "task.state_changed": {
    schema: z.object({ task_id: z.string(), from_state: z.string(), to_state: z.string(), reason: z.string() }),
    description: "Task transitioned to a new state",
  },
  // ... all 34
} as const satisfies Record<string, { schema: ZodType; description: string }>;

// Everything else derived automatically
export type EventType = keyof typeof EVENT_DEFINITIONS;
export type EventPayloads = { [K in EventType]: z.infer<(typeof EVENT_DEFINITIONS)[K]["schema"]> };
export const EventTypes = Object.keys(EVENT_DEFINITIONS) as EventType[];
export const eventPayloadSchemas = Object.fromEntries(
  Object.entries(EVENT_DEFINITIONS).map(([k, v]) => [k, v.schema])
);
```

**What gets deleted:**
- ~300 lines of parallel definitions
- The manually-maintained `EventPayloads` mapped type
- The manually-maintained `eventPayloadSchemas` record
- Every individual `FooBarPayloadSchema` export (replaced by `EVENT_DEFINITIONS["foo.bar"].schema`)

**What stays:** The derived types and the runtime schema map. But they're now auto-derived, not hand-synchronized.

**Risk:** Consumers that import individual `TaskCreatedPayloadSchema` need to change to `EVENT_DEFINITIONS["task.created"].schema`. Mechanical find-and-replace.

---

## Solution 5: Proper Error Taxonomy

**Problem:** 9 error files, no common hierarchy, no error codes. Retry logic in `llm-caller.ts` matches error messages by substring (`msg.includes("429")`). No classification of transient vs permanent vs operational.

**Proposed approach:**

```typescript
// src/errors.ts — single file, shared base

export type ErrorSeverity = "transient" | "permanent" | "operational" | "bug";

export class EngineerError extends Error {
  constructor(
    message: string,
    readonly code: string,          // e.g., "TASK_NOT_FOUND", "LLM_RATE_LIMITED", "DB_CORRUPT"
    readonly severity: ErrorSeverity,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EngineerError";
  }

  get retryable(): boolean {
    return this.severity === "transient";
  }
}

// Codes as const enum for compile-time safety
export const ErrorCodes = {
  // Task
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  // LLM
  LLM_RATE_LIMITED: "LLM_RATE_LIMITED",
  LLM_TIMEOUT: "LLM_TIMEOUT",
  LLM_NO_PLUGIN: "LLM_NO_PLUGIN",
  LLM_REJECTED: "LLM_REJECTED",
  // Adapter
  ADAPTER_AUTH_FAILED: "ADAPTER_AUTH_FAILED",
  ADAPTER_NOT_FOUND: "ADAPTER_NOT_FOUND",
  ADAPTER_NETWORK: "ADAPTER_NETWORK",
  // DB
  DB_CORRUPT: "DB_CORRUPT",
  DB_MIGRATION_FAILED: "DB_MIGRATION_FAILED",
  // Workspace
  WORKSPACE_NOT_FOUND: "WORKSPACE_NOT_FOUND",
  WORKSPACE_ESCAPE: "WORKSPACE_ESCAPE",
  // Safety
  COST_LIMIT_EXCEEDED: "COST_LIMIT_EXCEEDED",
  SCOPE_DENIED: "SCOPE_DENIED",
  // System
  DAEMON_ALREADY_RUNNING: "DAEMON_ALREADY_RUNNING",
  CONFIG_INVALID: "CONFIG_INVALID",
} as const;
```

**Retry logic becomes classification-based:**

```typescript
// Before (string matching):
if (msg.includes("429") || msg.includes("rate")) { retry(); }

// After (code-based):
if (error instanceof EngineerError && error.retryable) { retry(); }
```

**What gets deleted:**
- 9 separate `errors.ts` files (~320 lines total)
- All per-subsystem error class hierarchies
- String matching in retry logic

**What changes:**
- Every `throw new TaskNotFoundError(id)` becomes `throw new EngineerError("Task not found", ErrorCodes.TASK_NOT_FOUND, "permanent")`
- Or keep convenience constructors: `EngineerError.taskNotFound(id)` as static factories

**Risk:** Touching every throw site. But each is a mechanical change. The error codes themselves become the stable API — callers switch on codes, not class types.

---

## Solution 6: Fix the Adapter Tier Boundary

**Problem:** `BaseAdapter` has `hookRegistry?: unknown` and `observer?: unknown` typed as `unknown` to avoid tier import violations. The tier rule breaks type safety.

**Proposed approaches (pick one):**

### Option A: Shared types file (minimal change)
Create `src/shared/adapter-deps.ts`:
```typescript
export interface AdapterObserver {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

export interface AdapterHookExecutor {
  execute(hookPoint: string, data: unknown): Promise<void>;
}
```

Adapters import from `shared/`, not from `core/`. Tier rule preserved. Type safety restored.

### Option B: Drop the tier rule for observer (pragmatic)
Allow adapters to import the `IObserver` type (not the implementation). It's a type-only import — no runtime coupling. The tier boundary test allows type imports.

### Option C: Remove observer/hooks from BaseAdapter entirely
Plugins that need logging receive it via `initialize(config)` — pass observer as part of the config/context object. No base class field needed.

**Recommendation:** Option A. Minimal change, solves the problem, keeps tiers clean.

---

## Solution 7: Unify LLM Plugin NDJSON Parsers

**Problem:** `claude-code-llm.ts`, `gemini-cli-llm.ts`, `opencode-llm.ts` each have their own NDJSON parser with biome-ignore complexity suppressions. `buildLlmEnv()` is also duplicated across all three.

**Proposed approach:**

```typescript
// src/plugins/llm/shared.ts

export function buildLlmEnv(config: { env_passthrough?: string[] }): Record<string, string> {
  // Single implementation of env allowlist
}

export function parseNdjsonStream(
  stdout: string,
  extractors: {
    isResult: (line: unknown) => boolean;
    getContent: (line: unknown) => string;
    getUsage: (line: unknown) => TokenUsage | null;
    getCost: (line: unknown) => number | null;
  }
): { content: string; usage: TokenUsage | null; costUsd: number | null } {
  // Single NDJSON parser, plugin-specific extraction via callbacks
}
```

Each LLM plugin provides its extractors (since Claude, Gemini, and OpenCode have different JSON formats) but the parsing loop, error handling, and stream reassembly are shared.

**What gets deleted:** Three biome-ignore suppressions, ~150 lines of duplicated parsing logic, three copies of `buildLlmEnv`.

---

## Solution 8: Make the Tick Loop a Named Step Array

**Problem:** The daemon tick loop is 9+ sequential `await` calls. Adding/removing/reordering steps requires editing the function body.

**Proposed approach:**

```typescript
type TickStep = {
  name: string;
  run: (now: number) => Promise<void>;
  enabled?: () => boolean;  // optional guard
};

const TICK_STEPS: TickStep[] = [
  { name: "process-cost-flags", run: (now) => costLimitQueue.process() },
  { name: "poll-triggers", run: (now) => triggerPoller.poll(now) },
  { name: "poll-responses", run: (now) => responsePoller.poll(now) },
  { name: "sync-priorities", run: (now) => syncBasePriorities() },
  { name: "evaluate-preemption", run: (now) => preemption.evaluate() },
  { name: "schedule-next", run: (now) => scheduler.scheduleNext(now) },
  { name: "age-priorities", run: (now) => scheduler.applyPriorityAging(now) },
  { name: "check-stuck", run: (now) => healthMonitor.checkStuckTasks(now) },
  { name: "check-blocked", run: (now) => healthMonitor.checkBlockedEscalation(now) },
  { name: "check-reviews-reminders", run: (now) => healthMonitor.checkReviewPendingReminders(now) },
  { name: "check-merges", run: (now) => reviewHandler.checkMerges() },
  { name: "check-feedback", run: (now) => reviewHandler.checkFeedback() },
  { name: "cleanup-keys", run: (now) => triggerPoller.cleanupExpiredKeys(now) },
];

async function tick(): Promise<void> {
  const now = clock.now();
  for (const step of TICK_STEPS) {
    if (step.enabled && !step.enabled()) continue;
    try {
      await step.run(now);
    } catch (err) {
      observer.error(`Tick step ${step.name} failed`, { error: err });
    }
  }
}
```

**Benefits:**
- Self-documenting (step names visible in the array)
- Per-step error isolation (one failing step doesn't skip the rest)
- Testable at step level (run individual steps)
- Observable (log which steps ran, how long each took)
- Configurable (disable steps via config or feature flags)

**What gets deleted:** The procedural tick function body. The `reviewHandler.clearTickCache()` call can become a step.

---

## Solution 9: Add Missing Test Categories

**Problem:** 2,400 tests cover happy paths and first-layer failures. Missing: corruption, cascading failure, concurrent access, resource exhaustion.

**Proposed test additions:**

### Corruption tests
```typescript
describe("database corruption recovery", () => {
  it("handles truncated WAL file");
  it("handles garbage in _meta.schema_version");
  it("handles corrupt JSON in task.workspace column");
  it("handles safety snapshot with invalid JSON");
  it("handles observation with unparseable input/output");
});
```

### Cascading failure tests
```typescript
describe("failure during failure handling", () => {
  it("handles endSession throwing inside handlePhaseError");
  it("handles eventBus.publish throwing during shutdown");
  it("handles DB write failure during cost snapshot flush");
  it("handles registry.shutdownAll throwing during daemon stop");
});
```

### Concurrent access tests
```typescript
describe("concurrent database access", () => {
  it("handles two processes reading during daemon write");
  it("handles dashboard write during daemon write (busy_timeout)");
  it("handles migration lock timeout");
});
```

### Resource exhaustion tests
```typescript
describe("long-running stability", () => {
  it("cost tracker per_task Map doesn't grow unbounded after task completion");
  it("seenTriggerKeys Map doesn't grow unbounded with TTL cleanup");
  it("event table doesn't cause query degradation at 100K rows");
  it("blob store handles disk full gracefully");
});
```

**Priority order:** Corruption tests first (most likely to hit in production), then cascading failures, then resource exhaustion.

---

## Solution 10: Resolve the Workspace → Orchestrator Layer Violation

**Problem:** `workspace-manager/index.ts` imports `writeSessionResultTemplate()` from `orchestrator/session-result.ts`. This is Layer 3 importing from Layer 5.

**Proposed approach:**

Move `writeSessionResultTemplate()` to a shared location. Options:

### Option A: Move to schemas
`src/schemas/orchestrator.ts` already defines `SessionResultSchema`. Add `writeSessionResultTemplate()` there — it's just a JSON template writer, no orchestrator logic.

### Option B: Move to workspace-manager
The function writes a JSON file to the workspace's thoughts directory. The workspace manager owns that directory. The function belongs with its caller.

### Option C: Inject as callback
`WorkspaceManager.createWorkspace()` takes an optional `onThoughtsDirCreated?: (dir: string) => void` callback. The orchestrator passes `writeSessionResultTemplate`. No import needed.

**Recommendation:** Option B. The function is 10 lines of `fs.writeFileSync`. It belongs where it's used.

---

## Solution 11: EventBus Delivery Isolation

**Problem:** Synchronous delivery means a slow subscriber blocks all publishers. No per-subscriber timeout.

**Proposed approach:**

Split `publish()` into persist + deliver:

```typescript
publish<T>(input: PublishInput<T>): Event {
  const event = this.persist(input);  // SQLite INSERT — must succeed
  this.deliver(event);                 // fan out to subscribers — best effort
  return event;
}

private deliver(event: Event): void {
  for (const sub of this.subscriptions) {
    if (!matchesPattern(sub.pattern, event.type)) continue;
    try {
      const start = Date.now();
      sub.callback(event);
      const elapsed = Date.now() - start;
      if (elapsed > this.subscriberTimeoutMs) {
        this.observer.warn(`Subscriber ${sub.id} took ${elapsed}ms`, { event: event.type });
      }
    } catch (err) {
      this.observer.error(`Subscriber ${sub.id} threw`, { error: err, event: event.type });
      // Continue to next subscriber — don't let one failure block others
    }
  }
}
```

**Key change:** Each subscriber's error is caught individually. A throwing subscriber doesn't prevent other subscribers from receiving the event. The persist-before-deliver guarantee remains.

**Future evolution:** If throughput becomes an issue, `deliver()` can be made async with `queueMicrotask()` or `setImmediate()` without changing the persist guarantee.

---

## Solution 12: Dashboard Authentication

**Problem:** No auth. Any process on localhost can read all task data. `POST /api/open-explorer` executes `code [path]` from user input.

**Proposed approach:**

Token-file authentication (same pattern as PID file):

1. On daemon startup, generate a random token and write to `~/.engineer/data/dashboard.token` (0o600 permissions)
2. Dashboard reads the token file on startup
3. Every API request requires `Authorization: Bearer <token>` header
4. Dashboard UI reads token from a meta tag injected into index.html at serve time
5. `/api/open-explorer` additionally validates the path is within a known workspace root

**What changes:**
- `server.ts` gets a middleware that checks the bearer token
- `startDashboard()` takes a `tokenPath` parameter
- The static `index.html` is served through a handler that injects the token
- CLI commands that query the dashboard (`status`, `why`) read the token file

**Minimal implementation:** ~30 lines of middleware + ~10 lines of token file management.

---

## Solution 13: Eliminate the ObservationStore Middle Layer

**Problem:** Observer facade → ObservationStore → ObserverStore. Three layers for one SQLite INSERT.

**Proposed approach:**

Merge ObservationStore into the Observer facade:

```
Before: Observer.observe() → ObservationStore.observe() → ObserverStore.insert()
After:  Observer.observe() → ObserverStore.insert() + ObserverStream.notify()
```

The Observer facade already owns the `startSpan()` / `observe()` / `recordDecision()` / `recordError()` API. It should construct the `Observation` object and write it directly to the SQL store + notify the stream. The ObservationStore middle layer is pure delegation.

**What gets deleted:** `src/core/observer/observation-store.ts` (~262 lines). Its logic (ID generation, span tracking, blob storage) moves into the facade.

**What stays:** `ObserverStore` (SQL layer), `ObserverStream` (SSE pub/sub), `BlobStore` (content-addressable FS).

---

## Solution 14: Replace Class Hierarchy with Closure Pattern for Adapters

**Problem:** The adapter class hierarchy (`BaseAdapter` → 5 subclasses) uses template methods, `do*` prefixes, `unknown`-typed fields, and duplicated `wrapAsync` helpers. The closure pattern (used in daemon subsystems) is unanimously judged cleaner.

**Proposed approach:**

This is the most controversial solution and may not be worth the churn. But the end state would look like:

```typescript
// Instead of:
class GitHubTriggerPlugin extends TriggerAdapter {
  protected async doPoll(): Promise<TriggerEvent[]> { ... }
  protected async doInitialize(): Promise<InitResult> { ... }
  protected async doShutdown(): Promise<void> { ... }
  protected async doHealthCheck(): Promise<HealthStatus> { ... }
}

// You'd have:
function createGitHubTrigger(config: GitHubTriggerConfig): TriggerPlugin {
  let octokit: Octokit;
  const watermarks = new Map<string, string>();

  return {
    manifest: { ... },
    async initialize() { octokit = new Octokit({ auth: config.token }); return { success: true }; },
    async shutdown() { /* nothing */ },
    async healthCheck() { const rate = await octokit.rateLimit.get(); return { healthy: rate.remaining > 100 }; },
    async poll() { ... },
  };
}
```

**Trade-offs:**
- Pro: No `unknown` fields, no template methods, no `do*` prefix convention, no class hierarchy
- Pro: Matches the daemon pattern (proven to be the best code in the project)
- Con: Significant churn across all 8 plugins
- Con: Loses the template method's automatic timing/error-wrapping (but that's 10 lines as a wrapper function)

**Recommendation:** Do this only if also doing Solution 3 (file collapse). Otherwise the churn isn't worth it for a pattern that works, even if it's not ideal.

---

## Priority Order

Based on impact vs effort:

| Priority | Solution | Impact | Effort | Risk |
|----------|----------|--------|--------|------|
| 1 | S4: Unify event schema boilerplate | HIGH | LOW | LOW |
| 2 | S7: Unify LLM NDJSON parsers | HIGH | LOW | LOW |
| 3 | S5: Error taxonomy | HIGH | MEDIUM | LOW |
| 4 | S8: Named tick loop steps | MEDIUM | LOW | LOW |
| 5 | S6: Fix adapter tier boundary | MEDIUM | LOW | LOW |
| 6 | S2: Decompose phase-runner | HIGH | MEDIUM | MEDIUM |
| 7 | S10: Fix workspace layer violation | LOW | LOW | LOW |
| 8 | S11: EventBus delivery isolation | MEDIUM | LOW | LOW |
| 9 | S13: Eliminate ObservationStore middle layer | MEDIUM | MEDIUM | LOW |
| 10 | S3: Collapse file count | HIGH | HIGH | MEDIUM |
| 11 | S1: Split Task god object | HIGH | HIGH | HIGH |
| 12 | S9: Add missing test categories | HIGH | MEDIUM | LOW |
| 13 | S12: Dashboard auth | MEDIUM | LOW | LOW |
| 14 | S14: Adapter closure pattern | LOW | HIGH | MEDIUM |

Start from the top. Each solution is independently valuable and committable.

---

## Part II: Isolation, Cohesion & Integration — 5 Perspectives

> Solutions 1-14 focus on simplification and code quality. This section addresses a different question: **are things that belong together actually together? Are things that should be isolated actually isolated? When systems integrate, is it clean?**
>
> Five perspectives evaluate the same findings. Each brings a different lens to what "better architecture" means.

---

### The Cohesion Problems Found

Deep code-level analysis identified 5 places where one concept is fractured across multiple systems:

| # | Problem | Spread across |
|---|---------|---------------|
| C1 | GitHub integration | 4 plugins + github-utils (duplicated error classification, auth, retry logic) |
| C2 | Notifications | orchestrator-notifier.ts + daemon/notification-router.ts (overlapping APIs, dual comment functions) |
| C3 | PR lifecycle | orchestrator/pr-manager.ts + daemon/review-handler.ts + github-hosting plugin |
| C4 | Workspace concept | workspace-manager + orchestrator/workspace-lifecycle + orchestrator/session-result |
| C5 | Cost tracking | safety-layer/cost-tracker + orchestrator/llm-caller + daemon/cost-limit-queue (4-hop event chain) |

And 2 coupling/integration issues:

| # | Problem | Details |
|---|---------|---------|
| C6 | Dispatch carries stale snapshots | Full Task + Checkpoint copied at dispatch time, becomes stale during execution |
| C7 | Event subscriptions declared in bootstrap, not by the systems that use them | Violates "module declares its own dependencies" |

---

### Perspective 1: Linus Torvalds

> "Bad programmers worry about the code. Good programmers worry about data structures and their relationships."

**On GitHub duplication (C1):** "You have three files independently implementing `classifyGitHubError`. That is copy-paste. Fix it. Create a shared error classifier, share the Octokit instance factory, and move on. This is not an architecture problem — it is a discipline problem. One afternoon."

**On notifications split (C2):** "Two notification systems is one too many. The Orchestrator should not be sending messages. The Orchestrator's job is to run the pipeline. Notifications are a daemon concern — the daemon knows about task lifecycle, it knows when things complete, it knows when things fail. Let the daemon own all notifications. The Orchestrator emits events; the daemon reacts to them. That is the pattern you already use for cost limits. Use it for everything."

**On PR lifecycle (C3):** "This is the only one where the split is partially justified. PR *creation* happens inside the execution pipeline — the Orchestrator knows when the code is ready. PR *monitoring* happens in the daemon tick loop — checking merge status is polling, not execution. But the two halves should share a data structure: the PR record. Today they communicate via the Task's `review` JSON field, which is a serialized blob in a god-object row. Fix the Task schema (Solution 1) and this problem largely resolves itself — the PR lifecycle reads and writes a clean `task_review` table."

**On Dispatch staleness (C6):** "Don't carry copies of data. Carry references. The Dispatch should be `{ taskId, sessionId, checkpointId }` — three IDs. The Orchestrator queries the DB when it needs data. You have a synchronous DB layer. Use it. The current Dispatch is a cache that lies."

**On event subscriptions (C7):** "Subscribers should self-register. When I create a subsystem, it should declare what events it cares about. Not have some central wiring file know about every subscription. The Orchestrator already does this correctly for `preemption.requested` — it subscribes in its own constructor. The daemon subsystems should do the same."

---

### Perspective 2: D. Richard Hipp (SQLite)

> "The best code is code you don't have to write."

**On GitHub duplication (C1):** "This is 200 lines of code that exists twice. In SQLite, I would have one function that handles all GitHub HTTP errors, and every caller would use it. I would also consolidate the Octokit configuration — token, retry headers, rate limit handling — into one factory. Three plugins sharing one HTTP client is simpler than three plugins each building their own."

**On notifications split (C2):** "I am troubled by the overlapping APIs. `commentOnSourceIssue` (orchestrator) and `commentOnTaskIssue` (daemon) do the same thing. That is a bug waiting to happen — someone will fix one and not the other. Unify. One function. One call site decides when to call it."

**On cost tracking chain (C5):** "Four hops to block a task that exceeded its cost limit: LLM call → event → accumulate → event → daemon → block. In SQLite, the cost check would happen *at write time*. Before the LLM call, check the limit. After the LLM call, record the cost. If the new total exceeds the limit, block immediately. No events, no async chain, no 'next tick' delay. The safety gap — the LLM call completes but the block doesn't happen until the next tick — is a real deficiency."

**On workspace concept (C4):** "The workspace is a filesystem artifact. The session-result is a filesystem artifact inside the workspace. They belong in the same module. When I maintain SQLite's test harness, all filesystem operations for a test database — creation, population, corruption, cleanup — live in one place. Split filesystem ownership across modules and you get permission errors, stale paths, and orphaned files."

**On Dispatch staleness (C6):** "This is a classic caching anti-pattern. You snapshot data, pass the snapshot, and hope it stays current. It will not. In SQLite, every query returns current data because we query the source of truth. The Dispatch should carry IDs, not snapshots. The overhead of querying the DB is negligible — it is an in-process synchronous call with prepared statements and a 64MB cache."

---

### Perspective 3: Rob Pike (Go, Plan 9)

> "A little copying is better than a little dependency. But no copying is better than a little copying."

**On GitHub duplication (C1):** "Three copies of `classifyGitHubError` is bad. But be careful with the solution. Don't create a `GitHubSharedModule` with 15 helper functions, a `GitHubClientFactory`, and a `GitHubErrorClassifier` class. Extract the duplicated functions into `github-shared.ts`, export them as plain functions, import where needed. That is all. Do not build infrastructure for sharing — just share."

**On notifications split (C2):** "Two notification systems exist because two systems need to notify. The question is: should the Orchestrator notify at all, or should it just emit events and let someone else handle notifications? I lean toward the latter. The Orchestrator's job is to run phases. Notifications are a side effect. Let the daemon subscribe to orchestrator events and route all notifications. One notification system, one set of templates, one recipient resolver."

**On the Dispatch problem (C6):** "The Dispatch is a message between the Daemon and the Orchestrator. In Go, we pass messages through channels. The message should be small — an ID, a signal, a directive. Not a full copy of the world. `type Dispatch struct { TaskID string; ResumeFrom string }`. The receiver queries what it needs."

**On PR lifecycle (C3):** "The split between 'create PR' and 'monitor PR' is natural — they happen at different times, triggered by different events. But they should share the same understanding of what a PR is. Today, PR state is a JSON blob on the Task. Make it a first-class object. Then creation writes it, monitoring reads and updates it, and both use the same type."

**On event subscription fragmentation (C7):** "In Go, a goroutine that reads from a channel declares the channel in its signature. It does not get wired to the channel by a separate bootstrap function. Your subsystems should declare 'I need events matching this pattern' as part of their creation, and the creator (daemon factory or bootstrap) wires them. The subsystem owns the declaration; the parent owns the wiring."

---

### Perspective 4: The Engineer Persona

> "Every line earns its place. Every system is the simplest possible thing that could work."

**On all 5 cohesion problems:** "These are the symptoms of building bottom-up from design documents. Each layer was designed in isolation (Layer 2, 3, 4, 5), then implemented in phase order (Phase 6, 7, 8...). The *vertical* concerns (GitHub, notifications, PR lifecycle, cost) were never designed as cohesive units because the *horizontal* layers were the organizing principle.

This is fixable. The horizontal layers (Core, Adapter, Plugin) are correct for dependency management. But we need vertical *service* modules that cut across layers for cohesive concerns:

```
Horizontal layers (dependency direction):
  Foundation → Infrastructure → Communication → Core Services → Intelligence → Runtime

Vertical services (cohesion units):
  GitHub Service:     github-trigger + github-comm + github-hosting + github-shared
  Notification Service: all outbound messaging (milestone, completion, error, review reminder)
  PR Service:         creation + monitoring + feedback + merge detection
  Cost Service:       accumulation + limit checking + blocking + reporting
  Workspace Service:  git ops + directory structure + session-result templates
```

The layers enforce what can depend on what. The services enforce what belongs together. Both are needed. Currently we only have the layers."

**On Dispatch staleness (C6):** "This violates 'requirement clarity before all else.' The Dispatch is supposed to be the complete context for task execution. But it is a lie — it is a snapshot that becomes stale. A great engineer would either make the Dispatch truly authoritative (by locking the task during execution) or make it truly minimal (just IDs, query when needed). The current middle ground is the worst of both: it *looks* complete, so the Orchestrator trusts it, but it *isn't* complete, so bugs hide."

**On the stranger test:** "If a new contributor needs 10+ files to understand one bug, the system is not simple enough. Not because 10 files is inherently wrong, but because 10 files means 10 mental models. Each vertical service should be understandable by reading one directory. 'How do notifications work?' → read `src/core/communicator/`. 'How do PRs work?' → read `src/core/pr-lifecycle/`. One question, one place."

---

### Perspective 5: Technical Architect

> "What breaks if we do this? Can we reverse it?"

**On vertical services (the Engineer persona's proposal):** "This is a sound proposal with one critical risk: introducing vertical services on top of horizontal layers creates a matrix. Matrices are hard to navigate. The rule must be: **vertical services are implementation convenience, not architectural boundaries.** They group files, they don't create new interfaces or abstraction layers. A `github-shared/` directory with shared functions is fine. A `GitHubService` class with its own interface and lifecycle is over-engineering.

The test: can you delete a vertical service directory and replace it with inline code at each call site? If yes, the service is a useful grouping. If no, you've created a new dependency that increases coupling."

**On the notification unification:** "One-way door analysis: merging orchestrator-notifier and notification-router into a single Communicator changes who is responsible for *when* to notify. Currently the Orchestrator decides 'notify now' (sync, during execution) and the Daemon decides 'notify now' (async, during tick). A unified Communicator would need to handle both calling patterns.

My recommendation: don't merge the implementations. Instead, make them both delegate to a shared `formatAndSend(recipient, template, data)` function. The *decision* of when to notify stays with the system that has the context (Orchestrator for execution events, Daemon for lifecycle events). The *mechanism* of how to notify is shared. This is less elegant but much safer — it's a two-way door."

**On cost tracking (C5):** "The 4-hop event chain is the highest-risk cohesion problem. Here is why: the safety gap (LLM call succeeds, cost limit reached, but task not blocked until next tick) means you could overspend. For a system managing real money, that is not a 'nice to have' fix. The synchronous check proposed by Hipp is correct: before calling the LLM, ask the cost controller if you can afford it. After calling, record the cost synchronously. If you exceed the limit, block immediately — don't wait for an event chain."

**On Dispatch staleness (C6):** "This is a one-way door that was already walked through. The Dispatch-as-snapshot pattern is baked into the Orchestrator's `executeTask` signature. Changing it to ID-only requires changing how every phase accesses task data. The safe path: keep the Dispatch signature but add a `refreshTask()` method to the pipeline state that re-queries the DB. The Orchestrator calls it at phase boundaries (where it already creates checkpoints). Cost: one DB query per phase transition. Benefit: fresh data without changing the Dispatch contract."

---

### Proposed Solutions (Isolation & Integration)

#### Solution 15: Vertical Service Modules

Create cohesive directories for cross-cutting concerns. These are **groupings, not new abstraction layers** — shared functions, not new classes.

```
src/plugins/github-shared/
  errors.ts          # classifyGitHubError(), isRetryable() — used by all 3 GitHub plugins
  client.ts          # createOctokitClient() — shared factory
  utils.ts           # parseGitHubUrl(), parseTargetChannel(), diffStateLabels() — moved from github-utils.ts

src/core/communicator/
  index.ts           # formatAndSend(recipient, template, data) — shared sending mechanism
  templates.ts       # all notification templates in one place
  (orchestrator-notifier and notification-router both import from here)

src/core/cost-control/
  index.ts           # CostController: recordCost() (sync), checkLimit() (sync), getStatus()
  (replaces the 4-hop event chain with synchronous check + record)
```

**What doesn't change:** The daemon still decides when to send completion notifications. The orchestrator still decides when to send milestone notifications. PR creation stays in the orchestrator. PR monitoring stays in the daemon. The *decision* logic stays where the context is. Only the *shared mechanism* moves to the vertical module.

#### Solution 16: Fix Dispatch Staleness

Change Dispatch from full snapshot to minimal + refresh:

```typescript
// Keep existing Dispatch shape for backward compat
// But add a refresh mechanism to PipelineState:

interface PipelineState {
  // ... existing fields ...
  refreshTask(): Task;  // re-queries DB, returns fresh task
}

// At phase boundaries (where checkpoints already happen):
state.task = state.refreshTask();
```

This is a two-way door: if it causes performance issues, remove the refresh calls. If it prevents bugs, keep them.

#### Solution 17: Self-Registering Event Subscriptions

Move subscription declarations from bootstrap into the subsystem factories:

```typescript
// Before (in bootstrap.ts):
eventTopology.registerSubscriber("daemon:cost", "cost.limit_reached");
// Then separately in daemon/index.ts:
eventBus.subscribe("daemon:cost", EventTypes["cost.limit_reached"], handler);

// After (in subsystem factory):
function createCostLimitQueue(ctx): CostLimitQueue {
  // Self-register on creation
  ctx.eventBus.subscribe("daemon:cost", EventTypes["cost.limit_reached"], (event) => {
    queue.add(payload.task_id);
  });

  return { process, add };
}
```

Bootstrap's job becomes: create subsystems (which self-register) and start the tick loop. Not wire internal subscriptions.

**Note:** Some subsystems already do this correctly (Orchestrator's preemption gate). This solution makes the pattern universal.

#### Solution 18: Synchronous Cost Check Before LLM Calls

Replace the 4-hop async cost chain with a synchronous pre-check:

```typescript
// In llm-caller.ts, before calling the LLM:
const costCheck = safetyLayer.checkCostLimits(taskId);
if (costCheck.action === "deny") {
  return { outcome: "rejected", gate: "safety_layer", reason: costCheck.reason };
}

// After LLM call:
safetyLayer.recordCost(taskId, result.costUsd, result.tokens);
// This is synchronous — limit breach detected immediately, not next tick
```

**What gets deleted:** The `cost.limit_reached` event, the `cost-limit-queue.ts` daemon subsystem, the EventBus subscription for cost events. The entire 4-hop chain collapses to two synchronous calls.

**What stays:** `cost.incurred` event (for audit trail / dashboard visibility). But it becomes informational, not the trigger for blocking.

---

### Updated Priority Table (Solutions 1-18)

| Priority | Solution | Impact | Effort | Risk |
|----------|----------|--------|--------|------|
| 1 | S4: Unify event schema boilerplate | HIGH | LOW | LOW |
| 2 | S7: Unify LLM NDJSON parsers | HIGH | LOW | LOW |
| 3 | S15: Vertical service modules (github-shared, communicator) | HIGH | LOW | LOW |
| 4 | S18: Synchronous cost check | HIGH | LOW | LOW |
| 5 | S5: Error taxonomy | HIGH | MEDIUM | LOW |
| 6 | S8: Named tick loop steps | MEDIUM | LOW | LOW |
| 7 | S17: Self-registering event subscriptions | MEDIUM | LOW | LOW |
| 8 | S6: Fix adapter tier boundary | MEDIUM | LOW | LOW |
| 9 | S2: Decompose phase-runner | HIGH | MEDIUM | MEDIUM |
| 10 | S16: Fix Dispatch staleness | MEDIUM | LOW | LOW |
| 11 | S10: Fix workspace layer violation | LOW | LOW | LOW |
| 12 | S11: EventBus delivery isolation | MEDIUM | LOW | LOW |
| 13 | S13: Eliminate ObservationStore middle layer | MEDIUM | MEDIUM | LOW |
| 14 | S3: Collapse file count | HIGH | HIGH | MEDIUM |
| 15 | S1: Split Task god object | HIGH | HIGH | HIGH |
| 16 | S9: Add missing test categories | HIGH | MEDIUM | LOW |
| 17 | S12: Dashboard auth | MEDIUM | LOW | LOW |
| 18 | S14: Adapter closure pattern | LOW | HIGH | MEDIUM |
