# Startup & Configuration — Implementation Plan

## Context

The Engineer's CLI has 14 commands, three of which (`prepare`, `init`, `setup`) all solve "get me configured." A new user has to pick between them and still run `doctor` and `start` separately. This refinement consolidates the command surface to 9 commands, makes `engineer start` the single entry point (auto-detects state, runs guided setup on first run), and fixes real bugs discovered during review.

The ideation doc has the decisions. The research doc has every file path, schema field, and code location. This plan turns them into implementation steps. Expert panel review applied — over-engineering trimmed, gaps filled.

---

## Phase 0 — Safety Fixes (ship independently, no setup changes)

Each item is a standalone commit. No dependencies between them.

### 0.1 Signal Handler Dedup

**Problem:** Both `start.ts` (lines 160-190) and daemon `start()` (lines 517-526) register SIGTERM/SIGINT handlers. Two async shutdown sequences race on the same signal.

**Fix:** CLI owns signal handling. Daemon only exposes `stop()`.

**Files:**
- `src/core/daemon/index.ts` — Remove signal handler registration from `start()` (lines 517-526), remove cleanup from `stop()` (lines 561-567), remove `signalHandlers` array declaration (line 146)

**Tests:**
- `src/core/daemon/index.test.ts` — Update any stop() tests that assert handler cleanup
- Verify daemon start/stop lifecycle tests still pass

**Acceptance:** `daemon.start()` registers zero process-level signal handlers. CLI's `handleShutdownSignal` in `start.ts` is the single owner. Document in code: "When using the daemon programmatically, the caller is responsible for signal handling and must call `daemon.stop()` on shutdown signals."

### 0.2 Global Crash Safety Net

**Problem:** `src/index.ts` is 7 lines with no `uncaughtException` or `unhandledRejection` handler. Long-running daemon crashes silently.

**Fix:** Add handlers before `program.parseAsync()`. Both MUST call `process.exit(1)` — not just set exitCode. For `uncaughtException`, Node.js exits after the handler but the daemon may be in corrupted state. For `unhandledRejection`, Node.js does NOT reliably exit by default — the daemon would limp along in undefined state.

**File:** `src/index.ts`

```typescript
process.on("uncaughtException", (error) => {
  process.stderr.write(`Fatal: uncaught exception: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`Fatal: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  process.exit(1);
});
```

Uses `process.stderr.write()` (not `console.error()`) because logger may not exist at crash time. Uses `process.exit(1)` (not `process.exitCode`) because a daemon running after an unhandled rejection is in undefined state — crash immediately.

**Tests:** Unit test — verify handlers call `process.exit(1)`.

**Acceptance:** Unhandled exceptions/rejections write to stderr and exit immediately.

### 0.3 Friendly "Already Running" Message

**Problem:** `start.ts` catch block shows generic `Startup failed: ...` for `DaemonAlreadyRunningError`.

**Fix:** Check for `DaemonAlreadyRunningError` specifically before the generic path.

**File:** `src/cli/commands/start.ts` — in `runForeground()` catch block (~line 204)

```typescript
import { DaemonAlreadyRunningError } from "../../core/daemon/errors.js";

if (error instanceof DaemonAlreadyRunningError) {
  const pidHint = error.existingPid != null ? ` (PID: ${String(error.existingPid)})` : "";
  out.error(`The Engineer is already running${pidHint}.`);
  out.log("  Use 'engineer stop' to stop it, or 'engineer status' to check.");
  cleanup();
  return 1;
}
```

Note: `existingPid` is `number | undefined` (not `null`), so use `!= null`.

**Tests:** Unit test for the specific error path.

**Acceptance:** Running `engineer start` when daemon is active shows PID and suggests `stop`/`status`.

### 0.4 Bash-Tool Missing YAML Bug

**Problem:** `setup.ts` doesn't write `bash-tool.yaml`, but `discoverEnabledPlugins` requires a YAML file to exist. Bash tool silently doesn't load after setup.

**Fix:** Since `setup.ts` is deleted in Phase 1, this bug only needs fixing in the new setup module (Phase 2). The new `generateConfigFiles` always includes `bash-tool.yaml` when bash is detected. No changes to existing files.

**Acceptance:** After first-run setup, `bash-tool.yaml` exists in plugins dir and bash-tool loads.

### 0.5 Doctor Remedy Messages

**Problem:** Doctor check functions reference deleted commands in remedy strings (e.g., "Run 'engineer init' to set up plugins").

