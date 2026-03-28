# Trigger & Requirements Flow — Ideas & Brainstorm

Runtime Phase Refinement section 2 of 9. The bridge between external events and internal tasks: trigger polling, dedup, task creation, prioritization, requirements gathering, human outreach, and response handling.

Brainstormed in Session 078. Expert panel review applied (5 panelists: Torvalds, Hipp, Pike, Engineer Persona, Technical Architect).

---

## Trigger Polling — Conditional Requests

Current state: GitHub trigger polls ALL configured repos every 30 seconds. Each `pollIssues()` call hits the GitHub API, returns all matching issues, and the trigger poller processes them. No caching headers used — every request burns rate limit whether or not anything changed.

**Decision: Use ETags/If-Modified-Since for GitHub API calls.** GitHub's Issues API supports `If-None-Match` headers. On 304 Not Modified, skip processing entirely — saves rate limit and reduces payload parsing. Store ETag per repo alongside watermark. Simple, high-value change confined to `GitHubTriggerPlugin.pollIssues()`.

```typescript
// Store per-repo ETags alongside watermarks
private etags = new Map<string, string>();

// In pollIssues():
const headers: Record<string, string> = {};
const etag = this.etags.get(repoKey);
if (etag) headers["If-None-Match"] = etag;

const response = await this.octokit.issues.listForRepo({
  owner, repo, since, headers,
});

if (response.status === 304) return []; // Nothing changed
this.etags.set(repoKey, response.headers.etag ?? "");
```

**Panel note:** ETags work per-request, not per-logical-query. For paginated responses across multiple pages, only the first page's ETag is useful. Document this limitation — at 30s poll intervals most repos fit in a single page.

**Panel note:** ETags are a *performance optimization*; watermarks are the *correctness mechanism*. If GitHub changes ETag generation, you get false cache misses (fine) but never false cache hits (watermark catches those).

---

## Trigger Polling — Rate Limit Awareness

**Panel finding: Rate limit management is backwards.** The health check warns when remaining < 100, but the poll loop doesn't throttle based on remaining rate limit. A restart storm could burn through the entire limit with no alerting until it's too late.

**Decision: Read `X-RateLimit-Remaining` on every GitHub API response.** If below a configurable threshold, increase poll interval temporarily. This is proactive throttling — the poll loop backs off BEFORE hitting 429, not after. Also respect `Retry-After` header on 429 responses instead of generic exponential backoff.

---

## Trigger Polling — Polling-Only Architecture

**Decision: Polling-only for v1.** Webhooks add complexity (HTTP server, signature validation, replay, public endpoint requirement). Polling works behind firewalls, requires no infra, and is simpler to debug. The current architecture is correct for v1.

The TriggerAdapter contract (`poll(): Promise<TriggerEvent[]>`) is clean and sufficient. No contract changes needed for polling improvements.

---

## Trigger Surface — Issues Only

Current state: GitHub trigger polls issues and explicitly filters out PRs (`!issue.pull_request`). The `trigger.pr_review` event schema exists in `events.ts` but is never published — it's reserved for "someone asks The Engineer to review their PR."

**Decision: Keep issues-only trigger surface.** Focus this refinement on making issue triggering excellent. PR review requests are a different task type that would need different prompts, different phase behavior, and different output expectations. That's a separate design discussion.

Note: The review handler (`review-handler.ts`) already polls for feedback on The Engineer's OWN PRs — that's a separate daemon subsystem, not a trigger.

---

## External Ref — Plugin Owns Parsing

Current state: `parseGitHubUrl()` is inlined in `trigger-poller.ts` (core) with a GitHub-specific regex. This is a tier violation — core knows about GitHub URL formats. The function exists because "core must not import from plugins," but the real fix is to move parsing to the plugin.

**Decision: Plugin returns a structured `ExternalRef` object directly.** The `TriggerEvent.external_ref` field changes from `string` (raw URL) to `ExternalRef | null` (structured object). The plugin parses its own URLs. Core just stores what it receives.

```typescript
// Before (trigger-poller.ts — core):
const parsed = parseGitHubUrl(event.external_ref); // core knows GitHub URLs
const externalRef = parsed ? toExternalRef(...) : null;

// After (github-trigger.ts — plugin):
// Plugin builds ExternalRef directly in mapIssueToEvent()
external_ref: {
  type: "github_issue",
  repo: `${owner}/${repo}`,
  number: issue.number,
}
```

