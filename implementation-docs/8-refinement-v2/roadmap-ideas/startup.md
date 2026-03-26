# Startup & Configuration — Ideas & Brainstorm

Part of Runtime Phase Refinement (roadmap section 1 of 9). Ideas discussed between co-founders before implementation. Not everything here will be built — a separate plan will finalize scope.

---

### Command Surface Consolidation

Current state: 14 CLI commands. Three of them (`prepare`, `init`, `setup`) all solve "get me configured." A new user has to pick between them and then still has to run `doctor` and `start` separately.

**Decision: `engineer start` is the ONLY entry point.**

`start` absorbs `setup`, `init`, and `prepare`. It detects state and does the right thing — no separate commands for getting started. The user never needs to discover which setup command to use.

Commands removed:
- `engineer prepare` — absorbed into start's auto-config (seed mechanism becomes documentation or `config export`)
- `engineer init` — absorbed into start (non-interactive mode via `start --non-interactive`)
- `engineer setup` — absorbed into start (first-run detection triggers interactive setup)
- `engineer config validate` — absorbed into `doctor` (config validation IS a health check)

Commands renamed:
- `engineer shutdown` -> `engineer stop` (every CLI uses `stop` — Docker, systemctl, pm2, brew services)

**Proposed command surface (14 -> 10):**
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
engineer config migrate     # Rare config version migration

# Developer
engineer install            # Generate OS service config (launchd/systemd)
engineer create-plugin      # Scaffold a new plugin
```

### Smart `start` — Zero-Question Auto-Detection

The core idea: **detect, don't interrogate.** Plugins declare what they need. `start` checks what's available in the environment and auto-configures.

**State machine inside `start`:**
```
engineer start
  |
  +--> detect state
  |     |
  |     +--> no config?       --> auto-detect + confirm --> start
  |     +--> partial config?  --> fill gaps + confirm   --> start
  |     +--> full config?     --> pre-flight            --> start
  |     +--> already running? --> friendly message + suggest stop/status
  |     +--> stale config?    --> auto-migrate          --> start
```

**Auto-detection approach:**
- Each builtin plugin gets a `canAutoEnable()` method — checks if its requirements exist (CLI on PATH, env vars set, etc.)
- Repos detected from `git remote -v` in current working directory
- Detection is plugin-driven, not hardcoded — new plugins automatically participate
- Safety level defaults to conservative (safest default, user can change later)

**The one confirmation:** After detection, show what was found and ask ONE yes/no: "Start with these settings?" If no, show config dir for manual editing. This prevents surprise auto-enabling (e.g., GITHUB_TOKEN set for a different purpose).

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

### Plugin Setup — Guided One-by-One Flow

Current state: `init` dumps ALL plugins as a checkbox list with category separators. No guidance, no sequencing, no explanation. Overwhelming.

**Decision: Walk the user through plugins one category at a time, guided and contextual.**

The flow lives inside `engineer start` on first run, after auto-detection, before the final confirmation.

**Step 1: LLM Selection (the anchor).** This is the first and most important question. Not "select plugins" — "which AI do you use?" Every user already has an opinion here. Frame it in human terms, not adapter jargon.

```
  The Engineer works with these AI tools:

    1. Claude Code CLI     (Anthropic)
    2. Codex CLI           (OpenAI)
    3. Gemini CLI          (Google)
    4. OpenCode            (open-source, bring your own key)

  Which one do you use? (1-4): _
```

**Step 2: Task Source.** "Where do your tasks come from?" Currently only GitHub. Auto-select with a note if only one option, but structure supports adding GitLab, Linear, etc. later.

**Step 3: Code Hosting.** "Where does your code live?" Same — GitHub only today but structured for growth. If GitHub token already detected from step 2, note it.

**Step 4: Communication.** "How should The Engineer reach you?" GitHub comments (included with GitHub), Telegram, or both.

**Step 5: Custom Plugin Generation (escape hatch).** "Want to add a custom plugin?" If yes, spawn the user's chosen CLI tool (from step 1) with a crafted prompt pointing at our plugin SDK docs, adapter contracts, and examples. The AI builds the plugin. User comes back, runs `engineer start` again, auto-detection finds the new plugin.

```
  Want to add a custom plugin?

    1. No, I'm good
    2. Yes, generate a custom plugin with AI

  Describe what you want:
  > I want a plugin that monitors a Jira board for new tickets

  Launching Claude Code CLI to generate your plugin...
  (When done, run 'engineer start' again to pick it up.)
