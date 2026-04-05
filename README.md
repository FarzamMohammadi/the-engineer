# The Engineer

An autonomous software engineering agent that works like a real engineer — not a code generator.

Receives tasks, gathers requirements, researches codebases, plans, executes, self-reviews, and ships pull requests. Runs continuously as a daemon, listens for triggers, communicates through real channels.

## Get Running

**Prerequisites:** Node.js 22+, pnpm

**First time only:**

```bash
git clone https://github.com/user/the-engineer.git && cd the-engineer
pnpm install
pnpm setup                               # Configure PNPM_HOME (first time only)
source ~/.zshrc                           # Reload shell (or restart terminal)
```

**Start (and restart):**

```bash
./scripts/reset.sh                    # Full wipe — rebuild, re-seed, start fresh
./scripts/reset.sh --persist-data     # Keep DB, workspaces, .env — re-seed config & plugins
```

The reset script builds, links the CLI globally, seeds configs/plugins from [`seed-example/`](seed-example/), and starts the daemon. `--persist-data` preserves your task history and database while rebuilding everything else.

`seed-example/` ships with default configs and plugins. Fork it into your own seed directory with custom settings to make resets fast and repeatable.

> **Dev mode (without global install):** Use `npx tsx src/index.ts` in place of `engineer` for any command.

## Commands

```
engineer start              # Setup (first run) + start daemon
engineer stop               # Graceful shutdown
engineer status             # Is it running? Task queue depth
engineer logs               # View daemon logs (--follow, --json)
engineer doctor             # Health checks (9 categories)
engineer why <task-id>      # Explain a task's decision trail
```

All commands accept `--home <path>` to use a custom data directory instead of `~/.engineer`.

Full command reference, options, and configuration details: **[docs/cli.md](docs/cli.md)**

## Principles

- **Agent-agnostic** — any LLM (Claude, GPT, Gemini, local). No vendor lock-in.
- **Real engineer behavior** — requirements first, questions before code, ambiguity is a hard blocker.
- **Modular everything** — triggers, communication, LLM, tools, git hosting — all pluggable.
- **Minimal by design** — small prompts, few broad tools, single agent, no framework bloat.
- **Post-completion rigor** — self-review, draft PR, feedback loop, iterate.

Full rationale: [docs/philosophy.md](docs/philosophy.md) | Identity: [docs/persona.md](docs/persona.md)

## Architecture

Three tiers: **Core** (task engine, orchestrator, safety layer, event bus, daemon) → **Adapters** (trigger, communication, LLM, tool, git hosting) → **Plugins** (GitHub, Telegram, Claude, Bash — swappable).

The daemon tick loop: poll triggers → create tasks → schedule by priority → dispatch to orchestrator → 7-phase pipeline → ship PR.

Architecture guide: [docs/architecture/overview.md](docs/architecture/overview.md) | Three-tier model: [docs/architecture/three-tier-model.md](docs/architecture/three-tier-model.md)

## Development

```bash
pnpm test             # Unit tests (~2300+)
pnpm test:all         # All tiers (unit + integration + E2E)
pnpm run typecheck    # tsc --noEmit (strict)
pnpm run lint         # Biome (all rules)
pnpm run build        # Production build
npx tsx src/index.ts  # Run CLI in dev mode
```

> **Note:** [`implementation-docs/`](implementation-docs/) contains internal development documentation used during the design and build process (architectural layers, decision logs, session notes). These will be removed before the v1 release — they are not part of the product documentation. User-facing docs live in [`docs/`](docs/).

## License

TBD
