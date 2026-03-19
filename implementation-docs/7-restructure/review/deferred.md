# Deferred Findings

Accumulated across all merge rounds. Nothing gets lost.

## Round 1 — 1-bootstrap-wiring.md

### Lens A (Structure & Organization)
- `bootstrap.test.ts` not needed — bootstrap is tested via E2E tests

### Lens D (Error Handling & Edge Cases)
- **F9:** SIGTERM during bootstrap (<2s window) — accepted gap, OS reclaims resources on exit
- **F10:** Plugin cleanup on config load failure — lightweight risk, non-critical plugins deregistered without shutdown()

### Lens E (Security & Trust Boundaries)
- Event validation (integrity not trust) — payload validation is about data integrity, not a trust boundary; deferred until external plugins exist
- EventTopology publisher enforcement — theoretical risk until external/untrusted plugins exist
- Config error exposure — acceptable for desktop DX (single-user desktop app, not a server)

## Round 2 — 1-bootstrap-wiring.md

### Lens F (Logging & Observability)
- **Event topology registration is silent** — static deterministic wirings that never fail. Logging them adds noise with zero diagnostic value. A `topology.summary()` method logged once at startup would be the right approach if topology visibility is ever needed, but that's a feature rather than a logging fix.

### Lens G (Performance & Resources)
- **Bootstrap cleanup() only closes DB** — Logger streams, BlobStore, ObservationStore not explicitly closed. Not actionable: Node.js process exit handles cleanup. Only relevant if daemon is embedded/restarted in-process.
- **getActiveTaskIds() allocates new array per call** — Minor given max_concurrent is 3-5. Could return `IterableIterator<string>` for iteration paths but would require interface changes across multiple consumers. Left as-is.

### Lens H (Config & DX)
- **Hot-reload watcher not wired** — `createConfigWatcher` exists but is never called in bootstrap. safety.yaml and people.yaml changes have no runtime effect. This is a runtime integration issue, not a config template/DX issue.
- **No `engineer env` command** — Would list required env vars and their status. `engineer doctor` already covers this in category 4 (Required Secrets). Low priority.
- **`create-plugin` uses internal import paths** — Scaffolded imports use relative paths that only work inside the monorepo. Relevant when SDK is extracted to an npm package.
- **No `docs/configuration.md` reference** — A standalone config reference doc would reduce code-reading. Significant writing effort outside the bootstrap scope.

## Round 3 — 1

### Lens I (Consistency & Patterns)
- ~30 remaining inline `error instanceof Error ? error.message : String(error)` call sites outside Phase 0-3 scope — to be cleaned up in respective Lens I runs for other phase groups
- Config injection style difference between bootstrap.ts (unpacks ConfigBundle) and system.ts (receives pre-extracted types) — correct architectural layering, no change needed
- Signal handler gap during bootstrap — already documented and accepted in start.ts comments

### Lens J (Minimalism & Dead Code)
- `getManifest()`, `getAllHealthRecords()`, `getHealthRecord()` have test-only callers but are useful diagnostic APIs (~3 lines each) — kept deliberately
- `LifecycleManager` interface has single implementation but provides documentation value as closure type — kept deliberately

## Round 1 — 2-plugin-loading

### Lens A (Structure & Organization)
- `system.ts` loose in `src/core/` — intentionally left as the sole loose file (83-line boundary factory, acceptable)
- Topology registration split across `system.ts` and `bootstrap.ts` — correct as-is (follows "whoever creates registers")
- No unit tests for `bootstrap.ts` / `system.ts` — out of scope for structure lens

### Lens B (Naming & Readability)
- `opts` vs `options` inconsistency in `facade.ts` — skipped because `recordDecision` has a real name collision (3rd param is already `options: ReadonlyArray<...>`); the `opts` abbreviation is pragmatic disambiguation

