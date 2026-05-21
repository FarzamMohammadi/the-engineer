# Startup & Configuration — Implementation Plan (Final)

What was planned, what was built, and what changed along the way. This is the post-implementation record.

---

## Summary

Consolidated the CLI from 14 commands to 6. Made `engineer start` the single entry point — detects first run, walks through explicit plugin selection per adapter type, writes configs, starts the daemon. No separate setup/init/prepare commands.

**Final command surface:**
```
engineer start              # Setup (first run) + start daemon
engineer stop               # Graceful shutdown
engineer status             # Is it running? Task queue depth
engineer logs               # View daemon logs
engineer doctor             # Health checks (11 categories)
engineer why <task-id>      # Explain a task's decision trail
```

---

## What Was Built

### Safety Fixes
- **Signal handler dedup** — Removed duplicate SIGTERM/SIGINT handlers from daemon. CLI (`start.ts`) is the single signal handler owner. Daemon only exposes `stop()`.
- **Crash safety net** — `uncaughtException` and `unhandledRejection` handlers in `src/index.ts` with `process.exit(1)` (not just exitCode).
- **Friendly "already running"** — `DaemonAlreadyRunningError` caught specifically, shows PID and suggests `stop`/`status`.
- **Doctor remedy messages** — All references to deleted commands updated across doctor, dashboard, start-background.

### Command Surface (14 → 6)
- Renamed `shutdown` → `stop`
- Deleted: `prepare`, `init`, `setup`, `config validate`, `config migrate`, `dashboard`, `install`, `create-plugin`
- `config validate` absorbed into `doctor` (category 3 already did the same validation)
- `dashboard` auto-launches from `start` (standalone command redundant)
- `install` and `create-plugin` deferred (zero users need them today)
- Deleted `enabled` field from `PluginManifestSchema` (dead code — loader never read it)
- Removed `SEED_TEMPLATES` from `templates.ts` (only consumer deleted)

### Setup Module (`src/cli/setup/`)

Three files:
- **`types.ts`** — Shared types (`DetectionResult`, `AdapterTypeConfig`, `GuidedSetupResult`). Breaks circular import between setup.ts and prompts.ts.
- **`setup.ts`** — Detection (pure functions + I/O wrapper), config generation, file writing, `needsSetup()` predicate, `runFirstTimeSetup()` orchestrator, `ADAPTER_TYPE_CONFIGS` registry.
- **`prompts.ts`** — Thin interactive layer using `@inquirer/prompts`. One prompt per adapter type with `select()`/`checkbox()`. Per-plugin config functions. `ExitPromptError` handling.

### Plugin Selection Flow

**Explicit selection per adapter type** — not auto-detection. One prompt per adapter type, plugins grouped by type.

**`ADAPTER_TYPE_CONFIGS`** — Centralized registry driving the flow:
```typescript
{ type: "llm",           selectionMode: "single", required: true }
{ type: "trigger",       selectionMode: "single", required: true }
{ type: "git_hosting",   selectionMode: "single", required: true }
{ type: "communication", selectionMode: "multi",  required: false }
{ type: "tool",          selectionMode: "multi",  required: true }
```

**`combined_with`** on `PluginManifestSchema` — Plugin family grouping. GitHub trigger/comm/hosting reference each other. Selecting one pre-checks the others as defaults in later prompts. Declarative data on the manifest, not hardcoded logic.

**`requirements`** on `PluginManifestSchema` — Declarative `[{type: "binary", name: "claude"}]` arrays. Detection derives its check list from these (no hardcoded binary/env var lists).

**Detection** still runs but its role is "show availability status next to each option" and "auto-fill config values" — not "decide what to enable."

**Per-plugin config** — Fully dynamic via `promptForConfig` optional function on `BuiltinPlugin`. Each plugin that needs interactive user input (beyond `${VAR}` secrets) declares its own prompt function in `builtin.ts`. The setup module calls it generically — zero knowledge of plugin names. `generateConfigFiles` merges user config INTO templates, preserving `${VAR}` refs. Secrets handled separately by `promptForSecrets` which scans all generated template content for `${VAR}` patterns dynamically.

**`.env` secret management** — Tokens collected during setup via masked `password()` prompts, written to `~/.engineer/.env` with 0o600. Loaded on every startup before config resolution. Env vars already set take precedence (CI/Docker compatible). Doctor checks .env permissions.

### Wiring (`start.ts`)
- TTY guard as first check (fail clearly for headless environments)
- First-run detection calls setup before `loadConfigDir` (ordering fix)
- `--plugins <path>` option for non-interactive setup (copies plugin YAMLs, generates core config defaults)
- `--dry-run` support for both interactive and non-interactive setup paths
- `PluginLoadResult` return type from `loadBuiltinPlugins` (loaded/failed arrays)

