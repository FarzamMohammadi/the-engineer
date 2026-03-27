# Startup & Configuration — Ideas & Brainstorm

Part of Runtime Phase Refinement (roadmap section 1 of 9). Ideas discussed between co-founders before implementation. Not everything here will be built — a separate plan will finalize scope.

Reviewed by expert panel (Linus Torvalds, D. Richard Hipp, Rob Pike, The Engineer Persona, Technical Architect). Findings incorporated below — over-engineered pieces trimmed, missed gaps added.

---

## Command Surface Consolidation

Current state: 14 CLI commands. Three of them (`prepare`, `init`, `setup`) all solve "get me configured." A new user has to pick between them and then still has to run `doctor` and `start` separately.

**Decision: `engineer start` is the ONLY entry point.**

`start` absorbs `setup`, `init`, and `prepare`. It detects state and does the right thing — no separate commands for getting started. The user never needs to discover which setup command to use.

**Panel note:** 4/5 panelists cautioned that the setup logic must be a separable module that `start` calls — not woven into `start.ts` directly. The underlying detection/generation/bootstrap code stays modular regardless of CLI surface. One panelist (Pike) argued for keeping `setup` as a separate command. This is a two-way door — we can always re-expose `setup` if needed.

Commands removed:
- `engineer prepare` — absorbed into start's auto-config
- `engineer init` — absorbed into start (non-interactive mode via `start --plugins <path>`)
- `engineer setup` — absorbed into start (first-run detection triggers interactive flow)
- `engineer config validate` — absorbed into `doctor` (config validation IS a health check)
- `engineer config migrate` — deferred entirely (zero config versions exist today; add when needed)

Commands renamed:
- `engineer shutdown` -> `engineer stop` (every CLI uses `stop` — Docker, systemctl, pm2, brew services)

**Proposed command surface (14 -> 9):**
```
# Daily use (5 commands — this IS the product for 95% of usage)
engineer start              # Smart: auto-setup on first run, then run
engineer stop               # Clean shutdown (was "shutdown")
engineer status             # Show daemon status and task queue
engineer logs               # View daemon log output
engineer why <task-id>      # Explain why a task is in its current state

# Diagnostics & maintenance
engineer doctor             # Health checks (absorbs config validate)
engineer dashboard          # Reconnect to War Room standalone

# Developer
engineer install            # Generate OS service config (launchd/systemd)
engineer create-plugin      # Scaffold a new plugin
```

---

## Smart `start` — Auto-Detection with One Confirmation

The core idea: **detect, don't interrogate.** Plugins declare what they need. `start` checks what's available in the environment and auto-configures.

### State Detection (simplified per panel feedback)

```
engineer start
  |
  +--> detect state
  |     |
  |     +--> no config?       --> auto-detect + guided setup + confirm --> start
  |     +--> valid config?    --> pre-flight --> bootstrap --> start
  |     +--> already running? --> friendly message + suggest stop/status
```

**Panel feedback applied:** "Partial config" and "stale config" states dropped. Either config exists and is valid (start normally) or it doesn't (run setup). `doctor` handles diagnosis of what's broken. This eliminates significant complexity for scenarios that almost never happen.

### Auto-Detection via Declarative Requirements (not methods)

**Panel feedback applied:** All panelists agreed `canAutoEnable()` methods are the wrong abstraction. Plugin requirements should be declarative data on the manifest, not per-plugin code.

```typescript
// On the plugin manifest — data, not behavior:
requirements: [
  { type: "binary", name: "claude" },
  { type: "env", name: "GITHUB_TOKEN" },
]
```

One generic checker function walks the requirements array for all plugins. No per-plugin detection code. New plugins automatically participate by declaring their requirements.

Additional detection:
- Repos detected from `git remote -v` in current working directory (unreliable signal — validate before trusting)
- Safety level defaults to conservative (safest default, user can change later)

### TTY Guard (BLOCKER — panel unanimous)

**This was missed in the original brainstorm.** `start` must detect `!process.stdin.isTTY` as the FIRST thing. If setup is needed but there's no terminal (systemd, Docker, CI, cron), fail with a clear message:

```
First-run setup requires an interactive terminal.
Run 'engineer start' in a terminal first, or provide --plugins <path>.
```

Never silently hang waiting for input in a headless environment.

### Concurrent Start Protection (panel finding)

Two terminals running `engineer start` simultaneously during first-run = race condition. Both detect "no config," both write configs. Fix: acquire a lock file BEFORE state detection, release after config is written or setup is skipped.

---

## Plugin Setup — Guided One-by-One Flow

Current state: `init` dumps ALL plugins as a checkbox list with category separators. No guidance, no sequencing, no explanation. Overwhelming.