### Lens C (Abstractions & API Design)
- `requestTransition` (5 positional params, ~70 call sites) — `reason` and `triggeredBy` are both strings, easy to swap silently. Deferred due to blast radius across daemon, orchestrator, and tests.
- `updateTracking` (3 positional numbers, 0 production callers) — possibly dead code. Not worth refactoring unused method.
- Observer `upgrade()` on concrete only — correct by design; bootstrap is the composition root and should know concrete types.

### Lens D (Error Handling & Edge Cases)
- None — all 6 findings applied

### Lens E (Security & Trust Boundaries)
- None — all 6 findings applied

## Round 2 — 2-plugin-loading

### Lens F (Logging & Observability)
- **No tracing spans in bootstrap** — observer store unavailable until mid-bootstrap, and startup is <2s one-shot. Pino structured logs are sufficient.
- **start.ts has no structured logging for pre-bootstrap operations** — logger doesn't exist yet at those points. CLI output layer (`out.error/warn`) is the correct mechanism.

### Lens G (Performance & Resources)
- **`Date.parse()` per queued task per tick in `applyPriorityAging()`** — ~1us per call on V8, 50 tasks = 50us/tick. Not worth caching complexity.
- **`cleanupTable()` uncached prepared statements** — runs hourly, sub-ms compile time. Dynamic SQL makes caching awkward.
- **`collectReferencedBlobRefs()` JSON.parse on every observation** — runs hourly, <50ms even at 10K rows. Adding a `blob_refs` column would require migration for negligible gain.

### Lens H (Config & DX)
- **No escape syntax for `${...}` in config values** — Documented limitation in `loader.ts:119`. Unlikely to hit in practice — all config values using `${...}` are env var references by convention. Could add `\${...}` escape if needed later.

## Round 3 — 2

### Lens I (Consistency & Patterns)
- **C2:** Test helper naming conventions (`create*` vs `make*`) are inconsistent across orchestrator vs daemon tests — track for future convention doc, not worth a mass rename
- **C4:** `OrchestratorContext` is not narrowed per-subsystem (unlike `DaemonContext` which uses `Pick<>`), but this is pragmatic given tighter coupling — revisit if accidental coupling becomes a problem
- **S4:** Error transition reasons in `state_transitions` table are arbitrary strings for error outcomes vs structured constants for normal outcomes — consider typed reason enum in future

### Lens J (Minimalism & Dead Code)
- Ephemeral schemas (`src/schemas/ephemeral.ts`) contain ~15 schemas used only in their own test file — these are specification/documentation schemas by Layer 4 design, not dead code. Left as-is.
- Pure helper exports in `workspace-manager/index.ts` (`slugify`, `branchName`, `injectAuth`, `validateWorkspacePath`) and `action-executor.ts` (`shellEscape`, `resolveWorktreePath`, `resolveWorktreePathReal`) are exported only for test access. Kept for test coverage of complex logic.

## Round 1 — 3

### Lens A (Structure & Organization)
- **Topology registration pattern** — evaluated consolidating all publisher registrations into one block; decided the current colocated pattern (register publisher alongside component creation) is correct and intentional
- **logging.ts location** — evaluated moving `src/core/observer/logging.ts` back to `src/core/logging.ts`; decided to keep in observer/ since it's the primary consumer, and the conceptual benefit of moving is marginal

### Lens C (Abstractions & API Design)
- **No interfaces for Orchestrator or PeopleDirectory** — Orchestrator is a true singleton consumed only by the Daemon; PeopleDirectory is tiny (6 methods, all used). Low ROI for interface extraction.

### Lens E (Security & Trust Boundaries)
- **EventBus payloads not sanitized** — Current event schemas contain only structured data (states, costs, task IDs). Risk is future-facing only. Convention: publishers must not include secrets in payloads.
- **EventBus has no subscription ACLs** — All plugins are builtin. If third-party plugins are ever supported, EventBus subscription should be gated by the Registry.
- **PID file TOCTOU race** — Single-user desktop, informational file, millisecond race window. Accepted.
- **Config hot-reload without path validation** — Config files are user-controlled (same trust level as env vars). Accepted.
- **`engineerHome` path traversal** — Self-attack only (user controls their own env vars). Accepted.

