# The Dashboard

Your live window into what The Engineer is doing — tasks, phases, decisions, costs, errors, and the agent's own conversation as it streams.

## Opening It

The dashboard starts automatically with the daemon. Run `engineer start`, and once it reports the daemon is ready, open:

> [http://localhost:3847](http://localhost:3847)

It is a local web app bound to `127.0.0.1`, so only your machine can reach it — nothing is exposed to the network. There is nothing to install or launch separately; stopping the daemon (`engineer stop`, or `Ctrl+C` in the foreground) stops the dashboard with it.

**It is a read-only window.** The dashboard reads the same SQLite database the daemon writes to as it works — it never reaches into the running engine's memory. That has two upshots worth knowing up front: it shows past work as readily as the present (history survives restarts), and the one thing it can change is responding to a blocked task (covered below). Everything else is observation.

## What Each Page Shows

The dashboard has five top-level pages. Each answers a different question.

| Page | The question it answers |
|---|---|
| **Overview** | Is everything healthy right now, and is anything waiting on me? |
| **Tasks** | What work exists, and what state is each piece in? |
| **Activity** | What is the engine doing this very moment? |
| **Metrics** | What is this costing me, and am I near a limit? |
| **Errors** | What has gone wrong? |

### Overview

The home page — a grid of status cards for a glance-and-go health check.

- **Daemon** — running or stopped, with the process ID.
- **Cost** — today's and this month's agent spend.
- **Recent Errors** and **Blocked Tasks** — turn amber or red when they have something for you, so trouble is visible without clicking in.
- **Active Tasks** — what is executing now, each with its phase pipeline; click one to open its detail page.
- **Recent Activity** — the last handful of observations as they land.
- **Cleanup** and **Data Lifecycle** — the background housekeeping sweeps: the first reaps finished task workspaces (git worktrees and branches), the second prunes aged rows and orphaned blobs from the database. A failed count here is the signal that housekeeping is quietly falling behind.
- **Plugin Health** — the current health of every registered plugin. This is advisory: a degraded plugin is a heads-up to you, not something that silently changes the engine's behavior.

### Tasks

The full task list, with filter chips across the top to narrow by state — `active`, `blocked`, `queued`, `requirements_gathering`, `completed`, `failed`, `cancelled`. When you are looking at blocked tasks, a second row of chips lets you narrow further by *why* they are blocked: needs info, agent unavailable, pipeline failed, or PR review pending. Click any row to open that task's detail page.

#### Task detail

A task's detail page opens on its title, state, and current position in the pipeline, plus action buttons that match the task's state: a **Cancel** button while the task is still cancellable, a **Retry** button on a failed or blocked task that re-queues it, a **Resume** button on a cancelled task whose work has not yet been cleaned up (it picks up from the last checkpoint), and a **Re-run** button on a cancelled task whose work _has_ been cleaned up — it starts a brand-new task from the same source, since there is nothing left to resume. If a blocked task needs you, an amber banner sits at the top with the block details and a response box — see [Responding to a blocked task](#responding-to-a-blocked-task). Below that, six tabs break the task down:

| Tab | What it shows |
|---|---|
| **Overview** | State, phase position, cost and tokens, timestamps, acceptance criteria, and the structured artifacts (decisions, workspace, review). |
| **Timeline** | One chronological feed of everything — state changes, journal entries, agent calls, decisions, and gate verdicts — each rendered in its own legible form rather than raw JSON. |
| **Phases** | The per-phase breakdown: each pipeline phase with its sub-step sequence, the routing and skip decisions taken inside it, and its cost and duration. |
| **Decisions** | Every fork the engine recorded — the context, every option it weighed with the chosen one highlighted, the reasoning, and its confidence. The richest "why did it do that" view. |
| **Steps** | The step feed: one row per sub-phase the engine actually ran, in true executed order (e.g. `implement → verify → implement`), not just the agent calls. An agent step shows its cost and tokens and expands to the full conversation ([Watching the agent work](#watching-the-agent-work)); a non-agent step (verify, push, create-pr) expands to what it did and produced — gates, verdict, the routing decision. Where a step paused the task — most tellingly an autonomy decision awaiting your approval — a **block → resume** marker sits between it and the next step, drilling into the question asked and the reason, so there is never an unexplained gap. |
| **Tools** | The tool-execution log: every command and gate the agent ran, with status, duration, and expandable input/output. |

### Activity

A single live feed that merges every observation and event as the daemon emits them — the place to watch the engine think in real time. Filter by observation type (agent calls, tool executions, decisions, and the rest) or by severity, and toggle auto-scroll to either follow the latest line or hold your place while you read back.

### Metrics

The spend and capacity view: today's and this month's cost up top, then token usage, a cost trend over time, cost broken down by task and by phase, per-phase performance, and your agent **quota status** — live usage bars per rate-limit window, which fill in after the first agent run.

### Errors

One consolidated log of everything the engine flagged as an error or a warning, with chips to filter to just errors or just warnings. The first stop when something looks off.

## Watching the Agent Work

The flagship view lives in a task's **Steps** tab. Expand an agent step and you see the agent's whole conversation — assistant messages, its thinking, the tool calls it makes and the results that come back — rendered as a chat-style feed.

- While the call is **live**, the conversation streams in as the agent works, with a "streaming" pulse and the feed following the newest line. Scroll up to read back and it pins in place, with a "Jump to latest" affordance to return.
- Once the call is **done**, the same conversation is fully re-watchable — nothing is lost when the run ends.

This works the same for every agent. Each plugin maps its own native stream into one canonical form, so the conversation reads identically whether the agent is Claude Code, OpenCode, or Gemini.

## Responding to a Blocked Task

When a task needs you — a clarifying question, a decision, or a PR review — it goes to the `blocked` state and surfaces in two places: the **Blocked Tasks** card on Overview, and a filter on the **Tasks** page. Open the task and an amber banner at the top shows what it is blocked on and the next step it needs. Type your answer in the response box and send it (Cmd+Enter is the shortcut), and the task unblocks and continues.

This is the one action in the dashboard that reaches back into the engine. Everything else is a read-only view.

## How Live Updates Arrive

The dashboard stays current over **Server-Sent Events** (SSE): a single long-lived stream from the daemon pushes each new observation and event to your browser the moment it is written, so the Activity feed and the live agent conversation update on their own — no refresh, no manual polling. A handful of views that depend on a step *finishing* (for example, an agent call flipping from live to done) refresh on a short poll instead, so those indicators settle on their own too.

## When Something Looks Wrong

The dashboard is your first diagnostic tool. A quick triage:

- **Daemon card says Stopped, or the page won't load** — the daemon isn't running. Start it with `engineer start`.
- **Something for you** — check the **Blocked Tasks** card. A task in the `blocked` state is waiting on your response, not stuck.
- **A task failed or stalled** — open it and read its **Timeline** tab to see where it stopped and why; the **Errors** page has the engine-wide view. The **Decisions** tab explains the choices that led there.
- **Errors or warnings piling up** — the **Errors** page consolidates them; **Plugin Health** on Overview flags a degraded plugin (for example, the agent CLI or a token).
- **Spend climbing** — the **Metrics** page shows cost by task and phase and your quota usage.

For failures the dashboard surfaces but doesn't resolve — the daemon won't start, no tasks get picked up, an agent CLI isn't found, a token is invalid — see [Troubleshooting](../troubleshooting.md).
