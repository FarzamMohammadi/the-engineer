# Handoff: Slice 11 — Unit 1b (Cost enforcement + dashboard surfacing)

**Branch**: `slice11-background-services` (worktree `the-engineer-slice11`) | **Status**: complete, all gates green.

## What changed and why

Implements plan decisions D4 (global breaches terminate in-flight work + one global alert) and D1
(delete the dead `cost.quota_exhausted` event; surface `cost.limit_reached` legibly). Tests + README in
the same commit. Did NOT touch the cost-tracker accumulation internals from Unit 1a.

### D4 — daily/monthly breaches now terminate in-flight work + fire ONE global alert

- **`src/core/daemon/cost-limit-queue.ts`** — the queue is now backed by `Map<string, { ownerAlert }>`
  instead of a `string[]`.
  - `add(taskId, ownerAlert)` dedups by taskId and OR-combines `ownerAlert`
    (`pending.set(taskId, { ownerAlert: (existing?.ownerAlert ?? false) || ownerAlert })`).
  - `process()` drains the Map; per entry, if `task.state === active`: terminate via
    `dispatchTracker.terminate` (idempotent), then — if `ownerAlert` — notify `cost_limit` (owner DM)
    **and** `ticket_comment`; else `ticket_comment` ONLY. This removes the **same-tick double ticket
    comment** (Map dedups by taskId) and the **N owner DMs** for a global breach (ownerAlert=false path).
  - The `recordDecision`/`warn` per terminated task is unchanged; the warn now carries `ownerAlert`.

- **`src/core/daemon/index.ts`** — the `daemon:cost` subscription branches on `task_id`:
  - **task_id truthy** (per-task or provider): `costLimitQueue.add(p.task_id, true)` — owner DM stays.
  - **task_id null** (global daily/monthly): fire **exactly one** owner alert
    (`kind: alert, taskId: null, source: \`cost:${p.limit_type}\``) naming the limit_type, the
    current_spend/limit_value, and `ids.length` in-flight tasks being terminated; then
    `const ids = scheduler.getActiveTaskIds(); for (const id of ids) costLimitQueue.add(id, false)`.
    The `cost:daily`/`cost:monthly` source rides the router's alert dedup (keyed on `source`) so a
    flapping breach does not re-spam. `scheduler.getActiveTaskIds()` returns the in-flight dispatch set
    (delegates to `dispatchTracker.getActiveTaskIds()`); the queue's `state === active` guard is the
    second gate. The alert fires even when `ids.length === 0` — the owner must hear the global budget is
    exhausted even with nothing running (new work would be denied).

Confirmed in `notification-router.ts`: alerts dedup on `source` (`dedupKeyFor`), and `ticket_comment` is
exempt from the suppress window (early-returns before `isSuppressedDuplicate`). Per-task/provider
behavior is unchanged.

### D1 — delete the dead `cost.quota_exhausted` event; surface `cost.limit_reached` legibly

`cost.quota_exhausted` was declared + payload-schema'd + read by three surfaces but **published by no
one**. All three readers handled in this commit (grepped first; only `errors.test.ts` referenced it in
tests):
1. **`src/schemas/events.ts`** — deleted the enum member, `CostQuotaExhaustedPayloadSchema` + type, the
   `EventPayloads` map entry, and the `eventPayloadSchemas` map entry.
2. **`src/dashboard/api/errors.ts`** — `ERROR_EVENT_TYPES` drops `cost.quota_exhausted`, adds
   `cost.limit_reached`. New `costLimitReachedMessage(payload)` + a typed branch in `errorEventMessage`
   render the breach from its real payload:
   - **USD breach** (`limit_scope` null): `"<limit_type> cost limit reached: $<current_spend> of
     $<limit_value>"`.
   - **Provider breach** (`limit_scope` set): `"<limit_scope> daily request cap reached: <current_spend>
     of <limit_value>"` — **no `$`**, because per Unit 1a the provider payload's current_spend/limit_value
     are REQUEST COUNTS, not USD.
   Without this the page rendered the bare token `cost.limit_reached` (the payload lacks the prose keys
   `errorEventMessage` probes).