**Fix:** Grep all doctor output for references to `init`, `setup`, `prepare`, `config validate`, `shutdown`. Update remedy messages to reference `engineer start` or `engineer doctor` as appropriate.

**File:** `src/cli/commands/doctor.ts`

**Tests:** Grep the file post-edit to confirm zero references to deleted commands.

**Acceptance:** All doctor remedy messages reference only the 9 surviving commands.

---

## Phase 1 — Command Surface Consolidation (14 → 9)

### 1.1 Rename `shutdown` → `stop`

**Files:**
- Rename `src/cli/commands/shutdown.ts` → `src/cli/commands/stop.ts`
- Update internal function name: `runShutdown` → `runStop`
- `src/cli/index.ts` — Change command registration from `shutdown` to `stop`, update import path
- `test/e2e/daemon-lifecycle.e2e.test.ts` — Update any references to "shutdown" command name

**Tests:** E2E test for `engineer stop` still passes.

**Acceptance:** `engineer stop` works. `engineer shutdown` does not exist.

### 1.2 Remove 5 Commands + Files

**Delete files:**
- `src/cli/commands/prepare.ts`
- `src/cli/commands/init.ts`
- `src/cli/commands/setup.ts`
- `src/cli/commands/config-validate.ts`
- `src/cli/commands/config-migrate.ts`

**Modify:**
- `src/cli/index.ts` — Remove all command registrations for `prepare`, `init`, `setup`, `config` (entire subcommand group with `validate` and `migrate`). Remove imports.

**Config validate absorption:** Doctor's `checkConfigFiles()` (category 3) already validates the exact same 5 schemas with the same `loadConfigSafe()` function. Zero code changes needed in doctor.

**Templates cleanup:**
- `src/cli/templates.ts` — Remove `SEED_TEMPLATES` (only used by deleted `prepare.ts`). Keep `ALL_TEMPLATES` and `ALL_EXAMPLE_TEMPLATES`.

### 1.3 Delete `enabled` field from manifests

**Problem:** `enabled` field on manifests is dead code — loader ignores it entirely. Renaming to `default_enabled` without wiring it in is just different dead code.

**Fix:** Delete the field entirely from `PluginManifestSchema` and all 8 manifests. When something actually needs a "should this auto-enable" signal, add it then with real consumers from day one. The setup module's detection logic (Phase 2) handles auto-enablement via requirements + guided selection — no manifest field needed.

**Files:**
- `src/schemas/adapters.ts` — Remove `enabled` from `PluginManifestSchema`
- `src/plugins/builtin.ts` — Remove `enabled` from all 8 manifests
- Any tests or code referencing `manifest.enabled` — remove

**Tests:** Schema validation tests pass. Grep for `.enabled` on manifest types to catch all references.

**Acceptance:** No `enabled` field on manifests. No dead code.

**Tests (Phase 1 overall):**
- Remove any tests that import deleted files
- Verify `doctor` still passes all checks
- Verify 9 commands remain: `start`, `stop`, `status`, `logs`, `why`, `doctor`, `dashboard`, `install`, `create-plugin`

---

## Phase 2 — Setup Module (new code)

New module at `src/cli/setup/` with 2 files: `setup.ts` (detection + generation + orchestration — all pure or near-pure) and `prompts.ts` (thin interactive layer that needs a TTY). The split that matters is "testable" vs "needs a TTY." Everything else is one concern.

### 2.1 Add `requirements` to Plugin Manifests

**Schema change in `src/schemas/adapters.ts`:**

```typescript
export const PluginRequirementSchema = z.object({
  type: z.enum(["binary", "env"]),
  name: z.string(),
});
export type PluginRequirement = z.output<typeof PluginRequirementSchema>;
```

Simple flat object — both types have identical shape today. No discriminated union overhead. If a future requirement type needs different fields (e.g., `{ type: "port", port: 5432 }`), refactor to discriminated union then.

Add to `PluginManifestSchema`:
```typescript
requirements: z.array(PluginRequirementSchema).default([]),
```

Note: `.default([])` means existing manifests that don't specify requirements get an empty array ("needs nothing"). This is correct for backwards compatibility. Document: adding new requirement types is a non-breaking schema change.

