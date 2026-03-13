# Phase R6: Plugin Discovery + Scaffolding + Hooks

---

## Worktree Setup (DO THIS FIRST)

This phase runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-R6 -b layer7/R6 main
cd ../engineer-R6
```

**Rules:**
- Work ONLY in this worktree (`../engineer-R6/`)
- Commit your changes to the `layer7/R6` branch
- Do NOT push — the merge prompt will collect this branch
- Do NOT modify files outside the scope listed in this prompt
- When done: commit, verify tests pass, stop. The merge wave handles the rest.

---

## Identity

You are an implementation agent for **The Engineer** -- an autonomous software engineering agent built in TypeScript/Node.js. You are executing Phase R6 of Layer 7 (Structural Restructuring). You operate with zero prior context. Everything you need is in this prompt.

Read `docs/persona.md` and `docs/philosophy.md` before starting -- they define who The Engineer is and how it thinks. Your work must embody those principles.

---

## Architecture Catchup

The Engineer is a three-tier system:

- **Core** (invariant brain): EventBus, TaskEngine, Orchestrator, Daemon, Registry, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager, PeopleDirectory
- **Adapters** (stable contracts): TriggerAdapter, CommunicationAdapter, LLMAdapter, ToolAdapter, GitHostingAdapter -- abstract base classes in `src/adapters/`
- **Plugins** (swappable implementations): GitHubTrigger, GitHubComm, GitHubHosting, TelegramComm, ClaudeCodeLLM, BashTool -- in `src/plugins/`

Tech stack: TypeScript (strict), Node.js 22 LTS, pnpm, ESM, SQLite (better-sqlite3), Zod, Vitest, Biome.

Plugin manifests use `engineer.plugin.yaml` files with schema defined in `src/schemas/adapters.ts` (`PluginManifestSchema`).

### Key Files to Read First

Read these files to understand the current state before making changes:

1. `src/core/registry/index.ts` -- Registry class: five-phase loading pipeline (discover, validate, order, load, initialize), programmatic register/deregister, health state machine
2. `src/cli/bootstrap.ts` -- Current hardcoded plugin wiring (BUILTIN_PLUGINS array with inline manifests, factory functions, manual config loading)
3. `src/schemas/adapters.ts` -- PluginManifestSchema (id, type, version, name, description, config_schema, critical, enabled, entry, adapter_meta)
4. `src/adapters/base.ts` -- BaseAdapter abstract class (manifest, hasCapability, lifecycle template methods)
5. `src/plugins/tool/bash-tool/` -- Example plugin structure (bash-tool.ts, config.ts, index.ts)
6. `src/plugins/trigger/github-trigger/` -- Example plugin structure with config
7. `src/cli/commands/init.ts` -- Template generation command (pattern for scaffolding)
8. `src/config/loader.ts` -- Config loading with env var resolution
9. `src/schemas/config.ts` -- All config schemas (DaemonConfigSchema, SafetyConfigSchema, etc.)
10. `implementation-docs/7-restructure/assessment.md` -- Problem: "Hardcoded plugin registration -- bootstrap.ts manually wires 6 plugins with inline manifests"
11. `implementation-docs/4-implementation/plugins.md` -- Plugin system design (Decisions #102-#108)
12. `implementation-docs/7-restructure/decisions.md` -- Decision log (D166+)

### Related Layer 7 Context

This phase runs in **Wave 3** (parallel with R5, R7, R8). It depends on Wave 1 (R0) and Wave 2 being complete. R0 provides shared interfaces; Wave 2 restructured Core components.

---

## Problem Statement

From the assessment:
> **Hardcoded plugin registration** -- `bootstrap.ts` manually wires 6 plugins with inline manifests.

Currently:
- `bootstrap.ts` has a `BUILTIN_PLUGINS` array with 6 entries, each containing an inline manifest object and a factory import
- Adding a new plugin requires editing `bootstrap.ts` -- no auto-discovery
- Plugin manifests are duplicated (inline in bootstrap.ts AND potentially in `engineer.plugin.yaml` files)
- No scaffolding command to create new plugins
- No hook system for plugin lifecycle events
- No config schema versioning (breaking config changes have no migration path)
- No CI pipeline

---

## Exact Specifications

### 1. Create `src/core/registry/plugin-discovery.ts`

Auto-discovery module that replaces manual plugin wiring in bootstrap.

```typescript
export interface DiscoveryOptions {
  /** Directories to scan for plugins. */
  dirs: string[];
  /** Whether to include built-in plugins from src/plugins/. */
  includeBuiltins: boolean;
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
  entryPath: string;
  isBuiltin: boolean;
}

