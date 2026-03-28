# Trigger & Requirements Flow — Ideas & Brainstorm

Runtime Phase Refinement section 2 of 9. The bridge between external events and internal tasks: trigger polling, dedup, task creation, prioritization, requirements gathering, human outreach, and response handling.

Brainstormed in Session 079. Three rounds of expert panel review applied (5 panelists each: Torvalds, Hipp, Pike, Engineer Persona, Technical Architect). Final round enforced Plugin Blindness as a hard constraint — surfaced 5 additional tier violations in existing Core code beyond `parseGitHubUrl`.

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

**Note:** This is a clean break — no dual-format handling needed. The project is fresh (each user runs their own local instance, no shared data, no production events to migrate). The schema changes directly from `z.string()` to `ExternalRefSchema.nullable()`. All test fixtures update. `SyncMetadata.external_ref` in adapters.ts must also update to match.

**Panel note:** `ExternalRef.type` is actively ignored in `externalRefsMatch()` (unblock-resolver).

**Decision: Two matching semantics for two different purposes:**
- **Dedup (`findByExternalRef`):** Match on `type + repo + number`. Different types with the same number are different entities. This is correct for dedup — an issue and a PR with the same number should create separate tasks.
- **Unblock (`externalRefsMatch`):** Match on `repo + number` only (current behavior, keep it). A response arriving on a PR comment should unblock a task created from the associated issue — they share a number on platforms where issues and PRs are the same sequence. On platforms where they don't share sequences, the plugin constructs distinct ExternalRefs anyway.

This is a deliberate divergence, not an inconsistency. Document it in both functions.

---

## External Ref — Add Optional `url` Field

**Panel finding (final sweep):** `notification-router.ts:283` constructs `https://github.com/${repo}/issues/${number}` — Core building a platform-specific URL from ExternalRef data. Core should never construct platform URLs.

**Decision: Add optional `url: string` field to ExternalRefSchema.** The trigger plugin provides a display URL when constructing the ExternalRef. Core uses `external_ref.url` for linking — never constructs URLs from `repo` + `number`.

```typescript
// ExternalRef with url:
{
  type: "github_issue",
  repo: "owner/repo",
  number: 42,
  url: "https://github.com/owner/repo/issues/42"  // Plugin provides this
}
```

Core reads `url` when it needs a link. If `url` is absent, Core omits the link — it does NOT attempt to construct one.

---

## Plugin Blindness — Purge All Type-String Checks from Core

**Panel finding (final sweep — all 5 panelists):** Beyond `parseGitHubUrl`, Core contains 5 additional Plugin Blindness violations where it checks ExternalRef type strings against platform-specific values:

| File | Line | Violation |
|------|------|-----------|
| `response-poller.ts` | 41 | Constructs `type: "github_issue"` when building ExternalRef from message metadata |
| `phase-runner.ts` | 217 | `if (type !== "github_issue" && type !== "github_pr")` — gates issue commenting on platform type |
| `orchestrator-notifier.ts` | 78 | Same type-string check — second copy |
| `orchestrator-notifier.ts` | 39 | **Constructs plugin IDs from channel names** (`p.manifest.id === \`${contact.channel}-comm\``) — Core guessing plugin naming conventions |
| `notification-router.ts` | 256 | Same type-string check — third copy |
| `notification-router.ts` | 283 | Constructs `https://github.com/` URL from ExternalRef fields |

**Decision: Remove ALL type-string checks from Core.** Replace with capability gates:

- For ticket commenting: check `hasCapability("ticket_management")` on the CommunicationAdapter. If the adapter has the capability, it knows how to comment on whatever external system it represents. Core does not decide which ExternalRef types support commenting.
- For `linkMessageToTask()`: the adapter's `pollMessages()` must return the full `external_ref` object in message metadata (same structured type the trigger returns). Core reads it directly — never constructs an ExternalRef from decomposed fields.
- For URL display: use the new `external_ref.url` field provided by the plugin.
- For plugin lookup in `orchestrator-notifier.ts:39`: use `resolveContact()` from PeopleDirectory to get the preferred channel, then find a comm adapter with "send" capability via the Registry — NOT by constructing plugin IDs from contact channel names. Same pattern as `sendOutreach`.

