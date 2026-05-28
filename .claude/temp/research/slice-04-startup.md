# Research: Slice 4 — Startup & Configuration

**Date**: 2026-05-19 | **Repo**: the-engineer | **Branch**: main | **Commit**: a1e9533

Scope: code quality audit, simplification, and UX polish across CLI entry, bootstrap,
plugin loading, daemon startup, configuration, and first-run setup. Goal — bring these
files to OSS-grade quality.

---

## What I Found

### 1. Entry point and command registration
**Files**: `src/index.ts` (18 lines), `src/cli/index.ts` (188 lines)

- `src/index.ts` — shebang, global `uncaughtException`/`unhandledRejection` handlers, delegates to `program.parseAsync`. Clean. Uses `console.error` on line 15 (other files use `process.stderr.write`) — minor inconsistency.
- `src/cli/index.ts` — Commander program. 7 commands registered: `start`, `stop`, `status`, `logs`, `doctor`, `why`, `retry`. Global options: `--home`, `--config-dir`, `--verbose`, `--json`. `preAction` hook creates the Output singleton and applies `--config-dir` → `ENGINEER_CONFIG_DIR` env var.
- `VERSION` constant is `"0.0.1"`, hardcoded in `cli/index.ts` line 16. `package.json` version is also `"0.0.1"`. Two sources of truth for version.
- Line 140: inline type import `import("../config/loader.js").ConfigBundle` inside the `doctor` action — not a top-level `import type`.
- `parseDuration` (lines 19-29) is a named `function` — good.

### 2. Bootstrap — component wiring
**Files**: `src/cli/bootstrap.ts` (302 lines)

- Single `bootstrap()` async function. Wires ~13 components in dependency order inside one big try block. Each step has a numbered comment (1-12).
- Late-binding closure for `authUrlProvider` (line 103) — the git hosting plugin reference is `null` until plugin loading completes; the closure reads it lazily. This keeps Core plugin-opaque. The `authUrlProvider` arrow has no return type annotation.
- Returns `BootstrapResult { daemon, observer, cleanup, hints }`. The `cleanup()` method is a shorthand method in an object literal — no return type annotation.
- Failure path: catch block does reverse-order teardown (registry shutdown, db close, logger close). Well-handled.
- `milestones` record tracks elapsed ms per step for observability.
- The function is long (~240 lines of body) but cohesive — it does one thing (wire the system). Newspaper order holds: types at top, `bootstrap` is the only function.

### 3. ENGINEER_HOME resolution
**Files**: `src/cli/home.ts` (44 lines)

- `resolveEngineerHome(flagValue?)` — precedence flag > `ENGINEER_HOME` env > `~/.engineer`. Clean.
- `resolveDirectories(engineerHome)` — returns 8 standard subdirs. `EngineerDirectories` interface.
- No issues. Small, correct, well-named.

### 4. CLI output
**Files**: `src/cli/output.ts` (187 lines)

- `Output` class — `log`, `success`, `warn`, `error`, `heading`, `keyValue`, `table`, `data`, `blank`. Mode-aware (`human`/`json`/`quiet`). Singleton via `createOutput`/`getOutput`/`resetOutput`.
- **Dead code: `OutputMode` includes `"quiet"`** — the class JSDoc (lines 21-22) documents a `--quiet` flag, but `cli/index.ts` has no `--quiet` flag and nothing ever constructs Output with `mode: "quiet"`. The `quiet` branch in `data()` (line 138) is unreachable. Half-implemented feature.
- **Dead code: `Output.table()`** (lines 95-134, ~40 lines) — grep confirms zero call sites anywhere in `src/`. Pure dead weight.
- Naming: `clr` (line 39) is an abbreviation — coding standards require full names. Should be `colorize` or `applyColor`. `w` (line 119) is an abbreviated local closure for a column-width getter.
- `detectColor()` honors `NO_COLOR` / `FORCE_COLOR` / TTY — correct, standard behavior.

### 5. Progress spinner
**Files**: `src/cli/progress.ts` (92 lines)

