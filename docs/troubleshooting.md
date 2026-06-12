# Troubleshooting

When The Engineer misbehaves, two commands cover almost everything. Run them first, then jump to the matching symptom below.

```bash
engineer doctor          # Health checks — each failure prints a → remedy line
engineer logs --follow   # Stream the daemon log live (Ctrl-C to stop)
```

`engineer doctor` runs independent health-check categories and exits `0` (all pass), `1` (failures found), or `2` (warnings only). Every failing or warning check prints a one-line remedy, so it is both the diagnosis and the first fix. `engineer logs` tails the most recent log file under `~/.engineer/logs/`. See the [CLI Reference](./cli.md) for the full command and flag list.

Paths below assume the default home of `~/.engineer`. If you set `ENGINEER_HOME` or pass `--home`, substitute that directory.

## The daemon won't start

`engineer start` runs a pre-flight subset of the doctor checks before it boots. If pre-flight finds a failure, it prints the failing categories and exits without starting. Run `engineer doctor` to see the same checks with their remedies.

| Check | Symptom | Fix |
|-------|---------|-----|
| Node.js Runtime | "Node.js 22+ required" | Install Node.js 22 or later. |
| Config Files | A `*.yaml` reported as invalid | Edit the named file under `~/.engineer/config/` and fix the reported Zod errors. |
| Required Secrets | "Environment variable `X` is not set" | Add `X=<value>` to `~/.engineer/.env`, or `export` it. doctor names how to obtain known secrets. |
| Data Directory | "ENGINEER_HOME is not writable" | `chmod u+w ~/.engineer`. |
| Database | "Cannot access … engineer.db" | Fix file permissions on `~/.engineer/data/engineer.db`. |

Two more start-time failures are not doctor checks:

- **Already running.** Startup reports `The Engineer is already running (PID: N)`. Use `engineer stop`, or `engineer status` to confirm. The daemon refuses to start a second instance: on start it reads `~/.engineer/run/engineer.pid` and, if that PID belongs to a live process, throws rather than collide.
- **Stale PID file.** If the daemon was killed hard (power loss, `kill -9`), the PID file can outlive the process. The daemon handles this itself — when the recorded PID is no longer a live process, it logs "Removing stale PID file" and starts normally. If you want to clear it manually, delete `~/.engineer/run/engineer.pid` while the daemon is stopped.

If start fails after pre-flight with `Bootstrap failed` or `Config error`, the message points you at `engineer doctor`; run it and read the per-check remedies.

## No tasks get picked up

You created a GitHub issue (or other trigger) and nothing happens. Work through these in order.

