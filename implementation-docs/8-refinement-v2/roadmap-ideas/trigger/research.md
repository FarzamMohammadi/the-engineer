# Trigger & Requirements Flow — Technical Research

Implementation reference for the planning session. Every file path, schema field, code location, and architectural detail needed to build the plan from `ideation.md`. No external knowledge required — this document is self-contained.

---

## Project Context

- **Language:** TypeScript (ESM, strict mode)
- **Runtime:** Node.js 22 LTS
- **Database:** SQLite via better-sqlite3 (synchronous API)
- **Package manager:** pnpm
- **Lint:** Biome (all rules)
- **Test:** Vitest (forks mode)
- **Architecture:** Core / Adapter / Plugin three-tier model
- **State dir:** `~/.engineer/`

---

## Current File Map

### Files to MODIFY

| File | Current Purpose | What Changes |
|------|----------------|-------------|
| `src/core/daemon/trigger-poller.ts` | Dedup, event publish, task creation | Remove `parseGitHubUrl()` (L218–232) and `toExternalRef()` (L234–245). Accept structured `ExternalRef` from plugin. Add DB-backed dedup query before `createTask()`. Add label-based priority lookup. |
| `src/plugins/trigger/github-trigger/github-trigger.ts` | GitHub issue polling | Add ETag support in `pollIssues()` (L88–125). Build `ExternalRef` in `mapIssueToEvent()` (L164). Persist/load watermarks in `doInitialize()`/`doShutdown()` (L45–57, L81–84). Add rate limit header reading. |
| `src/schemas/adapters.ts` | TriggerEvent schema | Change `external_ref` from `z.string()` (L81) to `ExternalRefSchema.nullable()`. |
| `src/schemas/events.ts` | Event payload schemas | Change `TriggerNewEventPayloadSchema.external_ref` from `z.string()` (L217) to match new adapter schema type. |
| `src/core/orchestrator/phase-runner.ts` | Phase sequencing + outreach | Extract `sendOutreachFromFiles()` (L109–201) to own file. Populate `contacted` array (currently `[]` at L685). Add outreach dedup check (existing files = already contacted). |
| `src/core/daemon/unblock-resolver.ts` | Task unblocking | Change `writeFileSync` (L133) to write individual response files (`response-{timestamp}-{source}.txt`). Fix concurrent unblock race: write response regardless of transition success. |
| `src/core/daemon/response-poller.ts` | Response detection | Fix `linkMessageToTask()` (L41) — stop constructing platform-specific ExternalRef. Add task-reference regex scan as fallback. Plan for removing sole-blocked-task fallback (L156–169). |
| `src/core/orchestrator/orchestrator-notifier.ts` | Notifications | Remove platform type-string checks (L78). Fix URL construction (via `external_ref.url`). |
| `src/core/daemon/notification-router.ts` | Notification routing | Remove platform type-string checks (L256). Fix URL construction (L283 — use `external_ref.url`). |
| `src/schemas/config.ts` | Daemon configuration | Add `priority_labels` config field (after L156). Add `blocked_timeout_ms` for blocked task watchdog. (`rate_limit_threshold` is plugin-internal, NOT in Core config.) |
| `src/core/interfaces/task-engine.interface.ts` | Task engine contract | Add `findByExternalRef(ref: ExternalRef): boolean` method (after L86). |
| `src/core/task-engine/index.ts` | Task engine implementation | Implement `findByExternalRef()` with JSON-based query on tasks table. |
| `src/core/orchestrator/prompts/requirements-gathering.ts` | Requirements prompt | Add block/proceed criteria examples (around L97–129). Add "number your questions" guidance for outreach. |
| `src/core/daemon/index.ts` | Daemon tick loop | Verify `checkBlockedEscalation()` (L457) covers duration-based timeout. Add issue closure detection hookpoint. |

### Files to CREATE

