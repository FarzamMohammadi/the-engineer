# Observability

How logging, tracing, and real-time observation work in The Engineer — the API, the methods, and the rules for adding an emission. For the conceptual picture (the three systems, why SQLite is the system of record, one-trace-per-dispatch, how external export stays non-blocking), read the [observability architecture blueprint](../../architecture/observability.md) first.

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
                        └── BlobStore ──→ content-addressable files (agent prompts/responses)
```

The dashboard server is a **separate process** that polls the SQLite `observations` table by rowid and pushes new rows to the browser over HTTP SSE. There is no in-process pub/sub — durable SQLite rows are the only path to the dashboard, so anything not written to the table is invisible to the owner.

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

  // Store/read large content (agent prompts/responses, diffs, gate output) for drill-down
  storeBlob(content: string): string;   // returns a content-addressable ref
  readBlob(ref: string): string | null;

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
  "route:verify",                     // name
  'execution/verify reported "ok"',  // context
  [                                   // alternatives
    { id: "advance", description: "Move to the next sub-phase or phase" },
    { id: "repeat", description: "Loop this phase from its start" },
  ],
  "advance",                          // chosen
  "All verification gates passed",    // reasoning
  1,                                  // confidence
  { task_id: taskId, phase: "execution" },
);

// Error with recovery info
observer.recordError(
  error,
  { operation: "create_pr", component: "orchestrator" },
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

Pick the type that names what you're recording — never overload `lifecycle` as a catch-all:

| Type | When to use |
|------|-------------|
| `task_execution` | The root span of one dispatch — the whole task, start to outcome. Every other observation for the dispatch nests under it. |
| `agent_call` | One agent run — emitted per agent sub-phase, carrying the prompt, the result/transcript as blob refs, and the run's cost/token spend |
| `agent_activity` | One element of an agent's live conversation *inside* a single `agent_call` — an assistant message, a thinking block, a tool the agent invoked, or that tool's result. Children of the open `agent_call` span (see [Live Agent Activity](#live-agent-activity)). **Distinct from `tool_execution`:** `agent_activity` is what the *agent* did (parsed from its stream); `tool_execution` is what the *engine* did to the outside world. |
| `tool_execution` | One external action — a verify gate, a git push, a PR create, a merge call, a branch delete |
| `phase_transition` | Pipeline phase/sub-phase enter, start, and result |
| `decision_point` | A structured decision with alternatives and reasoning (via `recordDecision`) |
| `safety_verdict` | A gate result — e.g. the verify gates' pass/fail verdict |
| `state_transition` | Task state machine transition (e.g. a block) |
| `workspace_op` | Git worktree create, cleanup, and branch delete (emitted by the workspace manager) |
| `plugin_call` | Adapter/plugin method invocation |
| `error` | Error observation (use `recordError()`) |
| `lifecycle` | Generic lifecycle event (startup, shutdown, task pickup) |
| `quota_status` | Provider quota / rate-limit status (emitted by the daemon's periodic agent-quota poll) |

### What to trace, what not to, what's a decision

Not everything that happens is a trace. The dashboard and the OTLP export both read the `observations` table, but they are different lenses — and the cost of over-emitting is real (a flood of low-value rows, and lone 1-span "traces" that bury the task tree). Use this taxonomy:

**Emit a span (`startSpan`) or instant (`observe`) when** something *happened inside a task's work* — a phase ran, an agent was called, a gate executed, a worktree was created for the dispatch. These belong to the task's trace; always pass `trace_id` (and `task_id`) so they nest under the `execute_task` root. A span has duration (it wraps an operation); an instant is a point-in-time fact (it has no width).

**Record a decision (`recordDecision`) only when** a *genuine branch point* was resolved — there were real alternatives, and the *why* matters for later understanding. A routing choice between `advance`/`repeat`, a preemption `preempt`/`wait`, a merge `merge`/`wait`. Not every `if`: if only one outcome was ever possible, or the reasoning is "because the config said so" with no judgment, it's not a decision — it's control flow. A decision carries its alternatives, the chosen id, the reasoning, and a confidence.

**Do NOT emit a trace for:**
- **High-frequency gauges / polls.** A periodic quota reading, a heartbeat, a "still alive" tick. These are *metrics*, not events — a value sampled on a timer, not a unit of work. The daemon's `quota_polled` feeds the dashboard's quota widget and stays in SQLite, but it carries no `trace_id`, so it is **never exported** (see below). If you need a sampled value for a widget, emit it untraced; if you only need it for diagnostics, use a log line instead.
- **Pure ops diagnostics.** "Fetching from remote", "cache miss" — use `observer.debug/info`, not an observation.
- **Anything with no consumer.** An observation no dashboard view queries (and no trace groups) is dead data — see Rule 8.

**`trace_id` is the export boundary.** The OTLP exporter ships **task-traces only**: an observation with a `trace_id` is part of a task's end-to-end tree and is exported; an observation *without* one (a quota poll, a daemon arbitration decision made in the scheduler loop, a workspace *teardown* run by the reaper long after the task's trace closed, a startup beat) is **dashboard-only by design** — it stays fully visible in SQLite/the dashboard but never becomes a lone 1-span trace in Jaeger. So a daemon-scoped decision is a real, queryable observation; it is simply not a *trace*. The rule is mechanical and self-defending: if it carries a `trace_id`, it exports; if it doesn't, it won't. Workspace **setup** (`worktree_created`) runs inside `executeTask`, so the orchestrator threads the dispatch's `trace_id` into it and it nests under the task trace; cleanup runs in a daemon loop with no live trace and stays dashboard-only.

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
  links?: Array<{ trace_id: string; observation_id: string }>; // Cross-trace "follows-from" edges (continuity)
}
```

