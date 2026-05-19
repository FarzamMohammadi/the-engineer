# The Engineer

An autonomous software engineering agent that works like a real engineer — not a code generator.

Receives tasks, gathers requirements, researches codebases, plans, executes, self-reviews, and ships pull requests. Runs continuously as a daemon, listens for triggers, communicates through real channels.

## Get Running

**Prerequisites:** Node.js 22+, [pnpm](https://pnpm.io/installation)

```bash
git clone https://github.com/user/the-engineer.git && cd the-engineer
pnpm run setup    # install dependencies, build, link the `engineer` CLI
engineer start    # first-run setup, then start the daemon
```

`pnpm run setup` confirms before it acts and is safe to re-run any time. If pnpm's global bin directory isn't configured yet, it offers to set that up and tells you what to do next. `engineer start` walks you through first-run configuration, then runs the daemon in the foreground — `Ctrl+C` to stop.

> **Dev mode (without a global install):** use `pnpm dev <command>` in place of `engineer`.

### Resetting

For a clean rebuild during development:

```bash
./scripts/reset.sh                    # Full wipe — rebuild, relink, fresh interactive setup
./scripts/reset.sh --persist-data     # Keep the database, workspaces, and .env
./scripts/reset.sh <seed-dir>         # Wipe, then non-interactive setup from a seed directory
```

A seed directory holds saved configuration (`configs/` and `plugins/` YAML) so setup runs with no prompts. [`seed-example/`](seed-example/) shows the structure — copy it into a gitignored `seed-example-<name>/` and fill in your own values.

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

Full philosophy: [docs/philosophy.md](docs/philosophy.md) | Identity: [docs/the-engineer-persona.md](docs/the-engineer-persona.md)

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
