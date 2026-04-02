# Orchestrator Configuration

Controls the RRPIR pipeline (Requirements, Research, Planning, Implementation, Review), notifications, task decomposition, and phase management. These settings shape how The Engineer thinks and communicates.

**File:** `~/.engineer/config/orchestrator.yaml`
**Hot-reload:** No — requires daemon restart.

## RRPIR Pipeline

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `rrpir.max_requirements_loops` | integer | `5` | Maximum requirement-gathering loops before escalation. If the LLM keeps returning "need_more_info", it gives up after this many rounds. |
| `rrpir.include_thoughts_in_pr` | boolean | `true` | Include the `thoughts/` directory in PR commits. When true, RRPIR artifacts (requirements, research, planning docs) are committed for reviewer context. |
| `rrpir.review_phases` | string[] | `["requirements_check"]` | Which review sub-phases to run during self-review. Options: `"requirements_check"`, `"security_review"`, `"code_quality"`. |
| `rrpir.max_review_loopbacks` | integer | `3` | Maximum execution-to-self-review loops. If self-review keeps finding issues, it stops after this many rounds and alerts the owner. |

## Notifications

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notification.milestone_based` | boolean | `true` | Notify only on milestones (task pickup, PR created, completion), not every phase transition. |
| `notification.suppress_window_ms` | integer (ms) | `300000` (5m) | Suppress duplicate notifications within this window. |
| `notification.batch_window_ms` | integer (ms) | `120000` (2m) | Batch rapid notifications into a single message within this window. |

### Quiet Hours

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notification.quiet_hours.enabled` | boolean | `false` | Enable quiet hours (suppress non-critical notifications). |
| `notification.quiet_hours.start` | string | `"22:00"` | Quiet period start (HH:MM format). |
| `notification.quiet_hours.end` | string | `"08:00"` | Quiet period end (HH:MM format). |
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

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `question_batching.enabled` | boolean | `true` | Batch multiple questions before asking the owner, reducing interruptions. |
| `question_batching.batch_window_ms` | integer (ms) | `30000` (30s) | Wait window before sending a question batch. |
| `question_batching.max_batch_size` | integer | `5` | Maximum questions per batch. |

## Task Decomposition

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `decomposition.auto_threshold_ms` | integer (ms) | `14400000` (4h) | Auto-decompose tasks estimated longer than this. |
| `decomposition.suggest_threshold_ms` | integer (ms) | `7200000` (2h) | Suggest decomposition for tasks above this estimate. |
| `decomposition.min_child_size_ms` | integer (ms) | `1800000` (30m) | Minimum estimated duration for child tasks. |

## Demo

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `demo.always_create` | boolean | `true` | Always create a demo artifact (PR description) in the demo-prep phase. |
| `demo.tui_base_project` | string \| null | `null` | Base project for TUI demos (reserved for future use). |

## Phases

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `phases.checkpoint_on_transition` | boolean | `true` | Create a checkpoint at every phase transition for resume support. |
| `phases.periodic_checkpoint_interval_ms` | integer (ms) | `900000` (15m) | Create periodic checkpoints during long-running phases. |
| `phases.max_loopbacks_before_alert` | integer | `3` | Alert the owner if self-review loopbacks exceed this count. |

## Journal

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `journal.aggregate_file_reads` | boolean | `true` | Aggregate file-read entries in the session journal to reduce verbosity. |

## Complete Example

```yaml
rrpir:
  max_requirements_loops: 5
  include_thoughts_in_pr: true
  review_phases: [requirements_check]
  max_review_loopbacks: 3

notification:
  milestone_based: true

decomposition:
  auto_threshold_ms: 14400000
  suggest_threshold_ms: 7200000
```
