# Contributing to The Engineer

Welcome! Whether you're fixing a typo, reporting a bug, or building a new plugin, every contribution matters. Please read our [Code of Conduct](CODE_OF_CONDUCT.md) and [Philosophy](docs/philosophy.md) before participating — the philosophy governs how we work, make decisions, and collaborate on this project.

## Development Setup

**Prerequisites:** Node.js 22+, pnpm, git

First, get a working install the same way a user does — clone, then `pnpm run setup` and `engineer start`. The canonical getting-started lives in the [README](README.md#get-running); follow it once so `engineer` is built and linked.

For contributor iteration, the reset script gives you a fast clean rebuild on top of that install:

```bash
./scripts/reset.sh                    # Full wipe — rebuild, relink, re-seed, start fresh
./scripts/reset.sh --persist-data     # Keep DB, workspaces, .env — re-seed config & plugins
./scripts/reset.sh <seed-dir>         # Full wipe, then non-interactive setup from a seed directory
```

The reset script builds, links the CLI globally, seeds configs/plugins from [`seed-example/`](seed-example/), and starts the daemon. Full CLI and reset reference: [docs/cli.md](docs/cli.md).

**Dev mode (without global install):**

```bash
pnpm dev <command>    # Run the CLI without building or linking
```

## Project Structure

```
src/
  core/         # Invariant components (EventBus, TaskEngine, Orchestrator, Daemon, etc.)
  adapters/     # Abstract base classes + SDK boundary (plugin authors import from here)
  plugins/      # Implementations grouped by adapter type (trigger/, communication/, agent/, git-hosting/)
  schemas/      # Centralized Zod schemas
  cli/          # Commander CLI (start, stop, status, logs, doctor, why, retry, cancel)
  config/       # Config loader + hot-reload watcher
  db/           # SQLite database layer + migrations
  dashboard/    # War room dashboard (Hono + SSE)
  utils/        # Shared utilities
tests/
  unit/         # Component logic, schemas, state machines (mirrors src/)
  integration/  # Cross-component integration tests with fake plugins
  e2e/          # Full daemon lifecycle tests
  boundary/     # Architecture tier enforcement tests
  helpers/      # Mock factories, fake plugins, contract suites, test utilities
  fixtures/     # Test fixture data
  setup.ts      # Global test setup
```

Architecture details: [docs/architecture/overview.md](docs/architecture/overview.md) | Three-tier model: [docs/architecture/three-tier-model.md](docs/architecture/three-tier-model.md)

## Running Tests

Three test tiers:

| Tier | Command | Scope |
|------|---------|-------|
| Unit | `pnpm test` | Component logic, schemas, state machines |
| Integration | `pnpm test:integration` | Cross-component with fake plugins |
| E2E | `pnpm test:e2e` | Full daemon lifecycle |
| All | `pnpm test:all` | All three tiers |

Coverage targets: 70% lines/functions, 55% branches.

```bash
pnpm test:coverage    # Unit tests with coverage report
pnpm test:watch       # Watch mode for development
```

## Code Style

We use [Biome](https://biomejs.dev/) for linting and formatting. No ESLint or Prettier.

```bash
pnpm run lint         # Biome + TypeScript strict + knip (unused exports) + madge (circular deps)
pnpm run typecheck    # TypeScript strict mode (tsc --noEmit)
```

Biome uses the `all` preset with specific exceptions documented in `biome.json`. Key rules:

- `noExplicitAny`: error
- Maximum TypeScript strictness (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)

## Documentation Site

The docs in [`docs/`](docs/) double as a [VitePress](https://vitepress.dev/) site published to GitHub Pages. The site reads `docs/` directly, so the docs and the site are one source of truth.

```bash
pnpm docs:dev       # Local dev server with hot reload
pnpm docs:build     # Build the static site (docs/.vitepress/dist)
pnpm docs:preview   # Preview the production build
```

It deploys automatically on every push to `main` via [`.github/workflows/docs.yml`](.github/workflows/docs.yml). One-time repo setup: **Settings → Pages → Source: GitHub Actions**. The internal build journal under `docs/archived/` is excluded from the site and linked out instead.

> This is separate from `pnpm run docs:bundle`, which regenerates the plugin docs the CLI ships (see the [Pull Request Process](#pull-request-process) below).

## Commit Conventions

Every commit has a **title** and a **description**:

- **Title:** One sentence, imperative mood, capitalized, max 72 characters. Captures all changes at the highest level.
- **Description:** Bullet points that go one level deeper — enough to fully understand without viewing files.

```
Add observability and blueprint principles to philosophy

- Add "Radical Observability — The Owner Is Never in the Dark" with three litmus tests
- Add "Docs as System Blueprint" establishing docs as middle-level architectural representation
- Trim "Documentation as Product" opening to remove sentence absorbed by new section
```

When changes span multiple concerns, split into separate commits — one logical change per commit.

## Pull Request Process

1. Fork the repository and create a feature branch from `main`
2. Keep PRs small and focused — one logical change per PR
3. Include tests for new functionality
4. Fill out the [PR template](.github/PULL_REQUEST_TEMPLATE.md)
5. Ensure all checks pass: `pnpm test:all && pnpm run lint && pnpm run typecheck`
6. If you edited any `docs/plugins/**/*.md`, regenerate the bundled plugin docs and commit the result: `pnpm run docs:bundle`. CI fails if the bundle is out of sync with the source docs.

## Writing Plugins

The Engineer's plugin system has four adapter types — triggers, communication channels, agents, and git hosting — and you can add a plugin behind any of them.

Start with **[Authoring a Plugin](docs/contribution-docs/how-tos/plugins/authoring.md)** — the one executable methodology that covers all four adapter types. It owns the common sequence (identify the adapter, scaffold, implement, register, run the contract suite, configure, verify, contribute back) and sends you into the right [adapter contract](docs/plugins/) for the adapter-specific detail. Each adapter's `README.md` carries its contract, key types, and a short "Developing a New Plugin" section with that adapter's specifics.

## Reporting Bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include:

- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node version, OS, The Engineer version)
- Relevant logs (from `~/.engineer/logs/`)

## Suggesting Features

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md). Explain:

- What problem it solves
- How it aligns with the [project philosophy](docs/philosophy.md)
- Alternatives you've considered

## Getting Help

- **Questions:** Open a [GitHub Issue](https://github.com/FarzamMohammadi/the-engineer/issues) with the `question` label
- **Architecture:** See [docs/architecture/](docs/architecture/) for system design
- **Plugin development:** See [Authoring a Plugin](docs/contribution-docs/how-tos/plugins/authoring.md) for the methodology and [docs/plugins/](docs/plugins/) for the adapter contracts