/**
 * Scan directories for engineer.plugin.yaml files and return discovered plugins.
 *
 * Discovery order:
 * 1. Built-in plugins (src/plugins/) -- if includeBuiltins is true
 * 2. User plugin directories (from config daemon.plugins.dirs)
 * 3. ~/.engineer/plugins/ (user-installed plugins)
 *
 * Validates each manifest against PluginManifestSchema.
 * Skips disabled plugins (enabled: false).
 * Throws on duplicate plugin IDs across all directories.
 */
export function discoverPlugins(options: DiscoveryOptions): DiscoveredPlugin[];
```

### 2. Add `engineer.plugin.yaml` with `contributes` Section to Each Plugin

Each of the 6 built-in plugins must have a proper `engineer.plugin.yaml` file in its directory. Currently some may exist -- check each plugin directory. The manifest must match what's currently inline in `bootstrap.ts`.

Add a new optional `contributes` field to the manifest schema. Update `PluginManifestSchema` in `src/schemas/adapters.ts`:

```typescript
export const PluginManifestSchema = z.object({
  id: z.string(),
  type: AdapterTypeSchema,
  version: z.string(),
  name: z.string(),
  description: z.string(),
  config_schema: z.record(z.unknown()).default({}),
  critical: z.boolean().default(true),
  enabled: z.boolean().default(true),
  entry: z.string().default("index.ts"),
  adapter_meta: z.record(z.unknown()).default({}),
  // NEW: What this plugin contributes to the system
  contributes: z.object({
    events: z.array(z.string()).default([]),        // Event types this plugin may publish
    commands: z.array(z.string()).default([]),       // CLI commands this plugin adds
    config_keys: z.array(z.string()).default([]),    // Top-level config keys this plugin reads
    hooks: z.array(z.string()).default([]),          // Hooks this plugin implements
  }).default({}),
});
```

Create/update `engineer.plugin.yaml` in each plugin directory:
- `src/plugins/tool/bash-tool/engineer.plugin.yaml`
- `src/plugins/llm/claude-code-llm/engineer.plugin.yaml`
- `src/plugins/trigger/github-trigger/engineer.plugin.yaml`
- `src/plugins/communication/github-comm/engineer.plugin.yaml`
- `src/plugins/communication/telegram-comm/engineer.plugin.yaml`
- `src/plugins/git-hosting/github-hosting/engineer.plugin.yaml`

### 3. Create `src/cli/commands/create-plugin.ts`

Scaffolding command: `engineer create-plugin <name> --type <adapter-type>`

Generates a new plugin directory with:
- `engineer.plugin.yaml` (filled with provided name, type, version 0.1.0)
- `index.ts` (exports `createPlugin()` factory)
- `<name>.ts` (plugin class extending the correct adapter base class, with all abstract methods stubbed)
- `config.ts` (Zod config schema with empty object default)
- `<name>.test.ts` (test file importing the contract suite for the adapter type)

Output directory: the current working directory (or `--out <dir>` flag).

Register this command in `src/cli/index.ts` (the Commander program).

### 4. Create `src/core/hooks/` Hook System

A lightweight hook system that plugins can tap into for lifecycle events.

```typescript
// src/core/hooks/index.ts

/** Hook points in The Engineer lifecycle. */
export type HookPoint =
  | "pre:task:create"
  | "post:task:create"
  | "pre:task:transition"
  | "post:task:transition"
  | "pre:phase:start"
  | "post:phase:complete"
  | "pre:tool:execute"
  | "post:tool:execute"
  | "pre:publish"
  | "post:publish";

export interface HookContext {
  hookPoint: HookPoint;
  data: Record<string, unknown>;
  timestamp: string;
}

