# Session 61 — Slice 10 (Communication) BUILD, S5: inbound query routing fix + enrichment (Pillar C)

> On `slice10-build`, on top of S4 (`e34f259`). Implements plan § S5 as one unit of work (code + tests +
> docs + observability). Two green commits: `0bde17e` (code + tests), `2ebfb24` (docs + bundled mirror).

## What happened

The inbound query handler (`status` / `progress #N` / `cost` / `help`) was reachable in name only.
`response-poller.processInboundMessage` linked **every** inbound message to a task (metadata, else the
sole-blocked fallback) before it could be seen as a query, then published a non-null `task_id` and called
`tryUnblock`. The one path to `handleQuery` (the `daemon:comm` subscription, which fires only on a
`task_id=null` event) never received one. So a Telegram "status" sent while exactly one task was blocked was
mis-attributed as that task's unblock reply.

### (1) Classify before the sole-blocked fallback

New pure `classifyInbound(hasLinkedTask, content, blockedCount): InboundRoute` in `response-poller.ts`,
decided in this order:
1. Metadata link (`task_id` / `external_ref`) → `linked_reply`.
2. Query vocabulary (`status` / `cost` / `progress #N` / `help`) → `query`. **This wins over the
   sole-blocked reply** (the locked gate decision: the owner can ask `status` mid-block; the accepted cost
   is that a free-text reply literally containing "status"/"cost" reads as a query — fine for single-user).
3. Exactly one task blocked → `sole_blocked_reply`.
4. Zero or 2+ blocked → `query` (with reason `no_blocked_task` / `unmatched_multi_blocked`).

The poller calls `handleQuery` **directly** (still publishing a `task_id=null` `comm.message_received` for
the audit trail) and the redundant `daemon:comm` subscription (`daemon/index.ts`) is **removed**. That
closes the latent external_ref double-dispatch (a linked external_ref message used to publish `task_id=null`
→ fire `handleQuery` AND call `tryUnblock`): a linked message is now classified `linked_reply` and only
unblocks. `ResponsePollerContext` (`daemon/types.ts`) widened with `safetyLayer` / `notifications` /
`peopleDirectory` so the poller can build `QueryHandlerDeps` and resolve the owner.

### (2) status_response → owner

`handleQuery` previously set `personId` to the raw sender (a Telegram username), which `getPerson()` can't
resolve — it worked only by the router's accidental `getOwner()` fallback. Now `handleQuery` resolves the
recipient to `peopleDirectory.getOwner().id` explicitly (single-user: the sender is the owner); no owner →
a `warn` and no reply (owner-assumed-not-required).

### (3) Enriched formatters

`status` lists active + blocked tasks by short id + title (blocked carry their `blocked.reason`) plus a
one-line count of the other states; `progress #N` adds the block reason; `cost` surfaces the verdict
`reason` plus the per-window percent-of-limit `warnings`; `help` enumerates the supported forms. All short
and plain (Universal Audience) — the dashboard stays the full surface.

### (4) 2+-blocked unmatched → owner notice

A token-less non-query message arriving while 2+ tasks are blocked is no longer silently discarded — it is
routed to the query handler with `reason: unmatched_multi_blocked`, which replies "couldn't match this to a
blocked task — N are blocked" and points at the unambiguous reply form (reply on the task's ticket).

### (5) Observability + cleanup

`recordDecision("inbound_route", …)` records the query-vs-reply classification (invisible until now;
confidence 0.5 for the genuinely-ambiguous `unmatched_multi_blocked`, else 1) and `observe(lifecycle,
"inbound_query_handled", …)` fires per served query. The stale `daemon:comm` "deferred topology" comment in
`bootstrap.ts` is corrected to explain the poller calls `handleQuery` directly (no bus subscription).
Vocabulary stays slash-free (Telegram drops `/`-commands).

### Docs

`docs/plugins/communication/README.md` gains an "Inbound queries" section (vocabulary table + the
classification order + single-user owner resolution); `telegram-comm.md` gains a "Querying from Telegram"
note. Both mirrored into `cli/bundled/plugin-docs.ts` (parity diffed clean). `docs/future-considerations.md`
Smart Reply Correlation corrected: the `[Task: …]` tag is a breadcrumb only — it is NOT parsed on receive;
inbound correlation is structural (metadata, else sole-blocked), and the inference layer is reframed as the
disambiguator for the currently-unmatchable 2+-blocked metadata-less case.

## Reality vs. research

- The answer-injection gap is already fixed on main (`68a7`) as the grounding note said — untouched.
- The `[Task: …]` token IS appended on send (`outreach-sender.ts:67`, `orchestrator/index.ts:483`) but is
  **never parsed on receive** — confirmed by grep. The future-considerations claim that it is parsed back
  was the overstatement S5 was asked to correct.
- The `daemon:comm` subscription was live (research said so) but unreachable from the poller; removing it is
  the clean fix, not a behavior regression (the dashboard path is task-scoped and handled by `scanEventBus`).

## Decisions / deviations

- **Cost "spend-vs-limit" via the existing verdict, no contract change.** The plan said "real spend-vs-limit."
  `ISafetyLayer.consultJudgment("cost_check")` returns a verdict + `warnings` (the warnings already carry the
  per-window percent-of-limit near a ceiling); `CostStatus` (raw dollars) is not on the interface and does
  **not** include the limits, so exposing it would not show "vs limit" any better than the warnings already
  do. Surfaced the verdict `reason` + `warnings` instead of adding a `getCostStatus` method — minimal
  footprint, no new surface. (Flag for the S6 audit if richer dollar figures are wanted later.)
- **`recordDecision` on every inbound message**, not just queries. Per maximal-observability (err toward more
  detail for Core), the classification is a genuine fork worth showing — including normal unblock replies.

## Gates

- **lint:** PASS (biome + tsc + tsc-test + knip + madge; 0 errors. 3 pre-existing
  `noExcessiveCognitiveComplexity` warnings, ALL in `notification-router.ts` — S1's file, outside S5 scope.)
- **typecheck:** PASS (`tsc --noEmit` on src + test tsconfig, clean).
- **tests:** PASS (2542 unit [+13 over S4's 2529] + 64 integration + 16 e2e; production build OK incl.
  dashboard). New: `classifyQuery`/`isQueryVocabulary`, enriched formatters, owner resolution + no-owner,
  unmatched-multi-blocked notice (query-handler.test.ts); `classifyInbound` precedence + the 5 routing gate
  tests (sole-blocked+status→query, sole-blocked+free-text→unblock, 0/2+blocked+status→query, the
  task_id=null audit, the couldn't-match notice) + PR-review-pending non-regression (response-poller.test.ts).

## Next

S6 — AUDIT-1: full-file line-by-line sweep of every Slice-10-touched source + test file vs
coding-standards / anti-patterns / the three observability tests. Then S7 — AUDIT-2: docs + bundled-mirror
drift sweep.
