# Session 57 (Slice 10 build) — 2026-06-04

Slice 10 (Communication), **S1 of the build plan: notification-router refinement** (Pillar A).
Branch `slice10-build` (isolated worktree). Footwork: `.claude/temp/{requirements-gathering,research,create-plan}/slice-10-communication.md` (Session 56). Plan section: `create-plan` § S1.

> Naming note: this is the first **build** session of Slice 10. It collides on the counter with the
> Dashboard Sync tangent's `sessions/57.md` (a different branch), so this log is `57-slice10-s1.md`.

## What I did

Five things, as one unit of work (code + tests + docs + observability):

1. **Outbound observability.** The router emitted nothing to the observation store — the entire
   outbound path was invisible on the dashboard. Now every outcome emits a `tool_execution`
   observation alongside its existing `comm.*` event: `notification_delivered`,
   `notification_send_failed`, `notification_retry_succeeded`, `notification_retry_exhausted`. A
   suppressed duplicate records a `decision_point` (`notification_suppressed`) with the road not taken.
   No new ObservationType or `comm.*` event (per the research/observability doc); both
   `tool_execution` and `decision_point` are already rendered by the dashboard.

2. **Unified suppression.** Deleted the daemon's hardcoded `HEALTH_NOTIFY_COOLDOWN_MS` +
   `healthNotifyCooldowns` map + `shouldNotifyHealth` + the tick Step-9 cleanup. The router now owns one
   suppress window, keyed on `(kind, taskId | alert source)`. Added an optional `source` to the alert
   `Notification` variant so null-task alerts (trigger/plugin health alerts) dedup per origin
   (`trigger:<id>`, `plugin:<id>`, `plugin-unhealthy:<id>`); the stuck alert and reaper-failure alert
   carry a real `taskId` and dedup on that. The 5 daemon health alerts + the reaper alert all route
   through the window. The window config moved to `DaemonConfig.notification_suppress_window_ms`
   (default 5m) — passed to the router via bootstrap, no `OrchestratorConfig` needed by the router.

3. **Cut dead config.** Removed `OrchestratorConfig.notification` (digest, batch_window_ms,
   quiet_hours, milestone_based) and `question_batching` from `schemas/config.ts`, their YAML from
   `templates.ts` (ORCHESTRATOR_TEMPLATE + EXAMPLE_ORCHESTRATOR), and their sections from
   `docs/configuration/orchestrator.md`. `OrchestratorConfig` is now `{review, observability}`.

4. **review_reminder → owner.** `recipientsForKind("review_reminder")` now returns `owner` (single-user:
   the owner is the reviewer). `escalation_alert` keeps `owner_and_reviewers` untouched.

5. **Typed `system.health_changed`.** Was an untyped publish (forward-compat path → no validation,
   not in `EventTypeSchema`). Added `SystemHealthChangedPayloadSchema` + the enum member + the
   `EventPayloads`/`eventPayloadSchemas` entries + a declaration in the daemon's `EVENTS`, and the
   publish site uses `satisfies PublishInput<"system.health_changed">`.

Also a small readability refactor of the router: `notify()` reads top-to-bottom (ticket-comment →
suppress → resolve → fan out) by extracting `isSuppressedDuplicate` and `fanOutToContacts`.

## Decisions / deviations

- **Alert dedup vs "alerts bypass" (the load-bearing call).** The S1 brief contradicted itself:
  "route the 5 health alerts through [the suppress window] so they still dedup per-source" AND "ALERTS
  BYPASS suppression." I resolved it as **alerts ARE deduped by the suppress window**: that is exactly
  what the deleted `HEALTH_NOTIFY_COOLDOWN_MS` did, the per-source `dedup_key` requirement is dead code
  unless alerts dedup, and a literal bypass reintroduces owner-flooding from a flapping trigger. The
  "bypass" wording belonged to the now-cut multi-stage policy (quiet-hours/batch/digest), where an
  alert must never be *delayed*. Documented in the router code and flagged in `active.md` for the
  owner's final review.
- **`OrchestratorConfig = {review, observability}`, not `{review}`.** The brief said `{review}`, but
  `observability.live_activity` is a live, in-use, recently-added config outside the cut scope. Cutting
  it would break the live-activity feed, so I kept it. The brief predates that field landing.
- **Suppression keyed on `kind`, not resolved messageType.** The brief said "messageType/kind". I keyed
  on `kind` + scope because a `task_error` and a `cost_limit` on the same task both map to messageType
  `alert` and must NOT falsely dedup each other.
- **Session-number collision** handled by logging as `57-slice10-s1.md` (see note above).

## Gates

- lint: green (0 errors; 3 pre-existing `noExcessiveCognitiveComplexity` warnings in the router's retry
  closures — same count as the clean baseline, none added by S1).
- typecheck: clean (`tsc --noEmit` + test tsconfig).
- tests: 2510 unit + 64 integration + 16 e2e, all green. New router tests cover suppress dedup (one
  delivered within window; both after advancing the FakeClock; distinct scopes never dedup; null-task
  alerts dedup per source; alerts dedup), the suppress `decision_point`, and the four deliver/fail/
  retry observations. The two daemon review-pending reminder tests and the two router review_reminder
  tests were updated for owner-routing.

## Discrepancies vs the footwork docs (reality wins)

- The answer-injection gap is already fixed on `main` (as the brief warned) — out of S1 scope, untouched.
- `OrchestratorConfig` had also gained `observability.live_activity` since the research was written;
  kept it (see deviations).
- The pre-Slice-10 `active.md` "Deferred" block still describes honoring the reserved
  `notification.*`/`question_batching.*` knobs — that intent was reversed (CUT) by the create-plan. The
  Current section now reflects the refine-over-build scope.

## Out-of-scope notes for later sessions

- `PersonSchema.preferences` still carries `notification_level` + per-person `quiet_hours` (a separate
  shape from the cut `OrchestratorConfig.notification`; surfaced in `people.yaml` template +
  `docs/configuration/people.md`). Quiet-hours is a cut feature, so this per-person preference is now
  unwired scaffolding — a candidate for the Slice 10 closing sweep, not S1 scope. Flagging, not touching.
- The `notify`/`processRetries`/retry-closure complexity warnings are pre-existing; left as-is.

## Next

S2 — cancel/label coverage (reaper-driven cancel `ticket_comment` + `engineer:cancelled` label sync;
remove the scheduler duplicate; `writing-tickets.md`).
