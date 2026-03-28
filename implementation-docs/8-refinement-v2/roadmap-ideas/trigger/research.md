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
| `src/core/daemon/response-poller.ts` | Response detection | Add reply-threading check (Telegram `reply_to_message_id`, GitHub comment threading). Add task-reference regex scan as fallback. Plan for removing sole-blocked-task fallback (L156–169). |
| `src/schemas/config.ts` | Daemon configuration | Add `priority_labels` config field (after L156). Add `rate_limit_threshold` for proactive throttling. Add `blocked_timeout_ms` for blocked task watchdog. |
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
| `rate_limit_threshold` | `z.number().int().positive()` | `100` | Proactive throttle when remaining < threshold |
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
    WHERE json_extract(external_ref, '$.repo') = ?
      AND json_extract(external_ref, '$.number') = ?
      AND state NOT IN ('completed', 'failed')
    LIMIT 1
  `).get(ref.repo, ref.number);
  return row !== undefined;
}
```

**Migration (010):** Add index for performance:
```sql
CREATE INDEX IF NOT EXISTS idx_tasks_external_ref_repo
  ON tasks(json_extract(external_ref, '$.repo'), json_extract(external_ref, '$.number'));
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
if (remaining < config.rate_limit_threshold) {
  // Signal to trigger poller to increase poll interval
  // Could use a callback or emit a health event
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

## Reply Threading — Platform Details

### Telegram

- `doPollMessages()` in `telegram-comm.ts` (L161–206) calls `bot.api.getUpdates()`
- Each update has `message.reply_to_message.message_id` if it's a reply
- Outreach delivery returns `message_id` from `bot.api.sendMessage()` response
- **Correlation:** Store outreach `message_id` → `task_id` in `comm.message_sent` event payload. When reply arrives, look up `reply_to_message.message_id` in event history.

### GitHub

- Comments on an issue are inherently scoped to that issue
- `external_ref` already links task → issue via `repo + number`
- **Correlation already exists:** If a comment arrives on issue #42, and task T has `external_ref: {repo: "acme/app", number: 42}`, the match is automatic via `linkMessageToTask()` (response-poller.ts L38–44).
- GitHub reply threading not needed — issue-level scoping is sufficient.

---

## Outreach Dedup on Restart

When a blocked task re-enters requirements gathering after daemon restart:

1. Phase runner checks `{thoughtsDir}/requirements/outreach/` directory
2. If outreach files exist AND `{thoughtsDir}/requirements/responses/` has files → LLM already contacted people and got responses. Skip re-sending.
3. If outreach files exist AND no responses → Tricky case. Outreach was sent but no response yet. Check task.contacted array (now populated). If populated, don't re-send — the messages are already delivered.
4. If no outreach files → First run or files were cleaned up. Proceed normally.

---

## Testing Strategy

### Pure Function Extraction

| Function | Input | Output | Tests |
|----------|-------|--------|-------|
| `computePriority(labels, config)` | `string[]`, `Record<string, number>` | `number` | Empty labels → 50, single match, multiple matches (highest wins), no config matches → 50 |
| `isTerminalState(state)` | `TaskState` | `boolean` | All states: completed/failed = true, others = false |
| `formatResponseFilename(timestamp, source)` | `string`, `string` | `string` | Timestamp formatting, source sanitization |

### Integration Tests

| Scenario | What to Verify |
|----------|----------------|
| Restart dedup | Create task, restart daemon (clear cache), re-poll same issue → no duplicate |
| Watermark persistence | Poll issues, shutdown, restart → watermarks loaded, no re-fetch of old issues |
| ETag 304 | Poll repo (get ETag), poll again (nothing changed) → 304, no events returned |
| Preferred channel routing | Send outreach with Telegram+GitHub configured → only Telegram used |
| Individual response files | Two responses from same source → two separate files, both readable |
| Reply threading | Send outreach, receive reply → correctly linked to task via message_id |
| Label priority | Issue with `urgent` label → task created with priority 80 |
| Blocked timeout | Block task, advance clock past threshold → escalation notification sent |

### Existing Test Impact

| Test File | Impact |
|-----------|--------|
| `src/core/daemon/trigger-poller.test.ts` | Update: external_ref now ExternalRef object, not string. Add: DB dedup tests, priority tests. |
| `src/plugins/trigger/github-trigger/github-trigger.test.ts` | Update: mapIssueToEvent returns ExternalRef. Add: ETag tests, watermark persistence tests. |
| `src/schemas/adapters.test.ts` | Update: TriggerEvent fixtures with new external_ref type. |
| `src/schemas/events.test.ts` | Update: TriggerNewEventPayload fixtures. |
| `src/core/daemon/unblock-resolver.test.ts` | Update: response file format (individual files, not overwrite). |
| `src/core/daemon/response-poller.test.ts` | Add: reply threading tests. Update: sole-blocked-task fallback tests. |
| `src/core/orchestrator/phase-runner.test.ts` | Update: sendOutreachFromFiles extracted. Add: outreach dedup, contacted population. |

---

## Implementation Ordering

**Phase 0 — Schema & Migration (no behavior change)**
1. Change `external_ref` type in `TriggerEventSchema` (adapters.ts) and `TriggerNewEventPayloadSchema` (events.ts)
2. Add `priority_labels`, `rate_limit_threshold`, `blocked_timeout_ms` to config schema
3. Add migration 010 for `json_extract` index on tasks.external_ref
4. Update all test fixtures for new external_ref type
5. Add `findByExternalRef()` to task engine interface + implementation

**Phase 1 — Trigger Improvements (plugin-side)**
6. Build ExternalRef in `mapIssueToEvent()` (delete URL, return structured object)
7. Delete `parseGitHubUrl()` and `toExternalRef()` from trigger-poller.ts
8. Update `processNewTriggerEvent()` to use structured external_ref directly
9. Add ETag support to `pollIssues()`
10. Add watermark persistence (load on init, save on shutdown)
11. Add rate limit header reading + proactive throttle signal
12. Add label-based priority lookup in trigger-poller

**Phase 2 — Outreach & Communication**
13. Extract `sendOutreachFromFiles()` to `outreach-sender.ts`
14. Add preferred channel routing via `resolveContact()`
15. Add person ID validation (fall back to owner on unknown)
16. Populate `contacted` array after delivery
17. Include questions summary in GitHub issue comment
18. Add outreach dedup check (existing files + contacted array)
19. Add "number your questions" prompt guidance
20. Add block/proceed criteria to requirements gathering prompt

**Phase 3 — Response & Dedup**
21. Add DB-backed dedup (`findByExternalRef`) in trigger-poller
22. Change response files to individual files (write-temp-then-rename)
23. Add reply threading to response poller (Telegram message_id lookup)
24. Add task reference regex as fallback
25. Add max-loop escalation notification
26. Add blocked task timeout watchdog (verify checkBlockedEscalation covers it)

---

## Key Dependencies

| Package | Version | Used For |
|---------|---------|----------|
| `@octokit/rest` | existing | GitHub API (ETags, rate limit headers) |
| `grammy` | existing | Telegram API (message_id, reply_to) |
| `better-sqlite3` | existing | DB dedup query, json_extract |
| `pino` | existing | Debug logging for dedup suppression |

No new dependencies required.

---

## Event Flow After Changes

```
GitHub Issue Created/Updated
        │
        ▼
