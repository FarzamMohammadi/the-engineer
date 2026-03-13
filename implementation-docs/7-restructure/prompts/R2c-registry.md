# Phase R2c: Registry Decomposition

**Wave 2 (Parallel) -- Can run alongside R1, R2a, R2b, R3, R4.**

---

## Worktree Setup (DO THIS FIRST)

This phase runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-R2c -b layer7/R2c main
cd ../engineer-R2c
```

**Rules:**
- Work ONLY in this worktree (`../engineer-R2c/`)
- Commit your changes to the `layer7/R2c` branch
- Do NOT push — the merge prompt will collect this branch
- Do NOT modify files outside the scope listed in this prompt
- When done: commit, verify tests pass, stop. The merge wave handles the rest.

---

You are an autonomous software engineering agent working on The Engineer project. This prompt is fully self-contained -- you have zero prior context. Follow every step precisely.

---

## 1. Identity Preamble

Before making any changes, read these files to understand who The Engineer is:

- `docs/persona.md` -- The Engineer's identity and characteristics
- `docs/philosophy.md` -- Core beliefs: agent-agnostic protocol, minimalism, real engineer behavior, modular everything
- `implementation-docs/0-foundation/philosophy.md` -- Builder-specific principles (say it once, collaboration, no premature artifacts)

Internalize: The Engineer is the 100,000x engineer. Every line earns its place. Simplicity is the goal. Full names, no abbreviations.

---

## 2. Architecture Catchup

Read these docs to understand the system architecture relevant to this phase:

- `implementation-docs/1-system/overview.md` -- System overview, three-tier model
- `implementation-docs/1-system/architecture-tiers.md` -- Core / Adapter / Plugin tiers
- `implementation-docs/2-components/registry.md` (if it exists) -- Registry component design
- `implementation-docs/3-interactions/adapter-contracts.md` -- Adapter contracts including Registry
- `implementation-docs/4-implementation/plugins.md` -- Plugin system decisions (D102-D108)
- `implementation-docs/4-implementation/layout.md` -- Project layout conventions
- `implementation-docs/7-restructure/assessment.md` -- Layer 7 assessment (problems identified)
- `implementation-docs/7-restructure/decisions.md` -- Layer 7 decisions (D166+)

---

## 3. Decision Log Review

Read `implementation-docs/decisions.md` and understand these specific decisions:

- **D102**: Plugin manifests (`engineer.plugin.yaml`)
- **D103**: Five-phase loading pipeline (discover, validate, order, load, initialize)
- **D104**: Abstract class hierarchy (`BaseAdapter`)
- **D105**: Plugin health state machine (healthy/unhealthy/failed)
- **D106**: Curated SDK boundary
- **D124**: Factory function pattern (used by Daemon, relevant as a pattern)

Also check `implementation-docs/7-restructure/decisions.md` for any D166+ decisions that affect Registry decomposition.

---

## 4. Current Code Deep-Read

Read ALL of these files completely before making any changes:

### Source files
- `src/core/registry/index.ts` -- **The file being decomposed** (564 LOC, single `Registry` class)

### Schema files
- `src/schemas/adapters.ts` -- `AdapterType`, `PluginManifest`, `PluginManifestSchema`, `PluginHealthRecord`, `PluginHealthState`, `RegistrationResult`, `InitResult`

### Adapter base
- `src/adapters/base.ts` -- `BaseAdapter` abstract class

### Event Bus (dependency)
- `src/core/event-bus/index.ts` -- `EventBus` class, `publish()`, health event types

### Test files
- `src/core/registry/index.test.ts` -- All existing tests (86 tests)

### Test helpers
- `test/helpers/test-registry.ts` -- `createTestRegistry()` helper
- `test/helpers/mock-factories.ts` -- `createMockManifest()` and other factories
- `test/helpers/fake-plugins/` -- All fake plugin implementations

### Consumers (to understand the public API surface)
- `src/core/daemon/index.ts` -- Uses `registry.getPluginsByType()`, `registry.getPrimaryPlugin()`, `registry.startHealthCheckLoop()`, `registry.stopHealthCheckLoop()`, `registry.shutdownAll()`
- `src/core/orchestrator/index.ts` -- Uses `registry.getPrimaryPlugin()`, `registry.getPluginsByType()`
- `src/cli/bootstrap.ts` (if it exists, or find the bootstrap file) -- Uses `registry.register()`, `registry.loadFromDirectories()`

---

## 5. Exact Specifications

### Goal
Decompose the monolithic `Registry` class (564 LOC) into three focused modules while maintaining the same public API. The `Registry` class becomes a thin facade that delegates to subsystems.

### New file structure

```
src/core/registry/
  index.ts          -- Registry facade class (slim coordinator) + barrel exports
  discovery.ts      -- Plugin discovery as pure function
  lifecycle.ts      -- Plugin lifecycle management (register, deregister, initialize, shutdown)
  health.ts         -- Health monitoring subsystem (checks, state machine, loop)
  index.test.ts     -- Existing tests (update imports if needed)
