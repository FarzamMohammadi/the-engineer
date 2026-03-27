# Startup & Configuration — Technical Research

Implementation reference for the planning session. Every file path, schema field, code location, and architectural detail needed to build the plan from `ideation.md`.

This file + `ideation.md` together provide complete context. No external knowledge required.

---

## Project Context

**The Engineer** is an autonomous software engineering agent — a daemon-based system that monitors GitHub repos for issues, assigns tasks to itself, works through them using AI CLI tools (Claude Code, Codex, Gemini, OpenCode), and creates PRs.

**Architecture:** Three-tier — Core (13 components including EventBus, TaskEngine, Orchestrator, Daemon) → Adapters (5 types: Trigger, Communication, LLM, Tool, GitHosting) → Plugins (8 builtin, swappable implementations).

**Tech stack:** TypeScript, Node.js 22, pnpm, ESM, SQLite (better-sqlite3), Commander.js CLI, Zod schemas, Vitest, Biome linting.

**Current state:** 2,248 tests (unit + integration + E2E), 0 TypeScript errors, 0 Biome warnings. Layer 8 refinement in progress.

**Working conventions:** Co-founder partnership between Farzam (product compass, final say on all decisions) and the agent (depth, execution). Collaborate deeply, use Q&A, never assume, never rush. Session logs in `implementation-docs/sessions/NNN.md`.

**Key files for broader context (read if needed, not required for planning):**
- `implementation-docs/active.md` — current focus and status
- `implementation-docs/8-refinement-v2/roadmap.md` — full refinement roadmap
- `implementation-docs/decisions.md` — decision log (175 decisions)

---

## Current File Map

### Files to MODIFY

