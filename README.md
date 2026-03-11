# The Engineer

An autonomous software engineering agent that works like a real engineer — not a code generator.

Receives tasks, gathers requirements, researches codebases, plans, executes, self-reviews, and ships pull requests. Runs continuously as a daemon, listens for triggers, communicates through real channels.

## Get Running

**Prerequisites:** Node.js 22+, pnpm

```bash
git clone https://github.com/user/the-engineer.git && cd the-engineer
pnpm install

npx tsx src/index.ts init                # Create ~/.engineer/ with template configs
# Edit ~/.engineer/config/*.yaml          # Add API keys, repos, preferences
npx tsx src/index.ts doctor              # Verify health (10 checks)
npx tsx src/index.ts start               # Start daemon (foreground)
```

Any command accepts `--home <path>` to use a custom data directory instead of `~/.engineer`.

For the full command reference, options, and first-run walkthrough: **[docs/cli.md](docs/cli.md)**

## Principles

See [docs/persona.md](docs/persona.md) for the full identity.

- **Agent-agnostic** — any LLM (Claude, GPT, Gemini, local). No vendor lock-in.
- **Real engineer behavior** — requirements first, questions before code, ambiguity is a hard blocker.
- **Modular everything** — triggers, communication, LLM, tools, git hosting — all pluggable.
- **Minimal by design** — small prompts, few broad tools, single agent, no framework bloat.
- **Post-completion rigor** — self-review, draft PR, feedback loop, iterate.

## Architecture

Three tiers: **Core** (task engine, orchestrator, safety layer, event bus, daemon) → **Adapters** (trigger, communication, LLM, tool, git hosting) → **Plugins** (GitHub, Telegram, Claude, Bash — swappable).

The daemon tick loop: poll triggers → create tasks → schedule by priority → dispatch to orchestrator → 7-phase pipeline → ship PR.

Deep dives live in [`implementation-docs/`](implementation-docs/), organized by architectural layer.

## Development

```bash
pnpm test             # 1058 unit tests
pnpm run typecheck    # tsc --noEmit (strict)
pnpm run lint         # Biome (all rules)
pnpm run build        # Production build
npx tsx src/index.ts  # Run CLI in dev mode
```

## Status

Phase 13 of 19 complete. Core built and tested. Next: plugin implementations and integration tests.

## License

TBD
