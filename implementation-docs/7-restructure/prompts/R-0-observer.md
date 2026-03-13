# Phase R-0: Centralized Observer — The War Room's Eyes

> **Wave:** 0 (before everything else)
> **Parallel:** No — this is the foundation all other phases build on
> **Touches:** `src/core/observer/`, `src/schemas/observability.ts`, `src/db/migrations/`

---

## Identity Preamble

Before writing any code, read these files to absorb the project's identity and quality bar:

1. `docs/persona.md` — who The Engineer is (the 100,000x engineer)
2. `docs/philosophy.md` — core beliefs (minimalism, modular everything, open source for all)
3. `implementation-docs/0-foundation/philosophy.md` — builder principles (say it once, collaboration, no premature artifacts)

**Quality standard:** Every line earns its place. Delete more than you write. Simplest thing that works.

---

## Architecture Context

Read these to understand the current observability landscape:

1. `src/core/observability/index.ts` — current ObservabilityStore (passive trace storage, 314 LOC)
2. `src/core/observability/blob-store.ts` — content-addressable storage for LLM prompts
3. `src/schemas/observability.ts` — ActionTrace, LlmTrace, PhaseMetric schemas
4. `src/db/migrations/002_observability.sql` — current 3 observability tables
5. `src/core/daemon/logging.ts` — current pino logging setup
6. `src/schemas/events.ts` — all 30+ event types (understand what's already an "event")
7. `src/core/event-bus/index.ts` — EventBus (audit trail events, NOT observability)
8. `implementation-docs/3-interactions/event-catalog.md` — event catalog design
9. `implementation-docs/2-components/event-bus.md` — EventBus design (understand: EventBus = audit trail, Observer = visibility)

**Key insight:** The EventBus is the audit trail — it records business events (task created, state changed, cost incurred). The Observer is different — it records EVERYTHING that happens for the War Room dashboard. These are complementary, not competing.

---

## Decision Context

- D155-D159 (Session 061): War Room dashboard architecture
- D143 (Session 052): The Engineer owns the agent loop, LLMs are inference-only
- The current `ObservabilityStore` was built in Session 061 as a passive store. This phase evolves it into an active, centralized observer.

---

## Current Code Deep-Read

Before making changes, read EVERY one of these files completely:

```
src/core/observability/index.ts        — understand all current methods
src/core/observability/blob-store.ts   — understand blob storage
src/schemas/observability.ts           — understand current trace schemas
src/db/migrations/002_observability.sql — understand current tables
src/core/daemon/logging.ts             — understand logging setup
src/core/orchestrator/index.ts         — find ALL places where observability is called
src/core/orchestrator/agent-loop.ts    — find ALL places where traces should exist but don't
src/core/orchestrator/action-executor.ts — understand action execution
src/core/daemon/index.ts               — find ALL event emissions and logging
src/core/safety-layer/index.ts         — find evaluateAction/consultJudgment (no traces)
src/core/workspace-manager/index.ts    — find git operations (no timing)
src/core/task-engine/index.ts          — find state transitions
src/core/registry/index.ts             — find plugin lifecycle events
src/plugins/llm/claude-code-llm/claude-code-llm.ts — find LLM invocation
src/plugins/tool/bash-tool/bash-tool.ts — find tool execution
```

---

## What to Build

### The Observer (`src/core/observer/`)

A centralized component that ALL other components call to report what's happening. One interface, one implementation, one place where all visibility flows.

### Design Principles

1. **One call pattern** — Every component calls `observer.trace(category, event, data)`. That's it. The Observer decides what to persist, stream, and log.
2. **Structured categories** — Not free-form strings. Typed categories that map to dashboard sections.
3. **Zero-cost when unused** — If no dashboard is connected, traces are still persisted (cheap SQLite writes) but no SSE overhead.
4. **Replaces nothing** — EventBus stays for business events (audit trail). Logger stays for operational logs. Observer is additive — the War Room's dedicated data stream.
5. **Retroactive** — Observer can query its own history. Dashboard can load historical traces on connect.

### File Structure

```
src/core/observer/
  index.ts       — Observer class + factory (the centralized observer)
  categories.ts  — TraceCategory enum + per-category data schemas
  store.ts       — persistence layer (absorbs current ObservabilityStore)
  stream.ts      — SSE streaming for real-time dashboard connection
```

### Category System

Define typed trace categories that map 1:1 to War Room dashboard sections:

```typescript
export const TraceCategory = {
  // Agent intelligence
  AGENT_LOOP: 'agent_loop',        // Each LLM iteration: call, parse, action, result
  PHASE: 'phase',                  // Phase transitions, decisions, fast-path, loopback
  DECISION: 'decision',            // Every decision point with reasoning

  // Infrastructure
  PLUGIN: 'plugin',                // Every adapter call: trigger.poll, llm.complete, tool.execute, etc.
  WORKSPACE: 'workspace',          // Git operations: clone, branch, commit, push, PR
  TASK: 'task',                    // State transitions with full context

  // Safety & cost
  SAFETY: 'safety',                // Every evaluateAction/consultJudgment with verdict
  COST: 'cost',                    // Per-call, per-phase, per-task cost breakdowns

  // System health
  ERROR: 'error',                  // Every error with chain, context, recovery
  CONFIG: 'config',                // Config changes, hot-reload, validation
  LIFECYCLE: 'lifecycle',          // Component start/stop, health checks
} as const;

export type TraceCategory = typeof TraceCategory[keyof typeof TraceCategory];
```

### Core Interface (Langfuse observation-centric + OpenTelemetry spans)

Research sources: Langfuse (observation-centric model, single table), OpenTelemetry (span nesting, context propagation), LangSmith (runs + child runs), Jaeger (proven span data model).

**Key insight from Langfuse:** Make observations the atomic unit. Every observation carries full context (task_id, session_id, phase, trace_id). No joins needed — `SELECT * FROM observations WHERE task_id = ?` gives you everything.

**Key insight from OpenTelemetry:** Spans nest via parent_observation_id. `startSpan()` returns an object with `end()` that auto-records duration. Context propagates without parameter threading.

```typescript
export interface IObserver {
  /**
   * Start an observation span. Returns a handle with end().
   * This is the PRIMARY call every component makes.
   * Duration is automatically recorded when end() is called.
   */
  startSpan(
    type: ObservationType,
    name: string,
    input?: Record<string, unknown>,
    options?: SpanOptions,
  ): ObservationSpan;

  /**
   * Record an instant observation (no duration — a point-in-time fact).
   * Use for: decisions, state transitions, cost snapshots, errors.
   */
  observe(
    type: ObservationType,
    name: string,
    data: Record<string, unknown>,
    options?: SpanOptions,
  ): string; // returns observation ID

  /**
   * Record a decision point with alternatives and reasoning.
   * Agent-specific — not in standard OpenTelemetry.
   */
  recordDecision(
    name: string,
    context: string,
    options: Array<{ id: string; description: string }>,
    chosen: string,
    reasoning: string,
    confidence: number,
    opts?: SpanOptions,
  ): string;

  /**
   * Record an error with full chain, recovery, and impact.
   */
  recordError(
    error: unknown,
    context: { operation: string; component: string },
    recovery?: { action: string; success: boolean },
    opts?: SpanOptions,
  ): string;

  /**
   * Query observations. Powers dashboard historical views.
   */
  query(filters: ObservationQuery): Observation[];

  /**
   * Subscribe to real-time observations. Powers live dashboard SSE.
   */
  subscribe(callback: (obs: Observation) => void): () => void;

  /**
   * Store large content (LLM prompts/responses) in blob store.
   */
  storeBlob(content: string): string;
  readBlob(hash: string): string | null;
}

/** Observation types — agent-specific, not generic spans */
export const ObservationType = {
  AGENT_ITERATION: 'agent_iteration',   // Each LLM loop: call, parse, action, result
  LLM_CALL: 'llm_call',                 // Individual LLM invocation with cost snapshot
  TOOL_EXECUTION: 'tool_execution',      // Bash, git, any tool adapter call
  PHASE_TRANSITION: 'phase_transition',  // Phase start/end/skip/loopback
  DECISION_POINT: 'decision_point',      // Every decision with alternatives + reasoning
  SAFETY_VERDICT: 'safety_verdict',      // evaluateAction/consultJudgment results
  STATE_TRANSITION: 'state_transition',  // Task state changes with gates passed
  WORKSPACE_OP: 'workspace_op',          // Clone, branch, commit, push, PR
  PLUGIN_CALL: 'plugin_call',            // Any adapter method invocation
  ERROR: 'error',                        // Errors with chain + recovery
  COST_SNAPSHOT: 'cost_snapshot',         // Immutable cost record per LLM call
  LIFECYCLE: 'lifecycle',                 // Component start/stop, health checks
  CONFIG_CHANGE: 'config_change',        // Hot-reload, what changed
} as const;

export type ObservationType = typeof ObservationType[keyof typeof ObservationType];

export interface SpanOptions {
  task_id?: string;
  trace_id?: string;              // Correlation ID (ULID per executeTask)
  parent_observation_id?: string; // For nesting spans
  phase?: string;                 // Current orchestrator phase
  session_id?: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
}

export interface ObservationSpan {
  id: string;
  /** End the span, recording duration and optional output data */
  end(output?: Record<string, unknown>): void;
  /** Add a child span nested under this one */
  startChild(type: ObservationType, name: string, input?: Record<string, unknown>): ObservationSpan;
  /** Record a point-in-time event within this span */
  addEvent(name: string, data?: Record<string, unknown>): void;
  /** Mark this span as errored */
  setError(error: unknown): void;
}

/** Immutable observation record (single table, Langfuse-inspired) */
export interface Observation {
  id: string;                       // ULID
  trace_id: string | null;          // Correlation ID
  parent_observation_id: string | null;  // For nesting
  type: ObservationType;
  name: string;
  task_id: string | null;
  phase: string | null;
  session_id: string | null;
  start_time: string;               // ISO 8601
  end_time: string | null;          // null for instant observations
  duration_ms: number | null;
  input: Record<string, unknown> | null;   // What went in
  output: Record<string, unknown> | null;  // What came out
  metadata: Record<string, unknown> | null; // Extra context
  level: string;
  status: 'ok' | 'error';
  error_message: string | null;
}

export interface ObservationQuery {
  type?: ObservationType;
  task_id?: string;
  trace_id?: string;
  phase?: string;
  since?: string;
  level?: string;
  limit?: number;               // Default 100, prevents unbounded reads
}
```

### Database Schema

Create migration `003_observer.sql` — single unified table (Langfuse-inspired):

```sql
-- Unified observations table — Langfuse-inspired, immutable rows, no joins needed.
-- Every observation carries full context. Query any dimension directly.
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,                    -- ULID
  trace_id TEXT,                          -- Correlation ID (per executeTask call)
  parent_observation_id TEXT,             -- For span nesting (NULL = root)
  type TEXT NOT NULL,                     -- ObservationType enum
  name TEXT NOT NULL,                     -- Specific event name
  task_id TEXT,                           -- Context: which task
  phase TEXT,                             -- Context: which orchestrator phase
  session_id TEXT,                        -- Context: which session
  start_time TEXT NOT NULL,               -- ISO 8601
  end_time TEXT,                          -- NULL for instant observations
  duration_ms INTEGER,                    -- Auto-computed on span.end()
  input TEXT,                             -- JSON: what went in
  output TEXT,                            -- JSON: what came out
  metadata TEXT,                          -- JSON: extra context, cost snapshots, etc.
  level TEXT NOT NULL DEFAULT 'info',     -- debug/info/warn/error
  status TEXT NOT NULL DEFAULT 'ok',      -- ok/error
  error_message TEXT                      -- Sanitized error message if status=error
);

-- Query patterns the War Room needs:
CREATE INDEX IF NOT EXISTS idx_obs_task ON observations(task_id);
CREATE INDEX IF NOT EXISTS idx_obs_trace ON observations(trace_id);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_time ON observations(start_time);
CREATE INDEX IF NOT EXISTS idx_obs_type_name ON observations(type, name);
CREATE INDEX IF NOT EXISTS idx_obs_parent ON observations(parent_observation_id);
CREATE INDEX IF NOT EXISTS idx_obs_task_type ON observations(task_id, type);
CREATE INDEX IF NOT EXISTS idx_obs_level ON observations(level);
```

**Backward compatibility:** Keep existing `action_traces`, `llm_traces`, `phase_metrics` tables. The Observer writes to the new `observations` table only. The current dashboard reads from old tables. When War Room v2 is rebuilt, it reads from `observations` and old tables are dropped.

### Implementation

**`src/core/observer/index.ts`:**

```typescript
export class Observer implements IObserver {
  private db: Database;
  private blobStore: BlobStore;
  private subscribers: Set<(entry: TraceEntry) => void>;
  private insertStmt: Statement;

  constructor(db: Database, blobStore: BlobStore) {
    // Prepare insert statement
    // Initialize subscriber set
  }

  trace(category, event, data, options?) {
    const entry: TraceEntry = {
      id: ulid(),
      timestamp: new Date().toISOString(),
      category,
      event,
      data,
      task_id: options?.task_id ?? null,
      trace_id: options?.trace_id ?? null,
      parent_span_id: options?.parent_span_id ?? null,
      duration_ms: options?.duration_ms ?? null,
      level: options?.level ?? 'info',
    };

    // 1. Persist to SQLite
    this.insertStmt.run(/* ... */);

    // 2. Notify real-time subscribers (dashboard SSE)
    for (const sub of this.subscribers) {
      sub(entry);
    }
  }

  span(category, event, data?, options?) {
    const spanId = ulid();
    const start = Date.now();

    return {
      id: spanId,
      end: (endData?) => {
        const duration = Date.now() - start;
        this.trace(category, event, { ...data, ...endData }, {
          ...options,
          duration_ms: duration,
          parent_span_id: options?.parent_span_id,
        });
      },
    };
  }

  query(filters) {
    // Build dynamic SQL from filters, return TraceEntry[]
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  storeBlob(content) { return this.blobStore.store(content); }
  readBlob(hash) { return this.blobStore.read(hash); }
}
```

### What to Do with Existing ObservabilityStore

The current `ObservabilityStore` (314 LOC) has methods like `insertActionTrace`, `createPhaseMetrics`, etc. These write to the old 3-table schema. Strategy:

1. **Keep ObservabilityStore temporarily** — it powers the current dashboard API
2. **Observer writes to BOTH** — new `traces` table AND old tables (via adapter methods)
3. **Later (Wave 3 R5 or dashboard rebuild)** — migrate dashboard to read from `traces` table, remove old tables

For now, Observer absorbs BlobStore directly and adds the unified trace layer on top.

### Integration Points (for subsequent phases)

After R-0, every phase that decomposes a component will inject `observer: IObserver` into the subsystem. Here's how each phase uses it:

| Phase | How It Uses Observer |
|-------|---------------------|
| R1 (Safety Split) | `observer.trace(SAFETY, 'verdict', { allowed, reason, policy_matched })` on every evaluateAction/consultJudgment |
| R2a (TaskEngine) | `observer.trace(TASK, 'transition', { from, to, gates_passed, duration_in_state })` |
| R2b (SessionMemory) | No direct observer calls — journal IS the trace for sessions |
| R2c (Registry) | `observer.trace(LIFECYCLE, 'plugin_initialized', { id, type, duration })` |
| R3 (Daemon) | Each subsystem uses observer: TriggerPoller → `PLUGIN`, Scheduler → `TASK`, Health → `LIFECYCLE` |
| R4 (Orchestrator) | PhaseRunner → `PHASE`, LLMCaller → `AGENT_LOOP`, PRManager → `WORKSPACE`, etc. |
| R5 (Event Topology) | Observer is NOT the EventBus. EventBus = audit. Observer = visibility. They coexist. |
| R7 (CLI) | `engineer why` queries observer.query() to explain task decisions |

---

## Refinement Checklist

- [ ] Export Zod enum for `TraceCategory` (pattern: `export const TraceCategory = TraceCategorySchema.enum`)
- [ ] Tagged errors: `ObserverError` with context
- [ ] `span()` uses high-resolution timing (`performance.now()` or `Date.now()`)
- [ ] Subscriber errors are caught and don't propagate (fire-and-forget like EventBus)
- [ ] `query()` has LIMIT default (100) to prevent unbounded reads
- [ ] `trace()` is synchronous (non-blocking SQLite write) — never slows down the caller
- [ ] Blob store reused from existing `src/core/observability/blob-store.ts`
- [ ] Migration 003 is idempotent (IF NOT EXISTS)

---

## Verification

1. `tsc --noEmit` — zero type errors
2. `pnpm test` — all existing tests pass (Observer is additive, breaks nothing)
3. New tests for Observer:
   - `trace()` persists to DB and notifies subscribers
   - `span()` records duration automatically
   - `query()` filters by category, task_id, trace_id, since, limit
   - `subscribe()`/unsubscribe works
   - `storeBlob()`/`readBlob()` round-trips
   - Subscriber errors don't propagate
4. `pnpm biome check` — clean

---

## Commit

When all verification passes, run `/commit` to stage and commit your changes.
