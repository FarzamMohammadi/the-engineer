# Project Layout & Config System

Source directory structure, config file system, tooling configuration, and enforcement pipeline. These decisions determine the physical organization of the codebase and how quality is enforced.

Part of **Layer 4** — see [`../layers.md`](../layers.md). Built on technology choices from [`foundation.md`](foundation.md) and data schemas from [`schemas/`](schemas/).

---

## Source Directory Layout

Single package with monorepo-ready boundaries. All Zod schemas centralized in `src/schemas/`. The adapter interface layer (`src/adapters/`) is structured as the future `plugin-sdk` extraction point.

```
src/
  core/                              # Core tier (9 components)
    task-engine/
      index.ts
    orchestrator/
      index.ts
    daemon/
      index.ts
    safety-layer/
      index.ts
    session-memory/
      index.ts
    workspace-manager/
      index.ts
    event-bus/
      index.ts
    registry/
      index.ts
    people-directory/
      index.ts

  adapters/                          # Adapter tier (abstract classes + SDK boundary)
    base.ts                          # BaseAdapter abstract class (Decision #104)
    trigger.ts                       # TriggerAdapter abstract class
    communication.ts                 # CommunicationAdapter abstract class
    llm.ts                           # LLMAdapter abstract class
    tool.ts                          # ToolAdapter abstract class
    git-hosting.ts                   # GitHostingAdapter abstract class
    errors.ts                        # createAdapterError() helper (Decision #105)
    index.ts                         # Re-exports — curated plugin SDK boundary (Decision #105)

  plugins/                           # Plugin tier (grouped by adapter type, Decision #103)
    trigger/
      github-trigger/                # TriggerAdapter → GitHub polling
        engineer.plugin.yaml         # Plugin manifest (Decision #102)
        index.ts                     # createPlugin() factory
        github-trigger.ts            # Implementation
        config.ts                    # Zod config schema
    communication/
      telegram-comm/                 # CommunicationAdapter → Telegram
        engineer.plugin.yaml
        index.ts
        telegram-comm.ts
        config.ts
      github-comm/                   # CommunicationAdapter → GitHub
        engineer.plugin.yaml
        index.ts
        github-comm.ts
        config.ts
    llm/
      claude-code-llm/               # LLMAdapter → Claude Code CLI
        engineer.plugin.yaml
        index.ts
        claude-code-llm.ts
        config.ts
    tool/
      bash-tool/                     # ToolAdapter → shell execution
        engineer.plugin.yaml
        index.ts
        bash-tool.ts
        config.ts
    git-hosting/
      github-hosting/                # GitHostingAdapter → GitHub
        engineer.plugin.yaml
        index.ts
        github-hosting.ts
        config.ts

  schemas/                           # ALL Zod schemas (centralized)
    task.ts                          # Task, StateTransition, TaskState, SubState, etc.
    events.ts                        # EventEnvelope + 30 event payload schemas
    session-memory.ts                # Session, JournalEntry, Checkpoint, KnowledgeEntry
    adapters.ts                      # Adapter types, PluginManifest, PeopleDirectory
    orchestrator.ts                  # Phase outputs, CommEvent, DecompositionPlan
    ephemeral.ts                     # DaemonState, SafetyState, WorkspaceState
    config.ts                        # All config schemas (see schemas/config.md)

  db/                                # Database layer
    database.ts                      # Connection setup, WAL mode, prepared statements
    migrations/                      # Sequential SQL files
      001_initial.sql

  config/                            # Config system (loader, watcher)
    loader.ts                        # YAML parsing + Zod validation + env var resolution
    watcher.ts                       # File watcher for hot-reload (safety.yaml, people.yaml)

  index.ts                           # Entry point
```

### Why This Layout

**Single package for v1.** No pnpm workspaces, no build orchestration, no package versioning. The three tiers (Core / Adapter / Plugin) are directory boundaries, not package boundaries.