## Round 2 — 3

### Lens F (Logging & Observability)
- **F12:** `system.ts` is completely silent — skipped because `bootstrap.ts` already logs the component creation step

### Lens G (Performance & Resources)
- **EventBus `matchesPattern` O(subscriptions) per event** — non-issue at 7 subscribers (Phase 3 lens)
- **`seenTriggerKeys` O(n) cleanup per tick** — non-issue at ~50 entries (Phase 4 lens)
- **Data lifecycle blob cleanup uses sync I/O** — hourly, bounded cost (Phase 12 lens)
- **Priority aging queries all queued tasks per tick** — indexed SELECT, ~1-10 rows (Phase 5 lens)
- **`reviewReminderTimes`** — false positive, already cleaned every tick
- **`blockedEscalationState`** — false positive, already cleaned every tick
- **`getEventsSince()` unbounded** — false positive, only caller uses paginated replay

### Lens H (Config & DX)
- **`subscriber_warn_threshold_ms` at daemon config top level** — This is an EventBus concern living in daemon config. Moving it would be a schema-level change affecting config migration. Flagged for future consideration.
- **No `--quiet` flag** — Only `--json` and `--verbose` exist. A `--quiet` mode (suppress non-error output) could be useful for scripting but isn't urgent.
- **`engineer stop` alias for `engineer shutdown`** — Some users may expect `stop` as the inverse of `start`. Could add as a Commander alias. Not applied to avoid scope creep.

## Round 3 — 3

### Lens I (Consistency & Patterns)
- **C1 (Duplicate completion logic):** `handleCompletedOutcome` in task-scheduler.ts and `completeTaskOnMerge` in review-handler.ts implement similar completion sequences. The merge path has extra logic (demo→code transition hop) that makes extraction non-trivial without overcomplicating. Both paths are now tested. Could be refactored in a future pass if the completion sequence grows more complex.

### Lens J (Minimalism & Dead Code)
- **GitHub-specific code in Core tier** (`trigger-poller.ts` lines ~211-229): `parseGitHubUrl` + `toExternalRef` are GitHub-specific URL parsing that doesn't belong in Core. Per Farzam: "the system should not know of 'github' — GitHub is a plugin and its tooling should be extracted." Proper fix requires the TriggerAdapter contract to provide structured `ExternalRef` data instead of raw URLs. This is a schema/contract change beyond Lens J scope.
- **`DaemonError` abstract base with single subclass**: All 7 core modules follow this identical pattern (abstract base + concrete subclasses). It's a project convention from the L7 typed errors initiative — not over-abstraction.

## Round 1 — 4

### Lens B (Naming & Readability)
- `this.ctx` in Observer (facade.ts) — decided to keep as-is (private field, small class, common abbreviation)
- `source: "safety"` in daemon/index.test.ts:756 — inconsistent with actual `"safety_layer"` source used in cost-tracker.ts, but outside bootstrap phase scope

### Lens D (Error Handling & Edge Cases)
- **Bootstrap failure doesn't report which step failed** — User sees "Bootstrap failed: [error]" without knowing which bootstrap step (DB, plugins, observability) caused it. The spinner shows the last started step, but the error message doesn't include step context. Low priority — the error message itself usually makes the step obvious.
- **`createLogger` throws bare `Error` instead of typed error** — Inconsistent with the rest of the codebase (DatabaseError, ConfigError, etc.). Low priority — the error message is descriptive, and bootstrap doesn't need to discriminate logger errors from others.
- **Signal handlers not registered during bootstrap** — Documented accepted gap (~2s window, OS reclaims resources). No change needed.