**Decision: Walk the user through plugins one category at a time, guided and contextual.**

The flow lives inside `engineer start` on first run, after auto-detection.

### The Flow

**Step 1: LLM Selection (the anchor).** This is the first and most important question. Not "select plugins" — "which AI do you use?" Every user already has an opinion here. Frame it in human terms, not adapter jargon. If only one LLM CLI is on PATH, pre-select it.

```
  The Engineer works with these AI tools:

    1. Claude Code CLI     (Anthropic)
    2. Codex CLI           (OpenAI)
    3. Gemini CLI          (Google)
    4. OpenCode            (open-source, bring your own key)

  Which one do you use? (1-4): _
```

**Step 2: Task Source.** "Where do your tasks come from?" Currently only GitHub. Auto-select with a note if only one option.

**Step 3: Code Hosting.** "Where does your code live?" Same — GitHub only today but structured for growth.

**Step 4: Communication.** "How should The Engineer reach you?" GitHub comments, Telegram, or both.

**Step 5: Per-plugin config.** For each selected plugin, prompt only for REQUIRED fields that have no default and no detected value. Show defaults in a summary — don't prompt for them.

### Multi-Select per Adapter Type

Some adapter types allow only one plugin (LLM), others allow multiple (Communication). Simple config on the adapter type metadata: `{ selectionMode: "single" | "multi", setupOrder: number, setupLabel: string }`. Adding a new adapter type is data, not code.

### One Confirmation

After plugin selection and config, show everything that was detected/configured and ask ONE yes/no: "Start with these settings?" If no, show config dir for manual editing.

---

## Plugin Configuration — Hardcoded Prompts (not schema walker)

**Panel feedback applied:** All 5 panelists independently rejected the Zod schema-to-prompt walker. The reasoning:

1. **8 plugins, 20-40 total fields.** A generic walker is a framework to avoid writing 60-80 lines of direct code.
2. **Zod internals (`_def`, `typeName`) aren't a public API.** They break between versions.
3. **Prompts need human judgment** — which fields are secrets, which get masked, ordering, grouping, conditional display. That's UX logic, not derivable from types.
4. **Schema walker failure modes are ugly** — union types, transforms, refinements all need escape hatches.

**Decision: Write explicit prompt functions per plugin. Graduate to schema-driven at 15+ plugins.**

```typescript
// ~20 lines per plugin. Direct, obvious, testable.
async function promptGitHubTrigger(detected: DetectedEnv): Promise<GitHubTriggerConfig> {
  const token = detected.env.GITHUB_TOKEN ?? await input({ message: "GitHub token:" });
  const repos = detected.gitRemote
    ? await confirmRepos(detected.gitRemote)
    : await inputRepos();
  return { github_token: `\${GITHUB_TOKEN}`, repos };
  // labels, poll_interval get defaults — not prompted
}
```

**Still add `.describe()` to plugin schemas** — good hygiene for error messages, docs, and future tooling. Just don't couple the prompts to it.

**Prompt only required fields.** Fields with sensible defaults (poll_interval, parse_mode, merge_strategy) are NOT prompted. They appear in a summary: "Defaults applied: poll interval 30s, merge strategy squash." Power users edit YAML to customize.

### Concrete Workflows

**New user (everything available):**
```
$ engineer start

  First run — auto-configuring from environment...

  Detected:
    Claude Code CLI    found (/usr/local/bin/claude)     -> claude-code-llm
    GitHub token       found (GITHUB_TOKEN)              -> github-trigger, github-comm, github-hosting
    Bash               found (/bin/bash)                 -> bash-tool
    Telegram           not found                         -> skipped
    Current repo       FarzamMohammadi/the-engineer      -> watching

  Safety: conservative (default)

  Start with these settings? (Y/n): Y

  Initializing database            done (45ms)
  Wiring core system               done (12ms)
  Loading plugins:
    claude-code-llm                loaded
    github-trigger                 loaded
    github-comm                    loaded
    github-hosting                 loaded
    bash-tool                      loaded
  Pre-flight: 7/7 passed
  Starting daemon                  done

  The Engineer is ready (1.1s). War Room: http://localhost:3847

  Config: ~/.engineer/config/
  To add repos: edit ~/.engineer/config/plugins/github-trigger.yaml
```

**New user (missing GitHub token):**
```
$ engineer start

  First run — auto-configuring from environment...

  Detected:
    Claude Code CLI    found (/usr/local/bin/claude)     -> claude-code-llm
    GitHub token       not found                         -> github plugins skipped
    Bash               found (/bin/bash)                 -> bash-tool
    Telegram           not found                         -> skipped
    Current repo       (no git remote)                   -> no repos configured

  Warning: No trigger plugin enabled. The Engineer will start but won't pick up tasks.
  To fix: export GITHUB_TOKEN=ghp_... and restart.

  Safety: conservative (default)

  Start with these settings? (Y/n): _
```