| File | Purpose |
|------|---------|
| `src/core/orchestrator/outreach-sender.ts` | Extracted `sendOutreachFromFiles()` function with preferred channel routing |
| `~/.engineer/state/github-trigger/watermarks.json` | Persisted watermarks (created at runtime by plugin) |
| `src/db/migrations/010_*.sql` | Index on `external_ref` for dedup query (if needed — may use json_extract) |

### Files to DELETE

| File | Reason |
|------|--------|
| None | No files deleted — code is moved/refactored, not removed |

### Files REFERENCED but not modified

| File | Why Referenced |
|------|---------------|
| `src/adapters/trigger.ts` | TriggerAdapter contract — `poll(): Promise<TriggerEvent[]>` (unchanged) |
| `src/adapters/communication.ts` | CommunicationAdapter — `doSendMessage()`, `doPollMessages()`, capability checks |
| `src/core/people-directory/index.ts` | `resolveContact()` (L52–69), `getPerson()` (L17–19) — used by outreach sender |
| `src/core/daemon/task-scheduler.ts` | `computeAgedPriority()` (L24–43), `applyPriorityAging()` (L493–509) — priority system |
| `src/core/daemon/types.ts` | `TriggerPollerContext` (L35–38) — may need `config` expansion for priority_labels |
| `src/schemas/task.ts` | `ExternalRefSchema` (L51–56), `BlockedDetailsSchema` (L157–170) |
| `src/plugins/communication/telegram-comm/telegram-comm.ts` | `doPollMessages()` (L161–206) — reply_to field in platform_metadata |
| `src/plugins/communication/github-comm/github-comm.ts` | `doCommentOnIssue()` (L230–250) — issue comment with questions |

---

## Schema References

### TriggerEvent (adapters.ts L77–95)

| Field | Current Type | New Type | Notes |
|-------|-------------|----------|-------|
| `idempotency_key` | `z.string()` | unchanged | Opaque, plugin-owned |
| `source` | `z.string()` | unchanged | Plugin ID |
| `event_type` | `z.string()` | unchanged | Event classification |
| `external_ref` | `z.string()` | `ExternalRefSchema.nullable()` | **BREAKING CHANGE** — URL → structured object |
| `title` | `z.string()` | unchanged | |
| `body` | `z.string().nullable()` | unchanged | |
| `repo` | `z.string()` | unchanged | `owner/repo` format |
| `clone_url` | `z.string()` | unchanged | |
| `thoughts_id` | `z.string().nullable()` | unchanged | |
| `metadata` | `z.record(z.unknown()).nullable()` | unchanged | Labels, assignees, etc. |

### ExternalRef (task.ts L51–56)

| Field | Type | Notes |
|-------|------|-------|
| `type` | `z.string()` | `"github_issue"`, `"github_pr"`, etc. |
| `repo` | `z.string()` | `"owner/repo"` |
| `number` | `z.number().int().positive()` | Issue/PR number |

### BlockedDetails (task.ts L157–170)

| Field | Type | Current State | Change |
|-------|------|---------------|--------|
| `reason` | `z.string()` | Populated | — |
| `efforts_made` | `z.array(z.string())` | Populated | — |
| `contacted` | `z.array(z.object({person, channel, timestamp}))` | **Always `[]`** | Populate after outreach delivery |
| `needed` | `z.string()` | Populated | — |
| `waiting_for` | `z.string()` | Populated | — |

### TriggerNewEventPayload (events.ts L213–224)

| Field | Current Type | Change |
|-------|-------------|--------|
| `external_ref` | `z.string()` | Change to match new TriggerEvent type |

### Config — New Fields (config.ts, after L156)

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `priority_labels` | `z.record(z.string(), z.number().int().min(1).max(100))` | `{}` | Label → priority mapping |
| `blocked_timeout_ms` | `z.number().int().positive()` | `86_400_000` (1 day) | Watchdog for stuck blocked tasks |

---

## Specific Code Locations for Changes

### 1. Delete parseGitHubUrl / toExternalRef from Core

**File:** `src/core/daemon/trigger-poller.ts`

