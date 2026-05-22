# Safety Configuration

Controls cost limits, scope boundaries, autonomy levels, response timeouts, and merge policy. This is the guardrail layer — it determines what The Engineer is allowed to do, how much it can spend, and how PRs are approved and merged.

**File:** `~/.engineer/config/safety.yaml`
**Hot-reload:** No — requires daemon restart.

## Cost Limits

Set spending caps to prevent runaway costs. Warnings fire at 80% of each limit. Actions are denied when a limit is breached.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cost_limits.per_task.cost_usd` | number \| null | `null` | USD limit per task. `null` = unlimited. |
| `cost_limits.daily.cost_usd` | number \| null | `null` | USD limit per day (resets at UTC midnight). |
| `cost_limits.monthly.cost_usd` | number \| null | `null` | USD limit per month (resets on the 1st). |
| `cost_limits.providers.<id>.daily_requests` | integer \| null | `null` | Per-provider daily request cap. Key is the plugin ID (e.g., `claude-code-llm`). |

```yaml
cost_limits:
  per_task:
    cost_usd: 5.00
  daily:
    cost_usd: 50.00
  monthly:
    cost_usd: 500.00
```

## Scope Boundaries

Define what repos, branches, files, and domains The Engineer can interact with.

### Repos

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `scope.repos.allowed` | string[] \| null | `null` | Allowed repository names. `null` = all repos allowed. |

### Branches

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `scope.branches.create_pattern` | string (regex) | `"engineer/.*"` | Regex pattern for branch names The Engineer can create. |
| `scope.branches.push_to` | string[] (globs) | `["engineer/*"]` | Branch patterns The Engineer can push to. |
| `scope.branches.merge_to` | string[] (globs) | `["main"]` | Branch patterns The Engineer can merge into. |

### Files

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `scope.files.exclude_patterns` | string[] (globs) | `[".env*", "secrets/**", "*.pem", "*.key"]` | Files The Engineer must never touch. |

### External

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `scope.external.allowed_domains` | string[] \| null | `null` | Allowed external domains for API calls. `null` = all. |

```yaml
scope:
  branches:
    create_pattern: "engineer/.*"
    push_to: ["engineer/*"]
    merge_to: ["main"]
  files:
    exclude_patterns:
      - ".env*"
      - "secrets/**"
      - "*.pem"
      - "*.key"
```

## Autonomy

Control how much decision-making authority The Engineer has per category.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autonomy.decisions.<category>.level` | `"always_ask"` \| `"threshold"` \| `"always_decide"` | `"always_ask"` | Autonomy level for this decision category. |
| `autonomy.decisions.<category>.threshold` | string \| null | `null` | Threshold expression (e.g., `"scope > 5"`). Only used with `threshold` level. |
| `autonomy.decisions.<category>.description` | string | `""` | Human-readable explanation of the rule. |
| `autonomy.repo_overrides.<pattern>.decisions` | object | `{}` | Per-repo overrides (glob patterns). |

Categories are free-form strings (e.g., `code_style`, `architecture`, `dependencies`). Unknown categories default to `always_ask`.

```yaml
autonomy:
  decisions:
    code_style:
      level: always_decide
      description: "Trust formatting and naming decisions"
    architecture:
      level: always_ask
      description: "Always confirm structural changes"
```

## Response Timeouts

Configure escalation stages for blocked and review-pending tasks.

### Blocked Tasks

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `response_timeout.blocked.stages` | TimeoutStage[] | 3 stages (see below) | Escalation stages for blocked tasks. |

Default stages:
1. **reminder** — after 4h, send reminder, repeat every 4h
2. **self_unblock_check** — after 8h, evaluate self-unblock, no repeat
3. **escalation** — after 2d, escalation alert, no repeat

Each stage has: `name`, `after_ms`, `action` (`send_reminder` | `evaluate_self_unblock` | `escalation_alert`), `repeat`, `repeat_interval_ms`.

### Review Pending Tasks

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `response_timeout.review_pending.reminder_after_ms` | integer (ms) | `86400000` (1d) | Time before first review reminder. |
| `response_timeout.review_pending.repeat_interval_ms` | integer (ms) | `86400000` (1d) | Interval between repeated review reminders. |

## Merge Policy

Controls PR approval and merge behavior.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `merge.auto_merge_after_approval.default` | boolean | `false` | Auto-merge PRs after approval (global default). |
| `merge.auto_merge_after_approval.repos` | Record<string, boolean> | `{}` | Per-repo overrides (e.g., `"owner/repo": true`). |
| `merge.enable_comment_approval` | boolean | `false` | Allow `/approve` or `/approved` PR comments as approval signals. Designed for solo developers who cannot formally approve their own PRs on GitHub. The commenter must be authorized in People Directory (github handle match). |
| `merge.exclude_thoughts_on_merge` | boolean | `false` | Remove branch-introduced `thoughts/` files before merge. Thoughts remain in PR history for reviewer context but do not land in the target branch. Only files added by the branch are removed — pre-existing thoughts are untouched. |

```yaml
merge:
  auto_merge_after_approval:
    default: false
    repos:
      owner/internal-docs: true
  enable_comment_approval: true
  exclude_thoughts_on_merge: true
```

## Complete Example

```yaml
cost_limits:
  per_task:
    cost_usd: 5.00
  daily:
    cost_usd: 50.00

scope:
  branches:
    create_pattern: "engineer/.*"
    push_to: ["engineer/*"]
    merge_to: ["main"]
  files:
    exclude_patterns:
      - ".env*"
      - "secrets/**"

merge:
  auto_merge_after_approval:
    default: false
  enable_comment_approval: true
  exclude_thoughts_on_merge: true
```
