# The Engineer

[![CI](https://github.com/FarzamMohammadi/the-engineer/actions/workflows/ci.yml/badge.svg)](https://github.com/FarzamMohammadi/the-engineer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Status: Preview](https://img.shields.io/badge/status-preview-orange.svg)](#project-status)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](.node-version)

> An autonomous orchestrator for AI coding agents. The Engineer drives Claude Code, OpenCode, and other CLI agents through the **full engineering lifecycle** — from task intake to merge — with safety rails, a full audit trail, and a swappable plugin architecture.

<!-- TODO(visuals): hero dashboard screenshot here -->

> [!IMPORTANT]
> **Status: Preview — active development.**
> The Engineer is real, working software being built in the open as it moves toward `v1.0.0`. Interfaces, configuration, and behavior **will change** between preview tags. Use it, read the code, file issues — but do not depend on it for production work yet. See the [CHANGELOG](CHANGELOG.md) for what's in this cut and the [build journal](docs/archived/) for the path that got us here.

> **AI coding agents:** if you're an AI agent working *on* this codebase — not just reading about it — [`AGENT-README.md`](AGENT-README.md) is your required entry point. Read and follow it before making any change.

---

## What it is

AI coding CLIs like Claude Code, OpenCode, and other LLM agents are extraordinarily capable inside a single prompt. They fall short the moment you want them to do **real engineering work** — receiving tasks, gathering requirements, researching across the codebase, the web, and adjacent systems, planning the approach, executing safely, self-reviewing, shipping a pull request that survives review, iterating on review comments and CI failures, and merging only after sign-off.

The Engineer is the orchestration layer that closes that gap. It runs as a long-lived daemon that listens for tasks wherever engineering work actually lives — GitHub Issues today; Jira, Azure DevOps, and other popular ticket-management systems as plugin support lands.

From there it drives a coding CLI through that lifecycle end-to-end — preserving context across phases, isolating each task in its own workspace, and reaching out through your communication plugins when it hits a blocker or needs a decision.

Humans stay in the loop where it matters — requirements, key decisions, and the final review — by design, not by omission. Every action is observable, every plugin is swappable, every decision is auditable.

Think of it as **the conductor**. The coding CLIs are the instrumentalists.

## Get Running

**Prerequisites:** Node.js 22+, [pnpm](https://pnpm.io/installation)

```bash
git clone https://github.com/FarzamMohammadi/the-engineer.git && cd the-engineer
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

```bash
engineer start              # Setup (first run) + start daemon
engineer stop               # Graceful shutdown
engineer status             # Is it running? Task queue depth
engineer logs               # View daemon logs (--follow, --json)
engineer doctor             # Health checks across multiple categories
engineer why <task-id>      # Explain a task's decision trail
engineer retry <task-id>    # Re-queue a failed task
```

All commands accept `--home <path>` to use a custom data directory instead of `~/.engineer`.

Full command reference, options, and configuration details: **[docs/cli.md](docs/cli.md)**

## How it works

<!-- TODO(visuals): architecture diagram here (three-tier model: Core → Adapters → Plugins) -->

**Three tiers.** The system is built around a single architectural invariant called **Plugin Blindness**:

- **Core** — task engine, orchestrator, safety layer, event bus, daemon. **The conductor.**
- **Adapters** — contracts (`TriggerAdapter`, `CommunicationAdapter`, `LLMAdapter`, `GitHostingAdapter`). **The score.**
- **Plugins** — swappable implementations behind each adapter. **The instruments.**

Core never knows which plugins exist. The adapter contract is the integration boundary. Swap GitHub for GitLab, Telegram for Slack, Claude Code for OpenCode — Core's code does not change.

**How a task moves through the daemon:**

1. Poll triggers, create tasks, schedule by priority.
2. Dispatch each task to the orchestrator.
3. Run the per-task pipeline (requirements → research → planning → execution → self-review → demo prep → integration).
4. Ship a pull request.
5. Iterate on review comments and CI failures.
6. Merge after sign-off.

Architecture guide: **[docs/architecture/overview.md](docs/architecture/overview.md)** · Three-tier model: **[docs/architecture/three-tier-model.md](docs/architecture/three-tier-model.md)**

## Plugin Architecture

The Engineer's leverage compounds with every plugin built against it. Core defines the protocol; plugins do the work. The same protocol governs every agent — no `CLAUDE.md`, no `GEMINI.md`, no per-tool accommodations. **One protocol, any agent.**

| Adapter | Today's plugins | Your plugin |
|---|---|---|
| `TriggerAdapter` | `github-trigger` | GitLab, Jira, Linear, webhooks, cron — anything that emits a task |
| `CommunicationAdapter` | `github-comm`, `telegram-comm` | Slack, Discord, email, SMS |
| `LLMAdapter` | `claude-code-llm`, `opencode-llm`, `gemini-cli-llm` | Codex, Aider, any CLI agent that edits files from a prompt |
| `GitHostingAdapter` | `github-hosting` | GitLab, Bitbucket, Gitea, self-hosted git |

Build a plugin once, and every existing Core capability — safety rails, audit trail, retries, observability — applies automatically.

See [docs/plugins/](docs/plugins/) for adapter contracts and [docs/contribution-docs/](docs/contribution-docs/) for agent-executable plugin development how-tos.

## Philosophy

- **Real engineer behavior** — requirements first, research without bounds, plan then question the plan, build for the next person.
- **Orchestrate, don't build** — leverage LLM CLI tools (Claude Code, OpenCode, Gemini CLI) as autonomous agents. They keep evolving, we inherit every improvement.
- **Radical observability** — every action leaves a trail. The owner is never in the dark.
- **Boundaries as discipline** — modular everything, enforced contracts, swappable plugins. Plugin Blindness is the core architectural invariant.
- **Post-completion rigor** — reassess architecture, refine until beautiful, verify what matters, ship and refine through feedback.
- **Every decision earned** — no dogma. Strong defaults, deliberate deviations. Question, evaluate, evolve.

Full philosophy: **[docs/philosophy.md](docs/philosophy.md)** · Identity: **[docs/the-engineer-persona.md](docs/the-engineer-persona.md)**

## Documentation

User-facing documentation lives in [`docs/`](docs/) — the system blueprint. Anyone who never reads a line of source can understand how The Engineer works, what it does, and why, purely from these docs.

- [Philosophy](docs/philosophy.md) — core beliefs and principles
- [Constraints](docs/constraints.md) — deliberate v1 scope decisions (single-user)
- [Architecture](docs/architecture/overview.md) — system design and data flow
- [CLI Reference](docs/cli.md) — full command documentation
- [Coding Standards](docs/coding-standards.md) — the law for all code
- [Configuration](docs/configuration/) — daemon, orchestrator, safety, workspaces
- [Plugins](docs/plugins/) — adapter contracts and per-plugin references
- [Contribution Guides](docs/contribution-docs/) — agent-executable how-tos for adding plugins
- [Build Journal — Archive](docs/archived/) — phase-by-phase development history (not authoritative; read the code and `docs/` for ground truth)

## Development

```bash
pnpm test             # Unit tests
pnpm test:all         # All tiers (unit + integration + E2E)
pnpm run typecheck    # tsc --noEmit (strict)
pnpm run lint         # Biome + tsc + knip (unused exports) + madge (circular deps)
pnpm run build        # Production build (tsdown + Vite dashboard)
npx tsx src/index.ts  # Run CLI in dev mode
```

CI runs lint, typecheck, and tests on every push and pull request. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Project Status

The Engineer is in **active development** toward `v1.0.0`. Tags are cut at slice milestones with the `-preview` suffix and make no stability guarantees — interfaces, configuration shapes, and behavior may change between preview releases. The [CHANGELOG](CHANGELOG.md) tracks what's in the current cut and what's still missing.

- **Want to use it?** Clone, run `pnpm run setup`, follow `engineer start`. Read the [CHANGELOG](CHANGELOG.md) for known gaps.
- **Want to contribute?** Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/philosophy.md](docs/philosophy.md) — the philosophy governs how every decision gets made.
- **Want to report a security issue?** See [SECURITY.md](SECURITY.md). Do not file public issues for security concerns.
- **Want to understand the journey?** The full build history is preserved in [`docs/archived/`](docs/archived/).

## License

[MIT](LICENSE) © 2026 Farzam Mohammadi

---

Built by [Farzam Mohammadi](https://github.com/FarzamMohammadi).
