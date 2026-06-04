# Orchestrator Configuration

`orchestrator.yaml` holds settings for the per-task pipeline's **review** phase, its **observability**, and for how The Engineer **communicates** about a task.

**File:** `~/.engineer/config/orchestrator.yaml`
**Hot-reload:** No — requires a daemon restart.

Today [`review.lenses`](#review) and [`observability.live_activity`](#observability) change behavior. The communication settings ([Notifications](#notifications), [Question Batching](#question-batching)) are validated on load but [not yet honored](#notifications) — they are reserved for the communication layer.

## Review

The Review phase runs one or more **lenses** — focused agent passes that each examine the change through a single concern (correctness, security, code quality, architecture) and write findings. Then `refine` consolidates those findings, fixes what it can directly in the code, and decides whether to ship the change, re-check it, or hand it back to an earlier phase.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `review.lenses` | string[] | `["self-review"]` | Which review lenses run before delivery. Each is a focused agent pass that writes findings; `refine` then consolidates them and fixes in place. Options: `"self-review"`, `"security"`, `"code-quality"`, `"architecture"`. |

`self-review` is the default and is usually enough. The others are opt-in for a change that warrants a dedicated pass — add the lens name to the list. Each lens is a single file under the pipeline's `review/` folder, so adding one is a small change.

## Observability

Controls how much of a task's inner work The Engineer streams to the dashboard. These knobs are additive and best-effort: turning one off only reduces what is shown — it never changes what the pipeline does, costs, or how long it takes.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `observability.live_activity` | boolean | `true` | Stream each agent run's live conversation — assistant text, thinking, tool calls and their results — to the dashboard's **Agent Calls** tab as it happens, and keep it for re-watching afterward. |

When on, an agent run is no longer a black box between prompt and result: the owner watches the agent think and act in near real time, and can replay any past run. Only agents that report `supports_activity_streaming` emit a feed; others are unaffected and fall back to the post-run transcript. The feed is **observation-only** — a slow or failing dashboard can never affect a run. Turn it off if you want a quieter trail (the `agent_call` span, with its prompt/result/transcript blobs, is still recorded either way). See the [Live Agent Activity](../contribution-docs/how-tos/observability.md#live-agent-activity) how-to for the mechanics.

## Notifications

> **Validated but not yet honored.** Notifications are delivered today, but these tuning settings do not yet take effect — notification policy is currently fixed. They are reserved for the communication layer.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notification.milestone_based` | boolean | `true` | Notify only on milestones (task pickup, PR created, completion), not every phase transition. |
| `notification.suppress_window_ms` | integer (ms) | `300000` (5m) | Suppress duplicate notifications within this window. |
| `notification.batch_window_ms` | integer (ms) | `120000` (2m) | Batch rapid notifications into a single message within this window. |

### Quiet Hours

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notification.quiet_hours.enabled` | boolean | `false` | Enable quiet hours (suppress non-critical notifications). |
| `notification.quiet_hours.start` | string | `"22:00"` | Quiet period start (HH:MM). |
| `notification.quiet_hours.end` | string | `"08:00"` | Quiet period end (HH:MM). |
| `notification.quiet_hours.timezone` | string | `"UTC"` | IANA timezone identifier (e.g., `"America/New_York"`). |
| `notification.quiet_hours.allow_alerts` | boolean | `true` | Allow critical alerts even during quiet hours. |

### Digest

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notification.digest.enabled` | boolean | `false` | Enable periodic digest summaries. |
| `notification.digest.schedule` | string | `"0 9 * * *"` | Cron schedule for digest delivery (default: 9 AM daily). |
| `notification.digest.channel` | string | `"telegram"` | Delivery channel for digests. |
| `notification.digest.include` | string[] | `["completed", "blocked", "failed"]` | Task states to include in the digest. |

## Question Batching

> **Validated but not yet honored** — reserved for the communication layer.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `question_batching.enabled` | boolean | `true` | Batch multiple questions before asking the owner, reducing interruptions. |
| `question_batching.batch_window_ms` | integer (ms) | `30000` (30s) | Wait window before sending a question batch. |
| `question_batching.max_batch_size` | integer | `5` | Maximum questions per batch. |

## Example

```yaml
review:
  lenses: [self-review]   # add "security", "code-quality", and/or "architecture" for deeper passes

observability:
  live_activity: true     # stream each agent run's live conversation to the dashboard (default: true)
```
