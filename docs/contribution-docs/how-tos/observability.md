# Observability

How logging, tracing, and real-time observation work in The Engineer.

---

## Overview

Every component receives a single `observer: IObserver` — one interface for structured logging (pino rolling JSON) and tracing (SQLite observations for the dashboard). No `console.*` calls in production code, no optional loggers, no fallbacks.

```
IObserver (what components use)
    │
    ├── Logging ──→ pino ──→ rolling JSON files (~/.engineer/logs/)
    │
    └── Tracing ──→ ObservationStore ──→ SQLite (observations table)
                        │
                        ├── ObserverStream ──→ SSE to dashboard (real-time)
                        └── BlobStore ──→ content-addressable files (agent prompts/responses)
```

**Three distinct systems, one entry point:**

| System | Purpose | Destination | Interface |
|--------|---------|-------------|-----------|
| Logging | Ops diagnostics | Rolling JSON log files | `observer.info/warn/error/debug()` |
| Tracing | Dashboard visibility | SQLite `observations` table | `observer.startSpan/observe/recordDecision/recordError()` |
| Event Bus | Audit trail | SQLite `events` table | `eventBus.publish()` (separate from observer) |

The Event Bus is a separate system — it records business events (task created, state changed, cost incurred). The observer records everything else (what's happening inside components, agent runs, decisions, errors).

---

## The IObserver Interface

**File:** `src/core/observer/facade.ts`

```typescript
interface IObserver {
  // Structured logging (→ pino → JSON files)
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;

  // Tracing (→ SQLite for dashboard)
  startSpan(type, name, input?, options?): ObservationSpan;
  observe(type, name, data, options?): string;
  recordDecision(name, context, options, chosen, reasoning, confidence, opts?): string;
  recordError(error, context, recovery?, opts?): string;  // DUAL: logs to pino AND stores

  // Create a child observer scoped to a component
  child(component: ComponentTag): IObserver;

  // Escape hatch for code that needs raw pino
  readonly pino: Logger;
}
```

**Key rule:** `recordError()` is the only method with dual behavior — it writes to both pino (ops logs) and the observation store (dashboard). All other methods target exactly one system.

---

## Using the Observer

### Logging

```typescript
// Simple message
observer.info("Task scheduled");

// With structured data (always an object, never interpolated strings)
observer.info("Task scheduled", { taskId, priority });
observer.warn("Plugin unhealthy", { pluginId, consecutiveFailures });
observer.error("Workspace cleanup failed", { taskId, err: error });
observer.debug("Priority aged", { taskId, oldPriority, newPriority });
```

**Argument order:** `(message, data?)` — NOT pino's `(data, message)`. The facade flips the order internally.

**Structured data convention:** Always use an object with named fields. Never interpolate values into the message string — put them in the data object instead. This makes logs searchable and parseable.

### Tracing

```typescript
// Instant observation (point-in-time, no duration)
observer.observe("phase_transition", "execution_started", {
  taskId, fromPhase: "planning", toPhase: "execution",
}, { task_id: taskId, trace_id: traceId });

// Span (has duration — wraps an operation)
const span = observer.startSpan("agent_call", "planning_completion", {
  model: "claude-sonnet-4-20250514", promptLength: 4200,
}, { task_id: taskId, trace_id: traceId, phase: "planning" });

try {
  const result = await run(...);
  span.end({ tokensIn: result.tokens_in, tokensOut: result.tokens_out });
} catch (error) {
  span.setError(error);
  span.end();
}

// Child spans (nested under a parent)
const parentSpan = observer.startSpan("tool_execution", "bash_run", { cmd });
const childSpan = parentSpan.startChild("lifecycle", "output_parse");
childSpan.end({ lines: 42 });
parentSpan.end({ exitCode: 0 });

// Decision (structured choice with reasoning)
observer.recordDecision(
  "decomposition_strategy",          // name
  "Task too complex for single PR",  // context
  [                                   // alternatives
    { id: "single", description: "Handle in one task" },
    { id: "decompose", description: "Split into subtasks" },
  ],
  "decompose",                        // chosen
  "3 independent concerns detected",  // reasoning
  0.85,                               // confidence
  { task_id: taskId, phase: "planning" },
);

// Error with recovery info
observer.recordError(
  error,
  { operation: "pr_creation", component: "pr-manager" },
  { action: "retry_with_backoff", success: true },
  { task_id: taskId },
);
```

### Creating Child Observers

```typescript
// In a factory or constructor — scope the observer to this component
const myObserver = observer.child("task-engine");

// The child's pino logger is tagged: { component: "task-engine" }
// All logs from this child include the component field automatically
myObserver.info("Task created", { taskId });
// → {"level":"info","component":"task-engine","taskId":"...","msg":"Task created"}
```

---

## Observation Types

**File:** `src/schemas/observer.ts`

13 types — use the one that best describes what you're recording:

| Type | When to use |
|------|-------------|
| `agent_iteration` | One cycle of the agent execution loop |
| `agent_call` | Direct agent invocation |
| `tool_execution` | Tool/action execution (bash, file write, etc.) |
| `phase_transition` | Orchestrator phase change |
| `decision_point` | Structured decision with alternatives and reasoning |
| `safety_verdict` | Safety layer gate result |
| `state_transition` | Task state machine transition |
| `workspace_op` | Git worktree create/verify/cleanup |
| `plugin_call` | Adapter/plugin method invocation |
| `error` | Error observation (use `recordError()`) |
| `cost_snapshot` | Cost tracking data point |
| `lifecycle` | Generic lifecycle event (startup, shutdown, etc.) |
| `config_change` | Configuration change detected |

### SpanOptions

Every tracing method accepts optional `SpanOptions` for correlation:

```typescript
interface SpanOptions {
  task_id?: string;              // Links observation to a task
  trace_id?: string;             // Correlation ID (ULID, one per executeTask call)
  parent_observation_id?: string; // For manual nesting (startChild sets this automatically)
  phase?: string;                // Current orchestrator phase
  session_id?: string;           // Session correlation
  level?: "debug" | "info" | "warn" | "error";
}
```

---

## Component Tags

**File:** `src/core/observer/logging.ts`

Every observer child is tagged with a `ComponentTag` — a TypeScript string union:

```
daemon, registry, orchestrator, task-engine, safety, session-memory,
workspace-manager, event-bus, people-directory, config, cli,
action-pipeline, hooks, observer, pr-manager, phase-runner,
agent-runner, agent-loop, plugin-loader
```

Tags appear in every log line's `component` field. Use the existing tag for your component. If adding a new component, add its tag to the union in `src/core/logging.ts`.

---

## Bootstrap Lifecycle

**File:** `src/cli/bootstrap.ts`

The observer has a two-phase lifecycle because pino is available immediately but the SQLite observation store requires the database:

```
1. createObserverFacade(logger, "cli")     → Observer with store=null
2. Components created, receive observer    → Logging works, tracing is no-op
3. Database initialized
4. createObservationStore(db, blobStore)
5. observer.upgrade(observationStore)      → All children gain tracing instantly
```

**Why this works:** All Observer children share a `SharedContext` object. When `upgrade()` sets `ctx.store`, every existing child sees it immediately — no re-wiring needed.

---

## Threading Pattern

Every component receives `observer: IObserver` as a **required, non-nullable** dependency.

**Core components** (via `createCoreComponents` in `system.ts`):
```typescript
createCoreComponents({
  db, observer: observer.child("event-bus"), safetyConfig, workspaceConfig,
});
// Internally creates children: observer.child("task-engine"), observer.child("action-pipeline")
```

**Daemon** (via context object):
```typescript
interface DaemonContext {
  observer: IObserver;  // Required
  // ... other deps
}
```

**Orchestrator** (via context object):
```typescript
interface OrchestratorContext {
  observer: IObserver;  // Required
  // ... other deps
}
```

**Registry** (via options):
```typescript
new Registry({ observer: observer.child("registry"), eventBus, ... });
// Registry injects observer into plugins on register()
```

**Adapters** (special pattern — tier isolation):
```typescript
// Adapters can't import core, so BaseAdapter uses a local interface:
interface AdapterObserver {
  info(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// Registry injects the real IObserver as `unknown`, BaseAdapter casts internally:
const obs = this.observer as AdapterObserver | undefined;
obs?.info("Plugin initialized", { pluginId, elapsedMs });
```

This is the ONE place where observer is optional (`obs?.`) — because plugin instances are created by factories before the registry injects dependencies. The observer is always set before `initialize()` is called.

---

## Pino Configuration

**File:** `src/core/observer/logging.ts`

```typescript
interface LoggingConfig {
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  dir: string;           // Relative to engineerHome or absolute
  max_size_bytes: number; // Size cap per file
  max_files: number;      // Rotation count
  console: boolean;       // Also write to stdout (pino-pretty)
}
```

- **Transport:** `pino-roll` (daily rotation with size cap)
- **Console:** `pino-pretty` when `console: true` (enabled by `--verbose` flag)
- **Format:** JSON (one line per entry, structured fields)
- **Location:** `~/.engineer/logs/engineer.log`

---

## Observation Storage

### SQLite Table

**File:** `src/db/migrations/003_observer.sql`

```sql
CREATE TABLE observations (
  id TEXT PRIMARY KEY,                    -- ULID
  trace_id TEXT,                          -- Correlation ID
  parent_observation_id TEXT,             -- Span nesting
  type TEXT NOT NULL,                     -- ObservationType enum
  name TEXT NOT NULL,
  task_id TEXT,
  phase TEXT,
  session_id TEXT,
  start_time TEXT NOT NULL,               -- ISO 8601
  end_time TEXT,                          -- NULL for open spans
  duration_ms INTEGER,                    -- Computed on span.end()
  input TEXT,                             -- JSON
  output TEXT,                            -- JSON
  metadata TEXT,                          -- JSON
  level TEXT NOT NULL DEFAULT 'info',
  status TEXT NOT NULL DEFAULT 'ok',
  error_message TEXT
);
```

8 indexes for fast querying by task, trace, type, time, parent, level, and composite (task+type, type+name).

**Design:** Immutable rows. Only `end_time`, `duration_ms`, `output`, `status`, and `error_message` are updated (once, when a span ends).

### Blob Store

**File:** `src/core/observer/blob-store.ts`

Content-addressable storage for large content (agent prompts/responses). Uses SHA-256 hashing with Git-like directory structure:

```
~/.engineer/traces/blobs/
  ab/abcdef1234...    (first 2 chars as directory)
  cd/cdef5678...
```

Stored content is deduped by hash. Used by the orchestrator's agent runner to avoid storing multi-KB prompts in the observations table.

---

## Dashboard Integration

The dashboard is a React SPA (`src/dashboard/client/`) with 5 views: Overview, Tasks, Activity, Metrics, and Errors. It consumes observations through two channels:

1. **Real-time:** SSE stream (`/api/stream`) polls SQLite for new observations/events every second, pushes to the browser via Server-Sent Events
2. **Historical:** Dashboard API routes (`src/dashboard/api/`) query `ObservationStore` with filters (type, task_id, trace_id, phase, since, level) and serve blob content

The frontend uses TanStack Query for data fetching with SSE-driven cache invalidation — expensive endpoints (metrics, traces) refresh only when new data arrives.

---

## Testing

### Unit Tests (no tracing needed)

```typescript
import { createTestObserverFacade } from "../../test/helpers/test-observer-facade.js";

const observer = createTestObserverFacade("my-component");
// Silent pino (no output), no observation store (tracing is no-op)

// Spy on logging calls
const warnSpy = vi.spyOn(observer, "warn");
// ... do work ...
expect(warnSpy).toHaveBeenCalledWith("expected message", { expectedData });
```

### Integration Tests (with tracing)

```typescript
import { createTestObserver } from "../../test/helpers/test-observer.js";

const handle = createTestObserver();
// In-memory SQLite + temp dir blob store — full tracing

// ... do work that generates observations ...

const observations = handle.observer.query({ type: "agent_call", task_id: "task-1" });
expect(observations).toHaveLength(1);

// Cleanup
handle.cleanup(); // Closes DB + removes temp dir
```

---

## Rules

1. **Never use `console.log/warn/error`** in `src/` (except CLI commands that output to the terminal)
2. **Observer is always required** — never `observer?: IObserver`, always `observer: IObserver`
3. **Message first, data second** — `observer.info("message", { data })`, not pino's `(data, message)`
4. **Structured data** — put values in the data object, not in the message string
5. **Use the right observation type** — pick from the 13 types, don't overload `lifecycle` for everything
6. **Include SpanOptions** — always pass `task_id` and `trace_id` when available for correlation
7. **Spans must end** — always call `span.end()` (use try/finally if needed)
8. **No circular logging** — `ObserverStream` silently swallows subscriber errors (can't log its own errors)
9. **Adapters use local interface** — `AdapterObserver` to avoid tier import violations

---

## File Reference

| File | Purpose |
|------|---------|
| `src/core/observer/facade.ts` | `IObserver` interface + `Observer` class (the unified facade) |
| `src/core/observer/types.ts` | `IObservationStore` + `ObservationSpan` interfaces |
| `src/core/observer/index.ts` | `ObservationStore` class (SQLite persistence) |
| `src/core/observer/store.ts` | `ObserverStore` (prepared statements, SQL layer) |
| `src/core/observer/stream.ts` | `ObserverStream` (real-time pub/sub for dashboard SSE) |
| `src/schemas/observer.ts` | Zod schemas, observation types enum, row mapper |
| `src/db/migrations/003_observer.sql` | Database schema (table + 8 indexes) |
| `src/core/observer/logging.ts` | `ComponentTag` type, `createLogger`, `createSilentLogger` |
| `src/core/observer/blob-store.ts` | Content-addressable blob storage (SHA-256) |
| `src/cli/bootstrap.ts` | Observer creation, upgrade, and threading to all components |
| `test/helpers/test-observer-facade.ts` | Test helper: silent observer (no tracing) |
| `test/helpers/test-observer.ts` | Test helper: full observer with in-memory DB |