**Remove lines 218–245:**
```typescript
const GITHUB_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/;

function parseGitHubUrl(url: string): { owner: string; repo: string; number: number; type: "issue" | "pull" } | null {
  // ... regex parsing
}

function toExternalRef(owner: string, repo: string, number: number, type: "issue" | "pull"): ExternalRef {
  // ... object construction
}
```

**Remove from processNewTriggerEvent() lines 125–129:**
```typescript
const parsed = parseGitHubUrl(event.external_ref);
const externalRef = parsed
  ? toExternalRef(parsed.owner, parsed.repo, parsed.number, parsed.type)
  : null;
```

**Replace with:**
```typescript
const externalRef = event.external_ref; // Already structured from plugin
```

### 2. Build ExternalRef in GitHub Plugin

**File:** `src/plugins/trigger/github-trigger/github-trigger.ts`

**Modify mapIssueToEvent() line 164:**
```typescript
// Before:
external_ref: issue.html_url,

// After:
external_ref: {
  type: "github_issue",
  repo: `${owner}/${repo}`,
  number: issue.number,
},
```

### 3. Add ETag Support to GitHub Plugin

**File:** `src/plugins/trigger/github-trigger/github-trigger.ts`

**Add field after line 25:**
```typescript
private etags = new Map<string, string>();
```

**Modify pollIssues() around lines 94–111:**
```typescript
// Before octokit call, build headers:
const headers: Record<string, string> = {};
const etag = this.etags.get(`${owner}/${repo}`);
if (etag) headers["if-none-match"] = etag;

const response = await this.octokit.issues.listForRepo({
  owner, repo, state: "open", since, labels: this.config.labels?.join(","),
  headers,
});

// After call:
if (response.status === 304) return [];
const responseEtag = response.headers.etag;
if (responseEtag) this.etags.set(`${owner}/${repo}`, responseEtag);
```

### 4. Persist Watermarks in GitHub Plugin

**File:** `src/plugins/trigger/github-trigger/github-trigger.ts`

**Modify doInitialize() (L45–57) — add after config parsing:**
```typescript
const stateDir = path.join(process.env.ENGINEER_HOME ?? path.join(os.homedir(), ".engineer"), "state", this.manifest.id);
const watermarkPath = path.join(stateDir, "watermarks.json");
try {
  const data = fs.readFileSync(watermarkPath, "utf-8");
  const parsed = JSON.parse(data) as Record<string, string>;
  for (const [key, value] of Object.entries(parsed)) {
    this.watermarks.set(key, value);
  }
} catch { /* First run or corrupt — start fresh */ }
```

**Modify doShutdown() (L81–84) — add before watermarks.clear():**
```typescript
const stateDir = path.join(process.env.ENGINEER_HOME ?? path.join(os.homedir(), ".engineer"), "state", this.manifest.id);
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(
  path.join(stateDir, "watermarks.json"),
  JSON.stringify(Object.fromEntries(this.watermarks)),
  "utf-8",
);
this.watermarks.clear();
```

### 5. Add DB-Backed Dedup

**File:** `src/core/daemon/trigger-poller.ts`

**Modify processNewTriggerEvent() lines 98–105:**
```typescript
// 1. Hot cache (fast path)
const expiry = seenTriggerKeys.get(event.idempotency_key);
if (expiry !== undefined && expiry > now) return;

// 2. DB check (cold path)
if (event.external_ref) {
  const exists = ctx.taskEngine.findByExternalRef(event.external_ref);
  if (exists) {
    seenTriggerKeys.set(event.idempotency_key, now + config.seen_keys_ttl_ms);
    return;
  }
}

// 3. Mark seen
seenTriggerKeys.set(event.idempotency_key, now + config.seen_keys_ttl_ms);
```

**File:** `src/core/task-engine/index.ts`

