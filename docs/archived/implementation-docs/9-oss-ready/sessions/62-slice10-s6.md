# Session 62 — Slice 10 (Communication) BUILD, S6: AUDIT-1 (code + tests standards sweep)

> On `slice10-build`, on top of S5 (`ed0bd29`). The slice-closing code sweep per plan § S6 and
> `feedback_slice_closing_standards_sweep`. One green commit: `fde4587`.

## Scope

A full-file, line-by-line read of every source + test file Slice 10 touched across Sessions 57–61
(the diff against the slice base `17c43894`) against `docs/coding-standards.md`, `docs/anti-patterns.md`,
and the three observability tests (debuggability / owner-sync / external-reach) from `philosophy.md` and
`architecture/observability.md`. Hunting deliberately, not just re-reading.

Source files read in full: `notification-router.ts`, `query-handler.ts`, `response-poller.ts`,
`daemon/{types,index,health-monitor,task-scheduler}.ts`, `orchestrator/index.ts`,
`pipeline/{runner,agent-step,types,agent-prompt}.ts`, `safety-layer/{index,policy-engine}.ts`,
`interfaces/safety-layer.interface.ts`, `workspace-reaper/index.ts`, and the schema/dashboard/sub-phase
diffs (`config`, `events`, `notifications`, `orchestrator`, `task`, the six pipeline sub-phases, the two
dashboard client vocab files, `bootstrap.ts`). Tests: read `outreach-routing.test.ts` and
`query-handler.test.ts` in full; surveyed the rest for naming (no "should"), nesting depth (≤2),
disabled tests (none), and boundary-only mocking.

## Verdict

The Slice 10 work was **overwhelmingly clean** — the per-session closing discipline held. The runner,
orchestrator, workspace-reaper, safety-layer, query-handler, and response-poller are exemplary: FCIS
respected (pure decisions extracted from effects), rich JSDoc that explains the *why*, isolated failure
boundaries, schema-first single-source types, and complete observability. Most of the audit was
confirming quality, not fixing it.

## Findings + fixes

### MUST FIX — lint gate red (3 cognitive-complexity warnings)