| File | Current Purpose | What Changes |
|------|----------------|--------------|
| `src/cli/index.ts` (294 lines) | Commander.js CLI with 14 commands, global options (--home, --config-dir, --verbose, --json) | Remove commands: `prepare`, `init`, `setup`, `config validate`, `config migrate`. Rename `shutdown` → `stop`. Absorb `config validate` checks into `doctor`. |
| `src/cli/commands/start.ts` (273 lines) | `runStart()`: directory creation → config loading → pre-flight → dry-run/background/foreground modes. `runForeground()`: bootstrap → dashboard → signal handlers → daemon start. | Add first-run detection, TTY guard, lock file, setup flow call, friendly "already running" message. Keep returning-user path mostly intact. |
| `src/cli/bootstrap.ts` (266 lines) | 12-step sequential init: logger → db → core → hooks → registry → observability → people → orchestrator → data lifecycle → daemon → event topology → plugins. Reverse-order cleanup on failure. | Add plugin load result reporting (loaded/skipped names). Enhance `bootstrap_complete` observation with plugin details. |
| `src/cli/commands/doctor.ts` | 11 check categories, `runPreFlightChecks()` (categories 1-7), `runAllChecks()` (all 11). | Absorb config validation from `config validate` command. May need minor restructuring. |
| `src/plugins/loader.ts` (167 lines) | `discoverEnabledPlugins()`: scans plugin config dir for .yaml files, filters BUILTIN_PLUGINS by matching ID. `loadBuiltinPlugins()`: sequential load per plugin. | Make `loadBuiltinPlugins` return structured result `{ loaded: string[], skipped: string[], total: number }` instead of void. |
| `src/plugins/builtin.ts` (~141 lines) | 8 builtin plugin definitions with inline manifests and factory functions. | Add `requirements` array to each manifest for declarative auto-detection. |
| `src/schemas/adapters.ts` | `PluginManifestSchema`, `AdapterTypeSchema`, `MergeStrategySchema`, etc. | Add `requirements` field to `PluginManifestSchema`. Optionally add adapter type metadata for selection mode. |
| `src/core/daemon/index.ts` | Daemon factory with start/stop/tick. Lines 517-526: signal handler registration. Lines 561-567: signal handler cleanup in stop(). | Remove signal handler registration from `start()` (lines 517-526). Remove signal handler cleanup from `stop()` (lines 561-567). |
| `src/index.ts` (7 lines) | Entry point: `program.parseAsync().catch()`. | Add `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers. |
| `src/cli/commands/shutdown.ts` | Shutdown command implementation. | Rename file to `stop.ts`, update internal references. |

### Files to CREATE

| File | Purpose |
|------|---------|
| `src/cli/setup/detect.ts` | Environment detection: check PATH for binaries, check env vars, check git remote. Pure function: `detectEnvironment() → DetectionResult`. No I/O side effects beyond reading env and spawning `which`/`git`. |
| `src/cli/setup/prompts.ts` | Hardcoded prompt functions per plugin: `promptGitHubTrigger()`, `promptClaudeCodeLlm()`, etc. Each ~20 lines. Uses `@inquirer/prompts`. |
| `src/cli/setup/generate.ts` | Config file generation: takes detection results + user answers → writes YAML files atomically (temp dir → rename). |
| `src/cli/setup/index.ts` | Orchestrates the first-run setup flow: detect → guided plugin selection → prompt per plugin → confirm → generate. Called by `start.ts` when no config exists. |

### Files to DELETE (or disconnect from CLI)

| File | Current Purpose | Action |
|------|----------------|--------|
| `src/cli/commands/prepare.ts` (69 lines) | Scaffolds `seed/` directory with config templates. | Delete. Seed mechanism documented as alternative in README. |
| `src/cli/commands/init.ts` (233 lines) | Creates `~/.engineer/` from templates, plugin selection via checkboxes. | Delete. Functionality absorbed into setup module. |
| `src/cli/commands/setup.ts` (335 lines) | Interactive wizard: 6 questions, generates 8-9 config files. | Delete. Functionality absorbed into setup module. Reuse config generation patterns. |
| `src/cli/commands/config-validate.ts` | Validates config files. | Delete. Absorbed into doctor. |
| `src/cli/commands/config-migrate.ts` | Config migration (currently stub). | Delete. Deferred entirely. |

### Files REFERENCED but not modified

| File | Why it matters |
|------|---------------|
| `src/cli/home.ts` (44 lines) | `resolveEngineerHome()`: --home flag > ENGINEER_HOME env > ~/.engineer. `resolveDirectories()`: returns all subdirectory paths. Used by setup to know where to write configs. |
| `src/cli/output.ts` (187 lines) | Output singleton: human/json/quiet modes. Color detection. Used for all CLI output. |
| `src/cli/progress.ts` (92 lines) | Braille spinner. Writes to stderr. Used during bootstrap. |
| `src/cli/templates.ts` | Template strings for config files. Currently used by init/setup. Setup module may reuse or replace these. |
| `src/config/loader.ts` (462 lines) | `loadConfigDir()`: loads 5 YAML files + env var resolution + duration parsing. `walkSchema()` exists here (used for duration parsing only). Config loading stays as-is — setup writes files, loader reads them. |
| `src/cli/pid.ts` | PID file utilities. Used by daemon start for single-instance check. |
| `src/cli/commands/start-background.ts` | `spawnBackground()`: re-invokes process detached. Must work with or without setup. |
| `src/cli/commands/start-dashboard.ts` | `launchDashboard()`: starts War Room server. No changes needed. |

---

## Plugin Config Schema Reference (all fields)

### github-trigger (`src/plugins/trigger/github-trigger/config.ts`)
| Field | Type | Required | Default | Prompt in setup? | Notes |
|-------|------|----------|---------|-------------------|-------|
| `github_token` | string, min(1) | YES | — | YES (or detect from $GITHUB_TOKEN) | Secret, mask in display |
| `repos` | array of {owner: string, name: string}, min(1) | YES | — | YES (or detect from git remote) | |
| `labels` | string[] | no | `[]` | NO (default) | |
| `poll_interval_ms` | number, int, positive | no | `30_000` | NO (default) | |

### github-comm (`src/plugins/communication/github-comm/config.ts`)
| Field | Type | Required | Default | Prompt? | Notes |
|-------|------|----------|---------|---------|-------|
| `github_token` | string, min(1) | YES | — | YES (shared with github-trigger) | Same token, written as `${GITHUB_TOKEN}` |
| `label_prefix` | string | no | `"engineer:"` | NO (default) | |

### telegram-comm (`src/plugins/communication/telegram-comm/config.ts`)
| Field | Type | Required | Default | Prompt? | Notes |
|-------|------|----------|---------|---------|-------|
| `bot_token` | string, min(1) | YES | — | YES (or detect from $TELEGRAM_BOT_TOKEN) | Secret |
| `chat_id` | string, min(1) | YES | — | YES (or detect from $TELEGRAM_CHAT_ID) | |
| `parse_mode` | enum: MarkdownV2, Markdown, HTML | no | `"MarkdownV2"` | NO (default) | |
| `disable_link_preview` | boolean | no | `true` | NO (default) | |

### github-hosting (`src/plugins/git-hosting/github-hosting/config.ts`)
| Field | Type | Required | Default | Prompt? | Notes |
|-------|------|----------|---------|---------|-------|
| `github_token` | string, min(1) | YES | — | YES (shared) | Same token |
| `default_merge_strategy` | enum: merge, squash, rebase | no | `"squash"` | NO (default) | |

### claude-code-llm (`src/plugins/llm/claude-code-llm/config.ts`)
| Field | Type | Required | Default | Prompt? | Notes |
|-------|------|----------|---------|---------|-------|
| `model` | string | no | `"claude-sonnet-4-20250514"` | NO (default) | |
| `max_tokens` | number, int, positive | no | `16_384` | NO (default) | |
| `cli_path` | string | no | `"claude"` | NO (default) | |
| `command_timeout_ms` | number, int, positive | no | `600_000` | NO (default) | |

### opencode-llm (`src/plugins/llm/opencode-llm/config.ts`)
| Field | Type | Required | Default | Prompt? | Notes |
|-------|------|----------|---------|---------|-------|
| `model` | string | no | `"opencode/gemini-3.1-pro"` | NO (default) | |
| `cli_path` | string | no | `"opencode"` | NO (default) | |
| `command_timeout_ms` | number, int, positive | no | `600_000` | NO (default) | |

### gemini-cli-llm (`src/plugins/llm/gemini-cli-llm/config.ts`)
| Field | Type | Required | Default | Prompt? | Notes |
|-------|------|----------|---------|---------|-------|
| `model` | string | no | `"gemini-2.5-pro"` | NO (default) | |
| `cli_path` | string | no | `"gemini"` | NO (default) | |
| `command_timeout_ms` | number, int, positive | no | `600_000` | NO (default) | |

### bash-tool (`src/plugins/tool/bash-tool/config.ts`)
| Field | Type | Required | Default | Prompt? | Notes |
|-------|------|----------|---------|---------|-------|
| `max_output_bytes` | number, int, positive | no | `10_485_760` (10MB) | NO | |
| `command_timeout_ms` | number, int, positive | no | `300_000` (5 min) | NO | |
| `env_passthrough` | string[] | no | `[]` | NO | |
| `blocked_patterns` | string[] (19 regex patterns) | no | (19 security patterns) | NO | |
| `audit_commands` | boolean | no | `true` | NO | |

**Summary:** Across all 8 plugins, only 6 fields actually need prompting: `github_token` (shared by 3 plugins), `repos` (github-trigger), `bot_token` (telegram), `chat_id` (telegram). Everything else has sensible defaults. The LLM plugins have ALL defaults — zero prompting needed if CLI is on PATH.

---

## Plugin Manifest Reference

| Plugin ID | Type | Critical | Enabled (default) | Requirements (to be added) |
|-----------|------|----------|--------------------|-----------------------------|
| `github-trigger` | trigger | true | true | `[{type:"env", name:"GITHUB_TOKEN"}]` |
| `claude-code-llm` | llm | true | true | `[{type:"binary", name:"claude"}]` |
| `opencode-llm` | llm | true | **false** | `[{type:"binary", name:"opencode"}]` |
| `gemini-cli-llm` | llm | true | **false** | `[{type:"binary", name:"gemini"}]` |
| `bash-tool` | tool | true | true | `[{type:"binary", name:"bash"}]` |
| `github-comm` | communication | **false** | true | `[{type:"env", name:"GITHUB_TOKEN"}]` |
| `telegram-comm` | communication | **false** | true | `[{type:"env", name:"TELEGRAM_BOT_TOKEN"}, {type:"env", name:"TELEGRAM_CHAT_ID"}]` |
| `github-hosting` | git_hosting | true | true | `[{type:"env", name:"GITHUB_TOKEN"}]` |

**Plugin dependency grouping:** github-trigger, github-comm, and github-hosting all require GITHUB_TOKEN. Detecting that one env var enables the entire GitHub family. Implementation should group these.

---

## Adapter Type Metadata (to be added)

| Adapter Type | Selection Mode | Setup Order | Setup Label |
|-------------|---------------|-------------|-------------|
| `llm` | single | 1 | "Which AI do you use?" |
| `trigger` | single | 2 | "Where do your tasks come from?" |
| `git_hosting` | single | 3 | "Where does your code live?" |
| `communication` | multi | 4 | "How should The Engineer reach you?" |
| `tool` | multi | 5 | (auto-enabled, no prompt needed) |

---

## Specific Code Locations for Safety Fixes

### Signal Handler Dedup

**File:** `src/core/daemon/index.ts`

**Remove from `start()` (lines 517-526):**
```typescript
// Signal handling (tracked for cleanup in stop())
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  const handler = () => {
    stop().catch((error: unknown) => {
      observer.error(`Error during ${signal} shutdown`, { err: sanitizeErrorMessage(error) });
    });
  };
  signalHandlers.push({ signal, handler });
  process.on(signal, handler);
}
```

**Remove from `stop()` (lines 561-567) — signal handler cleanup:**
```typescript
// Remove signal handlers
for (const { signal, handler } of signalHandlers) {
  process.removeListener(signal, handler);
}
signalHandlers.length = 0;
```

**Also remove:** `signalHandlers` array declaration (search for `const signalHandlers` near top of factory).

**CLI already handles signals** at `src/cli/commands/start.ts` lines 178-190 — `handleShutdownSignal` calls `daemon.stop()` then `cleanup()`. This is the correct single owner.

### Global Crash Safety Net

**File:** `src/index.ts` (currently 7 lines)

**Current:**
```typescript
#!/usr/bin/env node
import { program } from "./cli/index.js";

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

