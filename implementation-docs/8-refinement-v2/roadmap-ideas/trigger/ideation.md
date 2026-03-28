# Trigger & Requirements Flow — Ideas & Brainstorm

Runtime Phase Refinement section 2 of 9. The bridge between external events and internal tasks: trigger polling, dedup, task creation, prioritization, requirements gathering, human outreach, and response handling.

Brainstormed in Session 079. Two rounds of expert panel review applied (5 panelists each: Torvalds, Hipp, Pike, Engineer Persona, Technical Architect).

**Governing principle:** Plugin Blindness (see `docs/philosophy.md`). Core sees only adapter contracts. Every decision below is framed through adapters, never through specific plugins. Plugin-internal improvements (ETags, watermarks, platform-specific optimizations) are clearly labeled as such and confined to the plugin tier.

---

# Core-Level Decisions

These changes affect Core components (daemon, orchestrator, task engine, schemas). They speak exclusively through adapter contracts and are entirely plugin-agnostic.

---

## External Ref — Plugin Owns Parsing

Current state: `parseGitHubUrl()` is inlined in `trigger-poller.ts` (core) with a platform-specific regex. **This is a tier violation** — core knows about a specific platform's URL format.

**Decision: Plugin returns a structured `ExternalRef` object directly.** The `TriggerEvent.external_ref` field changes from `string` (raw URL) to `ExternalRef | null` (structured object). The trigger plugin parses its own URLs internally. Core receives a platform-agnostic structured object and stores it without knowing what generated it.

```typescript
// Before (trigger-poller.ts — core knows platform URLs):
const parsed = parseGitHubUrl(event.external_ref);
const externalRef = parsed ? toExternalRef(...) : null;

// After (core is blind — plugin provides structured object):
const externalRef = event.external_ref; // Already ExternalRef | null from plugin
```

This removes `parseGitHubUrl()` and `toExternalRef()` from core entirely. Any future trigger plugin returns its own ExternalRef objects without core changes. Core compiles and functions identically regardless of which trigger plugin is installed.

**Panel note (one-way door):** This is a schema change with blast radius — `TriggerNewEventPayloadSchema` in events.ts, event payloads in the DB, all trigger plugin tests. Historical events in the database have the old string format. **Resolution: dual-format parsing on read** — the schema accepts both `string` and `ExternalRef`, consuming code handles both. New events always use structured format. Old events degrade gracefully.

**Panel note:** `ExternalRef.type` is actively ignored in `externalRefsMatch()` (unblock-resolver). **Resolution: include `type` in comparison.** Platform-specific number sequence collisions are the plugin's problem to handle when constructing ExternalRef, not core's problem during matching.

---

## Deduplication — Opaque Idempotency Keys

Current state: Plugin provides `idempotency_key` string. Core checks against in-memory `seenTriggerKeys` map with TTL. No validation on key format.

**Decision: Idempotency key remains an opaque string — core doesn't validate format.** The plugin owns the key structure. Core guarantees only: same key = same event, skip it. This is plugin-agnostic by design.

---

## Deduplication — DB-Backed via External Ref

Current state: Both dedup layers are in-memory only. On daemon restart, both are lost, allowing duplicate task creation.

**Decision: DB-backed dedup via `external_ref` — the tasks table is the source of truth.** Before creating a task, core queries the DB for existing non-terminal tasks with the same `external_ref`. If found, skip creation. If the existing task is terminal (completed/failed), allow re-creation.

The in-memory `seenTriggerKeys` map becomes a **hot cache** — a performance optimization, not a correctness requirement. On restart, the cache is cold but the DB catches duplicates.

```typescript
// In processNewTriggerEvent():
// 1. Hot cache check (fast path)
if (seenTriggerKeys.has(event.idempotency_key)) return;

// 2. DB check (cold path — only on cache miss)
if (event.external_ref) {
  const exists = taskEngine.findByExternalRef(event.external_ref);
  if (exists) {
    seenTriggerKeys.set(event.idempotency_key, now + ttl);
    return;
  }
}

// 3. Create task
```