**Returning user (happy path):**
```
$ engineer start

  Initializing database            done (43ms)
  Wiring core system               done (11ms)
  Loading plugins:
    claude-code-llm                loaded
    github-trigger                 loaded
    github-comm                    loaded
    github-hosting                 loaded
    bash-tool                      loaded
  Pre-flight: 7/7 passed
  Starting daemon                  done

  The Engineer is ready (1.0s). War Room: http://localhost:3847
```

**Already running:**
```
$ engineer start

  The Engineer is already running (PID: 42371).
  Use 'engineer stop' to stop it, or 'engineer status' to check.
```

**Plugin failure (non-critical):**
```
$ engineer start

  Initializing database            done (44ms)
  Wiring core system               done (13ms)
  Loading plugins:
    claude-code-llm                loaded
    github-trigger                 loaded
    github-comm                    SKIPPED — config error: GITHUB_TOKEN not set
    github-hosting                 loaded
    bash-tool                      loaded
  Pre-flight: 6/7 passed, 1 warning
    github-comm: communication plugin unavailable — issue comments disabled
  Starting daemon                  done

  The Engineer is ready (1.1s). War Room: http://localhost:3847
```

---

## AI Plugin Generation — Deferred

**Panel feedback applied:** All 5 panelists independently said defer this. No plugin SDK docs exist, adapter contracts are still being refined (Layer 8), the feature has never been tested even once. This is architecture for a capability that doesn't work yet.

**For now:** Document in README: "Use your AI tool to generate plugins using our adapter contracts as reference." Add the tooling when: (a) plugin SDK is documented, (b) contract test runner validates plugins in isolation, (c) users have asked for it.

The re-entrant loop concept (start -> build plugin -> come back -> start again -> see new plugin) is the right eventual pattern. It's just premature today.

---

## Core Config — Always Defaults

**Panel feedback applied:** No user on first run wants to tune daemon tick intervals. Conservative defaults, always. Power users edit YAML. The "Use defaults? (Y/n)" question was cut — it serves almost nobody and adds a prompt.

---

## Ctrl+C Mid-Setup — Simple Approach

**Panel feedback applied:** Transactional rollback (tracking created vs overwritten files, backup-and-restore) was over-engineered. Simpler approach:

1. Collect all answers during prompts (no files written yet)
2. Write all config files at the end, in one batch (takes milliseconds)
3. If Ctrl+C arrives during prompts — nothing was written, nothing to clean up
4. If Ctrl+C arrives during the write batch (extremely unlikely) — accept partial state, `start` handles it on re-run

---

## Non-Interactive Mode — `engineer start --plugins <path>`

For CI/automation/teams: skip all interactive prompts by providing pre-made plugin configs.

```
$ engineer start --plugins ./my-plugin-configs/
```

- Plugin YAML files are read from the provided path and copied into `~/.engineer/config/plugins/`
- Core configs (daemon, workspace, safety) use defaults
- No prompts, no questions — if plugin configs are provided and valid, just start
- If a plugin config is invalid, fail with a clear error pointing to the file and field

**Panel finding — config drift:** Copying creates divergence between source and running config. Consider symlinks or an include mechanism in a future iteration.

---

## Bootstrap Transparency

Current state: 12-step sequential init with good error handling and reverse-order cleanup. Solid engineering. But opaque to the user — only spinner states shown.

**Decision: Show everything inline during startup.**
- Plugin names and load status (loaded / SKIPPED + reason)
- Total startup time in the final ready message
- Pre-flight results with warning count, warnings always shown (not hidden behind --verbose)
- Structured `bootstrap_complete` observation for War Room with step timeline and plugin details

**Panel note:** Per-step millisecond timings (database: 45ms, wiring: 12ms) are developer vanity when total startup is ~1 second. Show plugin names + pass/fail and total time. That's the useful information.

---

## Safety & Internals (Ship Independently)

**Panel unanimous: these are real bugs. Fix them NOW, don't bundle with the larger refactor.**

**Signal handler dedup:** Both `start.ts` (lines 189-190) and `daemon.start()` (lines 518-526) register SIGTERM/SIGINT handlers. Two async shutdown sequences race on the same signal. Fix: CLI owns signal handling (it knows about dashboard + DB + logger cleanup). Daemon only exposes `stop()`, does NOT register its own signal handlers. Single deterministic shutdown path.