**Add method (after existing query methods):**
```typescript
findByExternalRef(ref: ExternalRef): boolean {
  const row = this.db.prepare(`
    SELECT 1 FROM tasks
    WHERE json_extract(external_ref, '$.type') = ?
      AND json_extract(external_ref, '$.repo') = ?
      AND json_extract(external_ref, '$.number') = ?
      AND state NOT IN ('completed', 'failed')
    LIMIT 1
  `).get(ref.type, ref.repo, ref.number);
  return row !== undefined;
}
```

**Migration (010):** Partial index for performance (only active tasks):
```sql
CREATE INDEX IF NOT EXISTS idx_tasks_external_ref_active
  ON tasks(json_extract(external_ref, '$.type'), json_extract(external_ref, '$.repo'), json_extract(external_ref, '$.number'))
  WHERE state NOT IN ('completed', 'failed');
```

### 6. Label-Based Priority

**File:** `src/core/daemon/trigger-poller.ts`

**Add in processNewTriggerEvent(), before createTask() (around L132):**
```typescript
const labels = (event.metadata as Record<string, unknown> | null)?.labels;
const priority = Array.isArray(labels)
  ? Math.max(DEFAULT_PRIORITY, ...labels.map((l: unknown) =>
      typeof l === "string" ? (config.priority_labels?.[l] ?? 0) : 0))
  : DEFAULT_PRIORITY;
```

**Pass `priority` to createTask():**
```typescript
const task = taskEngine.createTask({
  ...existing fields,
  priority,
});
```

### 7. Individual Response Files

**File:** `src/core/daemon/unblock-resolver.ts`

**Modify writeResponseToWorktree() (L115–142):**
```typescript
// Before:
const responsePath = path.join(responsesDir, `${source}.txt`);
fs.writeFileSync(responsePath, content, "utf-8");

// After:
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const responsePath = path.join(responsesDir, `response-${timestamp}-${source}.txt`);
const tempPath = `${responsePath}.tmp`;
fs.writeFileSync(tempPath, content, "utf-8");
fs.renameSync(tempPath, responsePath); // Atomic on POSIX
```

### 8. Extract sendOutreachFromFiles

**File to create:** `src/core/orchestrator/outreach-sender.ts`

Move `sendOutreachFromFiles()` from `phase-runner.ts` (L109–201) into this file. Modify to:
- Use `resolveContact()` for preferred channel routing (replace `for (plugin of sendPlugins)` loop)
- Validate person IDs against People Directory (skip + warn on unknown IDs)
- Populate `contacted` array and return it
- Include full questions summary in GitHub issue comment

**Signature:**
```typescript
export async function sendOutreach(
  taskId: string,
  outreachDir: string,
  deps: {
    peopleDirectory: IPeopleDirectory;
    registry: IRegistry;
    taskEngine: ITaskEngine;
    eventBus: IEventBus;
    observer: IObserver;
  },
): Promise<ContactedEntry[]>
```

### 9. Prompt Guidance Updates

**File:** `src/core/orchestrator/prompts/requirements-gathering.ts`

**Add to buildRequirementsInstructions() (around L97–129):**
```
When to block (signal need_more_info):
- Scope is ambiguous — multiple valid interpretations, no way to choose
- Security implications unclear — touching auth, permissions, data access
- Breaking change potential — public API, shared state, database schema
- Multiple people affected — need to coordinate, not just implement

When to proceed (signal ready):
- Direction is clear even if implementation details are uncertain
- You can make a reasonable choice and document it
- The task is well-scoped and self-contained

When writing outreach files, number your questions so the recipient can answer each one.
```

### 10. Reply Threading in Response Poller

**File:** `src/core/daemon/response-poller.ts`

**Modify processInboundMessage() (around L156–203):**
```typescript
// Before trying sole-task fallback, check reply threading:
// 1. If message has reply_to_message_id, look up which outreach message it replies to
// 2. Outreach messages are tracked in comm.message_sent events with message_id
// 3. Match reply_to → outreach message_id → task_id

// Also check for task reference pattern in message body:
const taskRefMatch = msg.content.match(/\[?Task:?\s*([a-zA-Z0-9]+)\]?/i);
if (taskRefMatch) {
  const taskId = taskRefMatch[1];
  // Verify task exists and is blocked
}
```