```

### Module: `discovery.ts`

Extract the discovery/validation/ordering logic as **pure functions** (no class, no state):

```typescript
// Types
export interface DiscoveredManifest {
  manifest: PluginManifest;
  dir: string;
  entryPath: string;
}

// Pure functions
export function discoverPlugins(dirs: string[]): DiscoveredManifest[]
  // Recursively scans dirs for engineer.plugin.yaml files
  // Parses YAML, validates via PluginManifestSchema
  // Skips disabled plugins
  // Returns discovered manifests

export function validateDiscoveredPlugins(discovered: DiscoveredManifest[]): void
  // Checks unique IDs, semver versions, entry file existence
  // Throws on validation failure

export function orderByTypePriority(discovered: DiscoveredManifest[]): DiscoveredManifest[]
  // Sorts by TYPE_PRIORITY (communication=1, llm=2, tool=3, git_hosting=4, trigger=5)
  // Tiebreak: alphabetical by ID
```

Move the `TYPE_PRIORITY` constant, `SEMVER_REGEX`, and `MANIFEST_FILENAME` into this module. These are pure concerns of discovery.

### Module: `lifecycle.ts`

Extract plugin registration, initialization, and shutdown:

```typescript
export interface PluginRecord {
  manifest: PluginManifest;
  instance: BaseAdapter;
  health: PluginHealthRecord;
  initOrder: number;
}

export interface LifecycleManager {
  register(manifest: PluginManifest, instance: BaseAdapter): RegistrationResult;
  deregister(pluginId: string): void;
  initializePlugin(pluginId: string, config: Record<string, unknown>): Promise<InitResult>;
  initializeAll(configResolver: ConfigResolver): Promise<void>;
  loadModules(ordered: DiscoveredManifest[]): Promise<void>;
  shutdownAll(): Promise<void>;
  getPlugin<T extends BaseAdapter>(type: AdapterType, id: string): T | null;
  getPluginsByType<T extends BaseAdapter>(type: AdapterType): T[];
  getPrimaryPlugin<T extends BaseAdapter>(type: AdapterType): T | null;
  getManifest(pluginId: string): PluginManifest | null;
  getRecord(pluginId: string): PluginRecord | undefined;
  getAllRecords(): PluginRecord[];
}

export function createLifecycleManager(): LifecycleManager
```

This is a factory function returning an object (consistent with D124 pattern). It owns the `plugins: Map<string, PluginRecord>` state.

**Per-type cache improvement**: Add `Map<AdapterType, BaseAdapter[]>` that is invalidated on register/deregister. `getPluginsByType()` should check the cache first, build on miss. This avoids O(n) iteration on every `getPluginsByType()` call (which happens every tick in the Daemon).

### Module: `health.ts`

Extract health monitoring:

```typescript
export interface HealthMonitor {
  checkAll(): Promise<PluginHealthRecord[]>;
  getRecord(pluginId: string): PluginHealthRecord | null;
  getAllRecords(): PluginHealthRecord[];
  startLoop(): void;
  stopLoop(): void;
}

export interface HealthMonitorDeps {
  getRecords: () => PluginRecord[];
  eventBus: EventBus;
  healthCheckIntervalMs: number;
  healthCheckTimeoutMs: number;
  consecutiveFailuresThreshold: number;
}

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor
```

Move the health state machine (`handleHealthy`, `handleUnhealthy`), timeout helper (`withTimeout`), and health check loop into this module. The `getRecords` callback connects it to the lifecycle manager without a circular dependency.

### Updated `index.ts` (Registry facade)

The `Registry` class remains as the public API but becomes a thin facade:

```typescript
export class Registry {
  private readonly lifecycle: LifecycleManager;
  private readonly healthMonitor: HealthMonitor;
  private readonly eventBus: EventBus;