**Add before `program.parseAsync()`:**
```typescript
process.on("uncaughtException", (error) => {
  process.stderr.write(`Fatal: uncaught exception: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`Fatal: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  process.exitCode = 1;
});
```

Uses `process.stderr.write()` not `console.error()` because logger may not exist at crash time.

### Friendly "Already Running" Message

**File:** `src/cli/commands/start.ts`, `runForeground()` catch block (around line 204)

**Current:** Generic `Startup failed: ${sanitizeErrorMessage(error)}` for all errors.

**Change:** Check for `DaemonAlreadyRunningError` specifically before the generic path:
```typescript
if (error instanceof DaemonAlreadyRunningError) {
  const pidHint = error.existingPid ? ` (PID: ${String(error.existingPid)})` : "";
  out.error(`The Engineer is already running${pidHint}.`);
  out.log("  Use 'engineer stop' to stop it, or 'engineer status' to check.");
  cleanup();
  return 1;
}
```

**Note:** Verify `DaemonAlreadyRunningError` has `existingPid` property. Check `src/core/daemon/index.ts` for the error class definition.

### Config File Permissions

**Every `writeFileSync` call that writes plugin configs** must use `{ mode: 0o600 }`.

Locations:
- `src/cli/commands/setup.ts` line 332: `writeFileSync(filePath, yamlStringify(content), "utf8")` → add mode
- `src/cli/commands/init.ts` line 117: `writeFileSync(filePath, content, "utf8")` → add mode
- New setup module: all file writes must use `0o600`

