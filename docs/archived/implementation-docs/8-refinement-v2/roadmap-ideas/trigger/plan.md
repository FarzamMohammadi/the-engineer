# Trigger & Requirements Flow — Implementation Plan

## Context

Layer 8 Runtime Phase Refinement for the Trigger & Requirements Flow subsystem. Sessions 079-080 completed ideation (4 rounds of expert panel review + co-founder line-by-line review). This plan translates `ideation.md` + `research.md` into executable implementation steps.

**Governing principles:**
1. **Plugin Opacity** — Core sees only adapters. No hardcoded plugin names, tokens, platform-specific checks. The test: "If I deleted every plugin, would Core still compile?"
2. **Fresh project, local-only** — Clean breaks always. No dual-format unions, no migration scripts for old data.

**All line numbers verified against current codebase on 2026-03-28.**

---

## Phase 0 — Schema & Foundation (no behavior change)

All schema changes are clean breaks (fresh project principle). No dual-format handling.

### 0.1 Add `url` field to ExternalRefSchema
- **File:** `src/schemas/task.ts:51-56`
- Add `url: z.string().optional()` to ExternalRefSchema
- Plugin provides display URL; Core reads it for linking, never constructs URLs

### 0.2 Change `external_ref` type in all schemas
- Full grep confirmed 5 locations that use `z.string()` for external_ref:
  1. `src/schemas/adapters.ts:81` — TriggerEventSchema → `ExternalRefSchema.nullable()`
  2. `src/schemas/adapters.ts:145` — SyncMetadataSchema → `ExternalRefSchema.nullable()`
  3. `src/schemas/adapters.ts:176` — TaskReconciliationInputSchema → `ExternalRefSchema.nullable()`
  4. `src/schemas/events.ts:81` — TaskCreatedPayloadSchema → `ExternalRefSchema.nullable()`
  5. `src/schemas/events.ts:217` — TriggerNewEventPayloadSchema → `ExternalRefSchema.nullable()`

### 0.3 Rename `issue_management` → `ticket_management` capability
- **File:** `src/adapters/communication.ts:144-157`
- Rename capability string: `"issue_management"` → `"ticket_management"`
- Rename methods: `commentOnIssue(repo, issueNumber, comment)` → `commentOnTicket(externalRef: ExternalRef, comment: string)`
- Rename: `createIssue()` → `createTicket()`, `updateIssue()` → `updateTicket()`
- Update all Core code that checks for this capability
- Update GitHub comm plugin implementation

### 0.4 Add `findByExternalRef()` to task engine
- **File:** `src/core/interfaces/task-engine.interface.ts` — add after L86
- **File:** `src/core/task-engine/queries.ts` — add implementation with `json_extract` query
- Query: `SELECT 1 FROM tasks WHERE json_extract(external_ref, '$.type') = ? AND json_extract(external_ref, '$.repo') = ? AND json_extract(external_ref, '$.number') = ? AND state NOT IN ('completed', 'failed') LIMIT 1`
- Returns `boolean` (minimal API)
- Match on `type + repo + number` (type-aware for dedup, per ideation)

### 0.5 Add migration 010: partial index for dedup query
- **File:** `src/db/migrations/010_external_ref_dedup_index.sql`
- Partial index on `json_extract(external_ref, '$.type')`, `json_extract(external_ref, '$.repo')`, `json_extract(external_ref, '$.number')` WHERE `state NOT IN ('completed', 'failed')`
- Performance optimization for the DB-backed dedup query

### 0.6 Document `externalRefsMatch()` divergence
- **File:** `src/core/daemon/unblock-resolver.ts` (where `externalRefsMatch` lives)
- Add comment explaining deliberate divergence: dedup is type-aware (`findByExternalRef`), unblock is type-agnostic (`externalRefsMatch` — repo + number only)

