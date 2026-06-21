# Daemon Configuration

Controls the daemon runtime: the main tick loop, task concurrency, trigger polling, logging, and housekeeping. These settings define how the daemon operates at the process level.

**File:** `~/.engineer/config/daemon.yaml`
**Hot-reload:** No — requires `engineer stop && engineer start`.

## Concurrency

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_concurrent` | integer | `1` | Number of tasks the daemon runs in parallel. Start with 1; increase after testing stability. |

Each concurrent task spawns a CLI agent process. Memory usage scales linearly — budget ~4GB per active task.

## Tick Loop

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tick_interval_ms` | integer (ms) | `5000` | Main daemon loop interval. Each tick polls triggers, checks scheduling, and runs housekeeping. |

## Preemption

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `preemption_threshold` | integer | `20` | Minimum priority gap to trigger preemption. A p70 task preempts a p50 task (gap=20) but not a p55 task (gap=15). Task `priority` is bounded to `[1, 100]` by the schema and the database CHECK constraint; the default priority for a new task is `50`. |
| `preemption_timeout_ms` | integer (ms) | `60000` | Grace period for a preempted task to checkpoint cooperatively. If the cooperative cycle misses two deadlines, the daemon force-terminates the dispatch via the dispatch-tracker primitive — see [scheduling-dispatch.md](../architecture/scheduling-dispatch.md). One preemption per tick by design. |

## Stuck Detection

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `stuck_threshold_ms` | integer (ms) | `1800000` (30m) | Duration of no progress after which a task is flagged as stuck. |
| `max_active_duration_ms` | integer (ms) | `28800000` (8h) | Hard cap on total wall-clock time a task can remain active. When exceeded, the dispatch is terminated, the task is marked `failed`, and the owner is alerted. Recover via `engineer retry <task-id>` after addressing the root cause. Wall-clock from `started_at`; blocked time counts. |
| `shutdown_timeout_ms` | integer (ms) | `30000` (30s) | Single shared timeout for the shutdown drain — worst-case shutdown is `shutdown_timeout_ms`, not `shutdown_timeout_ms × active_count`. Any dispatch that cannot settle in time is re-queued as `graceful_shutdown` so the daemon exits cleanly. See [scheduling-dispatch.md](../architecture/scheduling-dispatch.md). |

## Retry Policy

Task-level retry semantics live in one Core-owned module, called from the scheduler
(crash path, agent-unavailable path) and from boot recovery. Each category has its own
counter field on the task row, its own backoff schedule, and its own terminal disposition.
Configuration is per-category — both shape the *automatic* retry budget the daemon
applies before owner intervention is required.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `retry_policy.crash.backoff_minutes` | integer[] | `[1, 5, 15, 30, 30]` | Backoff schedule (in minutes) applied after each orchestrator crash. Index N is the wait before retry N+1. Past the array length, the last entry repeats until `max_attempts`. |
| `retry_policy.crash.max_attempts` | integer | `5` | Crashes before the task is marked `failed`. Owner can recover via `engineer retry <task-id>` after addressing the root cause. |
| `retry_policy.agent_unavailable.backoff_minutes` | integer[] | `[2, 5, 10, 15, 15]` | Backoff schedule applied each time the agent adapter is unreachable, blocking the task. |
| `retry_policy.agent_unavailable.max_attempts` | integer | `5` | agent-unavailability cycles before the task stays blocked until the owner explicitly unblocks. |

**Categories are independent.** A task whose agent adapter is briefly unavailable does
not lose any of its crash budget, and a successful pass through any phase resets both
counters. The same applies at boot — orphaned active tasks are routed through the
crash category, so a persistent boot-loop on a poison task exhausts the budget and
ends in `failed` rather than restarting forever.

## Notification Retry

When a notification cannot be delivered to a contact's channel, it is queued and retried.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notification_retry.interval_ms` | integer (ms) | `30000` (30s) | How often to retry a failed notification send. |
| `notification_retry.max_attempts` | integer | `120` | Maximum retry attempts per notification (~1 hour at 30s intervals). |
| `notification_retry.max_age_ms` | integer (ms) | `3600000` (1h) | Maximum age of a retry entry before it is discarded. |

## Notification Suppression