### Lens E (Security & Trust Boundaries)
- **EventBus payload sanitization at publish() level** — Intentionally not added. Would corrupt legitimate data. Documented as publisher responsibility instead. No current publisher includes raw secrets in payloads.
- **Observer-level auto-sanitization of data payloads** — Rejected as too expensive and prone to false-positive redaction. Kept as caller-responsibility with documented contract.

## Round 2 — 4

### Lens F (Logging & Observability)
- **Dashboard failure not logged to observer** — `launchDashboard()` uses `out.warn()` (CLI output only). Observer isn't threaded to it. Low priority: dashboard is non-critical, warning is visible in CLI output. Would require signature change.
- **`system.ts` has zero logging** — Intentionally left as-is. Pure factory with no I/O; bootstrap caller logs before/after. No debugging value in adding logging here.

### Lens G (Performance & Resources)
- **`getActiveTaskIds` array allocation** — Allocates a tiny array (max 5 elements) 2-3x per tick. Code clarity outweighs microseconds saved.

### Lens H (Config & DX)
- **`_ms` suffix confusing when fields accept duration strings** — Renaming is a breaking schema change. `.describe()` annotations + template comments mitigate for now.
- **`autonomy.decisions` open-key catalog** — Intentionally free-form by design. `.describe()` explaining this is sufficient.
- **Timezone IANA validation** — `Intl.supportedValuesOf('timeZone')` requires Node 21+. Defer to validation utility.
- **Progressive `engineer init`** — The `setup` wizard handles "just get started". Full phased init is a larger UX redesign.

## Round 3 — startup

### Lens I (Consistency & Patterns)
- **`extractErrorMessage` beyond phases 0-4 scope:** ~25+ additional files (adapter base classes, all plugin implementations, CLI commands, orchestrator subsystems) still use the inline `error instanceof Error ? error.message : String(error)` pattern — needs a dedicated sweep across the full codebase in respective phase-group reviews
- **Test mock divergence in `trigger-poller.test.ts`:** Uses inline `createMockContext()`/`makeDaemonConfig()` mocks instead of shared test helpers. Functional and correct; test-local mocks are acceptable for focused unit tests
- **Dead event types in schema:** ~9 forward-looking event types (`timeout.*`, `workspace.merge_conflict`, `git.*`, `health.config_reload_failed`) defined in `events.ts` but never published or subscribed — by design for future features

### Lens J (Minimalism & Dead Code)
- **`trigger.pr_review` event placeholder:** Schema and manifest contribution exist but no code publishes or subscribes. Left in place — documents planned feature intent, only ~10 lines
- **`DaemonError` abstract base with single subclass:** Only `DaemonAlreadyRunningError` extends it. Kept — 4-line cost, plausible second subclass, sound pattern
- **SDK barrel completeness:** Many re-exported schemas never imported by built-in plugins. Intentional — barrel is the future `packages/plugin-sdk/` extraction point

## Round 1 — phases5-6 (Scheduling & Workspace)

### Lens A (Structure & Organization)
- None — all actionable findings applied

### Lens B (Naming & Readability)
- **`getTaskRepo` possibly dead code** (`workspace-lifecycle.ts`): Method takes `Dispatch` but name says "Task." Only called in tests, never in production code. Candidate for removal in a future cleanup pass.

### Lens C (Abstractions & API Design)
- **`WorkspaceLifecycle` mixes 4 concerns**: Bundles workspace setup, session creation, milestone notifications, GitHub issue commenting, and AndonCord under one name. "WorkspaceLifecycle" accurately describes only 1-2 of these. Clean split: `WorkspaceSetup` + `PipelineNotifier` with `AndonCord` as a standalone dependency — each testable in isolation. Deferred because it touches the Orchestrator constructor and `executeTask` call sites.

### Lens D (Error Handling & Edge Cases)
- None — all 13 findings applied

### Lens E (Security & Trust Boundaries)
- None — all findings applied