The daemon's only lint findings were three `noExcessiveCognitiveComplexity` warnings, all in the rebuilt
`notification-router.ts` (S1's file): `sendToFirstReachable`'s async IIFE, `processRetries`, and the retry
redelivery IIFE. Every prior Slice-10 session noted them as "pre-existing, out of scope" — but the project
gate forbids warnings (Definition of Done item 6), the file is Slice-10-touched, and the slice-closing
sweep is exactly where they belong. Split along the natural seams (no `biome-ignore` suppression):

- **`processRetries`** → extract a pure **`decideRetryFate(entry, now)`** returning
  `RetryExhaustedReason | "due" | "wait"` (the per-entry eviction policy — in-flight / terminal / max-age /
  max-attempts / interval — as one readable table), plus an **`emitRetrySucceeded`** sibling to the existing
  `emitRetryExhausted`. The loop now reads "decide, then act".
- **the retry redelivery** → split the `inFlight`/error bookkeeping shell (**`attemptRetryDelivery`**) from
  the plain "did it land?" async (**`redeliverEntry`**, returns `boolean`).
- **`sendToFirstReachable`** → lift the all-contacts-failed branch (the `comm.send_failed` event + the
  `notification_send_failed` observation + the retry enqueue) into **`handleAllContactsFailed`**, leaving
  the IIFE as just the delivery loop.

**Every emission is preserved verbatim** — the four `comm.*` events (`message_sent`, `send_failed`,
`retry_succeeded`, `retry_exhausted`), the four `tool_execution` observations, and the
`notification_suppressed` decision. Verified by grep (same types/names) and by the notification-router
suite (which asserts the deliver/fail/retry observations) passing unchanged. The refactor moved control
flow only; the dashboard's outbound trail is byte-equivalent.

### SHOULD FIX — consistency

- **Stray mid-file import**: `import type { INotificationRouter }` sat after the templates const (line 67)
  of `notification-router.ts`. Moved to the top import block (newspaper order).
- **Raw `"alert"` literals**: the daemon's four health-alert `notify` calls (`daemon/index.ts`) used the raw
  string `"alert"` where `task-scheduler.ts` and `workspace-reaper.ts` use `NotificationKinds.alert`. S1
  actively edited these object literals (it added the `source` field) but left the literal. Switched to the
  constant — the `notifications.ts` JSDoc literally says "Use instead of raw strings". (The `switch`
  case-labels in `recipientsForKind`/`kindToMessageType` were left as string literals — that is correct
  case-discrimination over a typed union, not value construction.)

### Reviewed and judged acceptable (no change)

- **`ObservationTypes.lifecycle`** is used in exactly three Slice-10 spots: `task_picked_up`,
  `pipeline_completed`, `inbound_query_handled`. All three are genuine lifecycle milestones, not a
  catch-all overload — the routing *decision* behind a query is separately a `decision_point`
  (`inbound_route`). Standard satisfied.
- **`const dir = (ctx) => resultDirectory(ctx, PHASE_DIR)`** in the six pipeline sub-phases — § 1 favors
  `function` declarations for named functions, but this is a one-line closure shared into two object fields
  (`directory` + `resultDir`); writing it as a declaration adds verbosity for no clarity, and it is
  consistent across all six files. Deliberate judgment call (anti-patterns: apply with judgment).
- **`health-monitor`'s `attemptSelfUnblock(...).then(onResolve, onReject)`** — the two-arg `.then` form does
  handle the rejection, so it is not a floating promise; the self-unblock skip for `awaiting_human_decision`
  records via `observer.info` (a deterministic policy gate, not a judgment between alternatives — the
  surrounding escalation stages emit their own observations). Acceptable.
- **`SafetyVerdict` mutability** (`result.warnings = warnings`) is a localized builder on a freshly-created
  object, not a shared/input mutation; pre-existing, not slice-introduced.
- **`DecisionsSchema` validated in `agent-step.mapResult` AND re-parsed in `runner.readSurfacedDecisions`**
  is not a dual source of truth — same schema, validate-at-boundary then recover-the-type on read, with the
  runner JSDoc documenting exactly that. Acceptable per "parse, don't validate".

### Observability tests

- **Debuggability**: the autonomy escalation, inbound routing, suppression, termination routing, crash
  recovery, and cancel reconciliation each record a `decision_point`/`state_transition` with alternatives +
  reasoning; agent runs are `agent_call` spans with drill-down blobs; failures `recordError` with the stack.
- **Owner sync**: the new `awaiting_human_decision` block category is mirrored into **both** dashboard client
  files (`vocabulary.ts` BLOCK_CATEGORIES + `constants.ts` BLOCK_CATEGORY_LABELS) — the
  `vocabulary-parity.test.ts` guards it. Stored-is-surfaced holds.
- **External reach**: the notification router's deliver/fail/retry path is fully observable; the no-owner
  ask path warns loudly; health alerts route through the dedup'd suppress window.

## Out of scope (noted, not done — they belong to S7)

- The `cli/bundled/{plugin-docs,templates}.ts` mirror-vs-markdown drift and the `DEFAULT_AUTONOMY_DECISIONS`
  ↔ safety-template ↔ agent-prompt category-vocabulary sync are S7 (AUDIT-2 — docs + bundled-mirror sweep).
  I read the code side of these couplings and they are internally consistent; the line-by-line markdown diff
  is S7's job.

## Gate results

- **Lint**: PASS — `biome check` clean, `tsc --noEmit` clean, `tsc --noEmit -p tsconfig.test.json` clean,
  `knip` clean, `madge --circular` clean. **0 warnings** (the 3 cognitive-complexity warnings are gone).
- **Typecheck**: PASS (exit 0).
- **Tests**: PASS — 2542 unit + 64 integration + 16 e2e, all green.

## Reality-vs-research

No new discrepancies. The S5 handoff notes (answer-injection already fixed on main `68a7`; the
`[Task: …]` tag appended-on-send-never-parsed-on-receive) still hold and are reflected in code + docs.

## Next

S7 (AUDIT-2 — docs + bundled-mirror drift sweep, Slice-10 docs only), then the owner's final hands-on
review before merging `slice10-build` → `main`.