**`adapters/index.ts` as the plugin-sdk boundary.** This file re-exports everything a plugin author needs: adapter abstract classes, shared schemas, event types, error helpers. When the system grows to support third-party plugins, this becomes `packages/plugin-sdk/` — a move-and-rename, not a restructure. See [`../future-considerations.md`](../future-considerations.md) for the monorepo evolution path and [`plugins.md`](plugins.md) for the full SDK surface (Decision #105).

**Plugins grouped by adapter type.** Each plugin lives in `src/plugins/{adapter_type}/{plugin_name}/` with an `engineer.plugin.yaml` manifest, factory function, implementation class, and Zod config schema. Grouping mirrors the adapter contracts in `src/adapters/`, making the relationship visually clear (Decision #103).

**Centralized schemas in `src/schemas/`.** All Zod schemas live in one directory. Cross-component types (TaskSchema used by 5+ components) and component-internal types (DaemonState used only by Daemon) are all here. One place to find every type. Matches Session 24's schema directory organization.

**`config/` as its own concern.** The config system (YAML parsing, Zod validation, env var resolution, file watching) is separate from the schemas it validates. `config/loader.ts` uses schemas from `schemas/config.ts`.

---

## Config File System

### Decision #90: YAML for All Config Files

All config files use YAML (`.yaml` extension).

**Why YAML:**
- Deep nesting readability — SafetyConfig has 5 sections with sub-objects. YAML handles this cleanly.
- Comments — essential for config files. JSON is disqualified.
- Duration strings like `"4h"` read naturally in context.
- Parser: `yaml` npm package (battle-tested, used by OpenClaw).
- The "Norway problem" (`NO` → `false`) is irrelevant — Zod validates every field at load time.

**Alternatives rejected:**
- **JSON5** — OpenClaw uses it. Comments + trailing commas. But less readable for deep nesting.
- **TOML** — Explicit typing, but verbose for deep structures (`[section.subsection.field]` syntax).
- **JSON** — No comments. Unusable for config files humans edit.

### Decision #91: Multi-File Config Organization

Separate config files per concern. Each component's config lives in its own file.

```
~/.engineer/config/
  daemon.yaml              # Daemon tuning (tick, preemption, aging, trigger polling, shutdown, plugin lifecycle)
  orchestrator.yaml        # Fast-path, notification, question batching, decomposition, demo, phases
  safety.yaml              # Cost limits, scope, autonomy, response timeout, merge policy
  workspace.yaml           # Branch naming, PR defaults, cleanup, multi-repo
  people.yaml              # People Directory (contacts, preferences, roles)
  plugins/                 # Per-plugin config files
    github-trigger.yaml
    telegram-comm.yaml
    github-comm.yaml
    github-hosting.yaml
    claude-code-llm.yaml
    bash-tool.yaml
```

**Why multi-file:**
- Hot-reload precision — the watcher knows exactly which config changed, no need to re-parse everything.
- Separation of concerns — `safety.yaml` and `people.yaml` change independently from `daemon.yaml`.
- Plugin configs are naturally per-plugin.
- 6 files + a plugins directory is manageable.

**Alternatives rejected:**
- **Single file** (`engineer.yaml` with sections) — simpler to find everything, but hot-reload must re-parse the entire file and determine what changed.

### Decision #92: Config Location & Discovery

- **Default location:** `~/.engineer/config/`
- **Override:** `ENGINEER_CONFIG_DIR` environment variable
- **No merging, no layering, no per-project overrides for v1.** Fixed paths — `safety.yaml` is always the safety config at `{config_dir}/safety.yaml`.

---

## Config Loading Pipeline

### How Config Is Loaded

```
File on disk (.yaml)
  → Read file (fs.readFileSync)
  → Parse YAML (yaml package)
  → Resolve env vars (${ENV_VAR_NAME} → process.env[ENV_VAR_NAME])
  → Parse duration strings ("4h" → 14400000 via ms package)
  → Validate with Zod (.parse() on startup, .safeParse() on hot-reload)
  → Apply Zod .default() values for missing fields
  → Config object ready for use
```

### Decision #93: Defaults in Zod Schemas

Defaults live in Zod schemas via `.default()`. Config files only need to specify overrides. A missing config file means the system runs with all defaults — sensible behavior out of the box.

```typescript
// Schema defines defaults — config file only overrides what it needs
const DaemonConfigSchema = z.object({
  tick_interval_ms: z.number().int().positive().default(5000),
  // ...
});

// An empty daemon.yaml (or missing file) produces a valid config with all defaults.
```

### Decision #94: Hot-Reload Mechanism

**Hot-reloadable configs:**
- `safety.yaml` — Safety Layer config (per L2/L3 design)
- `people.yaml` — People Directory (per L3 adapter-contracts.md)

**Startup-only configs:**
- `daemon.yaml` — Changing tick intervals mid-operation is risky
- `orchestrator.yaml` — Phase behavior shouldn't change while tasks are active
- `workspace.yaml` — Branch naming conventions must be stable during operation

**Plugin configs:** Not hot-reloadable in v1. Changing plugin config requires shutdown + re-init via Registry.

**Mechanism:**
- `node:fs.watch()` on specific hot-reloadable files (not the entire directory)
- 500ms debounce to handle rapid saves (editor autosave, atomic write patterns)
- On valid change: replace in-memory config, emit `config.reloaded` event
- On invalid change: keep previous config, emit `config.reload_failed` event, alert human

### Decision #95: Config Error Handling

| Scenario | Behavior |
|----------|----------|
| Invalid config on startup | Refuse to start. Print clear Zod validation error with field path and expected type. |
| Missing config file on startup | Use all Zod defaults. System runs with sensible defaults out of the box. |
| Invalid config on hot-reload | Keep previous valid config. Emit alert event. Log Zod error details. |
| Missing env var reference | Fail at load time with clear error: `"${GITHUB_TOKEN}" references undefined environment variable "GITHUB_TOKEN"`. |

### Decision #96: Secrets via Environment Variables

Config files reference secrets using `${ENV_VAR_NAME}` syntax. Resolved at load time before Zod validation.

```yaml
# In safety.yaml — safe to commit to version control
api_key: ${GITHUB_TOKEN}
```

Config files never contain actual secrets. The env var resolution step replaces `${GITHUB_TOKEN}` with `process.env.GITHUB_TOKEN` before the YAML values reach Zod.

### Decision #97: Duration Parsing via `ms` Package

Human-readable duration strings (`"4h"`, `"30s"`, `"2m"`, `"1d"`) in config files are parsed to milliseconds at load time using the `ms` npm package.

```yaml
# In orchestrator.yaml — humans write:
notification:
  suppress_window: "5m"
  batch_window: "2m"
```

The config loader parses these to milliseconds before Zod validation. Internally, all durations are integers (per Decision #86). The `ms` package is tiny (~50 lines), zero dependencies, ~100M weekly downloads.

---

## Tooling Configuration

### Decision #98: tsconfig.json — Maximum Strictness

```jsonc
{
  "compilerOptions": {
    // Module system — ESM only (Decision #68)
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "verbatimModuleSyntax": true,

    // Strict type checking — ALL ON (Decision #89)
    "strict": true,                              // enables all strict family flags
    "noUncheckedIndexedAccess": true,            // array[i] → T | undefined
    "exactOptionalPropertyTypes": true,          // { x?: string } ≠ { x: undefined }
    "noPropertyAccessFromIndexSignature": true,  // forces record["key"] for index sigs
    "noFallthroughCasesInSwitch": true,

    // Delegated to Biome (faster feedback loop)
    // "noUnusedLocals": false,
    // "noUnusedParameters": false,

    // Build safety
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,                     // required for esbuild/tsdown

    // Output
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Key aggressive flags:**
- `noUncheckedIndexedAccess` — Every `array[i]` and `record[key]` returns `T | undefined`, forcing explicit undefined checks. Right for a safety-critical system where unchecked access causes runtime crashes.
- `exactOptionalPropertyTypes` — `{ x?: string }` only accepts `{}` (key absent) or `{ x: "value" }`, NOT `{ x: undefined }`. Prevents accidentally passing `undefined` where a missing key was intended.
- `noPropertyAccessFromIndexSignature` — Forces `record["key"]` instead of `record.key` when accessing index signatures. Makes it visually clear you're accessing a dynamic key, not a known property.

**Unused locals/parameters:** Delegated to Biome (faster, runs on staged files only in pre-commit). TypeScript's unused checks run over the entire project.

### Decision #99: Biome — `all` Preset, Strictest Enforcement

Start with Biome's `all` lint preset (every rule enabled) and carve specific exceptions as needed during implementation. This aligns with Decision #89 — strictest enforcement through tooling.

**Formatter settings:**
- Indent: 2 spaces
- Line width: 100 characters
- Trailing commas: `all`
- Semicolons: `always`
- Quote style: `double`

**Key lint rules:**
- `noExplicitAny`: **error** — non-negotiable for our contract-heavy architecture with 30 typed events, 5 adapter contracts, and typed state machine transitions.
- `noExcessiveCognitiveComplexity`: threshold 15 — enforces readable function decomposition.
- Import organization: auto-sort, grouped by external/internal.
- `useConst`, `noVar`: enforce `const` by default, `let` only when reassignment needed.

**Exceptions carved during implementation:** Starting with `all` means some rules won't apply to our patterns. Exceptions are added to `biome.json` with a comment explaining why. Every exception is intentional.

### Decision #100: lefthook for Git Hooks

lefthook manages pre-commit and pre-push hooks. Go binary — fast startup, no Node.js boot overhead.

**Why lefthook:**
- Go binary = instant hook startup (no `node` process spawn)
- YAML configuration (consistent with our config format choice)
- Supports parallel command execution
- Growing adoption, well-maintained

**Alternatives rejected:**
- **husky** — Most popular, but JS-based (slower startup), adds `.husky/` directory.
- **simple-git-hooks** — Minimal, but no parallel execution, limited features.

### Decision #101: Enforcement Pipeline (Decision #89 Detailed Design)

```yaml
# lefthook.yml

pre-commit:
  parallel: true
  commands:
    biome-check:
      run: pnpm biome check --staged    # lint + format on staged files only
    type-check:
      run: pnpm tsc --noEmit            # full type check (incremental)

pre-push:
  commands:
    test:
      run: pnpm vitest run              # full test suite
```

**What each hook enforces:**

| Hook | Tool | What It Catches |
|------|------|----------------|
| pre-commit | Biome | Formatting, unused imports, explicit `any`, dead code, style violations |
| pre-commit | tsc | Type errors, missing properties, wrong argument types, unchecked index access |
| pre-push | Vitest | Logic errors, broken contracts, regression bugs |

**Critical principle:** The Engineer (the agent) MUST NOT bypass hooks (`--no-verify`). If a hook fails, the agent fixes the issue and retries. This is the core enforcement mechanism from Decision #89 — automated tooling that agents cannot skip.

**Why type check in pre-commit:** tsc with `--noEmit` and incremental compilation is typically 2-5 seconds. This prevents committing code with type errors, which would accumulate across multiple commits and be harder to fix at pre-push time. Both Biome and tsc run in parallel.

---

## Dependencies Added This Session

| Package | Purpose | Category |
|---------|---------|----------|
| `yaml` | YAML parsing for config files | Runtime |
| `ms` | Duration string parsing (`"4h"` → 14400000) | Runtime |
| `lefthook` | Git hook management | Dev |

> These join the packages from Session 23: `better-sqlite3`, `zod`, `tsx`, `tsdown`, `@biomejs/biome`, `vitest`.
