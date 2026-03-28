# The Engineer

An autonomous software engineering agent that works like a real engineer — not a code generator.

Receives tasks, gathers requirements, researches codebases, plans, executes, self-reviews, and ships pull requests. Runs continuously as a daemon, listens for triggers, communicates through real channels.

## Get Running

**Prerequisites:** Node.js 22+, pnpm

```bash
git clone https://github.com/user/the-engineer.git && cd the-engineer
pnpm install

# ── Install the `engineer` CLI globally ──
pnpm run build                           # Build to dist/
pnpm setup                               # Configure PNPM_HOME (first time only)
source ~/.zshrc                           # Reload shell (or restart terminal)
pnpm link --global                        # Link `engineer` command

# ── First run ──
engineer init                            # Create ~/.engineer/ with template configs
# Edit ~/.engineer/config/*.yaml          # Add API keys, repos, preferences
engineer doctor                          # Verify health (10 checks)
engineer start                           # Start daemon (foreground, includes dashboard)
```

Any command accepts `--home <path>` to use a custom data directory instead of `~/.engineer`.

> **Dev mode (without global install):** Use `npx tsx src/index.ts` in place of `engineer` for any command.

For the full command reference, options, and first-run walkthrough: **[docs/cli.md](docs/cli.md)**

## Principles

See [docs/philosophy.md](docs/philosophy.md) for the full rationale, [docs/persona.md](docs/persona.md) for the identity.

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
pnpm test             # Unit tests (~2300+)
pnpm test:all         # All tiers (unit + integration + E2E)
pnpm run typecheck    # tsc --noEmit (strict)
pnpm run lint         # Biome (all rules)
pnpm run build        # Production build
npx tsx src/index.ts  # Run CLI in dev mode
```

## Status

Layer 7 (structural restructuring) complete. Full 7-phase pipeline, 6 built-in plugins, declarative event topology, plugin discovery, CLI polish, security hardening, typed errors, data lifecycle management, and observability tracing. Live end-to-end tested against real repos.

## License

TBD