This is the same category of fix as `parseGitHubUrl` — Core shedding platform knowledge.

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

## Task Creation — Priority from Ticket Variables

Current state: Every trigger-created task gets priority 50. No mechanism for per-ticket priority.

**Decision: Extract priority from the trigger event body using `@priority: <number>` syntax.** Core scans the event's `body` field for engineer variables — key-value pairs the user embeds in the ticket description. No plugin config, no platform knowledge, no metadata conventions.

The user writes in their ticket:

```
## Engineer Variables
@priority: 80
```

Core extracts it via `extractEventVariables(body)` — a pure function that scans for `@key: value` patterns. For now it extracts only `priority`. The function is extensible — future variables (e.g., `@complexity: high`, `@assignee: alice`) use the same pattern.

```typescript
// Pure function in Core:
export function extractEventVariables(body: string | null): EventVariables {
  const vars: EventVariables = {};
  if (!body) return vars;

  const priorityMatch = body.match(/@priority:\s*(\d+)/);
  if (priorityMatch) {
    const value = Number(priorityMatch[1]);
    if (value >= 1 && value <= 100) vars.priority = value;
  }

  return vars;
}

// In processNewTriggerEvent():
const vars = extractEventVariables(event.body);
const priority = vars.priority ?? DEFAULT_PRIORITY;
```

**Why this is better than label-based mapping:**
- Truly platform-agnostic — works with any trigger plugin that provides a body (all of them)
- Zero plugin config — no `priority_labels` in any config file
- User-controlled per ticket — not a system-wide mapping
- Extensible — new `@key: value` patterns added to the same extraction function
- `metadata` stays a pure audit bag — Core never peeks into it

Priority is set at creation time. Default 50 if `@priority` is absent. Valid range: 1-100.

---

## Task Creation — No Intake Gate

**Decision: No pre-creation gate. Requirements Gathering is the gate.** The RRPIR pipeline's first phase reads the trigger ticket, assesses clarity, and blocks with outreach if information is missing. The current flow is correct.

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

**Decision: Validate every outreach filename against People Directory before sending.** If a person ID isn't found, fall back to the owner — send the message to the owner with a note ("Originally intended for {person-id}, not found in contacts"). Owner is the guaranteed fallback for ALL unreachable contacts.

**Prerequisite:** Owner must always exist. `getOwner()` currently returns `null` when no owner is configured. Add a doctor/pre-flight check: "People Directory must have at least one person with role 'owner'." Validate at startup, not at outreach time.

**Security note (final panel):** The filename comes from LLM output (`outreach/{person-id}.txt`). Apply `path.basename()` before using as a filename lookup — prevents path traversal from a hallucinating or manipulated LLM (e.g., `../../etc/passwd`).

---

## Human Outreach — Preferred Channel Routing

Current state: `sendOutreachFromFiles()` sends via ALL communication plugins with "send" capability. Noisy.

**Decision: Route to the person's preferred channel from People Directory.** `PeopleDirectory.resolveContact()` already exists — it takes a personId and returns the preferred contact with fallback. The outreach sender resolves the contact, finds the communication adapter plugin that matches that channel via the Registry, and sends through that single plugin. Fall back to next contact if delivery fails, with a maximum fallback depth of 1 (person → owner → log warning).

Core asks the Registry for communication adapters. The Registry returns whatever plugins are registered. Core never names a specific plugin.

---

## Terminology: Trigger Ticket (not "Issue")

Core never says "issue" — that's platform-specific language. Whatever external work item triggered the task is a **trigger ticket**. Could be a GitHub issue, Jira ticket, Azure DevOps work item, Linear issue. Core uses "trigger ticket" or just "ticket." Plugin-specific terms stay in plugins.

**Renames across the codebase:**
- Capability: `issue_management` → `ticket_management`
- Methods: `commentOnIssue()` → `commentOnTicket(externalRef: ExternalRef, comment: string)`
- Related: `createIssue()` → `createTicket()`, `updateIssue()` → `updateTicket()`
- Method signature simplified: instead of decomposed `(repo, issueNumber, comment)`, pass `(externalRef: ExternalRef, comment: string)`. The plugin extracts what it needs from ExternalRef internally.

