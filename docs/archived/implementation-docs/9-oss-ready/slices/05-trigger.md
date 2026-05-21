# Slice 5: Trigger & Requirements (Contacts) Flow

## Requirements

Gathered through Q&A (Session 17). Code reality verified through direct grounding of every
related flow; research saved to `.claude/temp/research/slice-05-trigger.md`.

### Scope Framing

This is an **audit / refactor / complete** slice, not build-from-scratch. The trigger flow and the
people-directory already exist. We hunt rough edges, hardcoding, untested behavior, dead code, and
gaps that would break a plugin author writing a non-GitHub trigger — then fix them to OSS standard.

"Requirements gathering" in this slice's title means **requirements-gathering *contacts*** (the
people-directory that feeds outreach), **not** the RRPIR requirements *phase* (Slice 8) or the
send/receive *communication* machinery (Slice 12). Two halves:

1. **Trigger flow** — poll → dedup → task creation, plus the plugin-context foundation it exposed.
2. **Contacts** — the people-directory setup, governed by the single-user constraint.

The trigger/comm/pipeline boundary was **verified against the code** (see research doc): the trigger
flow imports nothing from comm/people/notification; the trivial-skip/pipeline machinery is wholly in
`orchestrator/`; the outreach/response loop is tangled across `orchestrator` + `daemon` +
`notification-router` and so is split across slices (below).

### Goals (priority order)

1. **Plugin-context foundation** — define and document the canonical contract for everything Core
   provides a plugin. The moat: a contributor reads one contract and writes a working trigger.
2. **Trigger flow correctness** — crash-safe exactly-once task creation for *every* trigger plugin,
   not just github-trigger.
3. **Honest code** — no dead scaffolding, no lying docs, no ignored config.
4. **Single-user clarity** — the deliberate v1 constraint, documented and enforced where cheap.
5. **Docs to OSS standard** — contract + authoring guide + flow docs, written as part of the work.

## Deliberate Constraint: Single-User (Decision #11)

**The Engineer assumes the human side is exactly one person — the owner.** They assign the work,
answer the questions, review the output. A "team of one," indefinitely, until deliberately lifted
(e.g., a future paid teams/pro version).

Two things it explicitly does **not** relax:
- **One user ≠ one task.** The owner still has many concurrent tasks — per-task correlation stays live.
- **One user ≠ one plugin.** This constrains the *human*, not the *integrations*. Plugin Blindness untouched.

Documented in **`docs/constraints.md`** ("Deliberate Constraints"), referenced from `README.md` +
`AGENT-README.md` (always-read), linked from `philosophy.md`. That doc is the home for future
self-imposed v1 constraints too.

## Decisions Made (Session 17 Q&A)

### #1 — Refactor mandate: fix/complete everything
Incomplete/wrong findings (dead docs, ignored config, dedup holes) are treated as bugs to finish,
not defer. Scope is large → planned now as a multi-session breakdown (below), each session sized to
finish completely (code + tests + docs + standards pass).

### #2 — Dedup → Core, keyed on `idempotency_key` (Option A)
Today durable dedup secretly rides on `external_ref` (`taskEngine.findByExternalRef`), so a trigger
emitting `external_ref: null` loses crash-safe dedup after a restart — a Plugin-Integrity hole. Fix:
**store `idempotency_key` on the task row (indexed, mirroring the existing `external_ref` storage +
`idx_tasks_external_ref_active` pattern), and dedup off it.** Every trigger already emits a required
`idempotency_key`, so all triggers get crash-safe exactly-once for free. Keys namespaced by `source`
(plugin id). `external_ref` stays — demoted to purely descriptive (URL, `pr_decorations`, dashboard
link-back). Clean split: `idempotency_key` = identity/dedup, `external_ref` = descriptive. Add a
`findByIdempotencyKey` query + an `idempotency_key` column, consolidated into `001_schema.sql`.

### #3 — Delete vestigial `trigger.pr_review` scaffolding
Review polling is **advertised but unimplemented** in github-trigger — and the real review/feedback
rework loop already exists in `daemon/review-handler.ts` via the **GitHostingAdapter**. The
`trigger.pr_review` event is a dead ancestor of `task.feedback_received`: zero producers, zero
consumers. Delete the dead scaffolding so the trigger is honestly issues-only:
- `github-trigger.ts` JSDoc claim ("…and PR reviews", `github:review:` keys)
- `builtin.ts:35` description, `builtin.ts:41` `contributes: trigger.pr_review`
- `schemas/events.ts` `trigger.pr_review` enum + `TriggerPrReviewPayloadSchema` + maps
- `cli/bundled/plugin-docs.ts` `pr_review_requested` example

