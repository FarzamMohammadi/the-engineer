# Phase R7: CLI Polish

## Identity

You are an implementation agent for **The Engineer** -- an autonomous software engineering agent built in TypeScript/Node.js. You are executing Phase R7 of Layer 7 (Structural Restructuring). You operate with zero prior context. Everything you need is in this prompt.

Read `docs/persona.md` and `docs/philosophy.md` before starting -- they define who The Engineer is and how it thinks. Your work must embody those principles.

---

## Architecture Catchup

The Engineer is a three-tier system:

- **Core** (invariant brain): EventBus, TaskEngine, Orchestrator, Daemon, Registry, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager, PeopleDirectory
- **Adapters** (stable contracts): TriggerAdapter, CommunicationAdapter, LLMAdapter, ToolAdapter, GitHostingAdapter
- **Plugins** (swappable implementations): GitHubTrigger, GitHubComm, GitHubHosting, TelegramComm, ClaudeCodeLLM, BashTool

Tech stack: TypeScript (strict), Node.js 22 LTS, pnpm, ESM, SQLite (better-sqlite3), Commander, Zod, Vitest, Biome.

The CLI is built with Commander.js (`commander` package). Entry point: `src/index.ts` -> `src/cli/index.ts`.

### Key Files to Read First

Read these files to understand the current state before making changes:

1. `src/cli/index.ts` -- Commander program setup, all command registrations (currently: start, stop/shutdown, status, logs, init, doctor, install, config validate, dashboard)
2. `src/cli/commands/start.ts` -- Start command with pre-flight checks, foreground/background modes
3. `src/cli/commands/status.ts` -- Status command (PID file check, process status)
4. `src/cli/commands/doctor.ts` -- Doctor checks (10 categories, pure functions, formatDoctorResults)
5. `src/cli/commands/logs.ts` -- Log viewing command
6. `src/cli/commands/init.ts` -- Template generation (11 config templates)
7. `src/cli/bootstrap.ts` -- Component wiring (where --dry-run would stop)
8. `src/cli/home.ts` -- resolveEngineerHome, resolveSubdirs
9. `src/core/event-bus/index.ts` -- EventBus (for `engineer why` to query events)
10. `src/core/task-engine/index.ts` -- TaskEngine (for `engineer why` to query task history)
11. `src/core/session-memory/index.ts` -- SessionMemory (for `engineer why` to query journal)
12. `src/index.ts` -- CLI entry point
13. `package.json` -- Current dependencies (no chalk/colors yet)
14. `implementation-docs/7-restructure/assessment.md` -- DX gaps section
15. `implementation-docs/7-restructure/decisions.md` -- Decision log (D166+)

### Related Layer 7 Context

This phase runs in **Wave 3** (parallel with R5, R6, R8). It depends on Wave 1 (R0) and Wave 2 being complete. If R6 adds `engineer create-plugin`, this phase should not conflict.

---

## Problem Statement

From the assessment:
> **DX Gaps:**
> - CLI lacks colors, progress indicators, output formatting
> - No `--dry-run`, `--json`, `engineer why` commands
> - No interactive setup wizard

Currently:
- All CLI output is plain `console.log()` / `console.error()` with no formatting
- No TTY detection, no color support, no `NO_COLOR` respect
- No machine-readable output mode (JSON)
- No progress indicators during startup (which can take seconds)
- No way to introspect why a task is in its current state
- No interactive first-run experience

---

## Exact Specifications

### 1. Create `src/cli/output.ts` -- Output Formatting

Central output module that all CLI commands use instead of raw `console.log`.