### 11. Rate Limit Awareness

**File:** `src/plugins/trigger/github-trigger/github-trigger.ts`

**After every Octokit API call, read rate limit headers:**
```typescript
const remaining = Number(response.headers["x-ratelimit-remaining"] ?? Infinity);
if (remaining < 100) { // Plugin-internal threshold — NOT in Core config
  // Plugin can slow its own poll interval or emit a health event
  // Core handles the error generically via adapter healthCheck()
}
```

**On 429 response, read Retry-After:**
```typescript
catch (error) {
  if (error.status === 429) {
    const retryAfter = Number(error.response?.headers?.["retry-after"] ?? 60);
    // Back off for exactly retryAfter seconds, not generic exponential
  }
}
```

---

## Response Correlation — Adapter-Level

Communication adapters returning messages from `pollMessages()` provide metadata that may include correlation fields. Core reads whatever the adapter provides — it never reaches into platform-specific threading mechanisms.

**Current metadata fields used by `linkMessageToTask()` (response-poller.ts L26-48):**
- `task_id` — direct match (from dashboard responses)
- `repo` + `issue_number` — match via `externalRefsMatch()` (from issue-scoped adapters)
- `reply_to` — available in message but not currently used for lookup

**Task reference fallback:** Outreach messages include `[Task: {short_id}]`. Response poller scans message text with regex. Works across any adapter, any platform.

---

## Testing Strategy

### Pure Function Extraction

| Function | Input | Output | Tests |
|----------|-------|--------|-------|
| `computePriority(labels, config)` | `string[]`, `Record<string, number>` | `number` | Empty labels → 50, single match, multiple matches (highest wins), no config matches → 50 |
| `isTerminalState(state)` | `TaskState` | `boolean` | All states: completed/failed = true, others = false |

### Integration Tests

| Scenario | What to Verify |
|----------|----------------|
| Restart dedup | Create task, restart daemon (clear cache), re-poll same event → no duplicate |
| Watermark persistence | Poll events, shutdown, restart → watermarks loaded, no re-fetch |
| Individual response files | Two responses from same source → two separate files, both readable |
| Label priority | Event with `urgent` label → task created with priority 80 |
| Blocked timeout | Block task, advance clock past threshold → escalation notification sent |
| Preferred channel routing | Two comm adapters with "send" → only person's preferred channel used |
| Dual-format ExternalRef | Old-format event (string) in DB + new code → replay doesn't crash |
| DB dedup with NULL external_ref | Trigger event with no external_ref → DB check skipped, task created |
| Concurrent unblock | Two responses for same blocked task → both response files written, task unblocked once |
| Person validation | Outreach file with unknown person ID → falls back to owner, warning logged |
| Contacted preservation | Block with contacted data → unblock → contacted data still accessible |

### Failure Tests (from panel)

| Scenario | What to Verify |
|----------|----------------|
| findByExternalRef on malformed JSON | Corrupted external_ref in DB → returns false, not crash |
| Watermark file corruption | Garbage in watermarks.json → plugin starts fresh, no throw |
| Preferred channel delivery failure | Primary channel fails → falls back to next contact |
| No contacts at all | Person + owner both unreachable → outreach skipped, warning logged |
| Atomic write failure | renameSync fails → error caught, task not in inconsistent state |
| Blocked timeout re-escalation | Already escalated → second tick does NOT re-send notification |

### Existing Test Impact