This is a mechanical rename across the CommunicationAdapter contract, all plugins that implement `ticket_management`, and all Core code that checks for the capability.

---

## Human Outreach — Source Ticket Comments

Current state: When blocking, the comment on the source trigger ticket (via `ticket_management` capability of a CommunicationAdapter) says "Blocked — reaching out for answers" with just names listed.

**Decision: Include questions summary in the source ticket comment.** If a registered CommunicationAdapter has the `ticket_management` capability and the task has an `external_ref`, post the full outreach content as a comment via `commentOnTicket(externalRef, comment)`. Core checks capability, then calls the adapter contract method. If no adapter has `ticket_management`, this is a no-op. Plugin-agnostic.

Every platform that supports trigger tickets supports posting comments back to them (GitHub, Jira, Azure DevOps, Linear). The adapter receives the `ExternalRef` and knows how to post to its platform. A plain webhook trigger with no backing ticket system simply doesn't declare `ticket_management` — Core skips it.

---

## Human Outreach — Zero-Adapter Guard

**Panel finding (final sweep — Architect):** If no CommunicationAdapter plugins are registered when outreach is needed, the task should NOT block waiting for responses that can never arrive.

**Decision: `sendOutreach` checks for available communication adapters before sending and returns a result indicating whether outreach was delivered.** The phase runner uses this result to decide whether blocking is safe.

Three failure cases, each handled explicitly:

1. **No adapters with "send" capability registered:** `sendOutreach` returns `{ delivered: false, reason: "no_send_adapters" }`. Log warning. Phase runner does NOT transition to blocked — the task proceeds without human input (best effort).
2. **Adapters exist but delivery fails for ALL contacts:** `sendOutreach` returns `{ delivered: false, reason: "all_delivery_failed" }`. Emit `health.outreach_delivery_failure` event. Phase runner does NOT block.
3. **Recipients resolved but no adapter matches their channel:** Log warning ("Recipients exist but no adapter has 'send' capability for channel X"). Fall back to owner's channel. If that also fails, case 2 applies.

Only when `sendOutreach` returns `{ delivered: true, contacted: [...] }` does the phase runner transition to blocked.

---

## Human Outreach — Extract to Own File

**Decision: Extract `sendOutreachFromFiles` to its own file as a standalone function.** Dependencies injected as arguments (peopleDirectory, registry, eventBus, observer). Phase runner calls `sendOutreach(taskId, outreachDir, deps)`. Phase runner handles task state transitions based on the returned result — taskEngine is NOT a dependency of the outreach sender.

---

## Human Outreach — Wire `contacted` Array

**Decision: Populate `contacted` after successful outreach delivery.** Each person + channel + timestamp recorded.

**Panel finding (final sweep — Torvalds):** `unblock-resolver.ts` nulls out `blocked` details (including `contacted`) when unblocking. This erases the data that steps above populate.

**Decision: Don't null the entire `blocked` object.** Instead, clear individual sub-fields while preserving `contacted`. Set `blocked.reason = null`, `blocked.needed = null`, `blocked.waiting_for = null`, `blocked.efforts_made = []` — but keep `blocked.contacted` intact. The `contacted` history remains accessible on the task record for escalation context, resume prompts, and audit. Simple, no new fields, no copy logic.

---

## Response Detection — Correlation Strategy

Current state: Response poller tries to link messages to tasks via `platform_metadata`. Falls back to "sole blocked task" heuristic for unlinked messages.

**Decision: Two-tier correlation, both adapter-agnostic:**

1. **Adapter-level correlation** — Communication adapters that support `receive` return messages with metadata that may include `task_id` (direct match from dashboard) or a structured `external_ref` object (same `ExternalRef` type the trigger returns). Core matches via `externalRefsMatch()`. The adapter enriches its metadata however it wants internally (threading, issue scoping, etc.) — Core just reads the structured fields.

2. **Task reference fallback** — Outreach messages include a short task reference (`[Task: abc123]`). Response poller scans message text for this pattern. Works across any platform, any adapter.