| Check | How to verify | Fix |
|-------|---------------|-----|
| Daemon actually running | `engineer status` shows `running (PID N)` | If it shows `stopped`, run `engineer start`. |
| Token present and valid | `engineer doctor` → Required Secrets passes; check `engineer logs` for auth/401 errors | Set or refresh the trigger plugin's token (e.g. `GITHUB_TOKEN`) in `~/.engineer/.env`. |
| Trigger filters match | The issue carries the configured label/assignee | See [github-trigger: Troubleshooting](./plugins/trigger/github-trigger.md#troubleshooting) for the label/assignee/PR-filter rules. |
| Poll delay | Wait one poll interval | Triggers are polled, not pushed. github-trigger polls every 30s by default; the daemon's `trigger_poll_interval_ms` is the fallback for plugins that declare no interval. |

If the daemon is running, the token is valid, and the filters match, watch `engineer logs --follow` across a full poll cycle — the plugin logs what it fetched and why it skipped each item.

## An agent CLI is not found

The Engineer drives external coding-agent CLIs (Claude Code, Gemini CLI, OpenCode) as subprocesses, so each must be installed and on `PATH`.

The External Dependencies category of `engineer doctor` derives its required binaries from the enabled plugins' manifests and checks each one. A binary that is missing reports `<name> is not available` with the remedy "Install `<name>` and ensure it is on PATH". This is a warning, not a hard failure — the daemon still starts, but a task routed to a missing agent cannot run.

Fix: install the agent CLI, confirm `<name> --version` works in a fresh shell, then restart the daemon so it inherits the updated `PATH`.

## A task is stuck blocked or failed

Read the task's history first, fix the root cause, then re-queue it.

```bash
engineer status                 # Find the task's 8-character ID prefix and state
engineer why <task-id>          # Timeline: state transitions, events, block reason, cost
engineer retry <task-id>        # Re-queue a blocked or failed task
```

`engineer why` prints the block reason and what the task needs to proceed, plus its full timeline and cost. `engineer retry` re-queues a `blocked` or `failed` task and resets its automatic retry counters; the daemon picks it up on the next scheduling cycle. It uses the database directly, so it works even while the daemon is stopped. Retry only once the root cause is addressed — re-queuing without fixing what blocked or failed the task just repeats the outcome.

| State | Why it happened | What to do |
|-------|-----------------|------------|
| `blocked` | The task needs owner input (a clarifying answer, a decision, missing access) | Provide what `engineer why` says it needs, then `engineer retry <task-id>`. |
| `failed` | The [retry policy](./configuration/daemon.md#retry-policy) exhausted its automatic budget, or the [hard cap](./configuration/daemon.md#stuck-detection) on total active time (`max_active_duration_ms`, 8h by default) triggered | Address the root cause — fix the crash, raise the cap — then `engineer retry <task-id>`. |

See [retry](./cli.md#retry) for the full command reference.

## A cost limit terminated work

The Engineer enforces the spending caps in `safety.yaml`. Warnings fire at 80% of each limit; on a breach it terminates the offending work and tells the owner.

- **A per-task or per-provider breach** transitions that one task to `blocked`, comments on its source ticket ("Task blocked — cost limit reached."), and DMs the owner.
- **A global daily or monthly breach** terminates every in-flight task and sends a single owner alert.

You will see it in the owner DM/alert, on the task's source ticket, and in `engineer why <task-id>` (the block reason and the `cost.incurred` timeline). A terminated task is `blocked`, so `engineer retry <task-id>` resumes it once you have headroom.

To raise the ceiling, edit `cost_limits` in `~/.engineer/config/safety.yaml` (`per_task`, `daily`, `monthly`, and per-provider request caps) and restart the daemon. See [Safety Configuration](./configuration/safety.md#cost-limits) for the full key reference. Leaving every limit `null` means spending is unbounded — `engineer doctor` warns when no cap is set.

## Where to look

| Source | Command / path | Shows |
|--------|----------------|-------|
| Health checks | `engineer doctor` | Every category, with a remedy on each failure or warning |
| Daemon logs | `engineer logs` (`--follow`, `--raw`, `--lines N`); files in `~/.engineer/logs/` | Everything the daemon does, including plugin polling and errors |
| Daemon status | `engineer status` (`--all` for terminal tasks) | Whether the daemon is running, plus the task list |
| Per-task history | `engineer why <task-id>` | One task's timeline, block reason, and cost |
| Dashboard | `http://localhost:3847` (starts with the daemon) | Live tasks, metrics, agent calls, and traces in the browser |

## Resetting the database

The Engineer is pre-v1: a breaking schema change ships without a data migration. If the database is corrupt, an upgrade reshaped the schema, or you just want a clean slate, delete it and let the daemon recreate it:

```bash
engineer stop
rm ~/.engineer/data/engineer.db
engineer start
```

For a full development reset (rebuild, relink the CLI, clear the whole data directory, fresh interactive setup), use `./scripts/reset.sh` instead. See the [reset reference](./cli.md#development-resets).

## Filing an issue

If none of the above resolves it, open an issue at [github.com/FarzamMohammadi/the-engineer/issues](https://github.com/FarzamMohammadi/the-engineer/issues). Include the failing `engineer doctor` output and the relevant lines from `engineer logs`.
