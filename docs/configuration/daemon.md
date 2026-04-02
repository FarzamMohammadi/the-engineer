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
| `preemption_threshold` | integer | `20` | Minimum priority gap to trigger preemption. A p70 task preempts a p50 task (gap=20) but not a p55 task (gap=15). |
| `preemption_timeout_ms` | integer (ms) | `60000` | Grace period for a preempted task to checkpoint before forced swap. |

## Stuck Detection

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `stuck_threshold_ms` | integer (ms) | `1800000` (30m) | Duration of no progress after which a task is flagged as stuck. |
| `max_active_duration_ms` | integer (ms) | `28800000` (8h) | Hard cap on total wall-clock time a task can remain active. |
| `shutdown_timeout_ms` | integer (ms) | `30000` (30s) | Time to wait for active tasks to checkpoint during graceful shutdown. |

## Polling

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `trigger_poll_interval_ms` | integer (ms) | `30000` (30s) | How often the daemon polls trigger adapters for new work. |
| `response_poll_interval_ms` | integer (ms) | `5000` (5s) | How often the daemon polls communication adapters for responses. |
| `seen_keys_ttl_ms` | integer (ms) | `86400000` (1d) | How long trigger dedup keys are remembered. Events older than this may re-trigger. |

### Review Polling

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `review_polling.failure_window_ms` | integer (ms) | `300000` (5m) | Time window for counting review API failures before pausing. |
| `review_polling.max_failures_before_pause` | integer | `3` | Failures within the window before pausing review polling (circuit breaker). |

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

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `data_lifecycle.enabled` | boolean | `true` | Enable automatic data cleanup (retention policies). |
| `data_lifecycle.interval_ms` | integer (ms) | `3600000` (1h) | How often to run retention cleanup. |
| `data_lifecycle.retention.events.max_age_days` | integer | `90` | Days to retain event records. |
| `data_lifecycle.retention.observations.max_age_days` | integer | `90` | Days to retain observation records. |
| `data_lifecycle.retention.journal_entries.max_age_days` | integer | `90` | Days to retain journal entries. |
| `data_lifecycle.retention.checkpoints.max_age_days` | integer | `90` | Days to retain checkpoint records. |

## Database

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `database.cache_size_mb` | integer | `64` | SQLite cache size in MB. |

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
```
