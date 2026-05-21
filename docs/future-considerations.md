# Future Considerations

Ideas beyond v1 scope, grounded in the system as it actually is today. This file is
where good ideas get parked so they are not lost — without expanding current scope. Each
entry states the idea, why it is deferred, and the concrete tie-in to today's code so a
future session can pick it up with full context.

This is a living document. Add to it when a worthwhile idea surfaces during scoped work;
do not implement from it without an explicit decision to bring the idea into scope.

---

## Trigger reversal / stale-work detection

**Idea.** Detect when the upstream signal that created a task is reversed or turned off
while the task is still in flight, and react — pause, abandon, or close the task and its
open PR — instead of letting the work go stale.

**Scenario.** A GitHub issue triggers a task; the task reaches `review_pending` with an
open PR. Meanwhile the issue is closed, resolved by someone else, relabeled out of scope,
or (a capability we do not have yet) explicitly stopped through The Engineer. Today nothing
notices: the task keeps living, the PR sits open and goes stale, and we may keep spending
effort on work nobody wants anymore.

**Why deferred.** v1 dedup is deliberately *active-scoped* — a completed task frees its
`idempotency_key`, so a reopened issue re-triggers cleanly (see the trigger flow doc). That
correctly handles the *forward* case (source comes back → new task). This is the *inverse*
case (source goes away → live work should wind down), which needs new detection and a new
shutdown/abandon path, plus a definition of which terminal state a "stopped" task lands in
so re-triggering later stays clean.

**Tie-in to today's code.**
- Trigger polling only surfaces `state: "open"` issues (`src/plugins/trigger/github-trigger/github-trigger.ts`),
  so a close is *invisible* to the trigger — detection would need a separate signal (issue-state
  poll, webhook, or a `CommunicationAdapter` reconciliation pass).
- A "stop through us" action does not exist yet; if added, it must move the task to a
  terminal state (`completed`/`failed`) so active-scoped dedup frees the key for any future
  re-trigger.
- Related: review polling / feedback handling lives in `src/core/daemon/review-handler.ts`
  (Slice 10), the natural home for PR-staleness reactions.