This removes `parseGitHubUrl()` and `toExternalRef()` from core entirely. Future plugins (GitLab, Bitbucket) return their own ExternalRef objects without core changes.

**Panel note (one-way door):** This is a schema change with blast radius — `TriggerNewEventPayloadSchema` in events.ts, event payloads in the DB, all trigger plugin tests. Needs an explicit migration: update schema to accept `ExternalRef | null`, update DB event serialization, update all test fixtures. Historical events with the old string format need either migration or dual-format handling during replay.

**Panel note:** Torvalds flags that `ExternalRef.type` is actively ignored in `externalRefsMatch()` (unblock-resolver). Either the comparison should include `type`, or the field needs documentation explaining why it's display-only.

---

## Deduplication — Opaque Idempotency Keys

Current state: Plugin provides `idempotency_key` string (e.g., `github:issue:acme/webapp:42`). Core checks against in-memory `seenTriggerKeys` map with TTL. No validation on key format.

**Decision: Idempotency key remains an opaque string — core doesn't validate format.** The plugin owns the key format. Core guarantees: same key = same event, skip it. This keeps the contract generic and extensible. A GitHub key looks different from a GitLab key — core doesn't need to know.

---

## Deduplication — DB-Backed via External Ref

Current state: Both dedup layers (watermarks + seen keys) are in-memory only. On daemon restart, both are lost. Watermarks cause full re-polling, seen keys allow duplicate task creation.

**Decision: DB-backed dedup via `external_ref` — the tasks table is the source of truth.** Before creating a task, core queries the DB for existing non-terminal tasks with the same `external_ref`. If found, skip creation. If the existing task is terminal (completed/failed), allow re-creation — a reopened issue is a new request.

The in-memory `seenTriggerKeys` map becomes a **hot cache** — a performance optimization to avoid DB queries during normal operation, not a correctness requirement. On restart, the cache is cold but the DB catches duplicates.

```typescript
// In processNewTriggerEvent():
// 1. Hot cache check (fast path)
if (seenTriggerKeys.has(event.idempotency_key)) return;

// 2. DB check (cold path — only on cache miss)
const existing = taskEngine.findByExternalRef(event.external_ref);
if (existing && !isTerminalState(existing.state)) {
  seenTriggerKeys.set(event.idempotency_key, now + ttl); // Warm cache
  return; // Already have an active task for this
}

// 3. Create task
```

**Panel note (index required):** `external_ref` is stored as JSON text in SQLite. Querying JSON equality is fragile (key ordering). Needs either `json_extract` comparisons or a generated column with an index. Without an index, this is a full table scan per trigger event. Add the index at implementation time.

**Panel note (Hipp):** `findByExternalRef` should return `boolean` ("does a non-terminal task exist?"), not a full `Task` object. Smaller API surface.

**Panel note (Pike):** Alternatively, return `Task[]` — multiple terminal tasks can exist. Let the caller decide what "duplicate" means.

**Panel note (concurrent unblock race):** Two responses arrive simultaneously for the same blocked task. First transitions `blocked → queued` and writes response file. Second finds task no longer blocked, response content is LOST. Fix: write response file regardless of transition success.

---

## Deduplication — Plugin State Persistence

Current state: GitHub plugin watermarks are in-memory (`Map<string, string>`), cleared on `doInitialize()` and `doShutdown()`. After restart, the plugin re-polls all issues from the beginning.

**Decision: Plugins persist their own state as JSON files.** No adapter contract change. The GitHub plugin writes `~/.engineer/state/github-trigger/watermarks.json` on shutdown, reads on init. ~6 lines of code. Each plugin owns its format. No generic `getState()/setState()` API.

**Panel feedback applied:** All 5 panelists unanimously rejected adding `getState()/setState()` to the adapter contract. It pollutes the interface for every adapter type to solve a plugin-internal concern. A little copying is better than a little dependency.

**Panel note:** If the watermark file is written but the poll didn't complete, watermark advances past unprocessed events. Combined with DB-backed dedup, this means lost events (watermark skips them, DB has no existing task). Mitigation: write watermarks AFTER processing, not before.

---

## Deduplication — Observability

Current state: Zero observability on dedup effectiveness. No counter, no log, no event when a duplicate is suppressed.

**Decision: Deferred to Backend Instrumentation Polish phase.** A debug log line is sufficient for now.

**Panel feedback applied:** Hipp and the Architect both said this is nice-to-have, not a correctness concern. Observer spans for dedup are write-only telemetry until the dashboard consumes them. Add during the dedicated instrumentation phase.

---

