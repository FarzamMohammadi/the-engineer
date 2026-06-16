# Communication — How The Engineer Talks to You

The Engineer runs autonomously, for a long time, often while you are asleep. Communication is
how a human stays in the loop without watching it — it **speaks** (outbound notifications),
it **asks and waits** when only you can decide, and it **listens** (inbound queries and replies).

The communication *plugins* are dumb transport — they format and deliver, nothing more (see the
[adapter contract](../../plugins/communication/README.md)). All the intelligence — what to say, who
should hear it, when to stay quiet, how to retry, how to tell a reply from a question — is **Core**,
and it lives in two modules: the **notification-router** (outbound) and the **response-poller**
(inbound). This page is that Core machine, end to end.

## Key Files

| Component | File | Role |
|---|---|---|
| Outbound router | `src/core/daemon/notification-router.ts` | Resolve recipients, suppress duplicates, fan out, retry |
| Notification vocabulary | `src/schemas/notifications.ts` | `NotificationKind`, the typed `Notification` union, `recipientsForKind` |
| Inbound poller + classifier | `src/core/daemon/response-poller.ts` | Poll comm plugins, classify each message as reply or query |
| Query handler | `src/core/daemon/query-handler.ts` | Answer `!status` / `!cost` / `!progress #N` / `!help` |
| Reaching out | `src/core/orchestrator/outreach.ts` | Resolve a block's one canonical question and deliver it to the owner's chat + the source ticket |
| The autonomy consult | `src/core/orchestrator/pipeline/runner.ts` | `consultDecisions` — ask the owner about a discretionary call |
| Router wiring | `src/cli/commands/start/bootstrap.ts` | Builds one router at startup, shared by daemon + orchestrator |

---

## 1. The voice — outbound notifications

There is **one** notification-router, built once at startup and shared by the daemon and the
orchestrator. Anything that wants to tell a human something calls a single method:

```typescript
notifications.notify(notification);   // notification is a typed Notification
```

The caller never names a person, picks a channel, or decides whether to send. It states *what
happened* as a typed `Notification`; the router owns *who hears it, on what channel, and whether
it goes out at all*. This is the same separation the pipeline uses — the caller reports, Core routes.

### The kind vocabulary

Each notification is one `kind`, and the kind alone decides who receives it
(`recipientsForKind`). Under the
[single-user constraint](../../constraints.md) the owner is the whole team, so most kinds resolve
to the owner; the role split is kept so a future multi-person edition fans out without a code change.

| Kind | Goes to | Raised when |
|---|---|---|
| `completion` | owner | A task finished successfully. |
| `review_pending` | owner | A PR was opened and is awaiting review. |
| `task_error` | owner | A task hit an error and blocked. |
| `cost_limit` | owner | A task blocked because a cost limit was reached. |
| `blocked_reminder` | owner | A blocked task is still waiting (timeout nudge). |
| `escalation_alert` | owner + reviewers | A block waited too long and was failed/escalated. |
| `review_reminder` | owner | A PR has been pending review for a while. |
| `plugin_recovered` | owner | A previously failing plugin passed its health check again (the outage is over). |
| `question` | the named person | The task needs a human to answer something. |
| `status_response` | the asking person | The reply to an inbound query. |
| `milestone` | owner | A noteworthy point was reached mid-task. |
| `alert` | owner | A health problem (a failing trigger, a stuck task). |
| `ticket_comment` | the source ticket | A note posted back on the issue/PR, not a DM. |

The kinds split by where their text comes from: **template kinds** (`completion`, `task_error`, …)
carry only a `taskId` and the router fills a fixed template; **custom kinds** (`plugin_recovered`,
`question`, `milestone`, `alert`, `status_response`, `ticket_comment`) carry their own `message`.
`plugin_recovered` is additionally keyed on its `source` (a stable `plugin:<plugin_id>` string)
for dedup — it has no `taskId`, so without the source every plugin's recovery would collapse to
the same suppress-window key.

### What `notify()` does

```
notify(notification)
  │
  ├─ ticket_comment?  → post on the source ticket (ticket_management) and return
  │                      (a different surface from a DM; bypasses owner-flooding dedup)
  │
  ├─ duplicate within the suppress window?  → drop it, record the decision, return
  │
  ├─ resolve recipients  (recipientsForKind → owner / reviewers / the named person)
  │     └─ none resolved? → nothing to do, return
  │
  └─ fan out: for each person, try their contacts in preferred order
        ├─ first success wins → emit comm.message_sent + a delivered observation
        └─ none reachable    → emit comm.send_failed; enqueue a retry if it was retryable
```