---

## The End-to-End Trace

Every task dispatch is one trace. The orchestrator opens a root `task_execution` span at the start of `executeTask`; its id is threaded into the pipeline context, and every observation the pipeline emits carries the dispatch's `trace_id` and points its `parent_observation_id` at that root. The result is a single nested tree per task — from intake to outcome — that the dashboard renders and that an external tracing tool can consume whole (see [External Trace Export](#external-trace-export-otlp) below).

**What the pipeline emits, by construction:**

- The runner records every phase enter, sub-phase start/result, **routing and skip decision** (`recordDecision`), loop, and block — so a sub-phase cannot forget to be observed. A block's log level follows its cause: an expected wait is `info`, the loop cap is `warn`, a genuine failure is `error`.
- Each **agent run** is an `agent_call` span carrying the full prompt and the result/transcript as blob refs, plus the run's cost and token spend (what the per-phase cost breakdown aggregates). When the agent streams, its live conversation lands as `agent_activity` children of that span (see [Live Agent Activity](#live-agent-activity)).
- The **verify gates** emit a `safety_verdict` (which gates ran, which passed) plus a `tool_execution` span per gate.
- **Delivery** spans its external git and host actions as `tool_execution`: the `git_push`, the `create_pr` (carrying the PR number and url), and a rework's `dismiss_approvals`.
- **auto-merge** records a `merge_readiness` decision (the live PR status, the disposition chosen, its alternatives) and a `tool_execution` span for the merge call.
- The **PR-event poller** records `pr_event_arbitration` (which event won among competitors) and `approve_comment_promotion` (a `/approve` turned into a merge).

The shared `traceScope(ctx)` helper builds the `{task_id, session_id, trace_id, phase, parent_observation_id}` scope so the runner and every sub-phase stitch into the same tree.

### Trace continuity across dispatches

One task is rarely one dispatch. It blocks (awaiting PR review, more info), gets resumed, bounces back from a self-review or a PR comment, retries — each is a separate `executeTask` call with its **own** `trace_id`. We deliberately do **not** merge them into a single task-long trace: a task can sit blocked for hours or days, so a merged trace's duration would be dominated by idle gaps, collapsing the actual work spans into invisible slivers and making the flame graph useless exactly as the task gets more interesting. A merged trace would also have no single root (nothing is "open" across a daemon restart while blocked) — it would be multi-root anyway.

Instead, **each dispatch is its own bounded trace, and the dispatches are chained with OTLP span links.** The task row persists its trace lineage in one nullable `last_trace_link` column — the previous dispatch root's `{trace_id, observation_id}` as a single JSON value, so the pair is atomic by construction with no half-set state to guard; when the orchestrator opens the next dispatch's root `execute_task` span, it emits a link back to the previous dispatch's root. In Jaeger you can walk the whole lifecycle by following the links, while every individual trace stays a crisp, readable flame graph.