| Test File | Impact |
|-----------|--------|
| `src/core/daemon/trigger-poller.test.ts` | Update: external_ref now ExternalRef object, not string. Add: DB dedup tests, priority tests. |
| `src/plugins/trigger/github-trigger/github-trigger.test.ts` | Update: mapIssueToEvent returns ExternalRef. Add: watermark persistence tests. |
| `src/schemas/adapters.test.ts` | Update: TriggerEvent fixtures with new external_ref type (dual-format). |
| `src/schemas/events.test.ts` | Update: TriggerNewEventPayload fixtures. |
| `src/core/daemon/unblock-resolver.test.ts` | Update: response file format (individual files). Add: contacted preservation test. |
| `src/core/daemon/response-poller.test.ts` | Add: task reference regex tests. |
| `src/core/orchestrator/phase-runner.test.ts` | Update: sendOutreachFromFiles extracted. Add: person validation, contacted population. |

---

## Implementation Ordering

**Governing principle:** Core changes speak through adapter contracts. Plugin-internal improvements are clearly separated. No step should introduce knowledge of specific plugins into Core. Every step must pass the Plugin Blindness test: "If I deleted every plugin and replaced them, would Core still compile?"

**Phase 0 — Schema & Migration (no behavior change)**
1. Add optional `url: z.string().optional()` field to `ExternalRefSchema` (task.ts)
2. Change `external_ref` type in `TriggerEventSchema` (adapters.ts) and `TriggerNewEventPayloadSchema` (events.ts) — use `z.union([z.string(), ExternalRefSchema]).nullable()` for dual-format compatibility
3. Add `priority_labels` and `blocked_timeout_ms` to config schema (NOT `rate_limit_threshold` — that is plugin-internal)
4. Add migration 010: partial index on `json_extract(external_ref, '$.type')`, `json_extract(external_ref, '$.repo')`, `json_extract(external_ref, '$.number')` WHERE `state NOT IN ('completed', 'failed')`
5. Add `findByExternalRef(ref: ExternalRef): boolean` to task engine interface + implementation (query includes `type`)
6. Fix `externalRefsMatch()` to include `type` field in comparison, remove platform-specific comment
7. Update all test fixtures for new external_ref type (use generic `type: "test_issue"`, NOT platform-specific values)

**Phase 1 — ExternalRef Migration (Core + Plugin done together)**

This phase is a single atomic change: Core stops parsing URLs, plugin starts providing structured objects. Steps 8-9 and 13 must ship together.

8. Delete `parseGitHubUrl()` and `toExternalRef()` from trigger-poller.ts — Core no longer parses platform URLs
9. Update `processNewTriggerEvent()` to read `external_ref` directly from TriggerEvent
10. Purge platform type-string checks from Core — replace ALL `type !== "github_issue"` / `type !== "github_pr"` guards in `phase-runner.ts:217`, `orchestrator-notifier.ts:78`, and `notification-router.ts:256` with `issue_management` capability gates
11. Fix `linkMessageToTask()` in `response-poller.ts:41` — stop constructing `{ type: "github_issue" }`. Require full `external_ref` object in adapter message metadata
12. Fix URL construction in `notification-router.ts:283` — use `external_ref.url` instead of constructing platform-specific URLs
13. Trigger plugin: build structured `ExternalRef` (with `url` field) in `mapIssueToEvent()` — the plugin-side of steps 8-9

**Phase 2 — Core Bug Fixes & Improvements (adapter-agnostic)**
14. Add DB-backed dedup: `findByExternalRef()` check before `createTask()` in trigger-poller
15. Add label-based priority lookup in trigger-poller (reads `event.metadata.labels`, maps via config)
16. Fix response file overwrite: individual files `response-{timestamp}-{source}.txt` with atomic write in unblock-resolver
17. Fix `contacted` erasure: preserve `contacted` data when clearing blocked details in unblock-resolver
18. Add block/proceed criteria + "number your questions" to requirements-gathering prompt
19. Add max-loop escalation notification (via CommunicationAdapter, adapter-agnostic)
20. Verify blocked timeout in `checkBlockedEscalation()` — add "already escalated" guard

