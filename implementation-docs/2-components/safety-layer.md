# Safety Layer -- Layer 2 Design

The Safety Layer is the policy enforcement authority for the system. It defines what the agent is allowed to do (scope, cost, autonomy) and enforces those boundaries through two complementary modes. It does not own task state (Task Engine), phase permissions (Task Engine permission table), or timeout execution (Daemon). It owns the policies that other components enforce.

Part of **Layer 2** -- see [`layers.md`](../layers.md). Resolves gaps: #5, #17, #19.

> **Layer 3 Update (Decision #42 — Action Pipeline):** The "Active Interceptor" section below describes the original Event Bus pre-processing model. In Layer 3, this was replaced by Gate 2 in the Action Pipeline — the Safety Layer is now called as a pipeline gate before action execution, not as an Event Bus pre-processor. The Safety Layer's role is unchanged (stateless policy evaluator), but the mechanism is different. See [`event-catalog.md`](../3-interactions/event-catalog.md) § Action Pipeline.

---

## Proven Systems

The Safety Layer derives from three proven patterns:

| Proven system | What we take | Applied as |
|---------------|-------------|------------|
| **SELinux / AppArmor** | Mandatory access control -- policy profiles evaluated per-operation, loaded at boot, deny-by-default for dangerous operations | Safety profiles loaded from config, evaluated per-action. Stateless policy evaluation -- does not query other components for state. |
| **Cloud IAM (AWS/GCP)** | Policy documents with conditions, resource scoping, composable policies. Multiple policies evaluated, most restrictive wins. | Autonomy boundary policies with conditions and scope. Per-repo overrides compose with global config -- most restrictive wins. |
| **Circuit breaker (Hystrix)** | Track accumulation against a threshold. Trip when exceeded. Reset on new window. | Cost tracking accumulators that trip (block further spending) when limits are reached. Reset on new time window or budget increase. |

**Key insight from proven systems:** These are **stateless evaluators with externally-provided state.** SELinux doesn't query the filesystem to learn about processes -- the kernel provides process context. The Safety Layer doesn't query the Task Engine for cost data. Cost data flows to it via Event Bus events, and it accumulates internally.

---

## What the Safety Layer Owns (and Doesn't)

| Concern | Owner | Why |
|---------|-------|-----|
| **Policy configuration** | Safety Layer | Single source of truth for all safety policies |
| **Cost accumulators** (cross-task aggregates) | Safety Layer | Built from Event Bus events, not queried from Task Engine |
| **Scope boundary definitions** | Safety Layer | Where the agent can operate |
| **Autonomy boundary definitions** | Safety Layer | What the agent can decide alone |
| **Response timeout policy** | Safety Layer | Stage definitions, thresholds, actions |
| **Active event interception** | Safety Layer | Pre-processing hook on Event Bus |
| Per-task cost tracking | Task Engine | On the Task object (`cost` field) |
| Phase permission table | Task Engine | State+sub-state -> action class mapping |
| Timeout timer execution | Daemon | Reads thresholds from Safety config, runs timers |
| Timeout action execution | Orchestrator + Comm plugins | Sends reminders, evaluates self-unblock |

The boundary: Task Engine answers "is this action legal in this phase?" Safety Layer answers "is this action within policy?" Both must agree -- the **two-gate model**.

---

## Dual Mode

### Active Interceptor (Hard Limits)

The Safety Layer subscribes to the Event Bus with a **pre-processing hook** -- it gets first look at specific event types before they're delivered to other subscribers.

**Interception flow:**

```
EventBus.publish(event):
  1. Safety Layer pre-process:
     verdict = SafetyLayer.intercept(event)
     if verdict.vetoed:
       event.status = "vetoed"
       event.veto_reason = verdict.reason
       log(event)              // still logged for audit trail
       return                  // event NOT delivered to subscribers
  2. Deliver to subscribers (normal flow)
```

**Events the Safety Layer intercepts:**

| Event type | What Safety checks |
|-----------|-------------------|
| `action.requested` | Scope check (file, branch, repo) |
| `cost.incurred` | Cost accumulator update + limit check |
| `git.push` | Branch policy check |
| `git.merge` | Merge policy check (auto-merge config) |
| `deploy.requested` | Deployment policy check |

**Events the Safety Layer does NOT intercept:**
- `task.state_changed` -- Task Engine's domain
- `journal.entry_added` -- Session/Memory's domain
- `trigger.new_event` -- Daemon's domain
- Internal scheduling events

**Rules:**
- The Safety Layer can only **veto**, never modify events
- Vetoed events are still logged -- the audit trail must show what was attempted AND blocked
- Interception is synchronous -- the event waits for the verdict before proceeding

### Passive Consultation (Judgment Calls)

The Orchestrator explicitly asks the Safety Layer before acting on decisions that require policy evaluation.

**Query interface:**

```
SafetyQuery {
  type:          "can_i" | "should_i_ask" | "cost_check"

  context: {
    task_id:            string
    repo:               string
    action_class:       string?         (for can_i: "write", "git-remote", etc.)
    decision_category:  string?         (for should_i_ask: "architectural", "refactoring", etc.)
    details:            object          (action-specific context)
  }
}
```

**Three query types:**

| Type | Question being asked | Example |
|------|---------------------|---------|
| `can_i` | "Is this action within policy?" | "Can I push to branch `engineer/dark-mode`?" |
| `should_i_ask` | "Should I ask a human about this decision?" | "Should I ask about this refactoring? (12 files)" |
| `cost_check` | "Am I near any cost limits?" | "Cost status for task #47" |

**Verdict:**

```
SafetyVerdict {
  allowed:     boolean
  action:      "proceed" | "ask_human" | "deny"
  reason:      string                    (human-readable explanation)
  warnings:    string[]?                 (non-blocking: "approaching cost limit")
}
```

Three possible outcomes -- richer than binary allow/deny:
- **proceed** -- go ahead
- **ask_human** -- you need human approval first (autonomy boundary)
- **deny** -- policy violation, cannot proceed regardless

**Examples:**

```
Query:   can_i push to branch "engineer/dark-mode"?
Verdict: { allowed: true, action: "proceed", reason: "branch matches create_pattern" }

Query:   should_i_ask about refactoring? (12 files affected)
Verdict: { allowed: false, action: "ask_human", reason: "refactoring scope (12 files) exceeds threshold (5)" }

Query:   cost_check for task #47
Verdict: { allowed: true, action: "proceed", warnings: ["task #47 at 72% of per-task cost limit"] }
```

---

## Cost Tracking (Gap #5 -- Resolved)

### Two LLM Provider Models

The Engineer can be powered by different LLM sources with fundamentally different cost semantics. The Safety Layer accommodates both.

| Provider model | Examples | What's tracked | Limit source | Enforcement |
|---------------|----------|---------------|-------------|-------------|
| **CLI-based** | Claude Code, Gemini CLI, Codex | Usage against subscription (requests, tokens, time windows) | Subscription plan | Stop when limit hit, report when limits reset |
| **API-based** | OpenRouter, Google API key, OpenAI API | Dollar spend per token/request | User-defined budget | Stop at budget, enforce per daily/monthly windows |

**Why two models:** Many users will run The Engineer using CLI tools they already have subscriptions for. These have rate limits and daily caps imposed by the provider -- not dollar budgets the user sets. API-based providers are the opposite: no subscription cap, but every token costs money. The Safety Layer must handle both.

### Cost Events

The Orchestrator (via the LLM provider plugin) emits a `cost.incurred` event after every cost-bearing operation:

```
CostEvent {
  task_id:        string
  repo:           string
  provider_type:  "cli" | "api"
  provider_id:    string            (e.g., "claude-code", "openrouter")
  timestamp:      datetime

  -- CLI-specific --
  usage: {
    requests:     number?           (number of requests consumed)
    tokens:       number?           (tokens consumed against subscription)
    window:       string?           (which limit window: "daily", "hourly", etc.)
    remaining:    number?           (remaining in window, if provider reports it)
    resets_at:    datetime?         (when the limit resets, if provider reports it)
  }?

  -- API-specific --
  spend: {
    tokens_in:    number
    tokens_out:   number
    cost_usd:     number            (actual dollar cost of this operation)
  }?

  -- Common --
  operation:      string            (what caused it: "llm_call", "embedding", etc.)
}
```

### Cost Accumulators

The Safety Layer maintains internal accumulators, updated by subscribing to `cost.incurred` events on the Event Bus:

```
CostAccumulators {
  -- API-based tracking (dollar spend) --
  api_spend: {
    per_task:   { [task_id]: { cost_usd: number } }
    daily:      { cost_usd: number, window_start: datetime }
    monthly:    { cost_usd: number, window_start: datetime }
    global:     { cost_usd: number }
  }

  -- CLI-based tracking (usage against limits) --
  cli_usage: {
    [provider_id]: {
      requests_used:   number
      tokens_used:     number
      last_known_remaining: number?
      last_known_reset: datetime?
    }
  }
}
```

**Ephemerality:** Cost accumulators are ephemeral -- reconstructable from Event Bus history on restart. On startup, the Safety Layer replays `cost.incurred` events within the relevant windows to rebuild accumulators. This follows the same pattern as the Daemon's ephemeral state.

### Cost Limit Configuration

```
cost_limits: {
  -- API-based limits (user-defined budgets) --
  api: {
    per_task: {
      cost_usd:       number?         (default: null -- no per-task limit)
      auto_resume_on_reset: boolean   (default: false -- Decision #49)
    }
    daily: {
      cost_usd:       number?         (default: null)
      auto_resume_on_reset: boolean   (default: false)
    }
    monthly: {
      cost_usd:       number?         (default: null)
      auto_resume_on_reset: boolean   (default: false)
    }
  }

  -- CLI-based limits (subscription awareness) --
  cli: {
    [provider_id]: {
      daily_requests:  number?        (manual cap if provider doesn't report limits)
      daily_tokens:    number?        (manual cap)
      auto_resume_on_reset: boolean   (default: false)
      // When the CLI tool itself reports rate limiting or exhaustion,
      // the Safety Layer respects it regardless of these settings
    }
  }
}
```

### Cost Enforcement

**Simple rule: when a limit is reached, stop.**

No graduated wind-down, no warning thresholds, no buffer percentages. When the limit is hit:

1. The active interceptor vetoes further `cost.incurred` events
2. The Orchestrator receives the veto (or a `cost.limit_reached` event)
3. The Orchestrator checkpoints current state (Session/Memory)
4. The task transitions to Blocked (reason: "cost limit reached")
5. The human is notified with: what limit was hit, current spend, and when limits reset (if CLI-based)

**For CLI-based providers:** The CLI tool itself may report rate limiting or exhaustion. The LLM provider plugin detects this and emits a `cost.incurred` event with `remaining: 0` and `resets_at`. The Safety Layer records this and blocks further operations until the reset time.

**For API-based providers:** The Safety Layer compares accumulated spend against configured budgets. When `accumulated >= budget`, stop.

**No hardcoded limits.** All limits are configurable, including setting them to null (unlimited). A user who trusts the agent and has budget can remove all cost limits. The system serves the user, not the other way around.

---

## Scope Boundaries

Scope defines WHERE the agent can operate. Separate from autonomy (WHAT decisions it can make).

### Scope Dimensions

```
scope: {
  repos: {
    allowed:          string[]?       (e.g., ["owner/repo-a", "owner/repo-b"])
    // null = unrestricted (agent works on any repo it receives triggers for)
  }

  branches: {
    create_pattern:   string          (regex for branch names, default: "engineer/.*")
    push_to:          string[]        (branches agent can push to, default: ["engineer/*"])
    merge_to:         string[]        (branches agent can merge into via approved PR, default: ["main"])
    // Direct push to main/master is never in push_to by default
  }

  files: {
    exclude_patterns: string[]        (glob patterns, default: [".env*", "secrets/**", "*.pem", "*.key"])
    // Everything not excluded is allowed. No include patterns -- deny-list, not allow-list.
  }

  external: {
    allowed_domains:  string[]?       (domains for HTTP requests, null = unrestricted)
    // For web search, API calls, documentation fetching
  }
}
```

### Scope Enforcement

- **Active interceptor:** Events implying out-of-scope operations (push to protected branch, modify excluded file) are vetoed on the Event Bus
- **Passive consultation:** Orchestrator asks "can I modify this file?" before attempting -- faster feedback than waiting for the veto

**Design principle: deny-by-default for dangerous operations, allow-by-default for safe operations.** Writing to `.env` files is blocked unless the user explicitly removes the exclusion. Reading files is allowed unless explicitly denied.

---

## Autonomy Boundaries (Gap #19 -- Resolved)

### The Problem

When the Engineer faces a decision (e.g., "should I refactor to CSS variables or keep inline styles?"), some decisions it should make on its own and some it should ask about. The autonomy boundary config defines this line.

### Decision Categories

Configurable categories, each mapped to an autonomy level. These are sensible defaults -- users add, remove, or modify freely:

| Category | Default level | What it covers |
|----------|--------------|---------------|
| `code_style` | always_decide | Formatting, naming, patterns that follow repo conventions |
| `testing_strategy` | always_decide | What tests to write, how to test, test structure |
| `error_handling` | always_decide | How to handle errors -- engineering judgment |
| `refactoring` | threshold | Code restructuring. Ask if scope > N files (configurable) |
| `data_model` | threshold | Schema changes. Ask for new tables, column removal |
| `architectural` | always_ask | Module boundaries, API surface changes, system design |
| `dependency_changes` | always_ask | Adding, removing, or upgrading dependencies |
| `breaking_changes` | always_ask | Any change that breaks existing contracts |
| `external_api` | always_ask | Calling external APIs the codebase doesn't already use |
| `deployment_config` | always_ask | Changes to deployment, CI/CD, infrastructure config |
| `task_decomposition` | always_ask | Splitting a task into sub-tasks. See `orchestrator.md` § Decomposition Decision and Approval |

### Three Autonomy Levels

| Level | Meaning | When to use |
|-------|---------|-------------|
| `always_decide` | Agent has full authority, no need to ask | Low-risk: code style, test strategy, error handling |
| `threshold` | Agent decides unless a condition is met, then asks | Medium-risk: refactoring is fine for small scope, ask for large |
| `always_ask` | Must get human approval before proceeding | High-risk: dependencies, breaking changes, architecture |

### Autonomy Schema

```
autonomy: {
  decisions: {
    [category]: {
      level:         "always_ask" | "threshold" | "always_decide"
      threshold:     string?         (condition when level="threshold", e.g., "scope > 5 files")
      description:   string          (human-readable: what this category covers)
    }
  }

  -- Per-repo overrides --
  repo_overrides: {
    [repo_pattern]: {
      decisions: {
        [category]: {                // same structure, overrides base for this repo
          level:       ...
          threshold:   ...
        }
      }
    }
  }
}
```

### How Autonomy Evaluation Works

When the Orchestrator faces a decision:

1. Orchestrator calls `SafetyLayer.evaluate({ type: "should_i_ask", context: { decision_category: "refactoring", details: { files_affected: 12 } } })`
2. Safety Layer looks up `autonomy.decisions.refactoring` -- level is `threshold`, threshold is `"scope > 5 files"`
3. Context shows 12 files -- exceeds threshold
4. Returns: `{ allowed: false, action: "ask_human", reason: "refactoring scope (12 files) exceeds threshold (5)" }`
5. Orchestrator transitions task to Blocked and asks the human

**For `always_decide`:** Returns `{ allowed: true, action: "proceed" }` -- agent proceeds without asking.

**For `always_ask`:** Returns `{ allowed: false, action: "ask_human" }` -- regardless of context.

**Per-repo override precedence:** Repo override > Base config > Defaults. Same precedence as Knowledge: Repo > User > Defaults.

---

## Response Timeout Policy (Gap #17 -- Resolved)

### Ownership Split

| Concern | Owner | What they do |
|---------|-------|-------------|
| **Timeout policy** (stages, thresholds, actions) | Safety Layer config | Defines what happens and when |
| **Timeout execution** (timers, event emission) | Daemon health monitoring | Runs the timers, checks thresholds, emits escalation events |
| **Timeout actions** (sending reminders, evaluating self-unblock) | Orchestrator + Comm plugins | Receives escalation events and acts |

### Policy Schema

```
response_timeout: {
  blocked: {
    stages: [
      {
        name:            "reminder"
        after:           duration         (default: 4 hours)
        action:          "send_reminder"
        repeat:          boolean          (default: true)
        repeat_interval: duration         (default: 4 hours)
      },
      {
        name:            "self_unblock_check"
        after:           duration         (default: 24 hours)
        action:          "evaluate_self_unblock"
      },
      {
        name:            "alert"
        after:           duration         (default: 48 hours)
        action:          "escalation_alert"
      }
    ]
  }

  review_pending: {
    reminder_after:    duration           (default: 24 hours)
    repeat_interval:   duration           (default: 24 hours)
    // Review-Pending NEVER self-unblocks -- the agent cannot self-approve
  }
}
```

### Self-Unblock + Autonomy Interaction

When the Daemon triggers the `self_unblock_check` stage (default: after 24 hours blocked):

1. Daemon emits `timeout.self_unblock_check` event
2. Orchestrator receives the event
3. Orchestrator looks up the autonomy category of the pending decision
4. **If category is `always_ask`:** No self-unblock. Only reminders continue. The agent cannot override an `always_ask` boundary regardless of wait time.
5. **If category is `threshold` or `always_decide`:** Orchestrator evaluates whether a reasonable default exists. If yes: proposes default, proceeds, notifies human ("Going with Option A since it's the cleaner approach. Override if you'd prefer otherwise."). If no: stays blocked, continues reminders.

### Review-Pending Timeout

Review-Pending is fundamentally different from Blocked:
- The agent submitted work for judgment -- it cannot self-approve
- The only action is reminders -- "PR #52 has been waiting for review for 24 hours"
- Never self-unblocks, never escalates to self-action
- The reminder nudges the human to review, nothing more

### Daemon Config Alignment

The Daemon's existing blocked timeout config (`blocked_reminder_interval`, `blocked_self_unblock_threshold`, `blocked_alert_threshold`) should **reference** the Safety Layer's response timeout policy rather than maintaining independent values. On startup, the Daemon reads these thresholds from the Safety Layer config. Single source of truth.

---

## Configuration Schema

The full Safety Layer configuration. Loaded at startup, hot-reloadable for policy changes without restart.

```
SafetyConfig {
  -- Cost limits --
  cost_limits: {
    api: {
      per_task:    { cost_usd: number?, auto_resume_on_reset: boolean }
      daily:       { cost_usd: number?, auto_resume_on_reset: boolean }
      monthly:     { cost_usd: number?, auto_resume_on_reset: boolean }
    }
    cli: {
      [provider_id]: {
        daily_requests: number?
        daily_tokens:   number?
        auto_resume_on_reset: boolean
      }
    }
  }

  -- Scope boundaries --
  scope: {
    repos:     { allowed: string[]? }
    branches:  { create_pattern: string, push_to: string[], merge_to: string[] }
    files:     { exclude_patterns: string[] }
    external:  { allowed_domains: string[]? }
  }

  -- Autonomy boundaries --
  autonomy: {
    decisions: {
      [category]: {
        level:       "always_ask" | "threshold" | "always_decide"
        threshold:   string?
        description: string
      }
    }
    repo_overrides: {
      [repo_pattern]: {
        decisions: { [category]: { level, threshold? } }
      }
    }
  }

  -- Response timeout policy --
  response_timeout: {
    blocked:         { stages: TimeoutStage[] }
    review_pending:  { reminder_after: duration, repeat_interval: duration }
  }

  -- Merge policy --
  merge: {
    auto_merge: {
      default:     boolean          (default: false)
      repos:       { [repo]: boolean }
    }
  }
}
```

### Configuration Layering

```
1. Global defaults        (built into the system -- sensible, conservative)
2. User config file       (overrides defaults)
3. Per-repo overrides     (overrides user config for specific repos)
```

Same precedence as Knowledge: Repo > User > Defaults.

**No hardcoded "never" rules.** Every field has a sensible default, and every field can be overridden. Users who want zero guardrails can have zero guardrails.

---

## Safety Layer State Schema

```
SafetyState {
  -- Configuration (loaded at startup, hot-reloadable) --
  config:           SafetyConfig

  -- Cost accumulators (ephemeral, reconstructable from Event Bus) --
  accumulators:     CostAccumulators

  -- Interceptor registrations --
  intercepted_event_types: string[]      (which event types get pre-processed)
}
```

### Ephemerality

SafetyState is ephemeral. On restart:

1. `config` -- reloaded from config file
2. `accumulators` -- reconstructed by replaying `cost.incurred` events from Event Bus within relevant time windows
3. `intercepted_event_types` -- derived from config

No persistence needed. The Event Bus is the durable store for cost history. The Safety Layer is a stateless evaluator that builds its accumulators from the event stream.

---

## Operations

The Safety Layer provides these operations:

**Active interception:**
- `intercept(event) -> { vetoed: boolean, reason?: string }`

**Passive consultation:**
- `evaluate(query: SafetyQuery) -> SafetyVerdict`

**Cost tracking:**
- `onCostEvent(event: CostEvent)` -- internal, updates accumulators
- `getCostStatus(task_id?, repo?) -> CostStatus` -- for cost_check queries

**Event emission:**
- `cost.limit_reached { task_id?, limit_type, current_spend, limit_value, resets_at? }` -- emitted when a cost limit is hit. Distinct from the veto mechanism: the veto prevents further `cost.incurred` events from passing through the Event Bus, while `cost.limit_reached` notifies the Orchestrator to checkpoint and transition the task to Blocked.

**Configuration:**
- `loadConfig(path) -> SafetyConfig`
- `reloadConfig()` -- hot-reload without restart
- `getTimeoutPolicy() -> ResponseTimeoutConfig` -- queried by Daemon on each health tick (not cached at startup, so hot-reload is immediately effective)

---

## Gaps Resolved

| # | Gap | Resolution |
|---|-----|-----------|
| 5 | Cumulative cost tracking | Two-model cost tracking (CLI subscription limits + API dollar budgets). Safety Layer maintains ephemeral cost accumulators from Event Bus events. When limit is reached, stop -- checkpoint, block task, notify human, wait for reset or budget increase. No hardcoded limits. |
| 17 | Response timeout policy | Safety Layer owns policy definition (stages, thresholds, actions). Daemon reads thresholds and executes timers. Three stages for Blocked: reminder, self-unblock check, alert. Review-Pending: reminders only, never self-unblocks. Self-unblock respects autonomy boundaries -- `always_ask` categories cannot self-unblock. |
| 19 | Autonomy boundary config | Decision categories mapped to three autonomy levels (always_ask, threshold, always_decide). Categories are configurable -- users add/remove freely. Per-repo overrides supported. Passive consultation returns three-way verdict (proceed, ask_human, deny). |

---

## Open Questions for Layer 3

- **Cost event schema details**: Exact fields for `cost.incurred`, how CLI tools report remaining limits, how different API providers normalize cost reporting. (Layer 3: Interactions & Protocols)
- **Autonomy threshold evaluation**: How are threshold conditions evaluated? Simple comparisons against context fields? A mini-expression language? Keep simple but extensible. (Layer 3)
- **Event Bus pre-processing hook**: How is the Safety Layer registered as a pre-processor? Priority ordering if multiple interceptors exist? (Layer 3: Event Bus design)
- **Config file format**: YAML? TOML? JSON? With schema validation? (Layer 4: Implementation Design)
- **Config hot-reload mechanism**: File watcher? Event-triggered? How to handle config changes mid-task? (Layer 3)
- **Multiple repo scope in single task**: When a task touches multiple repos (Gap #11), most restrictive scope across all repos applies. Full design deferred to Workspace Manager. (Layer 2: Workspace Manager)