The **true holistic, one-screen end-to-end view lives in the dashboard**, which groups every observation by `task_id` across all dispatches. In Jaeger, a `task_id` tag search lists every dispatch's trace for a task. So nothing is lost by keeping the traces bounded — the links give you navigability and the dashboard gives you the union.

A link is carried as the observation's `links` (JSON array of `{trace_id, observation_id}`), mapped to OTLP `links` at export (`otlp/span.ts`). It targets a span in *another* trace, so its ids derive from the link's own coordinates, not the linking span's.

## Live Agent Activity

An `agent_call` span on its own is a black box with two endpoints: the prompt that went in and the result that came out. **Live agent activity** fills the middle — it streams the agent's *conversation as it happens* (each assistant message, thinking block, tool call, and tool result) into `agent_activity` child observations of the open `agent_call` span. Because each is an instant `observe()` row under the live span, the dashboard plays the conversation **live** while the run is in flight and lets the owner **re-watch** it once the run is past — one source of truth for both.

**The module:** `src/core/agent-activity/`. It is the *only* both-sides mediator in the system: it consumes the canonical `AgentActivityEvent` (the agent adapter contract's plugin-agnostic vocabulary — see [the agent adapter doc](../../plugins/agent/README.md#activity-streaming-optional)) and writes the observations. It depends **only** on that event type and the observer interface — never on any plugin — so [Plugin Opacity](../../philosophy.md#plugin-opacity--core-sees-only-adapters) holds: delete every plugin and this module still compiles and runs (inert, because nothing emits).

**How it flows:**

1. A streaming agent plugin parses its CLI's native stream and calls `request.on_activity?.(event)` for each canonical `AgentActivityEvent` — in the same `spawnAndParse` loop it already runs. A plugin that does not stream simply never calls it.
2. `agent-step.ts` builds the sink via `createActivitySink(ctx.observer, traceScope(ctx), agentCallSpan.id)` and passes it as `request.on_activity` — but **only** when the agent reports `supports_activity_streaming` **and** the `orchestrator.observability.live_activity` toggle is on. Otherwise the request omits the sink and the plugin has nothing to call.
3. Per event, the sink maps it to an `agent_activity` observation parented on the `agent_call` span, sanitizes secrets, offloads large tool input/output (and long text) to the blob store with a bounded inline preview, and writes one instant row.

**Three invariants this path holds:**

- **Best-effort — it can never fail the run.** The whole per-event handler is wrapped in try/catch; any error (a malformed event, a blob write, a store hiccup) becomes a `debug` log and a return, never a throw back into the agent's loop. The feed is observation-only and must never change a run's outcome, cost, or timing.
- **Secrets sanitized.** Tool input/output can carry file contents, shell commands, and env. Every text, input, and output is run through `sanitizeSecrets` before it touches the store — both the inline preview and the offloaded blob.
- **Graceful degradation.** A non-streaming agent (or the toggle off) produces no feed; the run is byte-for-byte identical, and the owner falls back to the post-run `transcript_blob`. The two cases are indistinguishable to the plugin — there is simply no sink to call.

The pure mapping (`mapping.ts`: event → observation parts) is separated from the effectful sink (`sink.ts`: store blobs, write the row) per [FCIS](../../coding-standards.md#functional-core-imperative-shell-fcis), so the size-bounding, naming, and secret-scrubbing logic is unit-tested as pure data. The toggle and its degradation are documented in [Orchestrator configuration → Observability](../../configuration/orchestrator.md#observability).

**Where the owner watches it — the Agent Calls tab.** Expanding any `agent_call` row in a task's **Agent Calls** tab plays that call's conversation as a chat-like feed: assistant messages, collapsible thinking blocks, and tool cards (the tool name plus its input, with the result folded beneath it — paired by `tool_call_id` and styled ok/error). Long text and large tool I/O drill into the blob store on demand, exactly as the call's prompt/result/transcript do. The feed has **one source of truth** — the `agent_activity` rows — read two ways:

- **Live.** While the task is `active` and this call's span is still open (no `end_time`), the row is the call running right now. The view fetches the recorded backlog once, then subscribes to the SSE `observation` channel and appends each incoming `agent_activity` whose `parent_observation_id` is this call — deduped by id, so a call that began before the tab opened still shows its history and then continues streaming.
- **Retroactive.** Once the call's span closes, the same conversation is re-watchable: the view fetches its children via `GET /api/tasks/:id/agent-activity?call=<agentCallId>` (the `parent_observation_id` query filter on `ObservationStore`, ordered by `start_time, rowid` so same-millisecond rows keep their true insertion order) and renders the identical feed.

The reconstruction mirrors the open-vs-resolved precedent of `buildSubPhaseRuns`: rows are narrowed by a pure `readAgentActivity` reader (drops malformed rows to an empty line, never a crash), `session` markers are dropped (the model already shows in the call header), and an unpaired `tool_result` renders standalone so nothing is hidden.

## Drill-Down Blobs

Large content — agent prompts and responses, a failing gate's output, a diff — is stored via `observer.storeBlob(content)`, which returns a content-addressable ref, and referenced from the observation's `input`/`output`. The dashboard fetches it by ref through its blob route, so the summary stays small and the full detail is one click away. `storeBlob` no-ops (returns `""`) before the observation store is attached, exactly like the tracing methods, and the pipeline sanitizes content before storing it.

---

## External Trace Export (OTLP)

**File:** `src/core/observer/trace-export.ts` · **Mapper:** `src/core/observer/otlp/`

The same nested trace the dashboard renders can be projected into any OTLP/HTTP backend — Jaeger v2, the OTel Collector, Tempo, Honeycomb — for a real flame-graph view. This is **opt-in, additive, and best-effort**: off by default, it changes nothing about how the pipeline emits, and a down or slow backend can never affect a task or daemon startup.

**It is a projection, not new instrumentation.** SQLite stays the system of record; the backend is a disposable lens. The exporter is a side-channel **reader** of the `observations` table, never on the pipeline write path.

**Task-traces only.** The exporter ships **only observations that carry a `trace_id`** — the task pipeline's end-to-end tree. Untraced rows (quota polls, daemon arbitration decisions, workspace teardown, startup beats) are *not* exported: each would otherwise derive its own trace id and land as a lone 1-span "trace", which is noise in a trace tool. They remain fully visible in the dashboard (SQLite is the system of record); the OTLP lens is deliberately narrower. See [What to trace, what not to](#what-to-trace-what-not-to-whats-a-decision) for the emission rules this enforces.

```
observations table (SQLite)  ──poll by rowid──▶  OTLP mapper  ──POST──▶  <endpoint>/v1/traces
   (system of record)          (own timer)        (otlp/)                 (Jaeger / any OTLP backend)
```

**Poll-based, not subscribe.** There is no in-memory observation stream — the dashboard SSE route polls SQLite by rowid, and the exporter reuses that exact mechanism on its own timer. Because it runs off the write path, a hung or slow backend stalls only the exporter's loop, never `notify`/`startSpan`/`end`.

**Exactly-once, when complete.** A span row is inserted open (`end_time` NULL) and updated on close at the *same* rowid, so a naive `rowid > cursor` poll would see the open insert but miss the close. The exporter therefore exports only **complete** observations (an instant, or a span whose `end_time` is set), tracks open spans in an in-memory `pending` set, and re-queries them for completion each cycle — every observation is exported once, with its real duration, with no reliance on backend dedup.

**Rehydration.** On start the cursor reaches back a bounded recent window so a freshly-started backend replays recent history; the live tail then continues from the same cursor.

**One endpoint, no fan-out.** A single configurable OTLP/HTTP target (`daemon.telemetry.endpoint`). OTLP *is* the swap boundary — point that one URL at any compatible backend. There is no adapter and no multi-endpoint list.

**The mapping** (pure, in `otlp/`, shared with the dashboard's deep-link so ids match byte-for-byte):

- trace id = the dispatch `trace_id` ULID decoded to its 16 bytes, hex (32 chars).
- span id = the low 64 bits of the observation ULID, hex (16 chars).
- start/duration → unix-nanos as strings; an instant (and any same-millisecond span) is floored to 1µs wide so backends never flag a "negative duration" (1µs, not 1ns — Jaeger measures duration in microseconds, so a 1ns width truncates back to zero).
- `input`/`output` → typed OTLP attributes; the always-null `metadata` is dropped.
- a blob ref → an attribute carrying the dashboard blob URL, never the inlined content (OTLP size limits).
- `status` ok/error → OTLP span status; a decision or verdict carries its fields as attributes.

**Sanitize at the export boundary.** A remote endpoint ships data off-machine, so every stringified attribute value is sanitized where the span is built (`otlp/`), independent of whatever the facade stored. A planted secret is scrubbed before it can ride into an attribute.

### Backend adjuster quirks (why spans are shaped the way they are)

Jaeger runs *adjusters* over a trace at query time, and several append a **warning** to a span when its shape looks off. The catch: Jaeger **mutates the stored span on every query**, so a warning re-fires and **accumulates once per view** — a trace watched live while a task runs can rack up dozens of identical copies, baked in permanently. Two of these we design out at the source; the third is an accepted cosmetic cost of streaming live (below). A regression in the first two shows up as warning spam, not broken data:

| Backend warning | Root cause | How the exporter handles it |
|---|---|---|
| `Negative duration detected` | An instant (or same-millisecond span) is zero-width; duration is measured in **microseconds**, so a sub-µs width rounds to ≤0. | **Fixed** — `otlp/span.ts` floors every span to **1µs** wide (1µs, *not* 1ns — a 1ns width truncates back to 0µs and the warning returns). |
| `clock skew adjustment disabled; … delta …` | The clock-skew adjuster treats a span with **no host identity** as a foreign host and computes a bogus cross-host correction. | **Fixed** — `otlp/resource.ts` stamps one `host.name` on every span, so the adjuster sees a single host and skips skew entirely. |
| `parent span ID … is not in the trace` | A child reaches the backend before its parent. The root `execute_task` span covers the whole task and ships **last** (on settle), so while a task runs its children are briefly parentless, and each in-progress view appends another copy. | **Accepted, not fixed** — cosmetic (the data is correct and it resolves once the root lands; it only accrues while you *watch* a running trace). Eliminating it means withholding the whole trace until the root settles — i.e. no live view — a trade we chose against: live streaming wins. |

The throughline: **well-formed, same-host spans keep the backend quiet** — the 1µs floor and the host identity are non-negotiable. The one warning we live with is `parent not in trace`, the price of streaming a long-running root live (the row above). When adding an observation kind or changing span timing, re-check it against this table — the harness is a few synthetic spans POSTed to a local `:4318` and read back from `:16686/api/traces`, no task run needed.

**Bringing a backend.** The Engineer does not download, install, or supervise the backend — you bring it. The repo ships a root [`docker-compose.yml`](../../../docker-compose.yml) for a one-command local Jaeger v2 (`docker compose up -d`, UI at http://localhost:16686); a Homebrew/binary Jaeger (`brew install jaeger && jaeger`, the [official download](https://www.jaegertracing.io/download/)) or any other OTLP endpoint works identically. When telemetry is on but nothing answers, `engineer start` still starts and prints an OS-aware install pointer (`src/cli/commands/start/telemetry.ts`); `engineer doctor` reports a telemetry category that probes reachability with a short localhost timeout. When the backend answers, both the start output and the dashboard task page link out to the flame graph.

See [Telemetry configuration](../../configuration/daemon.md#telemetry) for the two config keys.

---

## Component Tags

**File:** `src/core/observer/logging.ts`

Every observer child is tagged with a `ComponentTag` — a TypeScript string union:

```
daemon, registry, orchestrator, task-engine, safety-layer, workspace-manager,
skills, event-bus, cli, action-pipeline, plugin, plugin-loader, data-lifecycle,
notifications, dashboard
```

Tags appear in every log line's `component` field. Use the existing tag for your component. If adding a new component, add its tag to the `ComponentTag` union in `src/core/observer/logging.ts`.

---

## Bootstrap Lifecycle

**File:** `src/cli/commands/start/bootstrap.ts`

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

**File:** `src/db/migrations/002_observations.sql`

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
  error_message TEXT,
  links TEXT                              -- JSON [{trace_id, observation_id}]; cross-trace continuity edges
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

The dashboard is a React SPA (`src/dashboard/client/`). Its top-level views are **Overview** (status cards plus a cleanup card surfacing recent reaper sweeps), **Tasks** (the list, filterable by state — including `cancelled` — and by block reason), **Activity** (the live observation/event feed, filterable across every real observation type), **Metrics**, and **Errors**. Opening a task drills into its detail tabs: **Overview** (phase/sub-phase, loop counters, block taxonomy, `reaped_at`), **Phases**, **Agent Calls** (cost/tokens/blob drill-down, plus each call's live or re-watchable conversation — see [Live Agent Activity](#live-agent-activity)), **Decisions** (alternatives, reasoning, confidence), **Tools**, and **Timeline**.

It consumes observations through two channels:

1. **Real-time:** SSE stream (`/api/stream`) polls SQLite for new observations/events every second, pushes to the browser via Server-Sent Events
2. **Historical:** Dashboard API routes (`src/dashboard/api/`) query `ObservationStore` with filters (type, task_id, trace_id, parent_observation_id, phase, since, level) and serve blob content — including `GET /api/tasks/:id/agent-activity?call=<agentCallId>`, which returns one `agent_call`'s `agent_activity` children in order for the retroactive conversation re-watch; the events route (`/api/events?type=`) is the cross-process path to durable system events like the reaper's `system.reap_completed` sweep summary

The frontend uses TanStack Query for data fetching with SSE-driven cache invalidation — expensive endpoints (metrics, traces) refresh only when new data arrives. The dashboard version shown in the sidebar is single-sourced from the root `package.json` (injected at build time via Vite `define`), never hardcoded.

---

## Testing

### Unit Tests (no tracing needed)

```typescript
import { createTestObserverFacade } from "../../tests/helpers/test-observer-facade.js";

const observer = createTestObserverFacade("my-component");
// Silent pino (no output), no observation store (tracing is no-op)

// Spy on logging calls
const warnSpy = vi.spyOn(observer, "warn");
// ... do work ...
expect(warnSpy).toHaveBeenCalledWith("expected message", { expectedData });
```

### Integration Tests (with tracing)

```typescript
import { createTestObserver } from "../../tests/helpers/test-observer.js";

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
5. **Use the right observation type** — pick the one that names the thing, don't overload `lifecycle` for everything
6. **Include SpanOptions** — always pass `task_id` and `trace_id` when available for correlation
7. **Spans must end** — always call `span.end()` (use try/finally if needed)
8. **Stored is not surfaced** — an observation no dashboard view queries (or a view nothing emits) is dead data; wire the emission and the view it feeds together as one unit of work
9. **Adapters use local interface** — `AdapterObserver` to avoid tier import violations

---

## File Reference

| File | Purpose |
|------|---------|
| `src/core/observer/facade.ts` | `IObserver` interface + `Observer` class (the unified facade) |
| `src/core/observer/types.ts` | `IObservationStore` + `ObservationSpan` interfaces |
| `src/core/observer/observation-store.ts` | `ObservationStore` class (SQLite persistence; re-exported from `index.ts`) |
| `src/core/agent-activity/` | The live-agent-activity mediator: `createActivitySink` (effectful sink) + `mapActivity` (pure event→observation mapping). Consumes `AgentActivityEvent`, writes `agent_activity` children of the `agent_call` span |
| `src/core/observer/store.ts` | `ObserverStore` (prepared statements, SQL layer) |
| `src/schemas/observer.ts` | Zod schemas, observation types enum, row mapper |
| `src/db/migrations/003_observer.sql` | Database schema (table + 8 indexes) |
| `src/core/observer/logging.ts` | `ComponentTag` type, `createLogger`, `createSilentLogger` |
| `src/core/observer/blob-store.ts` | Content-addressable blob storage (SHA-256) |
| `src/core/observer/trace-export.ts` | Poll-based OTLP exporter (`startTraceExport` factory + `stop()` handle) |
| `src/core/observer/otlp/` | Pure OTLP/JSON mapper (`deriveTraceId`/`deriveSpanId`, span + resource builders, attribute sanitization) |
| `src/cli/commands/start/telemetry.ts` | Start-output telemetry helpers (reachability probe, OS-aware install pointer) |
| `src/cli/bootstrap.ts` | Observer creation, upgrade, and threading to all components |
| `tests/helpers/test-observer-facade.ts` | Test helper: silent observer (no tracing) |
| `tests/helpers/test-observer.ts` | Test helper: full observer with in-memory DB |