- `Spinner` class — braille frames, writes to stderr, no-ops when not a TTY or in json/quiet mode. `start`, `update`, `succeed`, `fail`, `stop`.
- `succeed`/`fail` write raw ANSI codes (`\x1B[32m`) directly instead of going through `chalk` like `output.ts` does. Inconsistency — two different ways to colorize across two files in the same layer.
- `msg` local variable (lines 48, 58) — minor abbreviation.
- Otherwise clean.

### 6. The `start` command
**Files**: `src/cli/commands/start.ts` (399 lines), `start-background.ts` (41 lines), `start-dashboard.ts` (37 lines)

- `runStart()` orchestrates: first-run setup → load `.env` → capture shell env vars → register secrets → create dirs → load config → pre-flight checks → dry-run / background / foreground.
- `runForeground()` — spinner-driven progress, bootstrap, dashboard launch, APE-proof signal handling (first signal graceful, second signal hard exit, 10s force-exit timer).
- `runDryRun()` — prints what would happen.
- **Double scan**: `findResolvedEnvVars(dirs.config)` is called twice — once inside `captureEnvVarsToFile` (line 114) and once directly for `discoveredVars` (line 119). The config dir is walked twice on every start. Minor inefficiency, easily consolidated.
- Line 180: parameter typed as `import("./doctor.js").DoctorCategory[]` — inline type import instead of top-level `import type`.
- `start-background.ts` — `spawnBackground` spawns a detached child with `stdio: "ignore"`. Sanity-checks the child with `process.kill(pid, 0)`.
- `start-dashboard.ts` — `launchDashboard` only starts the dashboard if `engineer.db` exists. On first run the DB is created during bootstrap, and `launchDashboard` runs after bootstrap, so the DB exists by then.
- `start.ts` is 399 lines — past the 500-line smell threshold is not hit, but it carries several concerns (env capture, config load, preflight, dry-run, foreground, background, signal handling). Cohesive enough — it is "the start command" — but worth examining whether signal-handling could be its own unit.

### 7. The `doctor` command — health checks
**Files**: `src/cli/commands/doctor.ts` (725 lines)

- 9 check categories + conditional risky-config + aggregation + terminal formatting, all in one file.
- **Bug — orphaned JSDoc**: line 555 has `/** Run all doctor check categories (8 base + 1 conditional risky config). */` immediately followed on line 556 by `/** Category: CLI session artifact accumulation (informational). */` then `function checkCliArtifacts()`. The first JSDoc was meant for `runAllChecks` (which is actually defined at line 624) — a previous edit inserted `checkCliArtifacts` between the JSDoc and its function, orphaning it. Also "8 base + 1 conditional" is wrong — there are 9 base checks.
- **Stale category numbering**: comments label checks "Category 1" through "Category 8", then `checkCliArtifacts` is unnumbered, then `checkRiskyConfig` is labeled "Category 11" (line 472). Categories 9 and 10 do not exist. The numbering rotted across edits.
- **Plugin-opacity concern — `checkCliArtifacts`** (lines 557-622, ~65 lines): scans `~/.claude/projects/` and warns if it exceeds 500 MB. This hardcodes knowledge of the Claude Code CLI's session-history directory. A user running Codex, Gemini, or OpenCode as their LLM plugin has no `~/.claude/projects/`. Core/CLI code assuming a specific plugin's on-disk layout is exactly the pattern Plugin Opacity forbids. It is informational-only, but it does not belong in a plugin-agnostic doctor.
- The check functions themselves are clean, well-structured guard-clause style, with actionable `remedy` strings.
- `wsRoot` (line 334) — abbreviation; should be `workspaceRoot`.
- `runAllChecks` returns 9 categories (+1 conditional). `runPreFlightChecks` returns 7. Used by `cli/index.ts` doctor action and `start.ts` respectively.
- 725 lines — past the 500-line smell threshold. It IS cohesive (all doctor), but mixed concerns (checks vs aggregation vs formatting) make a split defensible.

### 8. First-run setup orchestrator
**Files**: `src/cli/setup/setup.ts` (600 lines), `src/cli/setup/types.ts` (39 lines)