3. **`/quota` "Recent Exhaustion Events"** — deleted as dead surface (owner-decided): the
   `exhaustion_events` query/field in `metrics.ts` (`/quota` handler), the client block in
   `quota-status.tsx`, and the `exhaustion_events` field in `types/api.ts`. Removed the now-unused
   `fromSqliteJson` import from `metrics.ts` (knip would flag it). `use-metrics.ts` needed no change — it
   only references the `QuotaStatus` *type*, not the field. The live provider-quota bars (from the
   `quota_status` observation) STAY; `available` now reflects only `liveQuota !== null`.

### README

`README.md` § Safety "Cost ceilings" — clarified that a global daily/monthly breach terminates every
in-flight task at once and sends a **single** alert naming the limit and how many tasks it stopped, never
one DM per task. Per-task/provider still terminates that one task and DMs.

## Tests

- **`tests/unit/core/daemon/cost-limit-queue.test.ts`** — existing tests updated to the new
  `add(taskId, ownerAlert)` signature (per-task path passes `true`). Two new behavior-as-fact tests:
  - `terminates every task enqueued for a global breach without DMing the owner per task` — 3 tasks
    enqueued ownerAlert=false → 3 terminates, **0** `cost_limit` DMs, 3 ticket_comments.
  - `comments once when a task is enqueued by both a per-task and a global breach in one tick` — same
    taskId added (true) then (false) → terminated once, **1** ticket_comment (no double), 1 cost_limit DM
    (ownerAlert OR-combined to true).
- **`tests/unit/dashboard/api/errors.test.ts`** — `cost.quota_exhausted` references repointed to
  `cost.limit_reached`. Two new render tests: a USD breach renders `"monthly cost limit reached: $512.5
  of $500"` (not the bare type); a provider breach renders `"claude-code-agent daily request cap reached:
  200 of 200"` with **no `$`**.
- **`tests/unit/core/daemon/index.notifications.test.ts`** — new daemon-level test driving the real
  `cost.limit_reached` subscription callback: a `task_id=null` daily breach fires **exactly one** global
  alert (`"Global daily cost limit reached … $52.4 of $50"`) through the real notification router, never a
  per-task `cost_limit` DM. (Driving N real in-flight dispatches is heavy in this harness; the isolated
  queue tests above already lock the per-N termination + no-double-comment behavior.)

## Gate results

- `pnpm run typecheck` — green (src + test configs).
- `pnpm run lint` — green (biome + tsc + knip + madge; no findings in touched files; 3 pre-existing knip
  processed-file warnings).
- `pnpm test tests/unit/core/daemon/cost-limit-queue.test.ts tests/unit/dashboard
  tests/unit/core/safety-layer tests/unit/core/daemon/index.notifications.test.ts` — 247 passed.
- Wider check: `tests/unit/core/daemon tests/unit/schemas tests/unit/core/event-bus` — 571 passed
  (confirms the event deletion broke no schema/event-bus/daemon test).

## What the next unit must know

- **`cost.quota_exhausted` is gone.** Any future cost-breach surface reads `cost.limit_reached`
  exclusively. The errors page is the one place cost breaches now render for the owner.
- **`cost:daily` / `cost:monthly` are reserved alert `source` values** for the global-breach dedup. Reuse
  them if you touch global cost alerting; don't invent a parallel key.
- **Provider-breach numbers are request counts, not USD** (limit_scope set). Any new render of a
  `cost.limit_reached` provider breach must not prefix `$` — `errors.ts costLimitReachedMessage` is the
  single place that gets this right today.
- **D2/D3/D4-note (Unit 1a) accumulation internals were not touched** — out of scope per the mandate.
- Remaining `quota` references in `docs/plugins/agent/*.md` are the **LLM-adapter quota-reporting
  capability** (rate-limit detection), a different live concept from the deleted Core event — leave them.
