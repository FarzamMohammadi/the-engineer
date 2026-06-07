# Safety Configuration

Controls cost limits, scope boundaries, autonomy levels, response timeouts, and merge policy. This is the guardrail layer — it determines what The Engineer is allowed to do, how much it can spend, and how PRs are approved and merged.

**File:** `~/.engineer/config/safety.yaml`
**Hot-reload:** No — requires daemon restart.

## Cost Limits

Set spending caps to prevent runaway costs. Warnings fire at 80% of each limit. On a breach The Engineer terminates the offending in-flight task and tells the owner: a per-task or per-provider breach blocks that one task and DMs you about it, while a global daily or monthly breach terminates every in-flight task with a single alert. See [Safety in the README](https://github.com/FarzamMohammadi/the-engineer/blob/main/README.md#safety) for the full behavior.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cost_limits.per_task.cost_usd` | number \| null | `null` | USD limit per task. `null` = unlimited. |
| `cost_limits.daily.cost_usd` | number \| null | `null` | USD limit per day (resets at UTC midnight). |
| `cost_limits.monthly.cost_usd` | number \| null | `null` | USD limit per month (resets on the 1st). |
| `cost_limits.providers.<id>.daily_requests` | integer \| null | `null` | Per-provider request cap per day (resets at UTC midnight, same as `daily.cost_usd`). Key is the plugin ID (e.g., `claude-code-agent`). |

```yaml
cost_limits:
  per_task:
    cost_usd: 5.00
  daily:
    cost_usd: 50.00
  monthly:
    cost_usd: 500.00
```

Daily windows (`daily.cost_usd` and every provider's `daily_requests`) reset at the UTC day boundary.
The reset is applied lazily: it takes effect when the first cost event of the new day arrives, not at
exactly 00:00:00. A provider that hit its `daily_requests` cap yesterday is usable again on the new day's
first request. This is restart-safe — a daemon that boots after midnight does not carry yesterday's counts
into today's window.

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

Control how much decision-making authority The Engineer has per category of **discretionary** decision.

### How it works

While running a task, the agent makes calls it *could* make alone but that you might want to weigh in
on — renaming a public function, adding a dependency, touching auth. The agent does not gate itself on
these: it makes the call, then **surfaces** it (a category, what it chose, and why). The orchestrator
consults the policy below per surfaced decision:

- **`always_decide`** — the agent proceeds; nothing is asked.
- **`always_ask`** — the task pauses and asks you before continuing.
- **`threshold`** — the task asks only when the decision's size crosses a limit (e.g. `files > 5`); the
  agent reports the measured number with the decision. If the number is missing, the task asks (fail-safe).

This is separate from a **hard block** (the agent reporting `needs_human` because it genuinely cannot
proceed). Autonomy governs choices the agent *can* make; a hard block is for choices it *cannot*.

### What happens when it asks

When the policy escalates a decision, the task **pauses and reaches out to the owner** with the
question — what the agent decided, why, and the choice it is asking you to confirm. This works from
**any** phase, not just requirements: a discretionary decision surfaced during research, planning,
execution, review, or delivery delivers its question the same way. When you answer, the task resumes
**where it asked**, with your reply carried into the agent's context as authoritative — so it acts on
your decision rather than re-deriving it.

A paused discretionary decision is a distinct kind of block (`awaiting_human_decision`) from a hard
block (`awaiting_human`). The difference matters for one behavior: the daemon's [self-unblock
check](#response-timeouts) never auto-resolves a discretionary decision, because only you can make that
call. Reminders and the final escalation still fire — you are still nudged and, if you never answer,
the task eventually escalates — but the engine will not decide it for you.

### When no owner is configured

If the policy says to ask but no owner is configured (see [people configuration](people.md)), the
engine cannot pause forever waiting for an answer that can never come. So it **proceeds with the
agent's call** and records a loud decision in the trace naming exactly what it decided without you. The
fix is to configure an owner so these decisions reach you; until then, the autonomy policy degrades to
"the agent decides, visibly" rather than stranding the task.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autonomy.decisions.<category>.level` | `"always_ask"` \| `"threshold"` \| `"always_decide"` | `"always_ask"` | Autonomy level for this decision category. |
| `autonomy.decisions.<category>.threshold` | string \| null | `null` | Threshold expression (e.g., `"files > 5"`). Only used with `threshold` level. |
| `autonomy.decisions.<category>.description` | string | `""` | Human-readable explanation of the rule. |
| `autonomy.repo_overrides.<pattern>.decisions` | object | `{}` | Per-repo overrides (glob patterns). |

### Default categories

Categories are free-form strings — you can add your own — but The Engineer teaches the agent a known
vocabulary and ships a curated policy for it. **Any category not listed (yours or the agent's) resolves
to `always_ask`**, so an unfamiliar decision always reaches you.

| Category | Default level | What it covers |
|----------|---------------|----------------|
| `code_style` | `always_decide` | Formatting and naming within touched code |
| `test_coverage` | `always_decide` | How much to test the change |
| `refactoring_local` | `always_decide` | Refactors confined to the code being changed |
| `doc_wording` | `always_decide` | Wording of docs and comments |
| `scope_expansion` | `threshold` (`files > 5`) | Touching files beyond the task's core |
| `refactoring_broad` | `threshold` (`files > 5`) | Refactors spanning many files |
| `architecture` | `always_ask` | Structural or design changes |
| `dependencies` | `always_ask` | Adding, removing, or upgrading dependencies |
| `public_api` | `always_ask` | Changing a public interface or contract |
| `destructive` | `always_ask` | Deleting data, files, or history |
| `security` | `always_ask` | Anything touching auth, secrets, or permissions |

These defaults apply with no `safety.yaml` at all. Override any category to widen or tighten the agent's
latitude:

```yaml
autonomy:
  decisions:
    dependencies:
      level: always_decide        # trust the agent to manage dependencies
      description: "Internal repo — dependency churn is low-risk here"
    scope_expansion:
      level: threshold
      threshold: "files > 10"     # allow a wider blast radius before asking
```

## Response Timeouts

Configure escalation timing for blocked tasks. The `blocked` stages apply when a task is waiting on a human (for example, an unanswered requirements question); the `review_pending` settings apply when a task is waiting on an open pull request's review (blocked with reason `pr_review_pending`).

### Blocked Tasks

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `response_timeout.blocked.stages` | TimeoutStage[] | 3 stages (see below) | Escalation stages for blocked tasks. |

Default stages:
1. **reminder** — after 4h, send reminder, repeat every 4h
2. **self_unblock_check** — after 8h, evaluate self-unblock, no repeat. Skipped for a discretionary
   [autonomy decision](#what-happens-when-it-asks) block — only the owner can decide that, so the engine
   never auto-resolves it (the reminder and escalation stages still apply).
3. **escalation** — after 2d, escalation alert, no repeat

Each stage has: `name`, `after_ms`, `action` (`send_reminder` | `evaluate_self_unblock` | `escalation_alert`), `repeat`, `repeat_interval_ms`.

### Review Pending Tasks

Reminder cadence for a task that has opened a pull request and is waiting on its review.

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
| `merge.enable_comment_approval` | boolean | `false` | Allow a `/approve` or `/approved` PR comment to count as an approval. Designed for a solo developer who cannot formally approve their own PR on GitHub. When on, an authorized `/approve` on a green, mergeable PR triggers the merge; with it off (the default), `/approve` comments are ignored. Authorization: when an owner or reviewer is configured, the commenter's github handle must match one of them; when no one is configured, any `/approve` counts. |
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