The sole-blocked-task heuristic remains as a last resort for v1 (single-user system). Remove it when correlation is proven reliable in production.

**Panel note:** Full platform-specific threading (e.g., `reply_to_message_id` on specific platforms) is a plugin-internal concern. The communication adapter's `pollMessages()` implementation can use threading internally to enrich the metadata it returns. Core never reaches into platform-specific message fields.

**Panel finding (final sweep — Engineer):** The `receive` capability may not be declared by any comm plugin in production. If no adapter has `receive`, the response poller finds no plugins to poll — blocked tasks can only be unblocked via the dashboard event bus scan. **This is a known limitation for v1.** The plan does not require `receive` to be implemented — correlation improvements (adapter metadata, task reference) simply make the flow smarter when `receive` IS available. The dashboard remains the guaranteed unblock path.

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

**Panel finding (final sweep — Hipp):** Must track whether escalation was already sent — without it, the watchdog spams every tick after threshold. **Resolution: query event bus** for prior escalation events for this task instead of adding a task field. Simpler — no schema change, event bus already has the data.

---

## Bugs to Fix Pre-Implementation

Bugs that exist TODAY, to be fixed as part of the plan:

1. **Response file overwrite** — `unblock-resolver.ts` line 133 writes `{source}.txt`. Second response from same source overwrites first. Data loss bug. Fix: individual files using epoch ms timestamps (`response-{Date.now()}-{source}.txt`), atomic write (temp+rename).
2. **`contacted` always `[]`** — phase-runner.ts line 685. Outreach is sent but never recorded.
3. **`contacted` erased on unblock** — `unblock-resolver.ts` line 108 nulls `blocked` details including `contacted`. Any data populated by the outreach sender is immediately destroyed.
4. **`pendingBasePriorities` buffer is unnecessary** — trigger-poller.ts line 47. A second Map that mirrors `basePriorities` as a "drain buffer." The main map has at most `max_concurrent` entries (small). Scanning it directly is free. Delete `pendingBasePriorities`, simplify `drainNewBasePriorities()` to return the full map.
5. **Concurrent unblock race is already handled** — `unblock-resolver.ts` writes the response file BEFORE transitioning (line 82-88). A second concurrent unblock finds the task no longer blocked and returns `{unblocked: false}`, but the response file was already written. No data loss. **No fix needed** — the existing code is correct. Remove from plan concerns.
6. **Multiple schemas still use old `external_ref: z.string()` type** — `SyncMetadata` (adapters.ts:145), `TaskReconciliationInputSchema` (adapters.ts:176), and `TaskStateChangedPayloadSchema` (events.ts:81). All must be audited and updated alongside the ExternalRef schema change. Full grep for `external_ref.*z.string` across all schema files during Phase 0.

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

## Deferred: Trigger Ticket Body Sync for In-Progress Tasks

**Trigger:** When users report working off stale task descriptions after editing the source trigger ticket.

## Deferred: Trigger Ticket Closure as Cancellation

**Trigger:** When users report that tasks continue running after they close the source trigger ticket.

Design consideration: This should come through the trigger adapter contract (plugin detects closure, returns a cancellation event) — NOT through core checking platform-specific ticket status. The trigger adapter's `poll()` could return events with an `event_type` of `"closed"` that the daemon interprets as a preemption signal.

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

## Deferred: ExternalRef Schema Generalization

**Trigger:** When a trigger plugin needs to represent non-numeric identifiers (Jira string keys like `PROJ-123`, Linear alphanumeric IDs like `LIN-42`).

Current `ExternalRefSchema` has `number: z.number().int().positive()` — this works for number-based issue trackers (GitHub, GitLab, Gitea) but not for string-key systems. A future generalization could be `{ type: string, identifier: string, repo?: string, url?: string }` where `identifier` is opaque and plugins own the format. This is a schema migration but a two-way door — the current structure is not load-bearing in ways that prevent evolution.

**Panel finding (final sweep — Hipp):** "GitHub-shaped with the serial numbers filed off." Document this as a known limitation so nobody is surprised when adding a Jira plugin.
