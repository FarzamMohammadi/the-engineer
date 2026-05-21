# Plan: Slice 5 — Trigger & Requirements (Contacts) Flow

**Date**: 2026-05-21 | **Stakes**: Full (touches the universal adapter contract — the moat)
**Upstream**: `.claude/temp/research/slice-05-trigger.md` | `docs/archived/implementation-docs/9-oss-ready/slices/05-trigger.md`
**Status**: Draft — expert-panel stress-test pending (run as first action of the implementation session, see Panel Review)

## Intent

Bring the trigger flow and the requirements-gathering *contacts* to OSS standard, and in doing so
define the **canonical plugin-context contract** every current and future plugin builds on. The single
most important reason: the moat is plugin interchangeability — a contributor must read one contract and
write a working trigger, with crash-safe behavior, persistence, and observability provided by Core, not
reinvented.

## Decisions

### D1: Dedup moves to Core, keyed on `idempotency_key` (req #2)
**Choice**: Store `idempotency_key` (indexed) on the task row; dedup off it. Demote `external_ref` to
descriptive-only. Namespace keys by `source`.
**Context**: Durable dedup secretly rode on `external_ref`; null-`external_ref` plugins lose crash-safe
exactly-once. Every event already carries a required `idempotency_key`.
**Rejected**: Require `external_ref` (GitHub-shaped, forces structure on cron/email triggers — Plugin-
Blindness smell); keep both + "at least one" (institutionalizes the confusing split).
**Consequence**: Every trigger gets crash-safe exactly-once for free. Adds an `idempotency_key` column +
`findByIdempotencyKey` to `001_schema.sql`.