```

**Step 6: Per-plugin config — Schema-Driven Prompts.** After plugin selection, walk the user through each selected plugin's configuration field by field, using the Zod schema as the source of truth.

### Schema-Driven Plugin Configuration

**The insight:** We already have Zod schemas for every plugin config, and the core config schemas already use `.describe()` extensively (41+ instances). Plugin schemas currently lack `.describe()` — adding it creates a complete metadata layer for interactive prompts.

**Current state of plugin schemas:**
- 8 plugin config schemas exist, all bare Zod (types + defaults, no descriptions)
- Core config schemas (`DaemonConfig`, `WorkspaceConfig`, `SafetyConfig`) already use `.describe()` throughout
- A `walkSchema()` function already exists in `config/loader.ts` that introspects Zod schemas (used for duration parsing) — this pattern is reusable

**The approach: Zod schema drives the prompt type, detected/default values pre-fill, `.describe()` provides the label.**

Every field gets prompted — nothing is hidden or silently skipped. But detected values and defaults are pre-filled so the user can just hit Enter to accept. Full visibility, fast happy path.

Schema type → prompt style mapping:
- `z.string()` → text input, pre-filled with detected/default value
- `z.enum([...])` → select list, default option pre-selected
- `z.boolean()` → yes/no confirmation, default capitalized (Y/n or y/N)
- `z.number()` → number input, default shown
- `z.array(z.object({...}))` → repeated object prompts ("Add another? y/N")
- `z.string()` with `${ENV_VAR}` pattern → show detected env var value, masked

**Example — GitHub Trigger setup:**
```
  Setting up GitHub Trigger...

    GitHub token (${GITHUB_TOKEN}): ghp_****...****3f2a (detected) [Enter to keep] _

    Repos to watch:
      Owner: FarzamMohammadi (detected from git remote) [Enter to keep] _
      Name:  the-engineer (detected from git remote) [Enter to keep] _
      Add another repo? (y/N): _

    Labels filter (default: all issues) [Enter to skip]: _
    Poll interval (default: 30s) [Enter to keep]: _

    ✓ github-trigger.yaml written
```

**Example — GitHub Hosting setup (enum field):**
```
  Setting up GitHub Hosting...

    GitHub token (${GITHUB_TOKEN}): ghp_****...****3f2a (detected) [Enter to keep] _

    Merge strategy:
    > squash (default)
      merge
      rebase

    ✓ github-hosting.yaml written
```

**Example — Telegram setup (boolean field):**
```
  Setting up Telegram...

    Bot token (${TELEGRAM_BOT_TOKEN}): (not set — required)
    Enter bot token: _

    Chat ID (${TELEGRAM_CHAT_ID}): (not set — required)
    Enter chat ID: _

    Disable link previews? (Y/n): _
    Parse mode:
    > MarkdownV2 (default)
      Markdown
      HTML

    ✓ telegram-comm.yaml written
```

**Implementation:**
1. Add `.describe()` to all plugin config schema fields (follow core config pattern)
2. Build a `schemaToPrompts()` walker extending the existing `walkSchema()` pattern
3. For each field: extract type, default, description, validation rules, env var references
4. Generate appropriate `@inquirer/prompts` call (input/select/confirm) with pre-filled values
5. Validate final values against the Zod schema before writing YAML
6. Write the validated config as YAML to the plugin config directory

**Key design principles:**
- Every field prompted — nothing hidden. User sees exactly what's being configured.
- Detected/default values pre-filled — Enter to accept. Fast path without hiding anything.
- One question at a time — use proper CLI prompt libraries (`@inquirer/prompts`)
- Schema is the single source of truth — add a field to the schema, it appears in setup automatically
- AI plugin generation is a separate session — user comes back to `start` when done

### Multi-Select per Adapter Type

Some adapter types allow only one plugin (LLM — one brain at a time), others allow multiple (Communication — Telegram + Slack + GitHub Comments simultaneously). This is a per-adapter-type configuration, not per-plugin.

During plugin selection, single-select types show a radio-style picker. Multi-select types show checkboxes. The adapter type metadata declares which mode applies. Simple config lookup — no special logic.

### AI Plugin Generation — The Re-Entrant Loop

When the user selects "Build a custom plugin with AI" during plugin setup:

1. Show a message: "We're about to open a terminal session with your chosen AI tool. It will have access to our plugin SDK docs, adapter contracts, and examples. Describe what you want, and the AI will build it."
2. Spawn a new terminal with the user's chosen CLI tool (from LLM selection step) + a crafted prompt pointing at plugin documentation.
3. User interacts with the AI to build their plugin in that separate session.
4. When done, user comes back and runs `engineer start` again.
5. `start` detects the new plugin in the plugins directory and includes it in the plugin selection list.
6. User selects their new plugin alongside the others, configures it (schema-driven), and continues to startup.

This is a loop: `start` → plugin selection → "build with AI" → separate session → come back → `start` again → see new plugin → continue. Each re-entry to `start` picks up any new plugins.

**Prerequisite:** Plugin SDK documentation, adapter contract docs, and examples must be complete before this feature works. The AI needs good reference material to generate plugins. Schema definitions based on adapters are the foundation — the plugin implements an adapter, so the adapter schema is what matters.

### Core Config — Defaults with Optional Customization

After plugin setup is complete, prompt the user:

```
  Use default settings for The Engineer? (Y/n): _