### 0.7 Update all test fixtures
- 11 test files use `"github_issue"` / `"github_pr"` hardcoded strings
- Replace with generic `"test_issue"` / `"test_pr"` in test fixtures (NOT in plugin code where platform-specific values are correct)
- This is significant work — own commit

---

## Phase 1 — ExternalRef Migration (Core + Plugin atomic)

Steps must ship together — Core stops parsing URLs, plugin starts providing structured objects.

### 1.1 Delete `parseGitHubUrl()` and `toExternalRef()` from Core
- **File:** `src/core/daemon/trigger-poller.ts`
- Delete L216-245 (regex + both functions)
- Delete L126-129 (call site in `processNewTriggerEvent()`)
- Replace with: `const externalRef = event.external_ref;` (already structured from plugin)

### 1.2 Purge ALL Plugin Opacity violations from Core
- Replace type-string checks with `ticket_management` capability gates:
  - `src/core/orchestrator/phase-runner.ts:217` — `if (type !== "github_issue"...)` → check `hasCapability("ticket_management")`
  - `src/core/orchestrator/orchestrator-notifier.ts:78` — same pattern
  - `src/core/daemon/notification-router.ts:256` — same pattern
- Fix plugin ID construction:
  - `src/core/orchestrator/orchestrator-notifier.ts:39` — `p.manifest.id === \`${contact.channel}-comm\`` → use Registry capability lookup
- Fix ExternalRef construction in response poller:
  - `src/core/daemon/response-poller.ts:41` — stop constructing `{ type: "github_issue" }`. Require full `external_ref` in adapter message metadata
- Fix URL construction:
  - `src/core/daemon/notification-router.ts:283` — use `external_ref.url` instead of constructing `https://github.com/...`

### 1.3 GitHub trigger plugin: build structured ExternalRef
- **File:** `src/plugins/trigger/github-trigger/github-trigger.ts`
- Modify `mapIssueToEvent()` (L154-177): `external_ref: issue.html_url` → structured `{ type: "github_issue", repo: "owner/repo", number: issue.number, url: issue.html_url }`

---

## Phase 2 — Core Bug Fixes & Improvements

All changes are adapter-agnostic. No plugin knowledge in Core.

### 2.1 DB-backed dedup
- **File:** `src/core/daemon/trigger-poller.ts`
- In `processNewTriggerEvent()` (L98-146): after hot cache check, add `findByExternalRef()` cold path before `createTask()`
- Hot cache remains as performance optimization; DB is correctness guarantee

### 2.2 Ticket variable extraction (`@priority:`)
- **Create:** `src/core/daemon/event-variables.ts`
- Pure function `extractEventVariables(body: string | null): EventVariables`
- Extracts `@priority: <number>` (range 1-100, default 50 if absent)
- Wire into `processNewTriggerEvent()` before `createTask()`

### 2.3 Fix response file overwrite bug
- **File:** `src/core/daemon/unblock-resolver.ts:133`
- Change `${source}.txt` → `response-${Date.now()}-${source}.txt` (`Date.now()` = epoch milliseconds, e.g. `1711612800000` — full timestamp precision for uniqueness)
- Atomic write: temp file + `fs.renameSync`

### 2.4 Fix `contacted` erasure on unblock
- **File:** `src/core/daemon/unblock-resolver.ts:108`
- Instead of `updateTaskField(taskId, "blocked", null)`, clear individual sub-fields while preserving `contacted`
- Set `reason`, `needed`, `waiting_for` to null, `efforts_made` to `[]`, keep `contacted` intact

### 2.5 Delete `pendingBasePriorities` buffer
- **File:** `src/core/daemon/trigger-poller.ts:47`
- Remove redundant second Map. Simplify `drainNewBasePriorities()` to return full `basePriorities` map directly

### 2.6 Prompt guidance updates
- **File:** `src/core/orchestrator/prompts/requirements-gathering.ts`
- Add block/proceed criteria (scope ambiguous → block, direction clear → proceed)
- Add "number your questions" for outreach

