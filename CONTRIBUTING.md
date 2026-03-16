# Contributing to The Engineer

Welcome! Whether you're fixing a typo, reporting a bug, or building a new plugin, every contribution matters. Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Development Setup

**Prerequisites:** Node.js 22+, pnpm, git

```bash
git clone https://github.com/FarzamMohammadi/the-engineer.git
cd the-engineer
pnpm install
pnpm run build
pnpm test
```

Run in development mode (no build step):

```bash
npx tsx src/index.ts
```

## Project Structure

```
src/
  core/         # Invariant components (EventBus, TaskEngine, Orchestrator, Daemon, etc.)
  adapters/     # Abstract base classes + SDK boundary (plugin authors import from here)
  plugins/      # Implementations grouped by adapter type (trigger/, communication/, llm/, tool/, git-hosting/)
  schemas/      # Centralized Zod schemas
  cli/          # Commander CLI (start, shutdown, status, logs, init, doctor, install, setup, dashboard, why, prepare, create-plugin, config-validate, config-migrate)
  config/       # Config loader + hot-reload watcher
  db/           # SQLite database layer + migrations
  dashboard/    # War room dashboard (Hono + SSE)
  utils/        # Shared utilities
test/
  helpers/      # Mock factories, fake plugins, contract suites, test utilities
  integration/  # Cross-component integration tests
  e2e/          # Full daemon lifecycle tests
  boundary/     # Architecture tier enforcement tests
```

For deep architecture details, see `implementation-docs/`.

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
pnpm run lint         # Check and auto-fix
pnpm run typecheck    # TypeScript strict mode (tsc --noEmit)
```

Biome uses the `all` preset with specific exceptions documented in `biome.json`. Key rules:

- `noExplicitAny`: error
- Maximum TypeScript strictness (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)

## Commit Conventions

We use imperative mood, capitalized subjects, with optional colon-separated details:

```
Add plugin discovery: implement five-phase loading
Fix type consistency: use ITaskEngine in CoreComponents
Update phase-plan.md: mark Wave 3 as MERGED
```

Keep commit messages concise. The subject line tells what changed; add detail after a colon if needed.

## Pull Request Process

1. Fork the repository and create a feature branch from `main`
2. Keep PRs small and focused — one logical change per PR
3. Include tests for new functionality
4. Fill out the [PR template](.github/PULL_REQUEST_TEMPLATE.md)
5. Ensure all checks pass: `pnpm test:all && pnpm run lint && pnpm run typecheck`

## Writing Plugins

The Engineer's plugin system lets you add new triggers, communication channels, LLM providers, tools, and git hosting integrations.

See [Plugin Development Guide](docs/plugin-development.md) for the full walkthrough.

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
- **Architecture:** Browse `implementation-docs/` for detailed design documentation
- **Plugin development:** See [docs/plugin-development.md](docs/plugin-development.md)
