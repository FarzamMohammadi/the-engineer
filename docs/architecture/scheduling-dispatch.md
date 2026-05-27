# Scheduling and Dispatch

How a queued task becomes an in-flight dispatch, how dispatches are ended cleanly,
and how the daemon shuts down without losing work.

This page is the one-pager for the four moving parts that share the dispatch lifecycle:
**eligibility**, the **dispatch-tracker primitive**, **preemption**, and **shutdown**.

---

## Eligibility model

A queued task is eligible to dispatch when both of the following hold:

1. A worker slot is available (`max_concurrent` is not yet reached).
2. The task's `not_before` timestamp is past.

That is the whole gate. `not_before` is set by the [retry policy](../configuration/daemon.md#retry-policy)
after a crash or agent-unavailable failure to defer the next attempt; on success it is
cleared. There are no other gates — no parent checks, no cascade rules, no priority
threshold. If a queued task is eligible, the scheduler will dispatch it next tick.

Ineligible tasks remain queued and are checked again on every tick.

---

## Dispatch-tracker — the lifecycle primitive

Every in-flight dispatch is owned by one module: the **dispatch-tracker**. Whatever
the trigger — normal scheduling, preemption, hard-cap, cost-limit breach, graceful
shutdown — the tracker is the single point of truth for "is this task running, and
how do we end it?"

The tracker gives every dispatch three things:

- **A per-dispatch identity (`dispatchId`)**, so a late callback that resolves *after*
  the dispatch was terminated and the task was re-dispatched cannot clobber the new
  dispatch's state. Mismatched callbacks no-op.
- **An `AbortSignal`** owned by the tracker and passed to the dispatch runner. The
  signal lives on the `Dispatch` object handed to the orchestrator; it is the contract
  by which the scheduler force-ends in-flight work. Honoring the signal through the
  full call chain (phase-runner → agent-runner → agent plugins) lands in Slice 8 — until
  then, the signal is set on abort but the orchestrator finishes its current call
  before observing it. Best-effort termination, by design.
- **One terminate path.** `terminate(taskId, reason)` records the reason, aborts the
  signal, and lets the late callback route the dispatch through `Outcomes.terminated`
  to the right recovery state. Calling terminate twice is harmless — the first reason
  wins, the second is ignored.

The tracker also owns drain — see [Shutdown](#shutdown-drain) below.

### The reason routing table

`Outcomes.terminated` carries a typed reason. The scheduler routes each to exactly
one recovery state:

| Reason                  | Recovery state | Notes |
|-------------------------|----------------|-------|
| `cooperative_preemption`| `queued`       | Phase-runner reached a safe checkpoint and yielded between phases. |
| `preemption_timeout`    | `queued`       | The cooperative cycle missed its deadline twice — the tracker force-aborted. |
| `hard_cap_exceeded`     | `failed` + alert | The task exhausted its total active-time budget. Owner can recover via `engineer retry`. |
| `cost_limit_reached`    | `blocked`      | Owner-facing notifications already fired immediately when the limit hit; the late callback only does the state transition. |
| `graceful_shutdown`     | `queued`       | The daemon is stopping. The task will resume from its last checkpoint on the next start. |

---

## Preemption

Preemption is an opportunistic re-prioritization. When a queued task's priority
exceeds an active task's by at least `preemption_threshold` (default 20), the daemon
asks the orchestrator to yield at the next safe boundary.

Three properties shape v1's behavior:

- **Eligible filter first.** The preempter ignores ineligible candidates (`not_before`
  in the future). Otherwise it would evict an active task for a candidate that cannot
  actually dispatch — leaving the slot empty.
- **One per tick — deliberate.** The cooperative-then-forced cycle is sequential by
  nature (signal → wait for safe yield → re-signal on timeout → force-terminate on
  second timeout). Running multiple preemptions in parallel would either parallelize
  the cooperation (complex) or queue multiple pending cycles (singleton becomes a
  map). v1 needs neither.
- **Bounded priority `[1, 100]`.** Enforced in the task schema, matching the database
  CHECK constraint. The default is `50`. A priority of `0` would crash on insert; a
  priority of `1_000_000` is an operator footgun. The schema rejects both.

When the second cooperative deadline elapses, preemption calls
`dispatchTracker.terminate(taskId, "preemption_timeout")`. The terminate routing
re-queues the task; the orchestrator's still-pending promise eventually settles and
the late callback no-ops on identity mismatch when the task is re-dispatched.

---

## Cost-limit termination

When the safety layer raises `cost.limit_reached`, the cost-limit-queue drains it on
the next tick: it calls `dispatchTracker.terminate(taskId, "cost_limit_reached")`
**and** fires owner-facing notifications immediately — the owner must hear about
the limit *now*, not whenever the in-flight agent run eventually settles. The state
transition to `blocked` happens later through the standard late-callback path. Once
Slice 8 plumbs the signal through the orchestrator, the gap between "owner notified"
and "task settled" closes to near-zero.

---

## Shutdown drain

On `engineer stop`, the daemon:

1. Stops the tick loop (no new work is scheduled).
2. Signals the orchestrator to yield between phases (cooperative path).
3. Calls `dispatchTracker.drain(shutdown_timeout_ms)`.

The drain has one **shared** timeout across all in-flight dispatches — worst-case
shutdown is `shutdown_timeout_ms`, not `shutdown_timeout_ms × active_count`. Inside
the drain:

- Every in-flight signal is aborted in parallel.
- If a dispatch's promise settles within the timeout, its late callback routes
  through the standard `graceful_shutdown` path → re-queues the task.
- If a dispatch's promise refuses to settle (the v1 best-effort case until Slice 8
  lands), the drain synthesizes the late callback so the task is still re-queued
  cleanly. The daemon must shut down even when an in-flight agent run cannot be
  killed.

After drain returns, every dispatched task is in `queued` and will resume from its
last checkpoint on the next start.

---

## Related documentation

- [Daemon configuration](../configuration/daemon.md) — preemption, retry policy, and
  shutdown-timeout settings.
- [Retry policy](../configuration/daemon.md#retry-policy) — per-category backoff
  schedules and ceilings that set `not_before` and drive eligibility.
- [Architecture overview](overview.md) — where the scheduler and orchestrator sit in
  the three-tier model.
