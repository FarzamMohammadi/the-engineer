# Phase 4: Trigger Polling & Task Creation — File Map & Flow

## Flow Summary

```
GitHub Issue (external)
    │
    ▼
[Daemon tick loop, step 2]
    │
    ▼
TriggerPoller.poll(now)
    │
    ▼
Registry.getPluginsByType("trigger")
    │
    ▼
GitHubTriggerPlugin.poll()          ← TriggerAdapter template method
    │
    ▼
GitHubTriggerPlugin.doPoll()        ← concrete: Octokit.issues.listForRepo()
    │
    ▼
mapIssueToEvent()                   ← builds TriggerEvent with idempotency_key
    │
    ▼
TriggerPoller dedup check           ← seenTriggerKeys Map (TTL-based)
    │
    ▼ (if new or expired)
EventBus.publish("trigger.new_event")
    │
    ▼
TaskEngine.createTask()             ← state: intake
    │
    ▼
TaskEngine.requestTransition()      ← intake → queued (reason: new_trigger_event)
    │
    ▼
basePriorities.set(task.id, priority)
    │
    ▼
[Daemon tick loop continues → step 4: TaskScheduler.scheduleNext()]
```

---

## Production Files (execution order)

| # | File | Role |
|---|------|------|
| 1 | `src/schemas/adapters.ts` | `TriggerEventSchema` — shape of a trigger event |
| 2 | `src/schemas/events.ts` | `TriggerNewEventPayloadSchema`, event types `trigger.new_event` / `trigger.pr_review` |
| 3 | `src/schemas/config.ts` | `trigger_poll_interval_ms` (30s default), `seen_keys_ttl_ms` (24h default), `consecutive_failures_threshold` (3) |
| 4 | `src/adapters/trigger.ts` | `TriggerAdapter` abstract base — `poll()` wrapper with error handling, `doPoll()` abstract |
| 5 | `src/plugins/trigger/github-trigger/config.ts` | `GitHubTriggerConfigSchema` — `github_token`, `repos[]`, `labels[]`, `poll_interval_ms` |
| 6 | `src/plugins/trigger/github-trigger/github-trigger.ts` | `GitHubTriggerPlugin` — polls GitHub issues, per-repo watermarks, idempotency keys (`github:issue:{owner}/{repo}:{number}`), error classification |
| 7 | `src/plugins/builtin.ts` | Manifest + factory for `github-trigger` (critical: true, events: `trigger.new_event`, `trigger.pr_review`) |
| 8 | `src/core/daemon/trigger-poller.ts` | `createTriggerPoller()` factory — dedup, adaptive backoff (`2^min(failures,8)`, max 5min), task creation, `health.trigger_failure` emission |
| 9 | `src/core/daemon/index.ts` | Wires TriggerPoller into tick loop (step 2: poll, step 9: cleanup expired keys), declares event topology |
| 10 | `src/cli/bootstrap.ts` | Creates Registry, loads builtin plugins including github-trigger |
| 11 | `src/cli/templates.ts` | User-facing config documentation for trigger fields |

---

## Key Behaviors

### Deduplication
- In-memory `seenTriggerKeys` Map: key = `idempotency_key`, value = expiry timestamp
- TTL = `seen_keys_ttl_ms` (default 24h)
- Expired keys cleaned in tick step 9 via `cleanupExpiredKeys(now)`

### Adaptive Backoff
- Per-plugin failure counter
- Effective interval = `baseInterval * 2^min(failures, 8)` (max 5 minutes)
- Only polls if `(now - lastPoll) >= effectiveInterval`
- Resets on successful poll

### Error Handling
- `TriggerAdapter.poll()` wraps `doPoll()` in try/catch → `AdapterMethodError`
- TriggerPoller catches per-plugin errors, increments failure count
- At `consecutive_failures_threshold` (default 3): emits `health.trigger_failure` event

### GitHub-Specific
- Filters out pull requests (`!issue.pull_request`)
- Per-repo watermarks (ISO timestamps) — only fetches issues updated since last poll
- Error classification: `auth_failed`, `rate_limited`, `network_error`, `not_found` (with retryability)

---

## Test Files

| File | Type |
|------|------|
| `src/adapters/trigger.test.ts` | Unit — adapter base class |
| `src/plugins/trigger/github-trigger/github-trigger.test.ts` | Unit — GitHub plugin |
| `src/core/daemon/trigger-poller.test.ts` | Unit — poller logic |
| `test/helpers/contract-suites/trigger-contract.ts` | Contract compliance suite |
| `test/helpers/fake-plugins/fake-trigger/` | Fake plugin for testing |
| `test/fixtures/manifests/valid-trigger.yaml` | Manifest fixture |
| `test/integration/daemon-trigger-polling.integration.test.ts` | Integration — full polling flow |