**Global crash safety net:** `src/index.ts` is 7 lines with no `uncaughtException` or `unhandledRejection` handler. For a long-running daemon, that's a gap. Fix: add handlers that write to stderr (logger may not exist) and set exit code.

**Friendly "already running" message:** Detect `DaemonAlreadyRunningError` specifically, show PID, suggest `engineer stop` or `engineer status` instead of raw error.

**Config file permissions (panel finding):** `writeFileSync` doesn't set mode. Plugin configs containing token references are world-readable by default (`0o644`). Fix: write with `mode: 0o600` for all config files.

---

## Existing Bugs Discovered During Review

These exist TODAY and should be fixed regardless of the larger refactor:

1. **`bash-tool` has no config YAML by default.** `setup.ts` doesn't write `bash-tool.yaml`, but `discoverEnabledPlugins` requires a YAML file to exist. Bash tool silently doesn't load after setup.

2. **`enabled` field on manifests is dead code.** Three plugins have `enabled: false` in `builtin.ts`, but `discoverEnabledPlugins` ignores this field entirely — it only checks for YAML file existence. Either use it or delete it.

3. **"detected" vs "enabled" gap.** Auto-detection creates YAML files. After first run, every detected plugin becomes permanently enabled even if the user later wants to disable it. Need an explicit enabled/disabled mechanism, not file-existence-as-truth.

---

## Panel-Identified Gaps (Not in Original Brainstorm)

These were surfaced by the expert panel and should be addressed during planning:

1. **Validate detected values before confirmation, not after.** Auto-detection finds GITHUB_TOKEN but doesn't verify it works (scope, expiration). User confirms, config written, THEN pre-flight discovers the token is bad. Consider lightweight validation (API call to check token scopes) before the Y/n.

2. **Atomic config writes.** Write all configs to a temp directory first, then rename into place. Same pattern databases use for crash safety. No partial config from interrupted writes.

3. **Version-stamp generated configs.** Add `# Generated by The Engineer v0.0.1` comment to written files. When schemas evolve, migration tooling knows which version generated the file.

4. **Plugin dependency grouping.** GitHub Trigger, Comm, and Hosting all need the same token. One detection should enable the GitHub family. This is implicit in the plan but never stated — must be explicit in implementation.

5. **Config portability story.** `prepare`/`seed` mechanism solved "same config on another machine." Removing `prepare` without preserving this capability is a gap. The `--plugins <path>` flag partially covers it.

6. **`git remote -v` is an unreliable signal.** User might run `engineer start` from home directory, /tmp, or a repo they don't want to monitor. Detect but always confirm.

7. **Concurrent start race condition.** Lock file before state detection prevents two terminals from both detecting "no config" and clobbering each other's setup.

---
---

# Deferred Items

Everything below is intentionally deferred — not forgotten, just not v1. Each item has a clear trigger for when it becomes relevant.

---

## Deferred: AI Plugin Generation

**Trigger:** When plugin SDK docs are complete, adapter contracts are stable, and a contract test runner can validate plugins in isolation.

The re-entrant loop concept (start -> build plugin in separate AI session -> come back -> start again -> see new plugin) is the right eventual pattern. For now: document in README "use your AI tool to generate plugins using our adapter contracts as reference."

---

## Deferred: Schema-Driven Prompt Walker

**Trigger:** When the project has 15+ plugins and maintaining hardcoded prompt functions becomes a burden.

A generic `schemaToPrompts()` that introspects Zod schemas to generate CLI prompts. Deferred because: Zod internals aren't a public API, only 8 plugins exist today (60-80 lines of hardcoded prompts is simpler), and prompts need human judgment about secrets/masking/ordering that types can't express.

---

## Deferred: Config Migration (`engineer config migrate`)

**Trigger:** When a config schema actually changes in a breaking way and there are existing users with old configs.

Zero config versions exist today. Don't ship dead code.

---

## Deferred: Interactive Reconfiguration

**Trigger:** When users frequently change plugin selections and the "stop, edit YAML, start" workflow becomes painful.

Smart approach: auto-detect existing config, prompt for changes, preserve what's unchanged. For now: `engineer stop`, edit configs in `~/.engineer/config/`, `engineer start`. Added to `future-considerations.md`.

---

## Deferred: Core Config Walkthrough

**Trigger:** When users consistently report that conservative defaults don't work for their use case and need guidance choosing settings.

No user on first run wants to tune daemon tick intervals. Conservative defaults, always. Power users edit YAML.

---

## Deferred: Config Portability / Export

**Trigger:** When teams need to share The Engineer configs across machines or onboard new team members.

The `prepare`/`seed` mechanism partially solved this. The `--plugins <path>` flag partially covers it. A proper `engineer config export` command is the eventual solution.
