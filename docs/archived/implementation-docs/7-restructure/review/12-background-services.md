# Phase 12: Background Services

These services run continuously alongside the main task lifecycle. They're periodic, event-driven, or always-on.

---

## Three Background Services

```
┌─────────────────────────────────────────────────────────┐
│ Data Lifecycle Manager (periodic, e.g., every 4 hours)   │
│   → Retention cleanup for 6 tables                       │
│   → Blob orphan cleanup                                  │
│   → Incremental vacuum                                   │
├─────────────────────────────────────────────────────────┤
│ Cost Tracking (event-driven, continuous)                  │
│   → Subscribes to cost.incurred events                   │
│   → Accumulates per-task / daily / monthly               │
│   → Emits cost.limit_reached on breach                   │
│   → Snapshots to _meta table (crash-safe)                │
├─────────────────────────────────────────────────────────┤
│ Registry Health Checks (periodic, every 60 seconds)      │
│   → Calls healthCheck() on each plugin                   │
│   → State machine: healthy → unhealthy → failed          │
│   → Emits health events for observability                │
└─────────────────────────────────────────────────────────┘
```

---

## Production Files

| # | File | Role |
|---|------|------|
| 1 | `src/core/data-lifecycle/index.ts` | Retention cleanup, blob pruning, vacuum |
| 2 | `src/core/safety-layer/cost-tracker.ts` | Cost accumulation, limit detection, snapshots |
| 3 | `src/core/registry/health.ts` | Plugin health state machine |
| 4 | `src/core/daemon/health-monitor.ts` | Cost limit processing (tick step 1) |

---

## Data Lifecycle Manager

### Cleanup Flow

```
runCleanup()
    ├─ For each managed table:
    │   └─ cleanupTable(db, table, timestampCol, maxCount, cutoffISO, excludeActive)
    │       ├─ DELETE WHERE timestamp < cutoff [AND task_id NOT IN active tasks]
    │       └─ DELETE WHERE rowid NOT IN (top N by timestamp DESC)
    ├─ Blob orphan cleanup:
    │   ├─ collectReferencedBlobRefs(db)  ← from llm_traces
    │   └─ cleanupOrphanedBlobs(blobsDir, refs)
    │       ├─ Walk blobs/{prefix}/ directories
    │       └─ Delete unreferenced blob files
    ├─ runIncrementalVacuum(db)  [if configured]
    └─ Emit system.cleanup_completed
```

### 6 Managed Tables

| Table | TTL Config Key | Exclude Active Tasks | Timestamp Column |
|-------|---------------|---------------------|-----------------|
| `events` | events | no | timestamp |
| `action_traces` | action_traces | no | timestamp |
| `phase_metrics` | phase_metrics | no | started_at |
| `llm_traces` | llm_traces | no | timestamp |
| `journal_entries` | journal_entries | **yes** | timestamp |
| `checkpoints` | checkpoints | **yes** | timestamp |

Active task states (never pruned): intake, queued, active, blocked, review_pending

### Configuration

```typescript
data_lifecycle: {
  enabled: boolean,
  interval_ms: number,        // default: 4 hours
  vacuum_on_cleanup: boolean,
  retention: {
    [table]: {
      max_age_days: number,
      max_count?: number
    }
  }
}
```

---

## Cost Tracking

### Accumulation Flow

```
EventBus subscription: cost.incurred
    │
    ▼
CostTracker.onCostEvent(payload)
    ├─ Update per-task accumulator
    ├─ Update daily window accumulator (auto-rollover at midnight UTC)
    ├─ Update monthly window accumulator (auto-rollover at month start)
    ├─ Save snapshot to _meta table (crash-safe)
    └─ checkCostLimits(taskId)
        ├─ Per-task limit breached?
        ├─ Daily limit breached?
        ├─ Monthly limit breached?
        └─ If any: emit cost.limit_reached
```

### Cost Limit Processing

`processCostLimits()` — tick step 1:

1. Drain `costLimitTasks` queue (FIFO)
2. For each task: transition `active → blocked` ("cost_limit_reached")
3. Send Telegram notification + GitHub issue comment

### Startup Recovery

1. `restoreFromSnapshot()` — load accumulator state from `_meta` table
2. `replayEvents()` — replay any `cost.incurred` events since last snapshot
3. Ensures no cost tracking gaps after crash

### Warning Threshold

At 80% of any limit: `getCostStatus()` returns warnings array (for human visibility).

---

## Registry Health Checks

### Health Check Loop

```
Every 60 seconds:
    healthCheckAll()
        └─ For each plugin:
            ├─ await withTimeout(plugin.healthCheck(), 5000ms)
            └─ Update state machine
```

### State Machine

```
healthy ──(first failure)──→ unhealthy
unhealthy ──(3+ consecutive failures)──→ failed
unhealthy/failed ──(successful check)──→ healthy
```

### Events

| Event | When |
|-------|------|
| `health.plugin_unhealthy` | First failure (healthy → unhealthy) |
| `health.plugin_failed` | Consecutive failures exceed threshold |
| `health.plugin_recovered` | Success after failure state |

### Configuration

| Setting | Default |
|---------|---------|
| `healthCheckIntervalMs` | 60,000 (60s) |
| `healthCheckTimeoutMs` | 5,000 (5s) |
| `consecutiveFailuresThreshold` | 3 |

---

## Lifecycle Integration

| Service | Started By | Stopped By |
|---------|-----------|-----------|
| Data Lifecycle | `daemon.start()` → `dataLifecycleManager.start()` | `daemon.stop()` → `dataLifecycleManager.stop()` |
| Cost Tracking | Bootstrap → SafetyLayer constructor (EventBus subscription) | Implicit (EventBus unsubscribe on shutdown) |
| Registry Health | `daemon.start()` → `registry.startHealthCheckLoop()` | `daemon.stop()` → `registry.stopHealthCheckLoop()` |

---

## Test Files

| File | Type |
|------|------|
| `src/core/data-lifecycle/index.test.ts` | Unit — cleanup, blob pruning |
| `src/core/safety-layer/cost-tracker.test.ts` | Unit — accumulation, limits |
| `src/core/registry/health.test.ts` | Unit — health state machine |
| `src/core/daemon/health-monitor.test.ts` | Unit — cost limit processing |