**Panel note (index):** `external_ref` is JSON text in SQLite. Use a partial index with `json_extract` for performance: `WHERE state NOT IN ('completed', 'failed')`. Smaller, faster, precisely matches the query.

**Panel note:** `findByExternalRef` returns `boolean` — core only needs "does a non-terminal task exist?", not the task object. Minimal API surface.

---

## Deduplication — Observability

**Decision: Deferred to Backend Instrumentation Polish phase.** A debug log line is sufficient for now.

---

## Retrigger Behavior

**Decision: Current retrigger behavior is correct.** Reopened external events re-trigger after TTL or when the existing task is terminal. Edits caught by plugin watermarks + same idempotency key blocks re-trigger during TTL. With DB-backed dedup, terminal → re-creation is explicitly allowed.

---

## Task Creation — Label-Based Priority Mapping

Current state: Every trigger-created task gets priority 50. The trigger event has a `metadata` bag with labels, but it's never used for priority.

**Decision: Config-driven label-to-priority mapping.** Core reads labels from `event.metadata.labels` (opaque strings provided by any trigger plugin) and maps them to priority values via config:

```yaml
# daemon.yaml
trigger:
  priority_labels:
    urgent: 80
    critical: 90
    low-priority: 30
```

**Highest match wins** (deterministic, order-independent):
```typescript
const priority = Math.max(
  DEFAULT_PRIORITY,
  ...labels.map(l => config.priority_labels?.[l] ?? 0)
);
```

Core doesn't know what "urgent" means to any particular platform. Labels are opaque strings from any trigger plugin's metadata. Priority is set at creation time — config hot-reload does NOT retroactively change in-flight task priorities.

---

## Task Creation — No Intake Gate

**Decision: No pre-creation gate. Requirements Gathering is the gate.** The RRPIR pipeline's first phase reads the issue, assesses clarity, and blocks with outreach if information is missing. The current flow is correct.

---

## Requirements Gathering — Block vs Proceed Criteria

**Decision: Add prompt-level guidance with concrete examples.** One short section of guidance, not a rigid rubric:

```
Block when: scope is ambiguous, security implications unclear, breaking change potential, multiple people affected.
Proceed when: direction is clear, reasonable choice can be documented, task is self-contained.
```

**Panel note:** Keep it light — one sentence of prompt direction beats a checklist.

---

## Requirements Gathering — Structured Outreach

**Decision: Add minimal prompt guidance.** Tell the LLM: "Number your questions so the recipient can answer each one." One sentence. The LLM already writes good messages.

---

## Requirements Gathering — Max Loop Escalation

**Decision: Block + escalation notification when max loops exhausted.** Notify the owner via whatever communication adapter is available: "I've asked 5 rounds of questions and still can't proceed." Clear signal that automation has hit its limits. The notification goes through the CommunicationAdapter contract — core doesn't know which platform delivers it.

---

## Requirements Gathering — Outreach Person Validation

**Decision: Validate every outreach filename against People Directory before sending.** If a person ID isn't found, fall back to the owner. Log a warning. Never block waiting for a non-existent person. Dedup the recipient — if fallback target is already receiving their own outreach, merge or note the redirect.

---

## Human Outreach — Preferred Channel Routing

Current state: `sendOutreachFromFiles()` sends via ALL communication plugins with "send" capability. Noisy.

**Decision: Route to the person's preferred channel from People Directory.** `PeopleDirectory.resolveContact()` already exists — it takes a personId and returns the preferred contact with fallback. The outreach sender resolves the contact, finds the communication adapter plugin that matches that channel via the Registry, and sends through that single plugin. Fall back to next contact if delivery fails, with a maximum fallback depth of 1 (person → owner → log warning).

Core asks the Registry for communication adapters. The Registry returns whatever plugins are registered. Core never names a specific plugin.

---

## Human Outreach — Source Issue Comments

Current state: When blocking, the comment on the source issue (via `issue_management` capability of a CommunicationAdapter) says "Blocked — reaching out for answers" with just names listed.