Real review-polling/feedback refinement is **Slice 10**'s (Review & Feedback). Logged as handoff.

### #4 — Core `StateStore` (folded into #7)
With Core owning durable dedup (#2), plugin watermark/ETag persistence becomes **efficiency, not
correctness** — a stateless trigger would still be exactly-once. So Core offers a **minimal, opaque
key-value `StateStore`** (`get`/`set`/`delete`, string keys, JSON-serializable values, namespaced
per plugin, `--home`-aware, atomic, backed by a new `plugin_state` table). The plugin decides *what*
to persist (its cursor — only it understands its source); Core owns *where/how*. github-trigger's
hand-rolled file I/O (5 `fs` imports, `getWatermarkPath`, `process.env["ENGINEER_HOME"]`, temp+rename,
bare `catch {}`) is **deleted** and rewritten through it. Discipline: **dumb store**, no TTL/queries/
eviction. Delivered as part of the PluginContext (#7).

### #5 — Per-plugin poll cadence
Three representations of poll interval exist; the two plugin-side ones are **dead** (daemon uses one
global `trigger_poll_interval_ms` for all triggers). Make the manifest's `adapter_meta.poll_interval`
(`"30s"`) the plugin's **honored default** (parse the duration string), with an optional per-plugin
operator override in daemon config. **Delete** the redundant `poll_interval_ms` from github-trigger's
Zod config. The daemon's failure backoff multiplies the per-plugin base. One source of truth per layer.

### #6 — Configurable work selection (assignee OR label OR both)
`event_type: "issue_assigned"` is a misnomer — selection is by **label** + open-state, never assignee.
Make selection configurable: assignee (add the bot's GitHub identity), label, or both. **Require at
least one** criterion via Zod (neither = matches every open issue = dangerous). Rename `event_type`
to reflect what actually matched.

### #7 — PluginContext: the canonical plugin-context contract (centerpiece)
The Registry already injects three scattered, `unknown`-typed fields onto adapters — `manifest`
(`lifecycle.ts:56`), `observer` and `hookRegistry` (`registry/index.ts:96-98`). The observer is
scoped to a generic `"plugin-loader"` child, **not** per-plugin. Consolidate all of it into **one
properly-typed `PluginContext`**, injected by the Registry, carrying: `manifest` (identity),
**per-plugin-tagged** logger (`observer.child(manifest.id)` + plugin-origin marker — Core stamps it,
never trusts the plugin to self-tag), `hookRegistry`, and the new `StateStore`. Interfaces live
**adapter-side** (`adapters/index.ts`, like `AdapterObserver`, to honor "adapters can't import core");
implementations live in Core and are injected. This **corrects finding #6c** (plugins *do* have an
observer; it was just `unknown`-typed and unused — hence the bare `catch {}`).

This is the **reusable foundation** for all future slices: Slice 12 comm plugins use the same
`StateStore`/logger; new adapter types inherit it; Slice 16 (npm) extracts `adapters/index.ts` as the
SDK package — a clean PluginContext now *is* the SDK surface later. Discipline: **extensible in shape,
minimal in members** — one injected object so a future primitive is a one-line add, but nothing
speculative now. First-class docs: adapter-contract reference + plugin-authoring guide (watermark +
logging examples). Touches `base.ts` + the injection sites + **all 7 built-in plugins'** wiring
(mechanical but wide — relevant to session sizing).

### #8 — Core owns poll backoff
github-trigger and the daemon run conflicting backoffs (the plugin's `retryAfterUntil` returns `[]`,
which the daemon reads as success and resets its counter). Make the plugin **report** rate-limit via
`AdapterError.retry_after_ms` (the field already exists) and stop throwing/suppressing; the **daemon**
owns next-poll timing — honor `retry_after_ms` when present, else exponential backoff on opaque
failures. Remove the plugin's `retryAfterUntil`. Every trigger plugin inherits correct rate-limit
behavior uniformly.

### #9 — Reply correlation via explicit token (naive, documented; cross-slice)
The `[Task: …]` hint we already send is **never parsed back**; metadata-less channels (Telegram) fall
back to "sole blocked task," so with 2+ blocked tasks a reply is silently discarded. Decision:
**keep** existing metadata correlation (task_id/external_ref — free, robust for GitHub/dashboard);
**replace** the fragile sole-blocked guess by appending the **full task id** clearly at the end of
every blocker outbound message with a plain instruction ("keep this reference in your reply") and
**parsing it back**. No reply-threading, no layered fallback. Document plainly. Smart subagent-based
correlation → **future considerations**. **Cross-slice:** send side (`outreach-sender`, requirements
phase) = Slice 8; receive/parse side (`response-poller`) + routing = Slice 12. Slice 5 captures the
design; the parts that relate land in their slices.

### #10 — Lightweight unblock sender check (cross-slice)
Today **any** sender unblocks a blocked task (a passerby comment re-queues it). Add a lightweight
check mirroring `review-handler`'s `isAuthorizedApprover`: only a known contact's reply unblocks; if
no people configured, anyone can (solo-dev default). `msg.sender` is already available in
`response-poller`. **Cross-slice:** lives in the daemon receive/unblock path → executed with Slice 12.

### #11 — Single-user constraint
See dedicated section above. Locked, documented, memory-persisted.

### #12 — People-directory: enforce single-user via load-warn, keep structure
The people-directory is **shared infra** (10 consumers across Slices 8/10/12 + bootstrap + observer),
so collapsing its structure is high-blast-radius. **Don't collapse.** Instead: on config load, **warn**
if >1 person is configured ("single-user in v1; will only reach out to the owner"), and **warn if no
owner is defined** — which makes finding #8's silent `"Owner"`-typo break **fail loud** instead of
vanishing answers. Outreach **solely targets the owner**. Role is `owner` (what `getOwner()` resolves).
Retires findings #10r (prompt directory dump — one person now) and F-C (responses-by-channel — only
the owner answers).

### #13 — Validate owner channels at load/`doctor`
`findPluginForChannel` matches a contact's channel against `manifest.adapter_meta.channel`. Send-time
failure is already loud-ish (`comm.send_failed` event + warn). The gap is **early detection**: nothing
validates the owner's configured channels against installed comm plugins until a send is attempted.
Add validation at config load / `engineer doctor` — warn loudly, name the channel, point to docs.
Pairs with the #12 load-warn. Send-time behavior unchanged.

## Cross-Slice Handoffs

- **Slice 8 (RRPIR Phases):** trivial→skip-research handoff (sound, lives in `phase-runner`); the
  *send* side of #9 (`outreach-sender`, requirements-phase blocking). Doc gap: the complexity/skip
  behavior isn't in user-facing docs yet.
- **Slice 10 (Review & Feedback):** real review-polling/feedback refinement; carried in from #3's
  deletion (the capability lives in `review-handler.ts`, refine/document it there).
- **Slice 12 (Communication):** the *receive*/parse side of #9 (`response-poller`), the unblock sender
  check #10 (`unblock-resolver`), channel routing. Slice 5 designs them; they execute here.

## Future Considerations (capture in docs/future-considerations.md)

- **Smart reply correlation** — a subagent that infers which blocked task a free-form (token-less)
  reply belongs to, replacing the naive token requirement (#9).

## Session Breakdown (high-level — detailed in the plan)

Sized so each session finishes completely: code + tests + docs + standards/anti-pattern pass.

1. **PluginContext foundation (#4, #7)** — the centerpiece. Adapter-side interfaces, `plugin_state`
   table, Core `StateStore` impl, Registry injection consolidation (per-plugin-tagged observer), rewire
   all 7 plugins, contract + authoring docs. Everything downstream builds on this.
2. **Trigger dedup → Core (#2) + delete review scaffolding (#3)** — `idempotency_key` column +
   `findByIdempotencyKey` + consolidated migration; rewire `trigger-poller` dedup; delete dead
   `trigger.pr_review` everywhere; trigger flow docs.
3. **Trigger plugin refinement (#5, #6, #8)** — per-plugin cadence, configurable work selection, Core
   backoff via `retry_after_ms`, watermark/ETag rewritten through `StateStore`; github-trigger docs.
4. **Contacts: single-user constraint (#11, #12, #13)** — `docs/constraints.md` + README/AGENT-README
   references; people-directory load-warn; owner-channel validation at load/`doctor`.

(Session ordering may adjust during planning. #9/#10 are designed here but executed in Slices 8/12.)
