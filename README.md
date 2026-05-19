# The Engineer

An autonomous software engineering agent that works like a real engineer — not a code generator.

Receives tasks, gathers requirements, researches codebases, plans, executes, self-reviews, and ships pull requests. Runs continuously as a daemon, listens for triggers, communicates through real channels.

## Get Running

**Prerequisites:** Node.js 22+, pnpm

```bash
git clone https://github.com/user/the-engineer.git && cd the-engineer
pnpm install
```

**Start (and restart):**

```bash
./scripts/reset.sh                    # Full wipe — rebuild, re-seed, start fresh
./scripts/reset.sh --persist-data     # Keep DB, workspaces, .env — re-seed config & plugins
```

The reset script builds, links the CLI globally, seeds configs/plugins from [`seed-example/`](seed-example/), and starts the daemon. `--persist-data` preserves your task history and database while rebuilding everything else. Fork `seed-example/` into your own seed directory with custom settings to make resets fast and repeatable.

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

## Philosophy

- **Real engineer behavior** — requirements first, research without bounds, plan then question the plan, build for the next person.
- **Orchestrate, don't build** — leverages external LLM CLI tools (Claude Code, Codex, OpenCode) as autonomous agents. We stay lean, they stay powerful.
- **Radical observability** — every action leaves a trail. The owner is never in the dark.
- **Boundaries as discipline** — modular everything, enforced contracts, swappable plugins. Plugin Blindness is the core architectural invariant.
- **Post-completion rigor** — reassess architecture, refine until beautiful, verify what matters, ship and refine through feedback.
- **Every decision earned** — no dogma. Strong defaults, deliberate deviations. Question, evaluate, evolve.

Full philosophy: [docs/philosophy.md](docs/philosophy.md) | Identity: [docs/persona.md](docs/persona.md)

## Architecture

Three tiers: **Core** (task engine, orchestrator, safety layer, event bus, daemon) → **Adapters** (5 contracts: trigger, communication, LLM, tool, git hosting) → **Plugins** (GitHub, Telegram, Claude, Bash — swappable). Core never knows which plugins exist — the adapter contract is the boundary.

The daemon tick loop: poll triggers → create tasks → schedule by priority → dispatch to orchestrator → 7-phase pipeline → ship PR.

Architecture guide: [docs/architecture/overview.md](docs/architecture/overview.md) | Three-tier model: [docs/architecture/three-tier-model.md](docs/architecture/three-tier-model.md)

## Documentation

All user-facing documentation lives in [`docs/`](docs/) — the system blueprint. Key references:

- [Philosophy](docs/philosophy.md) — core beliefs and principles
- [Coding Standards](docs/coding-standards.md) — the law for all code
- [Architecture](docs/architecture/overview.md) — system design and data flow
- [CLI Reference](docs/cli.md) — full command documentation
- [Configuration](docs/configuration/) — daemon, orchestrator, safety, workspaces

## Development

```bash
pnpm test             # Unit tests (~2500)
pnpm test:all         # All tiers (unit + integration + E2E)
pnpm run typecheck    # tsc --noEmit (strict)
pnpm run lint         # Biome + tsc + knip (unused exports) + madge (circular deps)
pnpm run build        # Production build (tsdown + Vite dashboard)
npx tsx src/index.ts  # Run CLI in dev mode
```

> **Note:** [`implementation-docs/`](implementation-docs/) contains internal development history (architectural layers, decision logs, session notes). These will be removed before the v1 release. User-facing docs live in [`docs/`](docs/).

## License

TBD