### 2.7 Verify blocked timeout escalation
- Existing `response_timeout.blocked.stages` config (config.ts:545-593) already covers escalation (reminder 4h, self-unblock 8h, escalation 48h) — **no new config field needed** (confirmed with co-founder)
- `checkBlockedEscalation()` (daemon/index.ts:457) calls into health monitor
- Verify event bus query prevents re-escalation spam (per ideation/Hipp finding)

---

## Phase 3 — Outreach Extraction & Routing

### 3.1 Extract `sendOutreachFromFiles()` to own file
- **Create:** `src/core/orchestrator/outreach-sender.ts`
- Move from `phase-runner.ts` (L109-201)
- Signature: `sendOutreach(taskId, outreachDir, deps) → Promise<OutreachResult>`
- `OutreachResult = { delivered: true, contacted: ContactedEntry[] } | { delivered: false, reason: "no_send_adapters" | "all_delivery_failed" }`
- Dependencies injected: `{ peopleDirectory, registry, eventBus, observer }`

### 3.2 Zero-comm-adapter guard
- If no adapters with "send" capability → return `{ delivered: false, reason: "no_send_adapters" }`, log warning
- Phase runner does NOT block when delivery fails

### 3.3 Preferred channel routing
- Use `resolveContact(personId)` → preferred channel
- Find comm adapter with matching channel via Registry capability lookup (no plugin names)
- Fall back to owner if person's channel fails (max depth 1)

### 3.4 Person ID validation
- Validate outreach filenames against People Directory
- Apply `path.basename()` to filenames (path traversal prevention from LLM output)
- Unknown person → fall back to owner with note

### 3.5 Populate `contacted` array
- **File:** `src/core/orchestrator/phase-runner.ts:685`
- After successful outreach delivery, populate `contacted` with `{ person, channel, timestamp }`

### 3.6 Source ticket comment with questions
- Check `hasCapability("ticket_management")` on comm adapter
- If capable + task has `external_ref` → `commentOnTicket(externalRef, fullOutreachContent)`
- No adapter = no-op

### 3.7 Add task reference to outreach
- Include `[Task: {short_id}]` in outreach messages for response correlation

### 3.8 Owner-must-exist pre-flight check
- Add doctor/pre-flight check: People Directory must have at least one person with role 'owner'
- Validate at startup, not at outreach time

---

## Phase 4 — Plugin-Internal Improvements

Confined to plugins. Core is unaware. Separate commits.

### 4.1 Watermark persistence
- **File:** `src/plugins/trigger/github-trigger/github-trigger.ts`
- Load from `~/.engineer/state/{plugin_id}/watermarks.json` on init
- Save with atomic write (temp+rename) on shutdown AFTER processing
- Corrupt file → start fresh

### 4.2 ETag/conditional request support
- Add `etags` map, send `If-None-Match` header, handle 304 responses
- Performance optimization only

### 4.3 Rate limit header handling
- Read `x-ratelimit-remaining`, respect `Retry-After` on 429
- Plugin-internal threshold, NOT in Core config

---

## Verification Plan

### Automated
- `pnpm test` — all existing + new tests pass
- `pnpm lint` — zero Biome warnings, zero TypeScript errors
- Boundary enforcement test passes (no plugin imports in Core)

### Manual Checks
- Grep for `"github_issue"` / `"github_pr"` in `src/core/` → zero results
- Grep for `parseGitHubUrl` → zero results in Core
- Grep for `issue_management` / `commentOnIssue` → zero results (all renamed)
- Grep for `external_ref.*z\.string` in schema files → zero results

### Integration Test Scenarios (from ideation)
- Restart dedup: create task, clear cache, re-poll → no duplicate
- Individual response files: two responses from same source → two files
- Ticket priority: `@priority: 80` → task priority 80; absent → default 50
- Zero comm plugins: outreach needed → skip blocking, log warning
- Contacted preservation: block with data → unblock → contacted intact