## Retrigger Behavior

Current state: Seen keys TTL is 1 day. If a GitHub issue is closed and reopened after TTL expires, the watermark catches the `updated_at` bump and the event re-enters the pipeline.

**Decision: Current retrigger behavior is correct.** Reopened issues re-trigger after TTL — they represent new requests. Edited issues (title/body changed) get caught by watermark but same idempotency key blocks re-trigger during TTL window. This is the right behavior: edits don't create new tasks, reopens do (after a cooldown).

With DB-backed dedup, the retrigger behavior is even cleaner: reopened issues only create new tasks if the existing task is in a terminal state.

---

## Task Creation — Label-Based Priority Mapping

Current state: Every trigger-created task gets priority 50 (`const priority = input.priority ?? 50`). The trigger event has a `metadata` bag with labels and assignees, but it's never used for priority. All tasks start equal.

**Decision: Config-driven label-to-priority mapping.** User defines mappings in config:

```yaml
# daemon.yaml
trigger:
  priority_labels:
    urgent: 80
    critical: 90
    low-priority: 30
    bug: 60
    enhancement: 40
```

**Panel feedback applied:** Highest priority wins when multiple labels match. Not "first match" — that's order-dependent on GitHub API return order. Deterministic, 3 lines:

```typescript
const priority = Math.max(
  DEFAULT_PRIORITY,
  ...labels.map(l => config.priority_labels?.[l] ?? 0)
);
```

**Panel note:** Priority is set at task creation time. Config hot-reload does NOT retroactively change in-flight task priorities. State the invariant explicitly.

---

## Task Creation — No Intake Gate

Current state: Task creation is instant and synchronous — trigger event arrives, task is created, immediately transitions to `queued`. No validation that the issue is actionable.

**Decision: No pre-creation gate. Requirements Gathering is the gate.** The RRPIR pipeline's first phase (Requirements Gathering) reads the issue, assesses clarity, and blocks with outreach if information is missing. Adding a pre-gate would duplicate this intelligence at a less capable layer. The current flow is correct.

---

## Requirements Gathering — Block vs Proceed Criteria

Current state: The requirements gathering prompt tells the LLM to "never assume" and reach out if unclear, but provides no concrete guidance on WHAT constitutes "unclear enough to block." An overly cautious LLM blocks on everything; an overconfident one never asks.

**Decision: Add prompt-level guidance with concrete examples.** Not a rigid rubric — practical examples that calibrate the LLM's judgment:

```
Block when:
- Scope is ambiguous (multiple valid interpretations, no way to choose)
- Security implications unclear (touching auth, permissions, data access)
- Breaking change potential (public API, shared state, database schema)
- Multiple people affected (need to coordinate, not just implement)

Proceed when:
- Implementation details are uncertain but direction is clear
- You can make a reasonable choice and document it in requirements.md
- The task is well-scoped and self-contained
- Style/approach questions where any reasonable choice works
```

**Panel note (Engineer):** This is guidance, not a policy document. One sentence of prompt direction beats a checklist. Keep it light.

---

## Requirements Gathering — Structured Outreach

Current state: When requirements gathering blocks, the LLM creates `outreach/{person-id}.txt` files with entirely free-form content. No structure, no consistency guarantee.

**Decision: Add minimal prompt guidance for outreach messages.** Tell the LLM: "Number your questions so the recipient can answer each one." One sentence. The LLM already writes good messages — don't over-structure.

**Panel feedback applied:** Engineer and Pike both said the original proposal (Context → Questions → What you tried) was process replacing judgment. Simplified to one sentence of guidance.

---

## Requirements Gathering — Max Loop Escalation

Current state: Max requirements loop count is 5 (configurable via `rrpir.max_requirements_loops`). When max is hit, there's just a warn log — no notification, no escalation. The task silently stops making progress.

**Decision: Block + escalation notification when max loops exhausted.** Block the task and notify the owner via communication: "I've asked 5 rounds of questions and still can't proceed. This task needs direct human attention." Clear signal that automation has hit its limits. The owner can then provide direction, simplify the task, or take over.

---

## Requirements Gathering — Outreach Person Validation

**Panel finding (Hipp):** The LLM creates `outreach/{person-id}.txt` files. If the LLM hallucinates a person ID that doesn't exist in People Directory, the file is written but never delivered. The task blocks forever waiting for a response that cannot arrive.

**Decision: Validate every outreach filename against People Directory before sending.** If a person ID isn't found, fall back to the owner. Log a warning. Never block waiting for a non-existent person.