**Update `src/plugins/builtin.ts`** — Add `requirements` to all 8 manifests:
- `github-trigger`: `[{type:"env", name:"GITHUB_TOKEN"}]`
- `claude-code-llm`: `[{type:"binary", name:"claude"}]`
- `opencode-llm`: `[{type:"binary", name:"opencode"}]`
- `gemini-cli-llm`: `[{type:"binary", name:"gemini"}]`
- `bash-tool`: `[{type:"binary", name:"bash"}]`
- `github-comm`: `[{type:"env", name:"GITHUB_TOKEN"}]`
- `telegram-comm`: `[{type:"env", name:"TELEGRAM_BOT_TOKEN"}, {type:"env", name:"TELEGRAM_CHAT_ID"}]`
- `github-hosting`: `[{type:"env", name:"GITHUB_TOKEN"}]`

**Tests:** Schema validation tests for `PluginRequirementSchema`. Manifest validation still passes.

### 2.2 Build `src/cli/setup/setup.ts` — Detection, Generation, Orchestration

This file contains all pure/near-pure functions: environment detection, requirements checking, config file generation, and the orchestrator that ties everything together.

**Detection — two-layer split:**

```typescript
// Pure layer (testable):
export interface DetectionResult {
  binaries: Record<string, string | null>;  // name → path or null
  envVars: Set<string>;                     // names that are present AND non-empty
  gitRemote: { owner: string; name: string } | null;
}

export function detectEnvironment(
  env: Record<string, string | undefined>,
  binaryPaths: Record<string, string | null>,
  gitRemoteOutput: string | null,
): DetectionResult;

export function checkRequirementsMet(
  plugin: { requirements: Array<{ type: "binary" | "env"; name: string }> },
  detection: DetectionResult,
): boolean;
// Must handle unknown requirement types gracefully (skip, not crash) for future extensibility

export function parseGitRemote(output: string): { owner: string; name: string } | null;
// Explicitly picks the "origin" remote. Multi-remote repos: origin wins. Document why.

// I/O wrapper (production entry point):
export function runDetection(): DetectionResult;
// Calls execSync("which claude") etc. with timeout: 5000 (matches doctor checks).
// Calls execSync("git remote -v") with timeout: 5000.
// Catches all exec errors → returns "not found" (never propagates).
// Empty/whitespace-only env vars treated as ABSENT.
```

**Generation:**

```typescript
export interface GeneratedFile {
  relativePath: string;  // e.g., "config/plugins/github-trigger.yaml"
  content: string;
}

export function generateConfigFiles(
  selectedPlugins: string[],
  pluginConfigs: Record<string, Record<string, unknown>>,
): GeneratedFile[];
// Pure function. Returns array of {relativePath, content}:
// - 4 core configs (daemon.yaml, safety.yaml, workspace.yaml, people.yaml) with conservative defaults
// - Plugin configs for each selected plugin (env var references for secrets, never raw values)
// - bash-tool.yaml always included when bash is selected (fixes the missing YAML bug)
// - Example templates to example-templates/ dir
// - No version stamps (deferred with migration tooling)
// - people.yaml: detect github username from git config or leave blank — never write a placeholder
//   that becomes live config

export function writeConfigFiles(
  engineerHome: string,
  files: GeneratedFile[],
): void;
// Simple writeFileSync with mode: 0o600 for each file.
// Creates parent directories as needed.
// No atomic write ceremony — the write takes milliseconds.
// Recovery from any partial write: re-run "engineer start" → needsSetup detects missing files → reruns setup.
```

**Orchestrator:**

```typescript
export interface SetupOptions {
  engineerHome: string;
  pluginsPath?: string;  // --plugins <path> for non-interactive mode
  dryRun?: boolean;
}

export async function runFirstTimeSetup(options: SetupOptions): Promise<boolean>;
// Returns true if setup completed, false if user cancelled.
// Orchestrates: detect → guide → prompt → generate → write.
// Catches ExitPromptError from @inquirer/prompts (Ctrl+C mid-setup) → returns false.
//
// Non-interactive mode (--plugins <path>):
// - Read YAML files from provided path, copy to plugins dir with 0o600
// - Generate core configs with defaults
// - No prompts. Fail with clear error if any plugin config is invalid.
// - Document: --plugins only works on first run. Configs are copied, not symlinked.
//
// Dry-run: handled by start.ts (existing --dry-run flag), NOT by setup module.

export function needsSetup(engineerHome: string): boolean;
// Checks: config dir exists AND plugins dir has at least one .yaml file.
// Exported from setup module (not start.ts) — single owner of "what does configured mean."
```

**Plugin dependency grouping:** GITHUB_TOKEN detection enables github-trigger + github-comm + github-hosting as a family. One detection, three plugins.

**Warnings:** Warn if no LLM plugin is selected (not just when no trigger). An LLM is as critical as a trigger — the daemon starts but can't do work without one.