GitHubTriggerPlugin.doPoll()
  ├─ ETag check → 304? Skip.
  ├─ Watermark filter (since=last_updated_at)
  ├─ mapIssueToEvent() → TriggerEvent with structured ExternalRef
  └─ Return TriggerEvent[]
        │
        ▼
TriggerPoller.processNewTriggerEvent()
  ├─ In-memory cache check (idempotency_key)
  ├─ DB check (findByExternalRef → non-terminal task exists?)
  ├─ Label → priority mapping (Math.max)
  ├─ Publish trigger.new_event
  ├─ taskEngine.createTask({...priority, external_ref})
  └─ Transition intake → queued
        │
        ▼
Daemon Tick Loop
  ├─ scheduler.scheduleNext() → dispatch to Orchestrator
  └─ Orchestrator.executeTask()
        │
        ▼
Requirements Gathering Phase
  ├─ LLM reads: task desc, repo context, team contacts (roles)
  ├─ LLM decides: ready or need_more_info
  │
  ├─ [ready] → Continue to Research phase
  │
  └─ [need_more_info]
      ├─ LLM writes outreach/{person-id}.txt (numbered questions)
      ├─ sendOutreach() — extracted function:
      │   ├─ Validate person IDs against People Directory
      │   ├─ resolveContact() → preferred channel
      │   ├─ Send via matched comm plugin
      │   ├─ Record message_id for reply threading
      │   ├─ Populate contacted array
      │   └─ Post questions summary to GitHub issue
      ├─ Block task (state → blocked, set return_to_phase)
      └─ End session
            │
            ▼
Response Poller (daemon tick)
  ├─ Poll comm plugins (receive capability)
  ├─ For each inbound message:
  │   ├─ Check reply threading (reply_to_message_id → outreach message_id → task_id)
  │   ├─ Check task reference regex ([Task: abc123])
  │   └─ (Sole-blocked-task fallback — to be removed)
  ├─ Link message → blocked task
  └─ UnblockResolver.tryUnblock()
      ├─ Write response-{timestamp}-{source}.txt (atomic: temp+rename)
      ├─ Transition blocked → queued
      └─ Clear blocked details
            │
            ▼
Re-dispatch → Requirements Gathering (resume)
  ├─ LLM reads: requirements.md, responses/*.txt, outreach/*.txt
  ├─ Checks existing outreach files (dedup — don't re-send)
  └─ Decides: ready or need_more_info again (max 5 loops)
            │
            ▼
  [If max loops hit] → Block + escalation notification to owner
```