---

## "Config Exists" Detection Logic

**Definition:** Config exists = `~/.engineer/config/plugins/` directory contains at least one `.yaml` file AND `~/.engineer/config/daemon.yaml` exists (or any core config file).

**Implementation:**
1. `resolveDirectories(engineerHome)` gives us the paths
2. Check `existsSync(dirs.config)` — no directory = first run
3. If directory exists, check for any `.yaml` file in `dirs.plugins` — no plugin configs = first run
4. If plugin configs exist, attempt `loadConfigDir()` — if it throws, tell user to run `doctor`
5. If load succeeds = valid config, proceed to normal startup

**NOT "partial":** If config dir exists but is invalid, that's a broken config, not "partial." `doctor` diagnoses it. We don't try to repair.

---

## Testing Strategy (from expert panel)

### Pure Function Extraction (testable without I/O)

| Function | Input | Output | Tests |
|----------|-------|--------|-------|
| `detectEnvironment(env, execPaths, gitRemote)` | env vars map, PATH binaries, git remote output | `DetectionResult` with per-plugin availability | Many cases: all found, none found, partial, wrong token format |
| `determinePluginsToEnable(detection, userChoices)` | Detection result + guided flow answers | List of plugins to enable + config values | Plugin dependency grouping, single-select enforcement |
| `generateConfigFiles(enabledPlugins, values)` | Plugin list + user-provided values | Array of `{path, content}` objects | YAML structure correctness, env var references, file permissions |