---

## Human Outreach — Preferred Channel Routing

Current state: `sendOutreachFromFiles()` sends via ALL communication plugins with "send" capability. If both Telegram and GitHub Comm are configured, the same person gets the same message on BOTH channels. Noisy.

**Decision: Route to the person's preferred channel from People Directory.** Each person has a `contacts` array with `{channel, handle}` entries. Use the first contact as preferred. Send ONLY on that channel. Fall back to the next contact if delivery fails. Respects user preferences, avoids duplicate notifications.

`PeopleDirectory.resolveContact()` already exists and does exactly this — takes personId and preferredChannel, returns the right contact with fallback. The fix is replacing the inner `for (const plugin of sendPlugins)` loop with a single plugin lookup via resolved contact. ~2 lines changed.

---

## Human Outreach — GitHub Issue Comments

Current state: When blocking, the GitHub issue comment says "Blocked — reaching out for answers:\n\n- personA\n- personB". Useful but minimal — issue followers can't see what's actually being asked.

**Decision: Include questions summary in the GitHub issue comment.** Post the full outreach content (or a structured summary) as the issue comment. Anyone following the issue can see what The Engineer is blocked on. Transparency for the team, not just the contacted person.

---

## Human Outreach — Extract to Own File

Current state: `sendOutreachFromFiles()` is ~90 lines of communication orchestration logic living inside `phase-runner.ts` (orchestrator). It resolves people, iterates plugins, formats messages, posts issue comments. This is communication infrastructure, not phase logic.

**Decision: Extract `sendOutreachFromFiles` to its own file as a standalone function.** Not a class, not a module with state — a function with dependencies injected as arguments. Phase runner calls `sendOutreach(taskId, outreachDir, deps)`.

**Panel feedback applied:** Pike and the Engineer said do it (clean cut, self-contained). Hipp said premature. Compromise: extract as a single function file, not a module or class. If it grows past 150 lines, that's a design problem.

---

## Human Outreach — Wire `contacted` Array

**Panel finding (Torvalds, Architect):** The `contacted` array in `BlockedDetails` is set to `[]` at line 685 of phase-runner.ts. Outreach is sent but never recorded in the task's blocked details. This means the escalation notification and resume prompt can't tell the human or LLM WHO was contacted and WHEN.

**Decision: Populate `contacted` after successful outreach delivery.** Each person + channel + timestamp recorded. Feeds into escalation messages and resume context.

---

## Human Outreach — Dedup on Restart

**Panel finding (Architect):** If the daemon restarts while a task is blocked, and the task re-enters requirements gathering, the LLM may re-generate the same outreach files and re-send the same questions. No "already contacted" guard exists.

**Decision: Check for existing outreach files before sending.** If `outreach/` directory already has files and `responses/` has content, the task was already in an outreach cycle. Don't re-send. Let the LLM read the existing responses and decide if it needs to ask more.

---

## People Directory — Expertise Tags

**Decision: Deferred.** With 1-3 people, the LLM can figure out who to ask from role + context alone. Expertise tags rot without maintenance.

**Panel feedback applied:** 4 of 5 panelists (Torvalds, Hipp, Pike, Engineer) called this premature. The LLM already has role information and can read the codebase to infer expertise. Add when team size exceeds 10.

---

## Response Detection — Reply Threading

**Panel finding (Pike):** The original proposal (include task reference code in outreach, ask humans to copy-paste it in replies) assumes human compliance. It won't work reliably. Telegram and GitHub both support reply-to-message natively.

**Decision: Use platform reply threading as primary correlation strategy.** When sending outreach, record the outgoing message ID (Telegram `message_id`, GitHub comment ID). When a reply comes in, check `reply_to_message_id` (Telegram) or comment threading (GitHub comments are already on the right issue). The platform gives you the correlation for free.

Task reference in the message body is a **fallback** for platforms without threading or when the human starts a new message instead of replying. Response poller checks: (1) reply threading, (2) task reference regex, (3) sole-blocked-task heuristic (to be removed once threading is implemented).

---

## Response Detection — Individual Response Files

Current state: Response files are written as `responses/{source}.txt` (e.g., `telegram.txt`). If multiple responses come from the same source, they OVERWRITE — only the last response survives.

**Decision: Write individual response files with timestamps.** Format: `response-{timestamp}-{source}.txt`. Each response is its own file. No append, no overwrite, no corruption risk from partial writes.