**Suppression is the single source of outbound dedup.** The router drops a notification whose
**kind + scope** matches one it already delivered inside `notification_suppress_window_ms`
(default 5m). Scope is the `taskId`, or for a task-less health `alert` its `source`
(e.g. `trigger:github-trigger`) — so a dependency that fails every tick cannot DM you every tick,
while the first occurrence and any *distinct* kind or scope always pass through immediately. The key
is the raw `kind`, not the resolved message type, so a `task_error` and a `cost_limit` on the same
task — both rendered as alerts — never falsely suppress each other. This replaced an older hardcoded
health-alert cooldown; it deliberately covers alerts too. See
[notification suppression](../../configuration/daemon.md#notification-suppression).

**Fan-out tries contacts, not just the first one.** A person can list several contacts; the router
tries them in order (first = preferred) and stops on the first successful send. Only when *no*
contact for that person is reachable does it count as a failure.

**Retry is for transient failures.** A failed send that the plugin marked `retryable` (and that
belongs to a task) is enqueued. Each daemon tick, `processRetries` decides each entry's fate:

| Fate | Meaning |
|---|---|
| `wait` | A send is in flight, or the retry interval has not elapsed — leave it. |
| `due` | Re-resolve the person's contacts and attempt redelivery now. |
| `task_terminal` | The task ended — abandon the retry (no one is waiting on it). |
| `max_age` | Older than `notification_retry.max_age_ms` — abandon. |
| `max_attempts` | Exhausted `notification_retry.max_attempts` — abandon. |

A retry that finally lands emits `comm.retry_succeeded`; an abandoned one emits
`comm.retry_exhausted`. See [notification retry](../../configuration/daemon.md#notification-retry).

**Two side paths** ride the same router but skip the DM machinery:

- **`ticket_comment`** posts back on the task's source issue/PR via the `ticket_management`
  capability — a different surface from the owner's DM, size-capped to the platform limit. It
  bypasses the owner-flooding dedup because its cadence is already controlled by the emitter.
- **State sync** (`syncStateToCommPlugin`) reflects a task's state change onto the external
  platform — e.g. updating `engineer:*` labels — through any plugin with the `sync` capability.

Every message is run through `sanitizeSecrets` before it leaves, and every step records a durable
observation (delivered, send-failed, suppressed, retry outcome) — see
[Observability](#observability).

---

## 2. Reaching out, and answers coming back

Sometimes the work cannot proceed on the agent's judgment alone — it needs *you*. The Engineer
reaches out in **two** distinct situations, and the difference is worth keeping straight:

| | A hard block (`needs_human`) | A discretionary ask (the autonomy consult) |
|---|---|---|
| Why | The agent genuinely *cannot* proceed — a real ambiguity, a missing decision. | The agent *could* proceed, but you might want to weigh in (a dependency, a rename, touching auth). |
| Where the question comes from | The agent writes `outreach/{person-id}.txt` files. | The runner synthesizes the question from the surfaced decision. |
| Block category | `awaiting_human` | `awaiting_human_decision` |
| Self-unblock | May be auto-resolved by the timeout self-unblock check. | **Never** auto-resolved — only you can make that call. |

### The autonomy consult

This is the mechanism behind the discretionary ask. While running, the agent makes calls it could
make alone and **surfaces** them in its result (a category, what it chose, why). After a sub-phase
result in a phase that *makes* such calls, the runner's `consultDecisions` reads those surfaced
decisions and consults the safety policy per decision:

```
sub-phase result
  └─ for each surfaced decision:
       consult should_i_ask (the autonomy policy)
         ├─ proceed       → the agent's call stands
         ├─ ask + owner   → collect it
         └─ ask, no owner → proceed anyway, and record a loud sub-confidence decision
                            naming exactly what was decided without you
  └─ any collected?       → block awaiting_human_decision, asking them all in one reach-out
```

The policy itself — the categories, their levels (`always_decide` / `always_ask` / `threshold`),
and the no-owner degrade — is configuration, documented in
[safety § Autonomy](../../configuration/safety.md#autonomy). The point here is *where it runs*: it is
a runner hook on the result of every step in the phases that make discretionary calls, so a decision
is caught no matter which of them raised it. The **intent-forming** phases — requirements and research
— are deliberately exempt: there the agent is still understanding the task, so a decision it surfaces
is premature. It is recorded for the trail (an `autonomy_not_gated` decision), not asked — which is what
stops requirements' ask-biased intake from re-surfacing a settled choice on every resume and looping you.

### Delivery, and the answer returning

Both kinds of ask — a `needs_human` file and a synthesized decision — converge on **one** delivery
path. The orchestrator resolves the blocking sub-phase's own `outreach/` directory (any phase, not
just requirements) into a single canonical question: the file(s) the agent wrote, or the block's
synthesized `needed` when it wrote none. That one question is delivered **identically** to every
surface you watch — your chat channel (a `question`) and the source ticket (a `ticket_comment`
carrying the full question, not a summary) — and persisted as `blocked.needed`, the text the
dashboard renders. Chat, ticket, and dashboard never show a different (or stale) question.

Resolving from the `outreach/` directory **consumes** its files (reads, then deletes them), so a
later block in the same sub-phase — a resumed run that surfaces an autonomy decision, which writes no
file — can never re-send a prior block's stale ask. If no owner is configured, the ticket comment
still posts and the dashboard still shows the question; the orchestrator only warns that it could not
reach you on chat.

When you answer, the [inbound path](#3-listening--inbound-queries-and-replies) unblocks the task and
it resumes **where it asked**. Your reply is carried into the agent's next prompt as authoritative
context (`buildCarrySection`) — "incorporate this and continue" — so the agent acts on your decision
rather than re-deriving it.

---

## 3. Listening — inbound queries and replies

The **response-poller** runs on the daemon tick. It polls every comm plugin with the `receive`
capability for new messages, and also scans the event bus for messages from non-plugin sources
(the dashboard). Tasks blocked on PR review are excluded — they resume through PR events, never a
chat reply.

Every inbound message is one of two things, and Core decides which before acting:

```
inbound message
  └─ classifyInbound(hasLinkedTask, content, blockedCount)
       ├─ carries task metadata?        → unblock reply (it names its task)
       ├─ a !-prefixed command?         → query   (wins even when one task is blocked)
       ├─ exactly one task blocked?     → unblock reply (the sole-blocked fallback)
       └─ zero or 2+ blocked?           → query   (nothing to reply to / can't match one)
```

The precedence is deliberate: `!status` sent while one task happens to be blocked is a **query**,
not the answer to that task's question — and a command word buried in a free-text reply (e.g. one that
mentions "help") is never mistaken for a command, so the answer reaches the blocked task. The full
classification table — and the query vocabulary (`!status`, `!cost`, `!progress #N`, `!help`) with their
responses — lives in the [adapter contract](../../plugins/communication/README.md#inbound-queries), which
owns that surface.

- A **reply** goes to the unblock-resolver, which unblocks the matching task so it resumes.
- A **query** goes to the query-handler, which answers with a `status_response` to the asker.

Responses are short and plain by design — the dashboard is the full-detail surface. Each
classification is recorded as an `inbound_route` decision, so a routing choice that is invisible in
chat is inspectable on the dashboard.

---

## Observability

Communication is held to the [observability](../../architecture/observability.md) bar: every action
lands a durable row, because the dashboard observer sees only what is emitted. Outbound deliveries,
send failures, suppressed duplicates, and retry outcomes each record an observation; the suppress
choice and every inbound classification record a `decision` with their alternatives and reasoning.
The audit ledger carries the matching events — `comm.message_sent`, `comm.send_failed`,
`comm.retry_succeeded`, `comm.retry_exhausted`, `comm.message_received`. Nothing the system says to
you, or hears from you, is invisible after the fact.

## Related documentation

- [Communication adapter contract](../../plugins/communication/README.md) — the plugin surface,
  the capability groups, and the full inbound query vocabulary.
- [Safety § Autonomy](../../configuration/safety.md#autonomy) — the discretionary-decision policy
  the consult evaluates.
- [Daemon configuration](../../configuration/daemon.md) — notification suppression, retry, and
  response-polling settings.
- [The pipeline](../../architecture/pipeline.md) — where the autonomy consult sits in the runner.
- [People configuration](../../configuration/people.md) — owner and contacts the router resolves.