### Thin Interactive Layer (manual testing only)

The prompt functions (`promptGitHubTrigger`, etc.) call `@inquirer/prompts` — these can't be unit tested. Keep them thin: call pure detection functions, present results, collect answers, pass to pure generation functions. The thin layer gets manual testing; everything else is automated.

### Integration Tests

- `engineer start --plugins <path>` with valid configs → daemon starts
- `engineer start` with existing valid config → normal startup (no prompts)
- `engineer start` when already running → friendly message + exit code 1
- `engineer stop` → clean shutdown (was `shutdown`)

### Existing Test Impact

- **Daemon tests** (`src/core/daemon/index.test.ts`): signal handler tests need updating after removal
- **CLI tests** (`test/unit/cli/`): command registration tests need updating for removed/renamed commands
- **E2E tests** (`test/e2e/daemon-lifecycle.e2e.test.ts`): may need adjustment for renamed `stop`
- **Plugin loader tests**: need new test for structured return type from `loadBuiltinPlugins`

---

## Implementation Ordering

**Phase 0 — Ship independently (safety fixes, no setup changes):**
1. Signal handler dedup (daemon + start.ts)
2. Global crash handlers (src/index.ts)
3. Config file permissions (all writeFileSync calls)
4. Friendly "already running" message
5. Fix bash-tool missing YAML bug
6. Clean up dead `enabled` field on manifests

**Phase 1 — Command surface:**
7. Rename `shutdown` → `stop` (file rename + CLI registration)
8. Absorb `config validate` into `doctor`
9. Remove `prepare`, `init`, `setup`, `config migrate` commands from CLI
10. Remove corresponding source files

**Phase 2 — Setup module (new code):**
11. Add `requirements` to PluginManifestSchema + all 8 builtin manifests
12. Build `detect.ts` — environment detection (pure function)
13. Build `prompts.ts` — hardcoded prompt functions per plugin (~80 lines total)
14. Build `generate.ts` — atomic config file generation (temp dir → rename)
15. Build `index.ts` — setup orchestrator (detect → guide → prompt → confirm → generate)

**Phase 3 — Wire into start:**
16. Add TTY guard to start.ts
17. Add lock file for concurrent start protection
18. Add first-run detection (config exists check)
19. Call setup module when no config exists
20. Add bootstrap transparency (plugin load reporting)
21. Add `.describe()` to all plugin config schemas (hygiene, not for prompts)

---

## Current Setup Flow (what gets replaced)

### setup.ts (335 lines) — Interactive Wizard
Asks 6 questions: home dir, GitHub token guidance, repos, LLM provider, Telegram, safety level. Generates 8-9 config files via `generateConfigs()`. Each file written with `writeConfigIfOk()` which checks for overwrites.

**Reusable patterns:** `SAFETY_PRESETS` object (conservative/balanced/autonomous cost limits), `REPO_PATTERN` regex, YAML generation via `yamlStringify()`.

### init.ts (233 lines) — Non-Interactive Config Generation
Plugin selection via `selectPlugins()` (checkboxes + single-select for LLM). Template writing via `writeTemplates()`. Reads from seed directory if present.

**Reusable patterns:** `CATEGORY_ORDER` array, `TYPE_LABELS` map, plugin filtering by type.

### prepare.ts (69 lines) — Seed Directory Scaffolding
Writes `SEED_TEMPLATES` to `seed/` directory. Prefers `seed-example/` files over built-in templates.

**Nothing reusable** — this entire concept is being removed.

---

## Key Dependencies

| Package | Used For | Already Installed |
|---------|----------|-------------------|
| `@inquirer/prompts` | Interactive CLI prompts (input, select, confirm, checkbox) | YES |
| `yaml` | YAML stringify for config file generation | YES |
| `commander` | CLI framework | YES |
| `chalk` | Colored output (used in init.ts) | YES |

No new dependencies needed.

---

## Core Config Files (written on first run alongside plugin configs)

First-run setup writes 4 core config files with conservative defaults. These are NOT prompted — always defaults.

### daemon.yaml
```yaml
tick_interval_ms: 30s
max_concurrent: 1
plugins:
  health_check_interval_ms: 1m
  health_check_timeout_ms: 5s
  consecutive_failures_threshold: 3
```