### Documentation
- **README.md** — Lean quick-start, 6-command table, data-first sections with references at bottom
- **docs/cli.md** — Full rewrite: first-run flow, all 6 commands with options, configuration guide
- **docs/architecture/** — Moved from single file to directory (`overview.md` + `three-tier-model.md`)
- **implementation-docs/** — Added note that these are internal dev docs, removed before v1

---

## Files Changed

### Created
- `src/cli/setup/types.ts`
- `src/cli/setup/setup.ts`
- `src/cli/setup/prompts.ts`
- `src/cli/setup/setup.test.ts`
- `docs/architecture/overview.md` (moved from `docs/architecture.md`)
- `docs/architecture/three-tier-model.md` (copied from implementation-docs)

### Modified
- `src/cli/index.ts` — 6 commands (was 14)
- `src/cli/commands/start.ts` — TTY guard, first-run detection, setup call, already-running, dry-run
- `src/cli/bootstrap.ts` — PluginLoadResult reporting
- `src/plugins/loader.ts` — PluginLoadResult return type
- `src/plugins/builtin.ts` — Added `requirements`, `combined_with`, deleted `enabled`
- `src/schemas/adapters.ts` — Added `PluginRequirementSchema`, `combined_with`, deleted `enabled`
- `src/core/daemon/index.ts` — Removed signal handlers
- `src/index.ts` — Added crash handlers
- `src/cli/commands/doctor.ts` — Updated remedy messages
- `src/cli/commands/dashboard.ts` — Updated references
- `src/cli/commands/start-background.ts` — Updated references
- `src/cli/templates.ts` — Removed SEED_TEMPLATES, updated comments
- `scripts/reset.sh` — Updated for new command surface
- `README.md` — Full rewrite
- `docs/cli.md` — Full rewrite

### Renamed
- `src/cli/commands/shutdown.ts` → `src/cli/commands/stop.ts`

### Deleted
- `src/cli/commands/prepare.ts`
- `src/cli/commands/init.ts`
- `src/cli/commands/setup.ts`
- `src/cli/commands/config-validate.ts`
- `src/cli/commands/config-migrate.ts`
- `src/cli/commands/install.ts`
- `src/cli/commands/create-plugin.ts`
- `docs/architecture.md` (moved to `docs/architecture/overview.md`)
- `seed-example/config/` (flattened to `seed-example/plugins/` only)

### Dev convenience
- `seed-example/plugins/` — Plugin configs for fast dev reset via `--plugins` flag

---

## What Was Cut (and why)

| Cut | Reason |
|-----|--------|
| Advisory lock file | Race condition requires two humans to type same command simultaneously. Non-problem. |
| Atomic writes (temp dir + rename) | Write takes milliseconds. Recovery = re-run `start`. |
| Version stamps on configs | Zero config versions, zero migration tooling. Deferred. |
| `default_enabled` rename | Renamed dead code to different dead code. Deleted the field instead. |
| 4-file setup module | Over-segmented for ~300 lines. 3 files (types + testable + TTY) is the right split. |
| `SetupChoices` interface | Inline return type is simpler. |
| Discriminated union for requirements | Both branches identical shape. Flat object with enum is simpler. |
| Auto-detect plugin selection | User has no agency. Replaced with explicit per-adapter-type prompts. |
| Auto-detect repo from git remote | CWD is The Engineer's repo, not the target. Always prompt. |
| `dashboard` command | Auto-launches from `start`. Standalone command redundant. |
| `install` command | Zero users need launchd/systemd generation today. |
| `create-plugin` command | No plugin SDK docs, contracts still being refined. Premature. |
| Hardcoded doctor categories 7-8 | GitHub/Telegram connectivity checks redundant with dynamic category 4 scan. |
| Hardcoded token refs in setup | Templates already contain `${VAR}` refs. Setup merges, doesn't duplicate. |
| Zod schema introspection for prompts | `promptForConfig` on BuiltinPlugin is simpler — plugin declares its own prompt. |

---

## Test Impact

- 2,279 tests passing (was 2,248 before this work)
- 4 test files deleted (for removed commands), 6 doctor tests removed (categories 7-8)
- 45 tests in `setup.test.ts` (detection, git remote, requirements, config generation, needsSetup, adapter configs, combined_with, promptForConfig, detection derivation)
- 23 tests in `env.test.ts` (parse, serialize, load, write, permissions)
- 0 TypeScript errors, 0 Biome errors, 0 circular dependencies