The Engineer drops a duplicate outbound notification — one with the same kind and scope (its task, or for a task-less health alert its origin, e.g. a specific trigger) — that it already delivered within this window. This is the single source of outbound dedup: it keeps a flapping dependency (a trigger failing every tick) from flooding you with the same alert, while the first occurrence and any distinct event always go through immediately.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notification_suppress_window_ms` | integer (ms) | `300000` (5m) | Drop a duplicate notification (same kind + scope) seen within this window. |

## Polling

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `trigger_poll_interval_ms` | integer (ms) | `30000` (30s) | Global fallback for how often the daemon polls trigger adapters. Plugins can declare their own `poll_interval_ms` on their manifest, which takes precedence. |
| `response_poll_interval_ms` | integer (ms) | `5000` (5s) | How often the daemon polls communication adapters for responses. |
| `seen_keys_ttl_ms` | integer (ms) | `86400000` (1d) | How long a seen trigger key stays in the in-memory hot-cache fast path. Performance only — durable dedup uses the task's `idempotency_key` in the database, so an event is not re-triggered while its task is still live, even after this expires. |

### Review Polling

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `review_polling.failure_window_ms` | integer (ms) | `300000` (5m) | Time window for counting review API failures before pausing. |
| `review_polling.max_failures_before_pause` | integer | `3` | Failures within the window before pausing review polling (circuit breaker). |
| `review_polling.max_blocker_reentries` | integer | `3` | Consecutive automated-blocker (merge-conflict / CI-failure) re-entries on one open PR before the task is escalated to the owner instead of reworked again. A reviewer comment or the blocker clearing resets the count. |

## Logging

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `logging.level` | `"trace"` \| `"debug"` \| `"info"` \| `"warn"` \| `"error"` \| `"fatal"` | `"info"` | Log verbosity level. |
| `logging.dir` | string | `"logs"` | Log directory. Relative paths resolve against `~/.engineer/`. |
| `logging.max_size_bytes` | integer | `524288000` (500MB) | Maximum file size per log file before rotation. |
| `logging.max_files` | integer | `7` | Maximum number of log files retained. |
| `logging.console` | boolean | `false` | Also output logs to stdout. |

## Plugins

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `plugins.dirs` | string[] | `[]` | Plugin discovery directories (auto-populated by `engineer start`). |
| `plugins.health_check_interval_ms` | integer (ms) | `60000` (1m) | How often to health-check plugins. |
| `plugins.health_check_timeout_ms` | integer (ms) | `5000` (5s) | Timeout per health check. |
| `plugins.consecutive_failures_threshold` | integer | `3` | Consecutive failures before marking a plugin as failed. |

## Data Lifecycle

The data-lifecycle manager is a daemon-resident periodic service that prunes aged rows from the local
SQLite tables, sweeps orphaned blob files, and runs an incremental vacuum. It is the local-DB sibling of
the [workspace reaper](#workspace-reaper) below — same shape, different work (pure local cleanup, no git
or network), and deliberately kept independent.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `data_lifecycle.enabled` | boolean | `true` | Enable automatic data cleanup (retention policies). |
| `data_lifecycle.interval_ms` | integer (ms) | `3600000` (1h) | How often to run retention cleanup. |
| `data_lifecycle.retention.events.max_age_days` | integer | `90` | Days to retain event records. See the retention-floor invariant below. |
| `data_lifecycle.retention.observations.max_age_days` | integer | `90` | Days to retain observation records. |
| `data_lifecycle.retention.journal_entries.max_age_days` | integer | `90` | Days to retain journal entries. |
| `data_lifecycle.retention.checkpoints.max_age_days` | integer | `90` | Days to retain checkpoint records. |

**Active-task protection.** A sweep prunes by age, but never prunes a row belonging to a task that is still
live (`queued`, `active`, `blocked`) — that task may still need its own events,
observations, journal, and checkpoints. System rows with no owning task (the cost, health, trigger, and
cleanup audit trail, stored with `task_id` NULL) and rows of terminal tasks (`completed`, `failed`,
`cancelled`) prune by age like everything else. This protection is deterministic: a system row prunes the
same way whether or not any task happens to be active at sweep time.

**Per-stage isolation.** Each stage of a sweep — each table, the blob sweep, the vacuum — is failure-isolated.
One table's error (or the blob-reference query throwing) is logged loudly and skipped; the remaining stages
still run, and the sweep still publishes its completion record. Liveness never lies: the
`system.cleanup_completed` event and the dashboard's **Data Lifecycle** card are emitted even on a mid-sweep
failure, carrying whatever stages did finish. A 0-row sweep still emits — that is the liveness signal that
the service is alive, not noise.

**Retention-floor invariant.** Keep `data_lifecycle.retention.events.max_age_days` at **31 or more**. The cost
tracker is the only component that full-replays the `events` table to rebuild its spend accumulators after a
snapshot loss, and the longest window it folds is the current calendar month — every `cost.incurred` event
back to the first of the month. On the last day of a 31-day month that span is just under 31 days, so an
`events` retention below 31 can prune this month's earlier cost events before a replay reads them, and the
rebuilt monthly total comes out short — under-enforcing the monthly cost limit. The Engineer **warns at
startup** when `events.max_age_days` is below this floor, naming that consequence. It is a warning, not a
hard-fail: the daemon still starts. Daemon config is [restart-only](#daemon-configuration) (not
hot-reloadable), so this startup check is the whole story — there is no reload path that could lower the
value at runtime.

## Workspace Reaper

The reaper performs the terminal-task cleanup that cannot happen inline: it deletes merged branches once their retention window (`pr.branch_retention_days` in [workspace.yaml](workspace.md)) elapses, and reconciles cross-process cancels. It runs from two triggers. The task-completion path invokes it eagerly, so a `branch_retention_days: 0` branch is deleted immediately on completion. An interval sweep then runs as the backstop for everything the eager path does not cover: non-zero retention windows, eager-deletion failures, and PRs merged while the daemon was down. The reaper is a daemon-resident service, separate from data lifecycle because it does git + plugin (network) work rather than pure local DB cleanup.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workspace_reaper.enabled` | boolean | `true` | Enable the reconciliation reaper. Disable only to suspend automatic branch cleanup. |
| `workspace_reaper.interval_ms` | integer (ms) | `3600000` (1h) | How often the reaper sweeps terminal tasks to reconcile their branches. |