```

If yes (default): apply conservative defaults for daemon, workspace, safety configs. Continue to startup. Don't bother people.

If no: walk through each core config category one-by-one, same schema-driven approach as plugins. Safety level (conservative/balanced/autonomous) becomes a select. Workspace settings, daemon tuning, etc. — all driven by existing Zod schemas which already have `.describe()` on every field.

Most users will say yes. Power users who want fine control say no and get the full walkthrough.

### Ctrl+C Mid-Setup — Clean Rollback

If the user sends Ctrl+C (SIGINT) during the setup flow, do a complete cleanup:
- Delete any config files written so far during this setup session
- Remove any directories created during this session
- Show a clean message: "Setup cancelled. Everything rolled back. Run `engineer start` again when ready."

No partial state left behind. Next `engineer start` starts fresh as if nothing happened.

### Non-Interactive Mode — `engineer start --plugins <path>`

For CI/automation/teams: skip all interactive prompts by providing pre-made plugin configs.

```
$ engineer start --plugins ./my-plugin-configs/
```

- Plugin YAML files are read from the provided path and copied into `~/.engineer/config/plugins/`
- Core configs (daemon, workspace, safety) use defaults — The Engineer manages `~/.engineer/` itself
- No prompts, no questions — if plugin configs are provided and valid, just start
- If a plugin config is invalid, fail with a clear error pointing to the file and field

This is the only thing non-interactive needs: where are the plugin configs? Everything else is defaults. Users don't pre-populate `~/.engineer/` — we manage that.

For automated setups without the flag, pre-populating `~/.engineer/config/` before running `engineer start` also works — `start` detects existing config and skips setup entirely.

### Reconfiguration — Deferred (Future Consideration)

Changing plugin selection or re-running setup after initial configuration is deferred. For now: `engineer stop`, edit configs manually in `~/.engineer/config/`, then `engineer start`. Document this in CLI help output.

The smart approach (auto-detect existing config, prompt for changes, preserve what's unchanged) is the right eventual solution but adds significant complexity. Added to `future-considerations.md`.

### Bootstrap Transparency

Current state: 12-step sequential init with good error handling and reverse-order cleanup. Solid engineering. But opaque to the user — only spinner states shown.

**Decision: Show everything inline during startup.**
- Per-step timing (database, core system, each plugin)
- Per-plugin load status with name and result (loaded / SKIPPED + reason)
- Total startup time in the final ready message
- Pre-flight results with warning count, warnings always shown (not hidden behind --verbose)
- Structured `bootstrap_complete` observation for War Room with full step timeline and plugin details

### Safety & Internals

**Signal handler dedup:** Both `start.ts` (lines 189-190) and `daemon.start()` (lines 518-526) register SIGTERM/SIGINT handlers. Two async shutdown sequences race on the same signal. Fix: CLI owns signal handling (it knows about dashboard + DB + logger cleanup). Daemon only exposes `stop()`, does NOT register its own signal handlers. Single deterministic shutdown path.

**Global crash safety net:** `src/index.ts` is 7 lines with no `uncaughtException` or `unhandledRejection` handler. For a long-running daemon, that's a gap. Fix: add handlers that write to stderr (logger may not exist) and set exit code. Safety net, not primary error handling.

**Friendly "already running" message:** Detect `DaemonAlreadyRunningError` specifically, show PID, suggest `engineer stop` or `engineer status` instead of raw error.