### safety.yaml (conservative preset)
```yaml
cost_limits:
  api:
    per_task:
      cost_usd: 1.0
    daily:
      cost_usd: 10.0
    monthly:
      cost_usd: 100.0
merge:
  auto_merge_after_approval:
    default: false
```

### workspace.yaml
```yaml
workspace_root: ~/.engineer/workspaces
branch_prefix: engineer/
default_base_branch: main
pr:
  default_merge_strategy: squash
  delete_branch_after_merge: true
cleanup:
  preserve_branch_on_failure: true
  preserve_branch_on_cancel: false
```

### people.yaml (minimal, user edits after)
```yaml
people:
  - id: owner
    name: Project Owner
    roles:
      - owner
    contacts:
      - channel: github
        handle: your-github-username
    preferences:
      notification_level: milestones
```

**Source:** These defaults come from the current `setup.ts` `generateConfigs()` function (lines 193-314) and `SAFETY_PRESETS` (lines 26-57). The new setup module should produce identical YAML.

---

## Generated Plugin YAML Format

Plugin configs use `${ENV_VAR}` references for secrets — the actual token value is never written to disk. The config loader resolves these at load time.

### github-trigger.yaml (example)
```yaml
github_token: "${GITHUB_TOKEN}"
repos:
  - owner: FarzamMohammadi
    name: the-engineer
```

### github-comm.yaml
```yaml
github_token: "${GITHUB_TOKEN}"
```

### github-hosting.yaml
```yaml
github_token: "${GITHUB_TOKEN}"
```

### claude-code-llm.yaml (all defaults, just needs to exist)
```yaml
# model: claude-sonnet-4-20250514
# cli_path: claude
```

### telegram-comm.yaml (only if user has Telegram tokens)
```yaml
bot_token: "${TELEGRAM_BOT_TOKEN}"
chat_id: "${TELEGRAM_CHAT_ID}"
```

### bash-tool.yaml (empty or minimal — just needs to exist)
```yaml
# Using defaults
```

**Critical pattern:** A plugin is "enabled" if and only if its config YAML file exists in `~/.engineer/config/plugins/`. The file can be nearly empty (defaults apply via Zod), but it MUST exist. This is why the bash-tool bug matters — setup never writes `bash-tool.yaml`, so bash-tool silently doesn't load.

---

## Dry-Run and Background Mode Interaction with First-Run

### `--dry-run` during first-run
Show what setup WOULD do: detection results, which plugins would be enabled, which configs would be written. Don't write anything. Don't start daemon. Exit 0.

### `--daemon` (background mode) during first-run
Cannot prompt interactively in a detached process. Options:
- Fail with: "First-run setup requires an interactive terminal. Run `engineer start` without --daemon first."
- Or: use `--plugins <path>` to provide configs non-interactively.

The TTY guard handles this automatically — background processes don't have a TTY.

---

## Config Subcommand Removal from index.ts

**Lines 253-279 in `src/cli/index.ts`** define the `config` subcommand:
```typescript
const configCmd = program.command("config").description("Configuration management");

configCmd
  .command("validate")
  .description("Validate all config files")
  .action(() => { ... });

configCmd
  .command("migrate")
  .description("Migrate config files to the current version")
  .action(() => { ... });
```

**Action:** Remove the entire `configCmd` block (both `validate` and `migrate` subcommands). `validate` is absorbed into `doctor`. `migrate` is deferred entirely.

---

## DaemonAlreadyRunningError Location

**File:** `src/core/daemon/index.ts` (near the top of the file, before the factory function)

```typescript
export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly existingPid: number | null) {
    super(
      existingPid
        ? `Another Daemon instance is already running (PID: ${String(existingPid)})`
        : "Another Daemon instance is already running",
    );
    this.name = "DaemonAlreadyRunningError";
  }
}
```

**Confirmed:** Has `existingPid` property (number | null). The friendly message code in ideation.md is correct.

---

## signalHandlers Array Location

**File:** `src/core/daemon/index.ts`, inside the `createDaemon()` factory function, near other state variables.

Search for: `const signalHandlers: Array<{ signal: string; handler: () => void }> = [];`

This is declared alongside other factory-scoped state like `running`, `shuttingDown`, `tickInterval`, `startedAt`.