- Pure functions: `detectEnvironment`, `checkRequirementsMet`, `parseGitRemote`, `generateConfigFiles`, `findUnresolvedEnvVars`, `findResolvedEnvVars`. I/O wrappers: `runDetection`, `writeConfigFiles`, `writePluginDocs`, `runFirstTimeSetup`, `runNonInteractiveSetup`. Good functional-core / imperative-shell separation.
- `ADAPTER_TYPE_CONFIGS` — 5 adapter types with friendly labels ("Which AI do you use?"), selection mode, setup order, required flag.
- `runDetection` (lines 166-191) calls `whichBinary` which runs `execSync("which ${name}")` — `which` does not exist on Windows (`where` is the Windows equivalent). Known limitation.
- **`checkRequirementsMet` is duplicated**: defined in `setup.ts` (lines 91-108, exported) AND re-defined privately in `prompts.ts` (lines 11-27). Same logic, two copies. The `prompts.ts` copy could import the `setup.ts` one.
- `runFirstTimeSetup` line 425: prints "First run — auto-configuring from environment..." then immediately runs interactive prompts. "auto-configuring" misrepresents an interactive flow.
- No OS detection anywhere in the flow.
- `runNonInteractiveSetup` — seed path handling, validates `plugins/` subdir, copies configs, checks unresolved env vars, warns on people-placeholder values.

### 9. Interactive prompts
**Files**: `src/cli/setup/prompts.ts` (436 lines)

- `runGuidedSetup` — the full wizard: detection summary → per-adapter-type selection (single/multi) → per-plugin config → people directory → secret collection → summary → confirm.
- Uses `@inquirer/prompts` (`select`, `checkbox`, `input`, `password`, `confirm`).
- `showDetectionSummary` prints found/not-found binaries, env vars, git remote. **There is no confirmation step after the detection summary** — it flows straight into plugin selection.
- Pre-selection logic: `combined_with` match → detected → first. Sensible defaults.
- `ExitPromptError` (Ctrl+C) is caught and returns `null` — clean cancel.
- Duplicated `checkRequirementsMet` (see item 8).
- The prompts are friendly and clear. The flow is ~15-20 prompts but each is a discrete, well-scoped question.

### 10. Config templates
**Files**: `src/cli/templates.ts` (749 lines)

- All string constants: 5 core config templates (commented-out defaults), 8 plugin config templates, 13 fully-documented "example" templates. `ALL_TEMPLATES` + `ALL_EXAMPLE_TEMPLATES` manifests.
- **Contradiction — Telegram template**: `TELEGRAM_COMM_TEMPLATE` (line 261) and `EXAMPLE_TELEGRAM_COMM` (lines 629-630) both state "Chat IDs are resolved automatically via /start handshake — no TELEGRAM_CHAT_ID needed." But `future-considerations.md` ("`engineer telegram-setup` CLI Command", "Telegram Receive Capability") says the Telegram plugin is send-only and chat-id resolution is a *future* feature not yet built. The template promises behavior that does not exist. Either the template is wrong or the plugin changed — needs verification against `src/plugins/communication/telegram-comm/`.
- Three overlapping sources of config content exist: `templates.ts` (compact + example templates), `seed-example/configs/` + `seed-example/plugins/`, and the Zod schemas in `src/schemas/config.ts`. Drift risk — a default changed in the schema must be hand-mirrored in two template sets and the seed.

### 11. Plugin docs
**Files**: `src/cli/plugin-docs.ts` (2350 lines)

- String constants — markdown documentation for each adapter type and plugin, written to `~/.engineer/docs/` during setup. Not behavioral code; out of deep-audit scope per the plan. Skimmed: well-structured. One stale reference noted — line 1492 area discusses Telegram `/start` handshake as a plugin requirement, consistent with send-only reality, which contradicts the `templates.ts` claim above.

### 12. Config loading and validation
**Files**: `src/config/loader.ts` (446 lines), `src/config/env.ts` (109 lines), `src/config/watcher.ts` (82 lines)