**Tests for setup.ts (many):**
- `detectEnvironment`: all binaries found, none found, partial, env vars present/absent/empty-string/whitespace-only
- `parseGitRemote`: SSH format, HTTPS format, multiple remotes (picks origin), no remote, malformed output
- `checkRequirementsMet`: various plugin/detection combos, unknown requirement type (graceful skip)
- `generateConfigFiles`: verify YAML content, env var references, core config defaults, bash-tool always included when selected
- `writeConfigFiles`: real temp dir, verify 0o600 permissions, verify parent dir creation
- `needsSetup`: no config dir, empty plugins dir, plugins dir with .yaml files, plugins dir with non-.yaml files only

### 2.3 Build `src/cli/setup/prompts.ts` — Guided Plugin Setup (thin interactive layer)

```typescript
export async function runGuidedSetup(
  detection: DetectionResult,
  plugins: BuiltinPlugin[],
): Promise<{ selectedPlugins: string[]; pluginConfigs: Record<string, Record<string, unknown>> } | null>;
// Returns null if user cancels (Ctrl+C or answers "no" to confirmation).
// Catches ExitPromptError from @inquirer/prompts.
```

No separate `SetupChoices` interface — the return type is inline and obvious. `repos` lives inside `pluginConfigs["github-trigger"]`, not top-level.

Flow follows ideation doc:
1. **LLM selection** — single-select from detected LLM CLIs. If only one found, pre-select with confirmation.
2. **Task source** — GitHub only today, auto-select with note.
3. **Code hosting** — GitHub only today, auto-select.
4. **Communication** — multi-select: GitHub comments (auto if GitHub token), Telegram (if tokens found).
5. **Per-plugin config** — Only prompt for REQUIRED fields with no default and no detected value. In practice: `repos` (if not detected from git remote, or always confirm detected repo).
6. **One confirmation** — Summary of all detected/configured settings, Y/n. If no → "No configuration was written. To configure manually, create YAML files in ~/.engineer/config/plugins/."