```typescript
export type OutputMode = "human" | "json" | "quiet";

export interface OutputOptions {
  /** Force a specific mode. Auto-detected if not set. */
  mode?: OutputMode;
  /** Force color on/off. Auto-detected if not set. */
  color?: boolean;
}

/**
 * CLI output controller.
 *
 * Mode detection (in order of precedence):
 * 1. --json flag -> "json" mode
 * 2. --quiet flag -> "quiet" mode
 * 3. Default -> "human" mode
 *
 * Color detection:
 * 1. NO_COLOR env var (any value) -> colors off (https://no-color.org/)
 * 2. FORCE_COLOR env var -> colors on
 * 3. stdout.isTTY -> colors on if TTY, off if pipe
 */
export class Output {
  readonly mode: OutputMode;
  readonly color: boolean;

  constructor(options?: OutputOptions);

  /** Print a line (human mode only, no-op in json/quiet). */
  log(message: string): void;

  /** Print a success message with green checkmark (human mode). */
  success(message: string): void;

  /** Print a warning with yellow prefix (human mode). */
  warn(message: string): void;

  /** Print an error with red prefix (human + quiet modes). */
  error(message: string): void;

  /** Print a heading with bold/underline (human mode). */
  heading(message: string): void;

  /** Print a key-value pair with aligned formatting (human mode). */
  keyValue(key: string, value: string): void;

  /** Print a table from an array of objects (human mode). */
  table(rows: Array<Record<string, string | number | boolean>>): void;

  /** Output structured data (JSON mode: prints JSON, human mode: prints formatted). */
  data(obj: unknown): void;

  /** Print a blank line (human mode only). */
  blank(): void;
}

/**
 * Create a global Output instance. Called once at CLI startup.
 * Stores in module-level variable for import by all commands.
 */
export function createOutput(options?: OutputOptions): Output;

/** Get the current Output instance. Throws if not initialized. */
export function getOutput(): Output;
```

Add `chalk` as a dependency (`pnpm add chalk`). Use it for colors throughout Output.

### 2. Create `src/cli/progress.ts` -- Progress Indicators

Progress indicators that write to stderr (so stdout remains clean for piping/JSON).

```typescript
/**
 * Spinner for indeterminate progress.
 * Uses stderr so stdout is reserved for data.
 * No-op if not a TTY or in json/quiet mode.
 */
export class Spinner {
  constructor(message: string);

  /** Start the spinner animation. */
  start(): void;

  /** Update the spinner message. */
  update(message: string): void;

  /** Stop with a success message. */
  succeed(message?: string): void;

  /** Stop with a failure message. */
  fail(message?: string): void;

  /** Stop the spinner without a status message. */
  stop(): void;
}

/**
 * Progress bar for determinate progress.
 * Uses stderr. No-op if not a TTY or in json/quiet mode.
 */
export class ProgressBar {
  constructor(total: number, message: string);

  /** Increment progress by `amount` (default 1). */
  tick(amount?: number): void;

  /** Complete the progress bar. */
  complete(): void;
}
```

Implement the spinner with a simple `setInterval` cycling through frames (`['|', '/', '-', '\\']` or Unicode braille). No external dependency needed -- keep it minimal.

### 3. Add `--dry-run` to `engineer start`

When `engineer start --dry-run` is passed:

1. Run all pre-flight checks (doctor categories 1-6)
2. Load and validate config
3. List which plugins would be loaded
4. Show the effective configuration (merged defaults)
5. Do NOT actually bootstrap or start the daemon
6. Exit with code 0 if everything validates, 1 if errors

Modify `src/cli/commands/start.ts` to accept `--dry-run` option. Add it to the Commander option definition.

Output format:
```
Dry Run -- The Engineer would start with:
  Config:    ~/.engineer/config/ (3 files loaded)
  Database:  ~/.engineer/data/engineer.db
  Plugins:   6 plugins (3 critical)
  Pre-flight: 10/10 checks passed

  Plugin loading order:
    1. github-comm (communication) -- non-critical
    2. telegram-comm (communication) -- non-critical
    3. claude-code-llm (llm) -- CRITICAL
    4. bash-tool (tool) -- CRITICAL
    5. github-hosting (git_hosting) -- non-critical
    6. github-trigger (trigger) -- CRITICAL

Everything looks good. Run without --dry-run to start.
```

### 4. Add `--json` Flag to Output Commands

Add `--json` global option to the Commander program in `src/cli/index.ts`. When set, initialize Output in "json" mode.

Commands that produce data output should respect JSON mode:
- `engineer status` -- output `{ running, pid, uptime, tasks }` as JSON
- `engineer doctor` -- output `{ checks: [...], exitCode }` as JSON
- `engineer config validate` -- output `{ valid, warnings, errors }` as JSON
- `engineer start --dry-run` -- output `{ config, plugins, preFlightResults }` as JSON