- `loader.ts` — error classes (`ConfigError`, `EnvVarError`, `ValidationError`), env-var resolution (`resolveEnvVars`), duration parsing via Zod schema introspection (`getNumberPaths` → `PathNode` tree → `applyDurations`), `loadConfig`, `loadConfigSafe`, `loadConfigDir`.
- **`getNumberPaths` is exported but used only inside `loader.ts`** (by `parseDurations`). grep confirms no external use. Either it should be private, or `knip` is tolerating it via config. Same question for `resolveEnvVars` — that one IS used externally (by `plugins/loader.ts`).
- **Config versioning machinery**: `CURRENT_CONFIG_VERSION` (=1), `ConfigVersionSchema`, `detectConfigVersion`, and a warning when a config's version exceeds the supported version. For a pre-v1 project whose universal rule is "zero backward compatibility, clean slate, no migrations," version-negotiation machinery may be premature — there has only ever been version 1. Candidate for simplification, but it is a deliberate design choice — needs a decision.
- `env.ts` — `parseEnvFile`, `serializeEnvFile`, `loadEnvFile` (shell env wins), `writeEnvFile` (0o600, merge), `checkEnvFilePermissions`. Clean, secure, well-tested.
- `watcher.ts` — `createConfigWatcher` with `fs.watch` + 500ms debounce; treats file deletion as an error (so safety.yaml can't be silently reset). Clean.
- The duration-parsing schema-introspection (`walkSchema`, `PathNode`) is ~110 lines of fairly intricate code. It works and is tested, but it is the single most complex thing in the config layer — worth a second look at whether it earns that complexity vs. a simpler explicit list of duration fields.

### 13. Plugin discovery and loading
**Files**: `src/plugins/loader.ts` (189 lines), `src/plugins/builtin.ts` (180 lines)

- `loader.ts` — `discoverEnabledPlugins` (a plugin is enabled iff its config YAML exists), `loadSinglePlugin` (create → register → load config → merge shared config → initialize), `loadBuiltinPlugins`. Critical-plugin failures throw; non-critical failures deregister and continue. Clean, well-commented, plugin-opaque.
- `builtin.ts` — 8 plugin manifests defined as a `const` array, validated against `PluginManifestSchema` at import time. `factories` map (id → constructor), `promptFunctions` map (only `github-trigger` has one). `BUILTIN_PLUGINS` assembled from validated manifests + factories.
- `factories[manifest.id] as () => BaseAdapter` (line 171) — type assertion. If a manifest id has no matching factory, this silently produces `undefined` cast as a function, deferring the failure to call time. A guard that every manifest has a factory would fail loud at import.
- Clean otherwise.

### 14. Reset script
**Files**: `scripts/reset.sh` (67 lines)

- Stops daemon, builds, `pnpm link --global`, wipes or preserves `~/.engineer`, re-seeds, optionally starts.
- **Bug — macOS-only path**: lines 22-23 hardcode `PNPM_HOME="$HOME/Library/pnpm"`. On Linux pnpm's home is typically `~/.local/share/pnpm`. Breaks on Linux.
- **Hardcoded seed path**: line 49 `SEED_PATH=".../seed-example/"` — no way to pass a custom seed directory.
- No OS guard.

### 15. Seed and gitignore
**Files**: `seed-example/` (11 files), `.gitignore` (31 lines)

- `seed-example/` is tracked: `configs/` (5 core YAMLs) + `plugins/` (6 plugin YAMLs).
- **`seed-example/` is the user's personal config, not a generic reference.** `seed-example/plugins/claude-code-llm.yaml` has `cli_path: /Users/farzammohammadi/.local/bin/claude` — a hardcoded absolute path to one developer's machine. `seed-example/plugins/github-trigger.yaml` watches `FarzamMohammadi/the-engineer`. `seed-example/configs/daemon.yaml` sets `logging.level: debug`. A new user copying this seed inherits a broken `cli_path` and the wrong repo. This contradicts the slice's plan to keep `seed-example/` as the tracked reference template.
- `.gitignore` line 25 ignores `seed/` — an unexplained pattern; no `seed/` directory exists. Possibly a leftover. There is no `seed-example-*` ignore pattern for personal seed directories.
- `.gitignore` lines 23-24: `.env*` then `!.env*.example` — ignores real env files, tracks examples. Correct.

### 17. Daemon startup/shutdown lifecycle
**Files**: `src/core/daemon/index.ts` (start/stop functions), `src/cli/pid.ts`, `src/cli/commands/stop.ts`, `src/cli/commands/status.ts`

- `daemon.start()` (Protocol P1) — atomic: `checkAndWritePidFile` → start health loop → start data lifecycle → crash-recovery scan (orphaned `active` tasks → `queued`) → register event subscriptions → set tick interval. On any failure, reverse-order rollback. Clean, well-structured.
- `daemon.stop()` (Protocol P15) — stop tick, flush cost snapshot, stop lifecycle, signal orchestrator yield, drain dispatches with timeout, drain evaluations, shutdown plugins, unsubscribe, remove PID file. Clean.
- `pid.ts` — `pidFilePath`, `readPidFile`, `isProcessRunning` (signal-0 probe). Small, correct.
- `stop.ts` — `runStop` SIGTERM + poll for exit; `cleanupAll` also stops the dashboard via its PID file. Clean.
- `status.ts` — PID check + read-only SQLite task counts. Clean.
- **Assessment**: the daemon-startup portion of this slice is already solid. The PID-file logic exists in two places — `daemon/index.ts` has its own private `pidFilePath`/`checkAndWritePidFile`/`removePidFile`, while `cli/pid.ts` has `pidFilePath`/`readPidFile`/`isProcessRunning` used by `stop.ts`/`status.ts`. Two `pidFilePath` definitions computing the same path. Minor duplication worth noting.

### 16. package.json scripts
**Files**: `package.json`

- Scripts: `test*`, `build`, `build:dashboard`, `dev` (`tsx src/index.ts`), `dev:dashboard`, `lint`, `lint:fix`, `typecheck`, `check:exports`, `check:circular`.
- **No `setup` script, no `prepare` script, no `start` script.** `bin.engineer` → `./dist/index.js` (the built output).
- `build` = `tsdown ... && cp -r migrations && build:dashboard`.

### Cross-cutting concerns

- **Stale `engineer init` references — `init` is not a command** (`cli/index.ts` registers only `start`, `stop`, `status`, `logs`, `doctor`, `why`, `retry`). Two docs reference it:
  - `docs/configuration/README.md` lines 51-53 ("First Run: `engineer init`") — whole section wrong.
  - `docs/plugins/trigger/github-trigger.md` line 72 ("Running `engineer init` prompts for the repo...") — wrong.
- **`docs/configuration/README.md`** also references a `--config` flag (line 19) — the actual flag is `--config-dir` (`cli/index.ts` line 36).
- **`docs/cli.md` is partially stale**:
  - Says doctor runs "9 independent health check categories" and gives a 9-row table (categories 1-9). The table's #9 is "Risky Config" — but `checkRiskyConfig` is the *conditional 10th*. The actual 9th unconditional check, `checkCliArtifacts`, is **not in the table at all**. Doc table does not match code.
  - "Installing the CLI" (lines 7-16) documents `pnpm run build` + `pnpm setup` + `source ~/.zshrc` + `pnpm link --global`. Note `pnpm setup` here is pnpm's *built-in* command (configures `PNPM_HOME`), not a project script. This whole section needs rewriting for the new `pnpm run setup` flow.
- **Tests that will need updating when code changes**:
  - `tests/unit/cli/setup/setup.test.ts` — covers `detectEnvironment`, `parseGitRemote`, `checkRequirementsMet`, `generateConfigFiles`, `writeConfigFiles`, `needsSetup`, `findUnresolvedEnvVars`, `ADAPTER_TYPE_CONFIGS`, doc-path conventions, manifests. Heavy coverage of `setup.ts` pure functions.
  - `tests/unit/cli/commands/doctor.test.ts`, `tests/unit/cli/output.test.ts`, `tests/unit/cli/progress.test.ts`, `tests/unit/cli/home.test.ts`.
  - `tests/unit/config/{loader,env,watcher}.test.ts`, `tests/unit/plugins/loader.test.ts`.
  - No test for `prompts.ts` (interactive — hard to test), `bootstrap.ts`, or `start.ts` (E2E covers daemon lifecycle indirectly).
- **`VERSION` duplication**: `cli/index.ts` hardcodes `"0.0.1"`; `package.json` also `"0.0.1"`. Two sources.
- **`engineer install` / `engineer dashboard` do not exist** — earlier exploration mentioned an `install.ts`; confirmed no such file in `src/cli/commands/` and no such command registered. Clean — no dead code there.

---

## What It Means

### Patterns to follow
- **Functional core / imperative shell** — `setup.ts` already separates pure functions from I/O wrappers. New code (OS detection, etc.) should follow: a pure `detectOperatingSystem()`-style decision function, a thin caller.
- **Manifest-driven, no hardcoded plugin lists** — `runDetection` derives binary/env checks from `BUILTIN_PLUGINS` manifests. `checkCliArtifacts` is the one place this is violated; everything new must stay plugin-opaque.
- **Guard clauses + actionable remedies** — `doctor.ts` checks are the model: validate, bail early, attach a `remedy` string. The OS-detection gate and any new pre-flight messaging should match this shape.
- **Numbered, commented wiring** — `bootstrap.ts` step comments are good. Keep them in sync if steps change.

### Risks
- **Stale docs teach the wrong thing** — `docs/configuration/README.md` documents a non-existent `engineer init` command and a wrong flag name. `docs/cli.md`'s doctor table doesn't match the code. Anyone onboarding via these docs is misled. These must be fixed in the same unit of work as the code (Definition of Done item 7).
- **Telegram template contradiction** — `templates.ts` claims automatic chat-id resolution that `future-considerations.md` says doesn't exist. Whatever the truth, the template a new user receives must not promise a feature that isn't there. Verify against the actual telegram plugin before touching the template.
- **`checkCliArtifacts` plugin-opacity violation** — shipping an OSS tool whose health check assumes one specific LLM CLI's directory layout is a visible architectural smell. Reviewers will flag it. Decide: make it generic, gate it behind the active LLM plugin, or remove it.
- **Config-version machinery vs. "zero backward compatibility"** — keeping version-negotiation code in a pre-v1 codebase that explicitly disclaims backward compatibility is a contradiction a sharp reviewer will notice. Either is defensible, but it should be a conscious, documented decision.
- **Three sources of config content** — `templates.ts`, `seed-example/`, and the Zod schemas can drift. Not fixable in this slice without restructuring, but worth noting so changes touch all three.
- **`pnpm setup` naming collision** — `pnpm setup` is a pnpm built-in (configures `PNPM_HOME`). A project script named `setup` is only reachable as `pnpm run setup`. Docs and README must always write `pnpm run setup` explicitly to avoid confusion.

### Simplification candidates (low-risk, high-clarity)
- Delete `Output.table()` — 40 lines, zero call sites.
- Delete `"quiet"` from `OutputMode` and its dead branches, plus the `--quiet` references in the class JSDoc — half-implemented, unreachable.
- Consolidate the duplicated `checkRequirementsMet` (setup.ts ↔ prompts.ts).
- Fix the double `findResolvedEnvVars` scan in `start.ts`.
- Make `getNumberPaths` private if `knip` allows (no external users).
- Rename abbreviations: `clr` → `colorize`, `wsRoot` → `workspaceRoot`.
- Fix the orphaned JSDoc + stale category numbering in `doctor.ts`.

### Resolved during research
- **Telegram template claim** — VERIFIED CORRECT. `telegram-comm.ts` (lines 118-360) implements full `/start` handshake capture: `getUpdates` polling, username→chat_id mapping, disk persistence. The template is right; `future-considerations.md`'s "Telegram Receive Capability" and "`engineer telegram-setup` CLI Command" entries are stale and should be removed.
- **`start.ts` signal handling** — DECIDED: extract the ~60-line APE-proof shutdown block into its own unit.
- **`seed-example/` is personal config** — it carries a hardcoded `cli_path` to one developer's machine and watches that developer's repo. For the slice's "tracked reference template" plan to work, `seed-example/` must first be sanitized to generic placeholder values.

### Open questions (need a decision before planning)
- **`checkCliArtifacts`**: remove it, make it generic, or gate it behind the active LLM plugin? It violates Plugin Opacity as written.
- **Config-version machinery**: keep it (forward-looking) or strip it (pre-v1, zero-backcompat)? It is ~30 lines, currently dead in practice (no template writes a `version:` field).
- **`doctor.ts` 725 lines**: split into `doctor/` (checks / aggregation / formatting) or leave as one cohesive file?
- **`pnpm run setup` script naming**: `pnpm setup` is a pnpm built-in; the project script is only reachable as `pnpm run setup`. Confirm the name or pick an unambiguous alternative.