  constructor(options: RegistryOptions) {
    this.eventBus = options.eventBus;
    this.lifecycle = createLifecycleManager();
    this.healthMonitor = createHealthMonitor({
      getRecords: () => this.lifecycle.getAllRecords(),
      eventBus: this.eventBus,
      healthCheckIntervalMs: options.healthCheckIntervalMs ?? 60_000,
      healthCheckTimeoutMs: options.healthCheckTimeoutMs ?? 5_000,
      consecutiveFailuresThreshold: options.consecutiveFailuresThreshold ?? 3,
    });
  }

  // All public methods delegate to subsystems
  async loadFromDirectories(dirs, configResolver) {
    const discovered = discoverPlugins(dirs);
    if (discovered.length === 0) { console.log("..."); return; }
    validateDiscoveredPlugins(discovered);
    const ordered = orderByTypePriority(discovered);
    await this.lifecycle.loadModules(ordered);
    await this.lifecycle.initializeAll(configResolver);
  }

  register(m, i) { return this.lifecycle.register(m, i); }
  deregister(id) { this.lifecycle.deregister(id); }
  getPlugin(t, id) { return this.lifecycle.getPlugin(t, id); }
  getPluginsByType(t) { return this.lifecycle.getPluginsByType(t); }
  getPrimaryPlugin(t) { return this.lifecycle.getPrimaryPlugin(t); }
  getManifest(id) { return this.lifecycle.getManifest(id); }
  initializePlugin(id, cfg) { return this.lifecycle.initializePlugin(id, cfg); }
  shutdownAll() { this.healthMonitor.stopLoop(); return this.lifecycle.shutdownAll(); }
  healthCheckAll() { return this.healthMonitor.checkAll(); }
  getHealthRecord(id) { return this.healthMonitor.getRecord(id); }
  getAllHealthRecords() { return this.healthMonitor.getAllRecords(); }
  startHealthCheckLoop() { this.healthMonitor.startLoop(); }
  stopHealthCheckLoop() { this.healthMonitor.stopLoop(); }
}
```

**Critical**: The public API (method signatures, return types, behavior) MUST NOT change. All existing consumers must work without modification.

### Barrel exports from `index.ts`

Re-export from the new modules:

```typescript
export { discoverPlugins, validateDiscoveredPlugins, orderByTypePriority } from "./discovery.js";
export type { DiscoveredManifest } from "./discovery.js";
export type { PluginRecord, LifecycleManager } from "./lifecycle.js";
export type { HealthMonitor } from "./health.js";
```

Keep existing exports: `Registry`, `RegistryOptions`, `ConfigResolver`.

---

## 6. Refinement Checklist

Apply these improvements during the decomposition:

- [ ] **Per-type cache**: `getPluginsByType()` uses `Map<AdapterType, BaseAdapter[]>` cache, invalidated on register/deregister
- [ ] **Discovery as pure function**: No `this` binding, no class, easily testable in isolation
- [ ] **Console.log to structured logging**: Replace bare `console.log/warn/error` calls with a `log` parameter or keep as-is (console is the pattern used in Registry today -- match existing convention, do not introduce pino dependency here since Registry doesn't receive a logger)
- [ ] **Defensive copies**: `getAllRecords()` returns copies, not references (already done for health records, extend to plugin records)
- [ ] **Type narrowing**: Ensure TypeScript narrows `PluginRecord` fields correctly in the new module boundaries
- [ ] **No circular imports**: `health.ts` depends on `lifecycle.ts` types only via the `getRecords` callback, NOT via direct import of the lifecycle module

---

## 7. Verification Steps

After completing all changes, run these commands and verify they pass:

```bash
# 1. Type check
pnpm tsc --noEmit

# 2. Run Registry unit tests
pnpm vitest run src/core/registry/

# 3. Run full test suite to catch any consumer breakage
pnpm vitest run

# 4. Biome lint + format
pnpm biome check --write .

# 5. Verify no new lint errors
pnpm biome check .
```

All existing tests (86 Registry tests + all consumer tests) MUST pass without modification to test assertions. If any test imports internal types that moved, update the imports only.

Additionally, write NEW tests for the extracted modules:

- `src/core/registry/discovery.test.ts` -- Test `discoverPlugins`, `validateDiscoveredPlugins`, `orderByTypePriority` as pure functions (at least 10 tests)
- `src/core/registry/lifecycle.test.ts` -- Test `createLifecycleManager()` independently, including per-type cache behavior (at least 8 tests)
- `src/core/registry/health.test.ts` -- Test `createHealthMonitor()` independently, including state machine transitions (at least 8 tests)

---

## Commit

When all verification passes, run `/commit` to stage and commit your changes.