### 5. Create `engineer why <task-id>` Command

New command that explains why a task is in its current state by querying the event history and state transitions.

Create `src/cli/commands/why.ts`:

```typescript
/**
 * Displays a timeline of significant events for a task, showing how it
 * reached its current state. Requires the daemon to be running (reads from DB).
 */
export async function runWhy(engineerHome: string, taskId: string): Promise<number>;
```

The command must:
1. Open the database at `~/.engineer/data/engineer.db` (read-only)
2. Query the task from the tasks table
3. Query all events for the task from the events table (via direct SQL, not EventBus -- the daemon may be running)
4. Query journal entries from the session_journal table
5. Display a formatted timeline:

```
Task: abc123
State: blocked (waiting_human)
Priority: 50
Created: 2024-03-15T10:30:00Z (2 hours ago)
Repo: owner/repo

Timeline:
  10:30:00  task.created           Created from GitHub issue #42
  10:30:01  task.state_changed     intake -> queued (auto-transition)
  10:30:05  task.state_changed     queued -> active (dispatched)
  10:31:00  cost.incurred          $0.12 (claude-code-llm, intake_analysis)
  10:32:00  task.state_changed     active -> active (research)
  10:35:00  cost.incurred          $0.45 (claude-code-llm, research)
  10:36:00  task.state_changed     active -> blocked (ambiguous requirement)

Journal (last 5 entries):
  10:31:00  [intake]    Analyzed issue: needs clarification on API endpoint
  10:32:00  [research]  Found 3 related files in src/api/
  10:35:00  [research]  Codebase analysis complete
  10:36:00  [planning]  Cannot proceed: requirement ambiguous, asking human

Cost: $0.57 total
```

Register the command in `src/cli/index.ts`.

### 6. Create `engineer setup` Interactive Wizard

Create `src/cli/commands/setup.ts`:

An interactive first-run wizard that guides the user through initial configuration. Uses [Inquirer.js](https://github.com/SBoudrias/Inquirer.js) (`pnpm add @inquirer/prompts`).

Steps:
1. **Welcome** -- Brief intro, explain what will be configured
2. **Engineer Home** -- Confirm or set `~/.engineer` directory
3. **GitHub Token** -- Prompt for GITHUB_TOKEN (store guidance, not the actual token -- tell them to set env var)
4. **Repos** -- Ask which repos to monitor (owner/repo format, comma-separated)
5. **LLM Provider** -- Select from available providers (currently just Claude Code CLI)
6. **Telegram** -- Optional: configure Telegram notifications (bot token + chat ID)
7. **Safety Level** -- Choose autonomy level (conservative / balanced / autonomous)
8. **Generate Config** -- Write config files to `~/.engineer/config/`
9. **Summary** -- Show what was created, next steps

Register the command in `src/cli/index.ts`.

Add `@inquirer/prompts` as a dependency: `pnpm add @inquirer/prompts`.

### 7. Progress Indicators During Startup

Modify `src/cli/commands/start.ts` and `src/cli/bootstrap.ts` to show progress during startup:

```
Starting The Engineer...
  [/] Loading configuration...         -> [+] Configuration loaded (3 files)
  [/] Running pre-flight checks...     -> [+] Pre-flight: 10/10 passed
  [/] Initializing database...         -> [+] Database ready
  [/] Loading plugins (6)...           -> [+] Plugins loaded (6/6)
  [/] Starting daemon...               -> [+] Daemon running

The Engineer is ready. War Room: http://localhost:3847
```

Use the Spinner from `src/cli/progress.ts`. Only show spinners in human mode with TTY.

### 8. Migrate Existing Commands to Use Output

Update these existing commands to use the new `Output` class instead of raw `console.log`:
- `start.ts` -- progress + formatted output
- `status.ts` -- key-value output, JSON mode
- `doctor.ts` -- colored pass/fail, JSON mode
- `logs.ts` -- no changes needed (streams raw logs)
- `init.ts` -- success/info messages
- `config-validate.ts` -- colored output, JSON mode

---

## Refinement Checklist

Before writing any code, verify:

- [ ] Read `src/cli/index.ts` completely -- understand all registered commands and global options
- [ ] Read every command file in `src/cli/commands/` to understand current output patterns
- [ ] Read `src/cli/bootstrap.ts` to understand startup sequence for progress indicators
- [ ] Check `package.json` for existing color/progress dependencies (there are none currently)
- [ ] Read `src/db/database.ts` to understand how to open read-only DB connections (for `why` command)

During implementation:

- [ ] `Output` respects NO_COLOR (https://no-color.org/) -- any value means no color
- [ ] `Output` respects FORCE_COLOR -- any value means force color even without TTY
- [ ] Spinner/ProgressBar write to stderr, not stdout
- [ ] JSON output is valid JSON (parseable by `jq`)
- [ ] `engineer why` works with daemon not running (direct DB access)
- [ ] `engineer setup` does not store secrets in config files (guides user to env vars)
- [ ] All existing command tests still pass (output changes may need test updates)
- [ ] `--dry-run` does not create any files or start any processes
- [ ] Progress indicators are no-ops when piped (not a TTY)

---

## Verification Steps

Run these commands after implementation:

```bash
# 1. Type check passes
pnpm typecheck

# 2. Lint passes
pnpm lint

# 3. All existing tests still pass
pnpm test

# 4. New tests pass
pnpm test -- --reporter=verbose src/cli/output.test.ts
pnpm test -- --reporter=verbose src/cli/progress.test.ts
pnpm test -- --reporter=verbose src/cli/commands/why.test.ts
pnpm test -- --reporter=verbose src/cli/commands/setup.test.ts

# 5. Verify --json produces valid JSON
echo '{}' | node dist/index.js status --json 2>/dev/null | jq .

# 6. Verify NO_COLOR works
NO_COLOR=1 node dist/index.js doctor

# 7. Verify --dry-run works
node dist/index.js start --dry-run --home /tmp/test-engineer

# 8. Build succeeds
pnpm build
```

---

## Test Requirements

### `src/cli/output.test.ts`

1. **Mode detection**: Defaults to human, respects --json, respects --quiet
2. **Color detection**: Respects NO_COLOR, FORCE_COLOR, TTY detection
3. **Human output**: log, success, warn, error, heading, keyValue produce formatted strings
4. **JSON output**: data() outputs valid JSON, log/success/warn are no-ops
5. **Quiet output**: Only error() produces output
6. **Table**: Formats array of objects with aligned columns

### `src/cli/progress.test.ts`

1. **Spinner**: start/update/succeed/fail/stop lifecycle
2. **TTY check**: No-op when not a TTY
3. **Stderr**: Output goes to stderr, not stdout
4. **ProgressBar**: tick increments, complete finishes

### `src/cli/commands/why.test.ts`

1. **Task found**: Displays timeline with state changes and cost events
2. **Task not found**: Error message with exit code 1
3. **No events**: Shows task state but empty timeline
4. **JSON mode**: Outputs structured JSON with task, events, journal

### `src/cli/commands/setup.test.ts`

1. **Config generation**: Writes valid YAML config files
2. **Idempotent**: Does not overwrite existing configs without confirmation
3. **Validation**: Rejects invalid repo formats, invalid tokens

---

## Commit Instructions

When complete, create a single commit:

```
Add CLI polish: output formatting, progress, why, setup (R7)

- Output class with human/json/quiet modes, TTY detection, NO_COLOR
- Spinner and ProgressBar for startup progress (stderr)
- --dry-run on engineer start
- --json flag on data-producing commands
- engineer why <task-id> command (event timeline)
- engineer setup interactive wizard (Inquirer.js)
- Migrated existing commands to Output class
```

Do NOT push. The commit stays local.

---

## Constraints

- Add only `chalk` and `@inquirer/prompts` as new dependencies -- no ora, no cli-progress, no blessed
- Progress indicators must be simple (spinner frames, percentage bar) -- no complex TUI
- Spinner/ProgressBar must be completely silent when not a TTY (piped output)
- JSON output must be a single valid JSON object per command (not NDJSON)
- `engineer why` must work without the daemon running (read-only DB access)
- `engineer setup` must never write secrets to disk
- Biome lint must pass (`pnpm lint`)
- TypeScript strict mode must pass (`pnpm typecheck`)
- All existing tests must continue to pass
