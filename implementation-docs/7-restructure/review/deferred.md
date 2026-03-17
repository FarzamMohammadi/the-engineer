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
- **Bootstrap cleanup() only closes DB** — Logger streams, BlobStore, ObservabilityStore not explicitly closed. Not actionable: Node.js process exit handles cleanup. Only relevant if daemon is embedded/restarted in-process.
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