export type HookHandler = (context: HookContext) => Promise<void> | void;

export class HookRegistry {
  private hooks = new Map<HookPoint, Array<{ pluginId: string; handler: HookHandler }>>();

  /**
   * Register a hook handler for a specific hook point.
   * Multiple handlers can be registered for the same hook point.
   * Handlers execute in registration order.
   */
  register(pluginId: string, hookPoint: HookPoint, handler: HookHandler): void;

  /**
   * Remove all hooks registered by a specific plugin.
   */
  deregister(pluginId: string): void;

  /**
   * Execute all handlers for a hook point.
   * Handlers run sequentially in registration order.
   * If a handler throws, the error is logged and execution continues to the next handler.
   * "pre:" hooks can abort by throwing a specific HookAbortError.
   */
  async execute(hookPoint: HookPoint, data: Record<string, unknown>): Promise<void>;

  /**
   * Get all registered hook points and their handler counts.
   */
  getRegisteredHooks(): Map<HookPoint, number>;
}

export class HookAbortError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly reason: string,
  ) {
    super(`Hook aborted by ${pluginId}: ${reason}`);
    this.name = "HookAbortError";
  }
}
```

Wire the HookRegistry into bootstrap (create instance, pass to Registry so plugins can register hooks during initialization).

### 5. Config Schema Versioning

Add a `version` field to the top-level config structure.

In `src/schemas/config.ts`, add:

```typescript
export const ConfigVersionSchema = z.object({
  version: z.number().int().positive().default(1),
});
```

Modify the config loader (`src/config/loader.ts`) to:
1. Read the `version` field from the root config file
2. If no version field exists, assume version 1 (backward compatible)
3. If version is higher than the current supported version, emit a warning
4. Store the version in the ConfigBundle

Add a new CLI command: `engineer config migrate`
- Create `src/cli/commands/config-migrate.ts`
- Reads current config version
- Applies migration functions sequentially (version N to N+1)
- Writes the migrated config back
- For now, only version 1 exists -- the migration infrastructure is the deliverable, not actual migrations

Register the command in `src/cli/index.ts`.

### 6. CI Pipeline

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint -- --error-on-warnings
      - run: pnpm test
      - run: pnpm build
```

### 7. Modify `bootstrap.ts` to Use `discoverPlugins()`

Replace the `BUILTIN_PLUGINS` array and `loadBuiltinPlugins()` function with:

```typescript
import { discoverPlugins } from "../core/registry/plugin-discovery.js";

// In bootstrap():
const discovered = discoverPlugins({
  dirs: [
    join(engineerHome, "plugins"),
    ...config.daemon.plugins.dirs,
  ],
  includeBuiltins: true,
});

// Use Registry.loadFromDiscovered() or adapt the existing loadFromDirectories
for (const plugin of discovered) {
  const instance = (await import(plugin.entryPath) as { createPlugin: () => BaseAdapter }).createPlugin();
  registry.register(plugin.manifest, instance);

  const configPath = join(pluginConfigDir, `${plugin.manifest.id}.yaml`);
  const pluginConfig = loadPluginConfig(configPath, plugin.manifest.id, plugin.manifest.critical);
  if (pluginConfig === null) {
    registry.deregister(plugin.manifest.id);
    continue;
  }

  const result = await registry.initializePlugin(plugin.manifest.id, pluginConfig);
  if (!result.success && plugin.manifest.critical) {
    throw new Error(`Critical plugin "${plugin.manifest.id}" failed: ${result.message}`);
  }
  if (!result.success) {
    registry.deregister(plugin.manifest.id);
  }
}
```

Remove the hardcoded `BUILTIN_PLUGINS` array and all 6 manual import statements for plugin factories.

---

## Refinement Checklist

Before writing any code, verify:

- [ ] Read `src/cli/bootstrap.ts` completely -- understand every import and the BUILTIN_PLUGINS array
- [ ] Read `src/core/registry/index.ts` completely -- understand the five-phase pipeline and how it interacts with bootstrap
- [ ] Check each plugin directory for existing `engineer.plugin.yaml` files
- [ ] Read `src/cli/index.ts` to understand how CLI commands are registered
- [ ] Read `src/cli/commands/init.ts` as a pattern for scaffolding output
- [ ] Read `src/config/loader.ts` to understand config loading flow
- [ ] Read `implementation-docs/4-implementation/plugins.md` for design decisions #102-#108

During implementation:

- [ ] `discoverPlugins()` finds all 6 built-in plugins from `src/plugins/`
- [ ] Each `engineer.plugin.yaml` matches the manifest currently inline in bootstrap.ts
- [ ] `PluginManifestSchema` change is backward-compatible (contributes has defaults)
- [ ] `create-plugin` generates valid TypeScript that compiles
- [ ] `create-plugin` generated test file imports the correct contract suite from `test/helpers/contract-suites/`
- [ ] HookRegistry handles async handlers correctly
- [ ] HookAbortError on pre: hooks is distinguishable from regular errors
- [ ] Config version detection is backward-compatible (no version = version 1)
- [ ] Bootstrap refactor produces identical runtime behavior (same plugins loaded, same order)
- [ ] CI pipeline uses correct pnpm and Node versions from package.json

---

## Verification Steps

Run these commands after implementation:

```bash
# 1. Type check passes
pnpm typecheck

# 2. Lint passes
pnpm lint

# 3. All existing tests still pass
pnpm test

# 4. New tests pass
pnpm test -- --reporter=verbose src/core/registry/plugin-discovery.test.ts
pnpm test -- --reporter=verbose src/core/hooks/index.test.ts
pnpm test -- --reporter=verbose src/cli/commands/create-plugin.test.ts

# 5. Verify plugin manifests exist
find src/plugins -name "engineer.plugin.yaml" -type f

# 6. Verify bootstrap no longer has BUILTIN_PLUGINS
grep -c "BUILTIN_PLUGINS" src/cli/bootstrap.ts  # should be 0

# 7. Verify CI workflow exists
cat .github/workflows/ci.yml

# 8. Build succeeds
pnpm build
```

---

## Test Requirements

### `src/core/registry/plugin-discovery.test.ts`

1. **Discovery**: Finds plugins with valid `engineer.plugin.yaml` in scanned directories
2. **Skip disabled**: Plugins with `enabled: false` are skipped
3. **Duplicate detection**: Throws on duplicate plugin IDs across directories
4. **Invalid manifest**: Throws on malformed YAML or schema validation failure
5. **Missing entry**: Includes plugins even if entry file doesn't exist (validation happens later in Registry)
6. **Built-in discovery**: Finds all 6 built-in plugins when `includeBuiltins: true`

### `src/core/hooks/index.test.ts`

1. **Registration**: register adds handler, deregister removes all for a plugin
2. **Execution order**: Handlers execute in registration order
3. **Error isolation**: Handler errors are caught and don't prevent subsequent handlers
4. **Abort**: HookAbortError from pre: hook propagates (aborts the operation)
5. **Async handlers**: Async handlers are awaited correctly
6. **Empty hooks**: Executing a hook with no handlers is a no-op

### `src/cli/commands/create-plugin.test.ts`

1. **File generation**: Creates all expected files (manifest, index, plugin class, config, test)
2. **Correct adapter**: Generated class extends the correct base adapter for the given type
3. **Valid TypeScript**: Generated code passes basic syntax checks
4. **Manifest validity**: Generated manifest passes PluginManifestSchema validation

---

## Commit

When all verification passes, run `/commit` to stage and commit your changes.

---

## Constraints

- Do not change any existing plugin behavior -- only how they are discovered and registered
- The `contributes` field must be fully optional with defaults (backward compatible)
- Plugin loading order must remain: communication, llm, tool, git_hosting, trigger (TYPE_PRIORITY in Registry)
- Do not add external dependencies for the hook system or discovery -- pure TypeScript
- `chalk` or `ansi-colors` may be added for `create-plugin` output formatting (check if R7 adds it first; if not, add it)
- Biome lint must pass (`pnpm lint`)
- TypeScript strict mode must pass (`pnpm typecheck`)
- All existing tests must continue to pass