**Decision: Include questions summary in the source issue comment.** If a registered CommunicationAdapter has the `issue_management` capability and the task has an `external_ref`, post the full outreach content as a comment. Core checks capability, then calls the adapter contract method. If no adapter has `issue_management`, this is a no-op. Plugin-agnostic.

---

## Human Outreach — Extract to Own File

**Decision: Extract `sendOutreachFromFiles` to its own file as a standalone function.** Dependencies injected as arguments (peopleDirectory, registry, observer). Phase runner calls `sendOutreach(taskId, outreachDir, deps)`.

---

## Human Outreach — Wire `contacted` Array

**Decision: Populate `contacted` after successful outreach delivery.** Each person + channel + timestamp recorded.

**Panel finding (final sweep — Torvalds):** `unblock-resolver.ts` nulls out `blocked` details (including `contacted`) when unblocking. This erases the data that steps above populate. **Resolution: preserve `contacted` data before clearing blocked details** — either copy to a separate task field or don't null the entire `blocked` object.

---

## Response Detection — Correlation Strategy

Current state: Response poller tries to link messages to tasks via `platform_metadata`. Falls back to "sole blocked task" heuristic for unlinked messages.

**Decision: Two-tier correlation, both adapter-agnostic:**

1. **Adapter-level correlation** — Communication adapters that support `receive` return messages with metadata that may include `task_id`, `repo`, `issue_number`, or `reply_to` fields. The response poller uses whatever metadata the adapter provides. Core doesn't know the platform-specific correlation mechanism — it just reads the fields the adapter returns.

2. **Task reference fallback** — Outreach messages include a short task reference (`[Task: abc123]`). Response poller scans message text for this pattern. Works across any platform, any adapter.

The sole-blocked-task heuristic remains as a last resort for v1 (single-user system). Remove it when correlation is proven reliable in production.

**Panel note:** Full platform-specific threading (e.g., `reply_to_message_id` on specific platforms) is a plugin-internal concern. The communication adapter's `pollMessages()` implementation can use threading internally to enrich the metadata it returns. Core never reaches into platform-specific message fields.

---

## Response Detection — Individual Response Files

Current state: Response files are `responses/{source}.txt` — same-source responses overwrite.

**Decision: Write individual response files.** Format: `response-{timestamp}-{source}.txt`. Atomic writes (write-temp-then-rename). The LLM reads all files in the directory. No data loss, no corruption risk.

---

## Response Detection — Resume Prompt Enhancement

**Decision: Deferred.** The existing rerun prompt already points to `requirements.md`, `responses/`, and `outreach/`. Test with live runs first.

---

## Blocked Task Timeout