**Panel feedback applied:** Hipp and the Architect both flagged that `appendFileSync` is not atomic — crash mid-append corrupts the file. Individual files are atomic (write-temp-then-rename) and the LLM reads all files in the directory regardless.

---

## Response Detection — Resume Prompt Enhancement

**Decision: Deferred.** Test with live runs first. The existing rerun prompt already points to `requirements.md`, `responses/`, and `outreach/`. If the LLM actually struggles with resumption in practice, add directed guidance then.

**Panel feedback applied:** Hipp and the Engineer both said the existing prompt is sufficient. The LLM reads the files and sees the conversation. Adding a summary section that narrates what's already in the files is redundant.

---

## Blocked Task Timeout

**Panel finding (Torvalds):** A task can sit in `blocked` forever if the human never responds. The max-loop escalation only fires during active requirements gathering. Once the task is blocked waiting for a response, there is no watchdog.

**Decision: Add blocked duration watchdog in the daemon tick loop.** If a task has been blocked for longer than a configurable threshold (e.g., 24 hours), escalate: notify the owner, log a warning. Reuse the existing `healthMonitor.checkBlockedEscalation()` — verify it covers this duration-based check.

---

## Issue Closure as Cancellation

**Panel finding (Architect):** If a user closes a GitHub issue while The Engineer is actively working on it, there is no mechanism to detect this and preempt the task. The trigger poller only looks for new/updated issues.

**Decision: Add issue status check in trigger poller.** When processing a trigger poll, also check if any in-progress tasks have issues that are now closed. If the source issue is closed, preempt the task (transition to a cancelled/completed state). This reuses the existing preemption machinery.

---

## Rate Limit as Shared Resource

**Panel finding (Architect):** Trigger poller, response poller, and review handler all hit the GitHub API from the same token. No fair sharing, no circuit breaker, no coordination.

**Decision: Acknowledge the shared resource and add basic coordination.** At minimum, track remaining rate limit on the Octokit instance (shared across GitHub plugins) and expose it. If remaining drops below threshold, all GitHub-based subsystems reduce their poll frequency. Implementation details deferred to the planning session — this may be as simple as a shared counter on the GitHub utility module.

---

# Deferred Items

## Deferred: Webhook/Push Mode for Triggers

**Trigger:** When we need real-time trigger ingestion, or when The Engineer needs to respond within seconds (not the current 30s poll interval). Also relevant when running behind a load balancer or as a hosted service.

Design consideration: Add optional `onEvent()` callback or webhook handler interface to TriggerAdapter. HTTP server, signature validation (GitHub webhook secrets), replay/retry handling. Significant scope — requires daemon to expose an HTTP endpoint.

## Deferred: PR Review Request Triggers

**Trigger:** When we want The Engineer to review other people's PRs, not just work on issues. This is a fundamentally different task type — different prompts, different phase behavior (read code → write review comments, not write code → create PR), different output expectations.

The `trigger.pr_review` event schema already exists in `events.ts`. The architectural insight: different trigger event types can map to different task types, which get different RRPIR configurations (prompts, review phases, etc.). This is a significant expansion of the task model.

## Deferred: Pre-Creation Intake Gate

**Trigger:** When spam or noise becomes a problem — too many low-quality issues creating tasks that immediately block on requirements. Could be a simple filter (minimum body length, required label, required assignee) or a lightweight LLM pre-screen.

Current mitigation: Requirements Gathering phase IS the gate. It blocks and asks for more info. But if the volume of junk issues is high, a pre-filter saves LLM cost.

## Deferred: Schema-Driven Outreach

**Trigger:** When outreach needs to be machine-readable (structured Q&A, not free-text). E.g., if we want to present questions as a form in the dashboard, or if we want to validate that all questions were answered before unblocking.

Current approach (LLM-crafted `.txt` files) is flexible and natural. Schema-driven outreach adds structure but reduces the LLM's ability to craft contextual, human-friendly messages.

## Deferred: People Directory Expertise Tags

**Trigger:** When team size exceeds ~10 people and role-based routing is insufficient. The LLM needs domain knowledge tags to pick the right person for each question.

Add optional `expertise: string[]` to person config. Requires a maintenance plan — who updates tags? How do stale tags get cleaned up?

## Deferred: Issue Body Sync for In-Progress Tasks

**Trigger:** When users report that The Engineer is working off stale issue descriptions because they edited the issue after task creation.

Design consideration: The trigger poller could detect `updated_at` changes on issues with existing active tasks and push the updated body into the task record. Needs careful design — mid-pipeline body changes could confuse the LLM.
