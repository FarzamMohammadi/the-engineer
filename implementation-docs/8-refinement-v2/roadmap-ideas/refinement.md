# Runtime Phase Refinement — Ideas & Brainstorm

Living document. Ideas discussed between co-founders before implementation. Not everything here will be built — a separate plan will finalize scope.

---

## 1. Startup & Configuration

*CLI entry, bootstrap, plugin loading, daemon startup. First impressions.*

### Command Surface Consolidation

Current state: 14 CLI commands. Three of them (`prepare`, `init`, `setup`) all solve "get me configured." A new user has to pick between them.

**The problem:**
- `engineer prepare` — scaffolds a `seed/` directory with config templates (team sharing mechanism)
- `engineer init` — creates `~/.engineer/` from templates or seed, prompts for plugin selection
- `engineer setup` — interactive wizard that asks questions and generates configs

Three commands, one job. New user doesn't know which to use.

**Ideas:**
- Collapse to ONE getting-started command: `engineer setup` (interactive, THE front door)
- `engineer init` becomes `setup --non-interactive` or `setup --from-seed <path>` for CI/scripting
- `engineer prepare` becomes `engineer config export` or just documentation — not a top-level command
- `shutdown` renamed to `stop` (every CLI uses `stop` — Docker, systemctl, pm2, brew services)
- `config validate` absorbed into `doctor` (config validation IS a health check)
- `config migrate` kept as subcommand but auto-triggered by `start` when old config version detected

**Proposed command surface (14 -> 11):**
```
# Daily use
engineer start              # Smart: setup if needed, then run
engineer stop               # Was "shutdown"
engineer status             # Unchanged
engineer logs               # Unchanged
engineer dashboard          # Unchanged
engineer why <task-id>      # Unchanged

# Setup & config
engineer setup              # Interactive first-run (absorbs init + prepare)
engineer doctor             # Diagnostics (absorbs config validate)
engineer config migrate     # Rare migration

# Developer
engineer install            # OS service config
engineer create-plugin      # Plugin scaffolding
```

### Smart `start` as Front Door

Today: `engineer start` with no config = error. User has to discover `setup`/`init` separately.

**Idea:** `start` detects first-run (no `~/.engineer/` or no config files) and offers:
- "No configuration found. Run setup?" -> interactive setup -> start
- One command from zero to running. The barrier of entry becomes just `engineer start`.

### Bootstrap Transparency

Current state: 12-step sequential init with good error handling and reverse-order cleanup. Solid engineering. But opaque to the user — only spinner states shown.

**Ideas:**
- Show startup timing: "Daemon running (started in 1.2s)" — gives confidence, baseline for regressions
- Per-plugin loading visibility: "Plugins loaded: 5/5" or "Plugins loaded: 4/5 (1 skipped)" instead of just "Plugins loaded"
- Return structured result from `loadBuiltinPlugins` (loaded/skipped/total) so bootstrap can report it
- Include plugin details in `bootstrap_complete` observation for War Room startup timeline

### Signal Handler Dedup

Current state: Both `start.ts` (lines 189-190) and `daemon.start()` (lines 518-526) register SIGTERM/SIGINT handlers. Two async shutdown sequences race on the same signal.

**Idea:** CLI owns signal handling (it knows about dashboard + DB + logger cleanup). Daemon exposes `stop()` but does NOT register its own signal handlers. Single deterministic shutdown path.

### Global Crash Safety Net

Current state: `src/index.ts` is 7 lines. No `uncaughtException` or `unhandledRejection` handler. For a long-running daemon, that's a gap.

**Idea:** Add handlers that write to stderr (logger may not exist) and set exit code. Safety net, not primary error handling.

### Plugin Loading Visibility

Current state: Non-critical plugin failures silently swallowed. User sees "Loading plugins" -> "Plugins loaded" but not which or why any were skipped.

**Idea:** Surface per-plugin status during startup. Log skipped plugins with reason. Include in structured observation for dashboard.

### Pre-flight Warning Visibility

Current state: Doctor check warnings only shown with `--verbose`. User might miss degraded functionality.

**Idea:** Always show a one-liner when warnings exist: "Pre-flight: 2 warning(s). Use --verbose for details." Don't hide problems behind a flag.

---

## 2. Trigger & Requirements Flow

*Trigger polling, dedup, task creation, prioritization. Requirements Gathering contacts via People Directory + Communication plugins.*

*(To be brainstormed)*

---

## 3. Scheduling & Dispatch

*Priority, eligibility, slot management, concurrency. How tasks move from waiting to working.*

*(To be brainstormed)*

---

## 4. Workspace & Session

*Worktree lifecycle, session setup, resume, rework detection. Task isolation. `thoughts/` directory lifecycle.*

*(To be brainstormed)*

---

## 5. Demo & PR

*Commit, push, draft PR creation. PR narrative from thoughts/ files. Cleanup config for thoughts/ removal.*

*(To be brainstormed)*

---

## 6. Review & Feedback (External)

*External review polling (after PR creation), feedback detection, rework loop. Distinct from internal RRPIR Review pipeline.*

*(To be brainstormed)*

---

## 7. Completion & Cleanup

*Terminal states, notifications, workspace cleanup, parent integration for decomposed tasks.*

*(To be brainstormed)*

---

## 8. Communication

*Notification wiring (Telegram + GitHub), message formatting, requirements Q&A formatting, what notifications say and when.*

*(To be brainstormed)*

---

## 9. Background Services

*Cost tracking, data lifecycle, health monitoring. The continuous machinery.*

*(To be brainstormed)*
