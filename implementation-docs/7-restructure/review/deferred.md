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