**Decision: Blocked duration watchdog in the daemon tick loop.** If a task has been blocked longer than a configurable threshold, escalate via CommunicationAdapter (the owner's preferred channel, resolved through People Directory). Verify existing `healthMonitor.checkBlockedEscalation()` covers this — if it does, no new code needed.

**Panel finding (final sweep — Hipp):** Must track whether escalation was already sent — without it, the watchdog spams every tick after threshold. Add an "escalated" flag to blocked details.

---

## Bugs to Fix Pre-Implementation

Three bugs exist TODAY that must be fixed before or alongside the main plan:

1. **Response file overwrite** — `unblock-resolver.ts` line 133 writes `{source}.txt`. Second response from same source overwrites first. Data loss bug.
2. **`contacted` always `[]`** — phase-runner.ts line 685. Outreach is sent but never recorded.
3. **`contacted` erased on unblock** — `unblock-resolver.ts` line 108 nulls `blocked` details including `contacted`. Any data populated by the outreach sender is immediately destroyed.

---

# Plugin-Internal Improvements

These changes are confined to specific plugins. Core is unaware of them. They improve the plugins we currently have, but are NOT required for the system to function. Any plugin can be swapped out, and these improvements go with it.

---

## Trigger Plugin — Conditional Requests (ETags)

**Plugin-internal optimization.** Trigger plugins that poll HTTP APIs can use caching headers (ETags, If-Modified-Since) to reduce unnecessary data transfer. This is entirely within the plugin's `doPoll()` implementation. Core's `TriggerAdapter.poll()` contract is unchanged.

The current trigger plugin can add ETag caching to its API calls — store per-resource ETags, send `If-None-Match`, handle 304 responses. Performance optimization, not correctness.

---

## Trigger Plugin — State Persistence (Watermarks)

**Plugin-internal concern.** Trigger plugins that maintain polling cursors (watermarks, offsets) should persist them across restarts. Each plugin writes its own state file to `~/.engineer/state/{plugin_id}/`. No adapter contract change. ~6 lines of code per plugin.

**Panel note:** Use atomic writes (write-temp-then-rename). Write state AFTER processing events, not before — prevents advancing past unprocessed events on crash.

---

## Trigger Plugin — Rate Limit Handling

**Plugin-internal concern.** Trigger plugins that interact with rate-limited APIs should read rate limit headers and respect `Retry-After` on 429 responses. This is internal to the plugin's `doPoll()` implementation. The existing exponential backoff in the trigger poller (core) handles the error case generically — the plugin improvement is about being smarter within its own API calls.

---

# Deferred Items

## Deferred: Webhook/Push Mode for Triggers

**Trigger:** When we need real-time trigger ingestion, or when The Engineer needs to respond within seconds (not the current 30s poll interval).

Design consideration: Add optional `onEvent()` callback or webhook handler interface to TriggerAdapter. HTTP server, signature validation, replay/retry handling.

## Deferred: PR Review Request Triggers

**Trigger:** When we want The Engineer to review other people's PRs. Different task type — different prompts, different phase behavior, different output expectations. The `trigger.pr_review` event schema already exists.

## Deferred: Pre-Creation Intake Gate

**Trigger:** When spam or noise becomes a problem. Requirements Gathering is the current gate.

## Deferred: Schema-Driven Outreach

**Trigger:** When outreach needs to be machine-readable (structured Q&A, dashboard forms).

## Deferred: People Directory Expertise Tags

**Trigger:** When team size exceeds ~10 people and role-based routing is insufficient.

## Deferred: Issue Body Sync for In-Progress Tasks

**Trigger:** When users report working off stale task descriptions after editing the source issue.

## Deferred: Issue Closure as Cancellation

**Trigger:** When users report that tasks continue running after they close the source issue.

Design consideration: This should come through the trigger adapter contract (plugin detects closure, returns a cancellation event) — NOT through core checking platform-specific issue status. The trigger adapter's `poll()` could return events with an `event_type` of `"closed"` that the daemon interprets as a preemption signal.

**Panel feedback applied (final sweep):** All panelists agreed this is a new subsystem feature, underspecified, and wrong time. The API cost (one call per active task per poll) was unaddressed. Deferred with the architectural note that it MUST go through the adapter, not hardcoded in core.

## Deferred: Rate Limit Coordination Across Subsystems

**Trigger:** When rate limits are actually hit in production (429 responses observed).

Design consideration: If multiple subsystems share a rate-limited external resource, coordination belongs in the plugin tier (shared utility) or adapter tier (health events), not in core. Core must never know about platform-specific rate limits.

**Panel feedback applied (final sweep):** Current per-plugin backoff is sufficient. The existing health check warns at low remaining. Build coordination when 429s are observed, not before.

## Deferred: Full Platform Reply Threading

**Trigger:** When multiple tasks are regularly blocked simultaneously and the task-reference fallback proves insufficient.

Design consideration: Communication adapters can use platform-native threading (reply-to-message) internally to enrich message metadata. Core only reads the adapter-provided metadata fields — it never reaches into platform-specific threading mechanisms. This is a plugin-internal improvement that makes the adapter's `pollMessages()` smarter.

## Deferred: Outreach Dedup on Restart

**Trigger:** When users report receiving duplicate outreach messages after daemon restarts.

The LLM already reads existing `outreach/` and `responses/` directories on resume. If it re-generates the same questions, the fix is in the prompt, not in a file-existence guard.