### D2: One Core `StateStore`, delivered via PluginContext (req #4)
**Choice**: Minimal opaque KV (`get`/`set`/`delete`, string keys, JSON values, namespaced per plugin),
DB-backed by a new `plugin_state` table in the existing `--home`-aware DB. No TTL/queries/eviction.
**Context**: Watermark/ETag persistence is now efficiency, not correctness. Two plugins (github-trigger
watermarks, telegram-comm chat-map) hand-roll identical `state/{id}/*.json` with `process.env` home-
guesses that ignore `--home`.
**Rejected**: File-backed store (reintroduces the path/atomicity fragility we're removing); document-the-
pattern only (each author still hand-rolls it wrong); stateless (burns API quota, the capable plugins
reinvent persistence anyway).
**Consequence**: github-trigger AND telegram-comm (D5, Gate 1) delete their file I/O.

### D3: PluginContext — principled split (req #7, Gate 2)
**Choice**: Keep `this.manifest` (identity) as-is. Introduce one typed `this.context: PluginContext`
carrying Core-provided capabilities — a per-plugin-tagged logger (`observer.child(manifest.id)` + plugin-
origin marker), `hookRegistry`, and `stateStore`. Interfaces adapter-side (`adapters/index.ts`, beside
`AdapterObserver`); implementations Core-side, injected by the Registry. Core stamps the plugin tag — never
trusts the plugin to self-tag.
**Context**: The Registry already injects three scattered `unknown`-typed fields. Corrects finding #6c
(plugins *do* have an observer; it was just `unknown` and unused → bare `catch {}`).
**Rejected**: Full consolidation (fold `manifest` in too) — high churn against `this.manifest.id` for no
gain; additive-without-a-context-object — leaves the `unknown` typing.
**Consequence**: The reusable foundation for Slices 8/10/12 and the npm SDK (`adapters/index.ts` is the
extraction point). Touches `base.ts`, both injection sites, all 7 plugins.

### D4: Delete vestigial `trigger.pr_review` scaffolding (req #3)
**Choice**: Remove the dead event + payload + manifest contribution + lying JSDoc/description + doc
example. Trigger becomes honestly issues-only.
**Context**: Zero producers, zero consumers; the real review/feedback loop lives in `review-handler.ts`.
**Consequence**: Review polling refinement handed to Slice 10.

### D5: telegram-comm chat-map → StateStore in Slice 5 (Gate 1)
**Choice**: Migrate opportunistically while #7 touches telegram's `initialize`.
**Context**: Half-migrated state is the trap; persistence-adoption ≠ comm-flow, so it respects the Slice
5/12 boundary. Second consumer validates the abstraction.
**Rejected**: Defer to Slice 12 (leaves known-bad env-guess after we've already opened the file).

### D6: Per-plugin poll cadence, numeric ms, no override map (req #5, Gates 3+4)
**Choice**: Formalize `poll_interval_ms` (numeric) as a typed manifest field; the daemon honors it as the
plugin's default with the global `trigger_poll_interval_ms` as fallback. **No** per-plugin override map for
v1. Delete the dead `poll_interval_ms` from github-trigger's Zod config. Daemon backoff multiplies the
per-plugin base.
**Context**: Numeric matches the system `_ms` convention (no duration parser, no parse-failure path); per-
plugin override is YAGNI under single-user v1.
**Consequence**: Per-plugin override logged as a future consideration.

### D7: Configurable work selection (req #6)
**Choice**: assignee (add the bot's GitHub identity to config) OR label OR both; require ≥1 via Zod;
rename `event_type` to reflect what matched.
**Consequence**: Neither-configured = rejected at parse (prevents matching every open issue).

### D8: Core owns poll backoff (req #8)
**Choice**: Plugin reports rate-limit via `AdapterError.retry_after_ms`; daemon honors it, else
exponential backoff. Remove the plugin's `retryAfterUntil`.
**Consequence**: Uniform rate-limit behavior for all trigger plugins.

### D9: Single-user constraint + people-directory guard (req #11/#12/#13)
**Choice**: `docs/constraints.md` (referenced from README + AGENT-README always-read + philosophy);
`PeopleDirectory` constructor warns if >1 person or no owner; outreach targets the owner; add an
`engineer doctor` category validating the owner's channels against installed comm plugins. Keep the
people-directory structure (shared by 10 consumers — don't collapse).
**Consequence**: Retires findings #10r and F-C; #8's silent owner-typo break becomes fail-loud.

## Scope Boundary

**Delivering**: D1–D9 — trigger flow correctness + the PluginContext/StateStore foundation + contacts
single-user guardrails, each with tests + docs (contract reference, plugin-authoring guide, trigger flow
doc, `docs/constraints.md`).

**Deferring (designed here, executed elsewhere)**:
- Reply-token correlation (#9) + unblock sender check (#10) → **Slice 12** (comm receive/route).
- Trivial→skip-research handoff doc + outreach send side → **Slice 8** (RRPIR).
- Review polling/feedback refinement → **Slice 10**.
- Per-plugin interval override map; subagent-based smart reply correlation → `docs/future-considerations.md`.

## Task Breakdown

### Session 1 — PluginContext + StateStore foundation (D2, D3, D5)
*Everything downstream builds on this; ship it complete and documented first.*

- **T1.1 — `plugin_state` table** [~20m]. Add to `001_schema.sql` (no BEGIN/COMMIT). Columns: `plugin_id`,
  `key`, `value` (TEXT/JSON), PK `(plugin_id, key)`. Verify: fresh DB migrates; `engineer doctor` clean.
- **T1.2 — StateStore (Core impl + adapter-side interface)** [~40m]. Interface in `adapters/index.ts`
  (no Core imports); impl in Core (prepared statements, per-plugin namespacing). Verify: unit tests for
  get/set/delete + namespace isolation.
- **T1.3 — PluginContext type + Registry injection** [~40m]. Define `PluginContext` adapter-side
  (logger=`AdapterObserver`, hookRegistry, stateStore). Registry builds + injects `this.context`, logger
  scoped `observer.child(manifest.id)` + plugin-origin marker. Consolidate the `lifecycle.ts` + `registry/
  index.ts` injection sites. Verify: a plugin reads `this.context.stateStore`/`logger`; logs carry plugin_id.
- **T1.4 — Rewire all 7 plugins to `this.context`** [~40m]. Replace `this.observer`/`this.hookRegistry`
  usages; keep `this.manifest`. Verify: typecheck + existing plugin tests green.
- **T1.5 — Migrate github-trigger watermarks + telegram chat-map → StateStore** [~40m]. Delete file I/O
  (fs imports, `getWatermarkPath`, env-guess, temp+rename, bare `catch{}`); rewrite via `this.context.
  stateStore`; corrupt/missing state → typed `logger.warn`. Verify: restart preserves cursor/chat-map.
- **T1.6 — Docs** [~40m]. Adapter-contract reference (PluginContext + StateStore guarantees) + plugin-
  authoring guide (watermark + logging examples). Verify: a stranger could use it.
- **Commit** per logical group (`/commit`).

### Session 2 — Trigger dedup → Core + delete review scaffolding (D1, D4)
- **T2.1 — `idempotency_key` column + index** in `001_schema.sql` (mirror `idx_tasks_external_ref_active`).
- **T2.2 — `findByIdempotencyKey`** in task-engine queries (mirror `findByExternalRef`); store key on
  `createTask`.
- **T2.3 — Rewire `trigger-poller` dedup** to key on `idempotency_key` (namespaced by source); demote
  `external_ref` to descriptive. Verify: crash/restart with null-`external_ref` event → no duplicate task.
- **T2.4 — Delete `trigger.pr_review`** across `events.ts` (enum/payload/maps), `builtin.ts` (desc +
  contributes), JSDoc, `plugin-docs.ts`. Verify: typecheck; `grep pr_review` clean.
- **T2.5 — Trigger flow doc** (dedup contract, idempotency_key vs external_ref roles).
- **Commit** per group.

### Session 3 — Trigger plugin refinement (D6, D7, D8)
- **T3.1 — `poll_interval_ms` typed manifest field**; daemon honors per-plugin default + global fallback;
  delete dead Zod `poll_interval_ms`. Verify: per-plugin interval respected; backoff multiplies it.
- **T3.2 — Configurable work selection** (assignee/label/both; bot identity config; require ≥1; rename
  `event_type`). Verify: Zod rejects neither-configured; assignee + label paths tested.
- **T3.3 — Core-owned backoff**: plugin sets `retry_after_ms`, daemon honors it; remove `retryAfterUntil`.
  Verify: simulated 429 → daemon delays correctly; no false success-reset.
- **T3.4 — github-trigger docs** refresh.
- **Commit** per group.

### Session 4 — Contacts: single-user constraint (D9)
- **T4.1 — `docs/constraints.md`** (single-user, two non-relaxations, until-modified) + references in
  README, AGENT-README (always-read), philosophy.md.
- **T4.2 — PeopleDirectory load-warn** (>1 person; no owner). Verify: warns surface; owner-typo is loud.
- **T4.3 — `engineer doctor` owner-channel validation** category. Verify: misconfigured channel warns at
  doctor, names the channel.
- **T4.4 — people-directory + contacts flow docs**.
- **Commit** per group; update `active.md` + session log at slice close.

## Verification Contract

| Check | Type | Command / Observation |
|-------|------|----------------------|
| Types compile | Auto | `pnpm run typecheck` |
| Lint clean | Auto | `pnpm run lint` (no new warnings) |
| Tests pass | Auto | `pnpm test` (new behavior covered) |
| Crash-safe dedup | Manual | Null-`external_ref` event survives daemon restart with no dup task |
| State persists | Manual | Watermark + chat-map survive restart via StateStore |
| Plugin logs tagged | Manual | Degradation logs carry `plugin_id` + plugin-origin marker |
| Doctor channel check | Manual | Misconfigured owner channel warns at `engineer doctor` |
| `--home` honored | Manual | Plugin state lands under `--home`, not `~/.engineer` |

## Risks

| Risk | If It Happens | Mitigation |
|------|--------------|------------|
| PluginContext rewire ripples beyond 7 plugins | Hidden `this.observer` users break | grep all `this.observer`/`this.hookRegistry` before rewire; typecheck gate |
| `001_schema.sql` edit doesn't apply to dev DBs | Confusing "missing column" errors | Test from fresh DB (`reset.sh`); note in session 1 |
| StateStore scope creep (TTL/queries) | Contract bloat, moat erosion | Hard rule: get/set/delete only; reject additions in review |
| telegram migration drags comm-flow concerns into Slice 5 | Boundary erosion | Migrate persistence ONLY; #9/#10 stay deferred |
| Session 1 too large (foundation + 7 plugins + 2 migrations + docs) | Context exhaustion mid-session | If tight, split T1.5/T1.6 into a Session 1b — cohesion over size |

## Panel Review

**Status**: PENDING. Run `/expert-panel-review` on this plan as the **first action of the implementation
session** — deferred deliberately so the panel runs in fresh context, not at the tail of the planning
session (a context-starved panel is worse than a fresh one). Panelists should pressure-test: the
PluginContext contract shape (moat), StateStore minimalism, the dedup migration's crash-safety, and
Session 1 sizing. Incorporate findings before writing Session 1 code.

## References
- Requirements + decisions: `docs/archived/implementation-docs/9-oss-ready/slices/05-trigger.md`
- Research: `.claude/temp/research/slice-05-trigger.md`
- Approach: `docs/archived/implementation-docs/9-oss-ready/approach.md`