**Tests:** Prompts use `@inquirer/prompts` (can't unit test). Keep this file THIN — all logic in `setup.ts`. Manual testing only for the prompt layer.

---

## Phase 3 — Wire Into Start

### 3.1 TTY Guard + First-Run Detection

**File:** `src/cli/commands/start.ts` — modify `runStart()`:

Add as FIRST check, before `ensureDirectories`:

```typescript
import { needsSetup, runFirstTimeSetup } from "../setup/setup.js";

// First-run detection
if (needsSetup(engineerHome) && !options.pluginsPath) {
  if (!process.stdin.isTTY) {
    out.error("First-run setup requires an interactive terminal.");
    out.log("  Run 'engineer start' in a terminal first, or provide --plugins <path>.");
    return 1;
  }
}

// Run setup if needed (after TTY guard)
if (needsSetup(engineerHome)) {
  const completed = await runFirstTimeSetup({
    engineerHome,
    pluginsPath: options.pluginsPath,
  });
  if (!completed) {
    out.log("Setup cancelled. Run 'engineer start' to try again.");
    return 0;
  }
}

// IMPORTANT: loadConfigDir must be called AFTER setup completes (not before).
// Restructure runStart so config loading happens here, after the setup gate.
```

Also applies to `--daemon` (background) mode: if setup needed and no `--plugins`, fail with same message. The TTY guard handles this automatically since background processes don't have a TTY.

**Add `--plugins <path>` option:**
- `src/cli/index.ts` — Add `.option("--plugins <path>", "Plugin config directory for non-interactive setup")` to start command

**Tests:**
- `needsSetup` returns true/false correctly (various states)
- TTY guard returns exit code 1 when `isTTY` is false and setup is needed
- `loadConfigDir` is called after setup, not before

### 3.2 Bootstrap Transparency

**File:** `src/plugins/loader.ts` — change `loadBuiltinPlugins` return type:

```typescript
export interface PluginLoadResult {
  loaded: string[];   // plugin IDs that loaded successfully
  failed: Array<{ id: string; reason: string }>;  // plugin IDs that failed + why (not "skipped" — honesty)
}

export async function loadBuiltinPlugins(
  registry: Registry,
  pluginConfigDir: string,
  observer: IObserver,
): Promise<PluginLoadResult>;
```

**File:** `src/cli/bootstrap.ts` — use the result, include in `BootstrapResult`:

```typescript
// Step 12: Plugin loading
const pluginResult = await loadBuiltinPlugins(registry, pluginConfigDir, observer.child("plugin-loader"));
progress?.("plugins", "done");

observer.info("Plugins loaded", {
  loaded: pluginResult.loaded,
  failed: pluginResult.failed,
  total: pluginResult.loaded.length + pluginResult.failed.length,
});
```

**File:** `src/cli/commands/start.ts` — show plugin names in foreground output:

After bootstrap completes, before "The Engineer is ready":
```
Loading plugins:
  claude-code-llm              loaded
  github-trigger               loaded
  github-comm                  FAILED — GITHUB_TOKEN not set
  bash-tool                    loaded
Pre-flight: 7/7 passed
```

**Tests:** Update loader tests for new return type. Verify structured result contains correct loaded/failed lists.

---

## Verification

After all 4 phases:

1. **Command surface:** `engineer --help` shows exactly 9 commands
2. **First-run flow:** Delete `~/.engineer/`, run `engineer start` in TTY → guided setup → daemon starts
3. **Returning user:** Run `engineer start` with existing config → no prompts, normal startup
4. **Already running:** Run `engineer start` when daemon active → friendly message with PID
5. **Non-interactive:** `engineer start --plugins ./configs/` → no prompts, starts with provided configs
6. **No TTY:** `echo | engineer start` (piped, no TTY) → clear error message
7. **Doctor:** `engineer doctor` still validates all 11 categories, remedy messages reference correct commands
8. **No LLM warning:** Setup warns if no LLM plugin selected
9. **Ctrl+C mid-setup:** Clean exit, no config files written, no stack trace
10. **Empty env vars:** `GITHUB_TOKEN=""` treated as absent in detection
11. **E2E test:** First-run → configs written → daemon starts (automated, not manual)
12. **All tests pass:** `pnpm test` — zero failures, zero TS errors, zero Biome warnings

---

## Files Summary

### Modified
- `src/cli/index.ts` — Remove 5 commands, rename shutdown→stop, add --plugins option
- `src/cli/commands/start.ts` — TTY guard, first-run detection, setup call, already-running message, loadConfigDir ordering fix, bootstrap transparency output
- `src/cli/bootstrap.ts` — Use PluginLoadResult, report plugin details
- `src/plugins/loader.ts` — Return PluginLoadResult (with `failed` not `skipped`) from loadBuiltinPlugins
- `src/plugins/builtin.ts` — Add requirements, delete `enabled` field
- `src/schemas/adapters.ts` — Add PluginRequirementSchema (flat object, not discriminated union), delete `enabled`
- `src/core/daemon/index.ts` — Remove signal handler registration/cleanup, add doc comment about programmatic usage
- `src/index.ts` — Add crash handlers with `process.exit(1)` (not just exitCode)
- `src/cli/commands/shutdown.ts` → renamed to `src/cli/commands/stop.ts`
- `src/cli/commands/doctor.ts` — Update remedy messages referencing deleted commands
- `src/cli/templates.ts` — Remove SEED_TEMPLATES

### Created
- `src/cli/setup/setup.ts` — Detection + generation + orchestration (pure functions + I/O wrapper)
- `src/cli/setup/prompts.ts` — Guided plugin setup (thin interactive layer, handles ExitPromptError)

### Deleted
- `src/cli/commands/prepare.ts`
- `src/cli/commands/init.ts`
- `src/cli/commands/setup.ts`
- `src/cli/commands/config-validate.ts`
- `src/cli/commands/config-migrate.ts`

---

## What Was Cut (and why)

| Cut | Reason |
|-----|--------|
| Advisory lock file | Race condition requires two humans to type same command at same instant. Non-problem. |
| Atomic writes (temp dir + rename) | Write takes milliseconds. Recovery = re-run `start`. Per-file rename isn't actually atomic anyway. |
| Version stamps on configs | Zero config versions, zero migration tooling. Deferred with `config migrate`. |
| `default_enabled` rename | Renaming dead code to different dead code. Deleted the field instead. |
| `--dry-run` in setup flow | The Y/n confirmation IS the preview. Existing `--dry-run` for returning users stays. |
| 4-file setup module | Over-segmented for ~200 lines. 2 files (testable vs TTY) is the right split. |
| `SetupChoices` interface | Inline return type is simpler. `repos` belongs in pluginConfigs, not top-level. |
| Discriminated union for requirements | Both branches have identical shape. Flat `z.object` with `z.enum` is equivalent and simpler. |
| `DetectionResult.binaries.found` | Redundant. `string | null` (path or null) conveys found/not-found. |
