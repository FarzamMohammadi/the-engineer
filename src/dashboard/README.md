# The Dashboard

The owner's live window into The Engineer. A local web app that shows what the daemon is doing —
tasks, phases, decisions, costs, errors, and (newest) the **agent's own conversation, streaming live** —
so the owner is never in the dark.

> Looking to run or hack on the React client? See [`client/README.md`](client/README.md) for dev setup,
> the tech stack, and the client file tree. **This** doc explains how the dashboard works end to end.

---

## The one idea that explains everything

**The dashboard renders only what the pipeline durably emitted — it never reaches into the daemon's memory.**

The daemon writes two trails to SQLite as it works. The dashboard is a *separate process* that reads
those trails back. It shares no memory with the engine. Three consequences fall out of that:

- It shows **history as readily as the present** — it reads the system of record, not a live feed.
- It **survives restarts** — nothing it shows lives only in RAM.
- Anything held only in a daemon component's memory is **invisible** to it. So if the owner needs to see
  it, the engine must *emit* it. (This is why the agent conversation feature exists: the stream used to
  live only in the agent subprocess's memory.)

---

## Data flow

```
   ┌─────────────────────────── the daemon (engine) ───────────────────────────┐
   │  Observer  ──►  observations table   (the "how": spans, decisions,         │
   │                 + blob store          agent activity, verdicts, errors)    │
   │  Event Bus ──►  events table          (the "what": state changes, cost)    │
   └───────────────────────────────┬───────────────────────────────────────────┘
                                    │  SQLite (WAL — concurrent reader-safe)
                                    ▼
   ┌──────────────────────── the dashboard (this dir) ─────────────────────────┐
   │  server.ts ── Hono on 127.0.0.1:3847                                       │
   │     ├─ /api/*  REST routes  (read SQLite, serve blobs)                     │
   │     ├─ /api/stream  SSE     (tail new rows by cursor, push to the browser) │
   │     └─ static  serve the built React SPA (dist/dashboard)                  │
   └───────────────────────────────┬───────────────────────────────────────────┘
                                    │  HTTP + Server-Sent Events
                                    ▼
                         React SPA in the browser
```

- **Observer → `observations` table** — the diagnostic trail: typed spans (`task_execution`, `agent_call`,
  `agent_activity`, `tool_execution`, `phase_transition`, `decision_point`, `safety_verdict`, …), each with
  `input`/`output`/`metadata`, correlated by `task_id` / `trace_id` / `phase` / `parent_observation_id`.
- **Event Bus → `events` table** — the audit trail: every action with a ULID + monotonic sequence
  (`task.state_changed`, `cost.incurred`, `system.reap_completed`, …).
- **Blob store** — large payloads (agent prompts, full responses, transcripts, tool I/O) are content-addressed
  by SHA-256 and referenced from observations, never inlined. The dashboard drills into them on demand.

---

## Process & serving model

| Concern | How |
|---|---|
| **Lifecycle** | Started by `engineer start` via `startDashboard(config, port)` ([`index.ts`](index.ts)); stopped with the daemon. |
| **Server** | A [Hono](https://hono.dev) app ([`server.ts`](server.ts)) on `127.0.0.1:3847`. |
| **DB access** | Opens a **read-only** and a **write** connection to the same SQLite file in **WAL** mode — safe to read while the daemon writes. |
| **SPA serving** | Serves the built client from `dist/dashboard` (co-located with the bundled server entry). A catch-all returns `index.html` for client-side routing. |
| **Dev mode** | `pnpm dev:dashboard` runs Vite on `:5173` and proxies `/api/*` to `:3847` (live client reload). See `client/README.md`. |
| **CORS** | Restricted to `localhost:3847` and `localhost:5173`. |

---

## The API layer (`api/`)

Each file is a Hono sub-router mounted under `/api`. They are thin: parse the request, query
`ObservationStore` / the DB, return JSON. Routes never mutate the pipeline (the one write path is a guarded
task cancel; comms replies go through `messages`).

| Mount | File | Serves |
|---|---|---|
| `/api/tasks` | `tasks.ts` | task list, detail, `timeline`, `phases`, `traces` (tool executions), `agent-traces` (agent calls), **`agent-activity`** (one call's conversation), and a guarded `cancel` |
| `/api/stream` | `stream.ts` | **SSE** — the realtime channel (see below) |
| `/api/observations` | `observations.ts` | raw observation queries |
| `/api/events` | `events.ts` | durable event queries (the cross-process path to engine events) |
| `/api/traces` · `/api/blob` | `traces.ts` | trace lookups + **blob drill-down** (`GET /api/blob/:prefix/:hash`) |
| `/api/metrics` | `metrics.ts` | cost / token aggregates |
| `/api/errors` | `errors.ts` | the error log |
| `/api/system` | `system.ts` | daemon health, telemetry surface, reaper sweeps |
| `/api/messages` | `messages.ts` | respond to a blocked task (the only inbound-to-engine path) |

`agent-cost-aggregation.ts` is a shared helper (per-call spend from an `agent_call` span), not a mounted route.

---

## The realtime layer — SSE

The live heartbeat of the dashboard is one endpoint and one client hook:

- **Server** ([`api/stream.ts`](api/stream.ts)) — every second, `SELECT … WHERE rowid > ?` on `observations`
  and `WHERE sequence > ?` on `events`, then pushes each new row as a typed SSE message
  (`event: observation` / `event` / `heartbeat`). The cursor advances per connection.
- **Client** ([`client/src/hooks/use-sse.ts`](client/src/hooks/use-sse.ts)) — a *singleton* `EventSource`
  with exponential-backoff reconnect, plus a tiny pub/sub: `useSseSubscription("observation", cb)`.

**The one subtlety worth knowing:** an instant observation (`observe()`) is a single `INSERT`, so the
`rowid > cursor` poll catches it cleanly and it streams live. A **span**, though, is `INSERT`ed open and
later `UPDATE`d closed at the *same rowid* — so a span's *close* is invisible to the cursor. That is why
live data is modeled as **instant rows**, and why anything that depends on a span *closing* (e.g. the
agent-call "live → done" flip) is refreshed by a short **poll** rather than the stream.

---

## The client (`client/`)

React 19 · Vite · Tailwind v4 (dark-only, oklch tokens) · TanStack Query · React Router. Full dev details
in [`client/README.md`](client/README.md). The shape that matters for understanding it:

- **Top-level views:** **Overview** (daemon + tasks + cost + reaper sweeps), **Tasks** (filterable list),
  **Activity** (the live observation/event feed), **Metrics**, **Errors**.
- **Task detail tabs:** **Overview**, **Timeline**, **Phases**, **Decisions**, **Agent Calls**, **Tools**.
- **Typed readers** ([`lib/observation-shapes.ts`](client/src/lib/observation-shapes.ts)) — the API returns
  observations with opaque `input`/`output` JSON; pure readers narrow each into the exact shape a component
  renders, **dropping anything malformed** so one bad row degrades to an empty card, never a white screen.
- **Blob drill-down** ([`components/shared/blob-viewer.tsx`](client/src/components/shared/blob-viewer.tsx)) —
  lazy-loads a blob only on expand. "Bounded summary on top, full detail one click beneath."
- **Markdown** ([`components/shared/markdown.tsx`](client/src/components/shared/markdown.tsx)) — a reusable
  renderer for model-authored text (`react-markdown` + `remark-gfm`, secure by default), styled compact for
  dense panes.

---

## ★ Live + retroactive agent conversation

The flagship view: expand any call in the **Agent Calls** tab and watch the agent's whole conversation —
assistant messages, thinking, tool calls and their results — **streaming live while it runs**, and
**re-watchable** once it's done. It is the clearest expression of the "emit it so the owner can see it" idea.

**The data.** Each agent run is an `agent_call` span. Its conversation elements are `agent_activity` child
observations — one per assistant message, thinking block, tool call, or tool result — written by the
isolated `src/core/agent-activity` sink as the agent's CLI streams. Each plugin (Claude Code, OpenCode,
Gemini) maps its native stream into one canonical `AgentActivityEvent`; Core writes the rows; the dashboard
renders them. Plugin-agnostic end to end. (Contract: `docs/plugins/agent/` · design: `docs/architecture/observability.md`.)

**One source of truth, two read paths:**

```
agent CLI stream ──► plugin maps to AgentActivityEvent ──► core/agent-activity sink
        └─► instant `agent_activity` rows, parented on the open `agent_call` span
                 │                                            │
   LIVE  (span open, task active)              RETROACTIVE  (span closed)
   tail new children over SSE                  GET /api/tasks/:id/agent-activity?call=<id>
                 └──────────────► the SAME chat feed ◄────────┘
```

**The UI** ([`client/src/pages/tasks/task-agent-tab.tsx`](client/src/pages/tasks/task-agent-tab.tsx)):

- The **model's answer** sits in a **blue card**, rendered as **markdown** and shown **in full** (a
  truncated preview auto-resolves its blob) — it's what people scan for first.
- **Thinking** is a muted, collapsible block; **tool calls** are neutral cards with their result folded
  beneath (paired by `tool_call_id`), drilling into blobs for large input/output.
- The feed is a **chat-style tail**: it lands at the latest line and follows the bottom as content streams
  in (pre-paint, no flicker) — unless you scroll up to read back, which pins it and shows "↓ Jump to latest".
- A "•••streaming" pulse shows while the call is live; because a span's *close* doesn't reach the SSE, the
  task and traces **poll every ~2.5s while the task is live** so the indicator stops on its own when the
  call finishes — no refresh needed.

**Why it can't hurt a run:** the whole path is observation-only and best-effort. The plugin emits to an
optional sink it knows nothing about; the sink wraps every write so it can never throw into, slow, or fail
the agent. A plugin that doesn't stream simply has no live feed — the run is byte-for-byte identical.

---

## File map

```
src/dashboard/
  README.md          ← you are here (how the dashboard works)
  index.ts           startDashboard(config, port) — boots the Hono server
  server.ts          createDashboardApp() — DB connections, mounts /api/*, serves the SPA
  api/               one Hono sub-router per concern (tasks, stream, events, metrics, …)
  client/            the React SPA (see client/README.md)
```

## See also

- [`client/README.md`](client/README.md) — client dev setup, tech stack, client file tree.
- [`docs/architecture/observability.md`](../../docs/architecture/observability.md) — the system blueprint
  for the Observer, Event Bus, and the live agent activity model.
- [`docs/plugins/agent/`](../../docs/plugins/agent/) — the agent adapter contract, including the optional
  activity-streaming capability.
