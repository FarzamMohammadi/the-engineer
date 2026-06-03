# Observability

How The Engineer makes an autonomous, long-running agent legible — to the owner watching it, to the engineer debugging it, and to any external tracing backend that wants the whole picture. This document explains the *shape* of observability and the reasoning behind it. For the API, the method names, and the rules you follow when you add an emission, read the [Observability how-to](../contribution-docs/how-tos/observability.md); for the principle it serves, read [Radical Observability](../philosophy.md#radical-observability--the-owner-is-never-in-the-dark).

> **Key terms:** an **observation** is one recorded thing that happened (a span or an instant); a **trace** is the nested tree of observations for a single task dispatch; the **observer** is the one interface every component uses to emit; the **dashboard** is the owner's live window onto the traces. See also the [architecture overview](overview.md) and the [pipeline](pipeline.md).

## Why this exists

The Engineer runs autonomously, for a long time, doing real engineering work inside an opaque agent subprocess. Autonomy without observability is a black box: a task succeeds or fails and no one can say why. So observability is not a feature bolted on the side — it is a first-class concern of the Core, with the same weight as safety and the same invariant status as the pipeline.

The bar is set by the owner's eyes, not the engineer's. The person watching a task cannot see the source and cannot see inside the agent runs. They see **only what the pipeline chose to emit.** Everything below is built so that what is emitted is enough to reconstruct the whole story — what happened before, what is happening now, what happens next — and to drill into the full underlying detail the moment they are curious. If it was not emitted, as far as the owner can tell it did not happen.

## Three systems, one entry point

Observability is three distinct systems with different purposes, destinations, and lifetimes. Every component reaches all of them through a single injected dependency, the **observer**, so a component never juggles loggers or stores — it gets one interface and uses the right verb.

| System | Question it answers | Destination | Who reads it |
|---|---|---|---|
| **Logging** | "What was the program doing, in what order, with what values?" | Rolling JSON log files (pino) | The engineer, after the fact, diagnosing |
| **Tracing** | "What is the shape of this task — its steps, durations, decisions, outcome?" | The `observations` table in SQLite | The owner, live, via the dashboard (and any external backend) |
| **Event Bus** | "What business-significant things have happened to this task?" | The `events` table in SQLite | The system itself (replay, recovery) and the audit trail |

They are deliberately separate because they answer different questions and have different consumers. Logging is *reasoning* — a flat, searchable narrative for a human with the code open. Tracing is *structure* — the nested shape of an operation, written for an owner who has neither the code nor the agent transcript. The Event Bus is the system's own *nervous system and ledger* — the durable record of what happened that the system can replay to rebuild its state after a crash. Conflating them would force one shape to serve three incompatible needs.

One method bridges two systems on purpose: recording an error writes to **both** the logs (so the engineer can diagnose) and the trace (so the owner sees the failure on the timeline). It is the only deliberate dual-write; every other emission targets exactly one system.

### Logging — the engineer's narrative

Logging is structured JSON, one entry per line, rotated by day with a size cap, tagged with the component that emitted it. It is for the engineer reading after the fact: searchable, parseable, ordered. The discipline that keeps it useful is that values live in named fields, never interpolated into the message string — so the log is queryable, not just readable. Logging is available from the first moment of startup, before any database exists, because it has no dependency beyond the file system.

### Tracing — the owner's live picture

Tracing records the *shape* of work as a tree of observations. The two basic shapes are a **span** (something with duration — an agent run, a gate, a git push: it opens, work happens, it closes with an outcome) and an **instant** (a point-in-time fact with no duration — a decision, a verdict, an error). Spans nest: a parent span has children, children have children, and the whole nesting is the trace. The dashboard renders this tree; an external backend renders it as a flame graph. Tracing is the system through which the principle of Radical Observability is actually delivered, so it is the richest of the three — for the pipeline, completeness wins over restraint.

Crucially, tracing lands in **durable SQLite rows**, not an in-memory stream. This is the load-bearing design choice that everything downstream depends on (see [The system of record](#the-system-of-record-is-sqlite)).

### Event Bus — the audit trail

The Event Bus is its own subsystem, documented with the [architecture overview](overview.md#event-bus); it is named here because it is the third leg of observability and is sometimes confused with tracing. The distinction: the Event Bus records *business events* — a task was created, a state changed, a cost was incurred — as a persisted, replayable, glob-subscribable stream that the system itself consumes to reconstruct state after a crash. Tracing records *everything else that happened inside the components* for human eyes. The Event Bus is the ledger; tracing is the story.

## One trace per dispatch

The unit of tracing is the **task dispatch**. Every time the orchestrator picks up a task and runs it, that whole run is one trace: a single root span opened at the start, with every observation the pipeline emits during the run hanging off it as a descendant. The mechanism is a correlation id — one identifier minted per dispatch and threaded through the pipeline context — that every emission carries, plus a parent pointer that stitches each observation under the right ancestor.

This is what makes a task *legible as a whole* rather than as scattered log lines. Because the pipeline's runner — the generic loop that drives every sub-phase — is the thing that emits phase entries, sub-phase results, routing decisions, loops, and blocks, a sub-phase *cannot forget to be observed*: observability is a property of the loop, not a discipline each step must remember. The agent runs, the verify gates, the delivery actions, and the merge decision all nest into the same tree by construction. The result is one coherent, drill-down-able narrative per task, from intake to outcome — the same tree the dashboard shows and an external backend consumes whole.

## The system of record is SQLite

There is no in-memory observation stream. Tracing methods write rows to the `observations` table, and **every** consumer — the dashboard, the external exporter — reads those durable rows back. This is a deliberate inversion from a push-based pub/sub design: durable SQLite rows are the *only* path to any viewer, which means anything not written to the table is invisible to the owner, and conversely anything written survives a restart of the engineer, the dashboard, or the whole machine.

The table is append-mostly and immutable in spirit: a row is inserted when a span opens, and only its closing fields (end time, duration, outcome) are updated once, when the span ends. An instant is inserted already complete. This single, narrow write contract is what makes a *poll-by-rowid* read model work for every consumer (below).

### The blob store

Tracing rows must stay small — the dashboard summarizes a whole task at a glance, and a trace backend has hard per-span size limits. But the genuinely interesting detail is large: an agent's full prompt, its complete response, a failing gate's output, a diff. The **blob store** resolves this tension. Large content is written once to content-addressable storage (hashed, deduplicated, stored as files outside the database), and the observation row carries only a small *reference* to it. The summary stays small; the full detail is one click away. This is how the system honors "drill down into everything" without bloating the hot path or the trace payload — the trail is complete *and* lean.

## How observations are read

Both viewers read the same durable rows the same way: a **poll-by-rowid high-water cursor.** A reader remembers the largest rowid it has seen, periodically asks for rows beyond it, and advances its cursor. No subscriptions, no callbacks, no in-process coupling between the writer and its readers. The writer's only job is to land durable rows; readers catch up on their own clock. This decoupling is the reason a slow or absent reader can never affect the thing being observed — a property the external exporter leans on entirely.

### The dashboard

The dashboard is a **separate process** — the owner's live window onto the traces. It does not share memory with the engine; it polls the `observations` (and `events`) table by rowid and streams new rows to the browser. It is the durable, always-available default view: a task timeline, the phase and sub-phase tree, the decisions with their alternatives and reasoning, the agent runs, the verdicts, the errors — each expandable down to the underlying blob. Because it reads the system of record rather than a live feed, it shows history as readily as the present, and it survives restarts. Because it is a separate process, anything held only in a daemon component's memory is invisible to it: the workspace reaper, for instance, publishes a durable per-sweep `system.reap_completed` event so the dashboard can surface recent cleanup, since the reaper's in-memory last-run summary is unreachable across the process boundary.

## External trace export

The same per-dispatch tree the dashboard renders can be **projected** into any external OTLP/HTTP tracing backend — Jaeger, the OpenTelemetry Collector, Tempo, Honeycomb — for a real flame-graph view. Four properties define it, and together they keep it safe to leave running:

- **It is a projection, not new instrumentation.** SQLite stays the system of record; the backend is a disposable lens. Turning export on changes *nothing* about how the pipeline emits — the exporter is a side-channel reader of the same rows the dashboard reads, never on the pipeline's write path. The observation model is the source of truth; the backend is a view that can be thrown away and rebuilt.

- **It is poll-based and off the hot path.** Like the dashboard, the exporter polls the `observations` table on its own timer and POSTs what it finds. Because it runs off the write path, a hung or slow backend stalls only the exporter's own loop — never a task, never daemon startup. This non-blocking guarantee is the linchpin: a misbehaving observability tool must never wedge the work it observes.

- **It is best-effort and opt-in.** Off by default. When on and the backend is reachable, traces flow; when the backend is down, slow, or absent, the exporter drops what it cannot deliver, warns sparingly, and keeps going — the daemon and dashboard start and run regardless. Failure of the lens is never failure of the system.

- **It is one swappable endpoint.** A single configurable OTLP/HTTP target — no adapter, no fan-out, no multi-endpoint list. OTLP itself *is* the swap boundary: point that one URL at any compatible backend and that is the entire "register whichever observability tool you like" capability, delivered through config alone.

### What the projection guarantees

The mapping from an observation to a trace span is **pure** and is the single shared source of truth for both the exporter and the dashboard's deep-link, so the two never derive an id differently and a "view this trace" link always resolves. Each observation becomes exactly one span (an instant is a zero-duration span — still visible on the flame graph, just without width); the dispatch correlation id becomes the trace id and the observation's own id becomes the span id, so the backend reconstructs the exact same tree.

Two properties of the projection are load-bearing. First, **completeness without double-counting:** because a span row is inserted open and updated closed at the *same* rowid, a naive rowid poll would see the open insert but miss the close. The exporter exports only *complete* observations, remembers the open ones, and re-checks them for completion each cycle — so every observation is exported exactly once, with its real duration, without relying on the backend to deduplicate. On start it reaches back a bounded recent window so a freshly-started backend replays recent history rather than only the live tail.

Second, **sanitization at the export boundary.** A remote backend ships data *off the machine*. So every value placed into a span attribute is sanitized where the span is built — independent of whatever was stored in SQLite — so a secret cannot ride out of the box inside a trace. This is the one place sanitization is duplicated on purpose: the export boundary is a trust boundary, and it defends itself.

### Bringing a backend

The Engineer does not download, install, or supervise the tracing backend — the user brings it (a local Jaeger, a `docker run`, or any OTLP endpoint). When export is enabled but nothing answers, the system still starts and prints an OS-aware install pointer; the doctor check reports whether export is enabled and whether the endpoint is reachable. When the backend answers, both the start output and the dashboard's task page link out to the flame graph. The dashboard stays the durable default; the external backend is the rich, optional upgrade. The two config keys that control this are documented in the [daemon telemetry configuration](../configuration/daemon.md#telemetry).

## Lifecycle and threading, in brief

Two operational facts shape how observability is wired, both detailed in the [how-to](../contribution-docs/how-tos/observability.md):

- **Two-phase startup.** Logging works from second one (pino needs nothing but the file system); tracing joins the moment the database is ready. Components are created with a logging-capable observer whose tracing is a silent no-op, and a single upgrade step lights up tracing for every component at once — they share one context, so none need re-wiring.

- **The observer is a required dependency, everywhere.** Every component receives the observer as a non-nullable injection, so there is no "if a logger exists" branch and no console fallback anywhere in `src/`. The one nuance is the adapter tier, which cannot import Core: adapters see a minimal local view of the observer, injected by the registry, to preserve [tier isolation](three-tier-model.md).

## The discipline that keeps it honest

The system is only as observable as what the pipeline chooses to emit, so a few rules are load-bearing rather than stylistic:

- **Stored is not surfaced.** An observation that no view renders is dead data; a view that nothing emits is an empty promise. Emission and the view it feeds ship as one unit of work — never one without the other.
- **Name the thing.** Each observation has a type that names what it is (an agent run, a tool action, a decision, a verdict, a state transition). Overloading a generic "lifecycle" type for everything destroys the queryability that makes a trace useful.
- **Emit more, when in doubt.** For the per-task pipeline, completeness wins. "Signal, not noise" forbids meaningless plumbing output — not genuine decisions, verdicts, state changes, and milestones, which are emitted richly and durably as structured data the dashboard can parse and query.

These are enforced in the [Definition of Done](../philosophy.md#radical-observability--the-owner-is-never-in-the-dark) and specified concretely in [Coding Standards §§ 12 and 14](../coding-standards.md#12-logging).

## Further reading

- [Observability how-to](../contribution-docs/how-tos/observability.md) — the API, the methods, the lifecycle, and the rules for adding an emission.
- [Radical Observability](../philosophy.md#radical-observability--the-owner-is-never-in-the-dark) — the principle this system serves.
- [Coding Standards §§ 12 and 14](../coding-standards.md#12-logging) — what to log, what to trace, what to record as a decision.
- [Daemon telemetry configuration](../configuration/daemon.md#telemetry) — the two keys that turn external export on and point it at a backend.
- [The pipeline](pipeline.md) — the per-task structure that one-trace-per-dispatch mirrors.
- [Architecture overview](overview.md) — the Event Bus and the components that emit.