**Phase 3 — Outreach Extraction & Routing**
21. Extract `sendOutreachFromFiles()` to `outreach-sender.ts` (function, 3 deps: peopleDirectory, registry, observer)
22. Add zero-comm-adapter guard (if no "send" adapters, skip blocking, log warning, emit health event)
23. Add preferred channel routing via `resolveContact()` + Registry adapter lookup (no plugin names)
24. Add person ID validation (fall back to owner, dedup recipient)
25. Populate `contacted` array after successful delivery
26. Include questions summary in source issue comment (via `issue_management` capability check — no-op if no adapter)
27. Add task reference `[Task: {id}]` to outreach messages for response correlation

**Phase 4 — Plugin-Internal Improvements (confined to plugins)**
28. Trigger plugin: add watermark persistence (JSON file, atomic write, load on init, save on shutdown AFTER processing)
29. Trigger plugin: add ETag/conditional request support
30. Trigger plugin: respect `Retry-After` header on 429 responses

---

## Key Dependencies

| Package | Version | Used For |
|---------|---------|----------|
| `better-sqlite3` | existing | DB dedup query, json_extract, partial index |
| `pino` | existing | Debug logging for dedup suppression |

No new dependencies required. Plugin-specific dependencies (Octokit, grammy) are plugin-internal and not relevant to Core.

---

## Event Flow After Changes

Core components in **bold**. Adapter contracts in *italics*. Plugin-internal details in (parentheses).

```
External Event (any platform)
        │
        ▼
*TriggerAdapter.poll()* → TriggerEvent[]
  (Plugin-internal: caching, watermarks, rate limit handling)
  (Plugin returns structured ExternalRef + opaque idempotency_key)
        │
        ▼
**TriggerPoller.processNewTriggerEvent()**
  ├─ In-memory cache check (idempotency_key)
  ├─ **DB check** (findByExternalRef → non-terminal task exists?)
  ├─ Label → priority mapping (event.metadata.labels + config)
  ├─ Publish trigger.new_event
  ├─ **taskEngine.createTask**({priority, external_ref})
  └─ Transition intake → queued
        │
        ▼
**Daemon Tick Loop**
  ├─ **scheduler.scheduleNext()** → dispatch to Orchestrator
  └─ **Orchestrator.executeTask()**
        │
        ▼
**Requirements Gathering Phase**
  ├─ LLM reads: task desc, repo context, team contacts (roles)
  ├─ LLM decides: ready or need_more_info
  │
  ├─ [ready] → Continue to Research phase
  │
  └─ [need_more_info]
      ├─ LLM writes outreach/{person-id}.txt (numbered questions)
      ├─ **sendOutreach()** — extracted function:
      │   ├─ Validate person IDs against **People Directory**
      │   ├─ **resolveContact()** → preferred channel
      │   ├─ **Registry** lookup → *CommunicationAdapter* with matching channel
      │   ├─ *adapter.sendMessage()* — Core calls adapter contract, not plugin
      │   ├─ Populate **contacted** array
      │   └─ If adapter has *issue_management* capability → post summary comment
      ├─ Block task (state → blocked, set return_to_phase)
      └─ End session
            │
            ▼
**Response Poller** (daemon tick)
  ├─ Poll *CommunicationAdapter* plugins with *receive* capability
  ├─ For each inbound message (adapter-provided metadata):
  │   ├─ Check adapter metadata (task_id, repo, issue_number)
  │   ├─ Check task reference regex ([Task: abc123])
  │   └─ Sole-blocked-task heuristic (last resort, v1 only)
  ├─ Link message → blocked task
  └─ **UnblockResolver.tryUnblock()**
      ├─ Write response-{timestamp}-{source}.txt (atomic: temp+rename)
      ├─ Preserve contacted data
      ├─ Transition blocked → queued
      └─ Clear remaining blocked details
            │
            ▼
Re-dispatch → **Requirements Gathering** (resume)
  ├─ LLM reads: requirements.md, responses/*.txt, outreach/*.txt
  └─ Decides: ready or need_more_info again (max 5 loops)
            │
            ▼
  [If max loops hit] → Block + escalation via *CommunicationAdapter*
```