## Database

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `database.cache_size_mb` | integer | `64` | SQLite cache size in MB. |

## Evaluation

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `evaluation.enabled` | boolean | `false` | Run an AI-as-Judge evaluation after each task completes — two independent CLI sessions (a blind plan, then a comparison verdict). Results are stored under `~/.engineer/evaluations/`. |

## Telemetry

Opt-in projection of the daemon's observation tree to an external OTLP backend (e.g. [Jaeger v2](https://www.jaegertracing.io/)) for a live flame-graph view. This is a *projection* of observations already recorded in SQLite, not new instrumentation — SQLite stays the system of record and the backend is a disposable lens. It is **off by default**, additive, and **best-effort**: a down or slow endpoint never affects a task or daemon startup.

The endpoint is a single, swappable OTLP/HTTP target. Point it at any OTLP backend by URL — that one URL is the entire integration surface. The Engineer does not download, install, or supervise the backend; you bring it (e.g. `brew install jaeger && jaeger`, the official download, or `docker run`). When telemetry is enabled but the endpoint is unreachable, the daemon still starts and prints a friendly install pointer.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `telemetry.enabled` | boolean | `false` | Export the observation tree to the OTLP backend. When off (the default), nothing is exported and the pipeline is unchanged. |
| `telemetry.endpoint` | string | `"http://localhost:4318"` | OTLP/HTTP ingest base URL of the trace backend. Spans are POSTed to `<endpoint>/v1/traces`. The default targets a local Jaeger v2. |
| `telemetry.ui_base` | string | `"http://localhost:16686"` | Web-UI base URL of the trace backend, distinct from the OTLP ingest `endpoint`. The start output and the dashboard's "View trace in Jaeger" deep-link point here. The default targets a local Jaeger v2 web UI. |

> **Data leaves the machine.** A non-localhost endpoint ships trace data — including span attributes derived from task input and output — off your machine. Keep the endpoint local unless you intend to export. Attribute values are sanitized at the export boundary, but treat any remote endpoint as a trust boundary.

## Other

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `subscriber_warn_threshold_ms` | integer (ms) | `50` | Warn if an EventBus subscriber callback exceeds this duration. `0` disables. |

## Complete Example

```yaml
max_concurrent: 1
tick_interval_ms: 5000
trigger_poll_interval_ms: 30000
response_poll_interval_ms: 5000

logging:
  level: info
  console: false

review_polling:
  failure_window_ms: 300000
  max_failures_before_pause: 3
  max_blocker_reentries: 3
```
