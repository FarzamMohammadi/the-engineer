# Testing Strategy

Multi-tier test architecture for The Engineer. Validates everything from individual schema parsers to full daemon lifecycles, without requiring external services or paid infrastructure.

Part of **Layer 4** — see [`../layers.md`](../layers.md). Built on Vitest (Decision #73) from [`foundation.md`](foundation.md), project layout from [`layout.md`](layout.md), and plugin system from [`plugins.md`](plugins.md).

**Reference project:** [OpenClaw](https://github.com/openclaw/openclaw) — validated several testing patterns during evaluation. See [`openclaw-review.md`](openclaw-review.md) for full comparison.

---

## Test Architecture Summary

| Tier | Config | Pool | Scope | Typical Runtime |
|------|--------|------|-------|-----------------|
| Unit | `vitest.config.ts` | `forks` | Component logic, schemas, state machines | < 15s |
| Integration | `vitest.integration.config.ts` | `forks` | Cross-component interactions with fake plugins | 30-60s |
| E2E | `vitest.e2e.config.ts` | `forks` | Full daemon lifecycle with in-process control | 1-3 min |

All tiers extend `vitest.shared.ts` for common settings. Coverage enforced on unit tests only (70% lines, 55% branches). Boundary enforcement tests verify three-tier architecture at test time.

---

## Multi-Tier Vitest Configuration

### Decision #119: Three-Tier Vitest Configs

Three config files organized by test type:

| Config | File | Includes | Excludes |
|--------|------|----------|----------|
| Unit | `vitest.config.ts` | `src/**/*.test.ts`, `test/boundary/**/*.test.ts` | `*.integration.test.ts`, `*.e2e.test.ts` |
| Integration | `vitest.integration.config.ts` | `test/integration/**/*.integration.test.ts` | — |
| E2E | `vitest.e2e.config.ts` | `test/e2e/**/*.e2e.test.ts` | — |

**Shared base (`vitest.shared.ts`):**
- TypeScript transform via esbuild
- Path aliases matching `tsconfig.json`
- `unstubEnvs: true` — scopes `vi.stubEnv()` to individual tests
- `unstubGlobals: true` — prevents cross-test pollution
- Setup file: `test/setup.ts`

**Pool: `forks` globally.** OpenClaw uses `forks` everywhere — they learned that `vmForks` leaks module state/mocks across files, and `better-sqlite3` native bindings aren't thread-safe across workers. Safety over speed.

**Worker scaling** (adopted from OpenClaw):
- Local: `Math.max(4, Math.min(16, os.cpus().length))` — aggressive
- CI: `Math.min(2, Math.max(1, Math.floor(cpuCount * 0.25)))` — conservative
- E2E: 1 by default, configurable via `ENGINEER_E2E_WORKERS` env var

**package.json scripts:**

```json
{
  "test":             "vitest run",
  "test:unit":        "vitest run",
  "test:integration": "vitest run -c vitest.integration.config.ts",
  "test:e2e":         "vitest run -c vitest.e2e.config.ts",
  "test:all":         "pnpm test && pnpm test:integration && pnpm test:e2e",
  "test:watch":       "vitest",
  "test:coverage":    "vitest run --coverage"
}
```

**Amendment to Decision #101** (enforcement pipeline): The pre-push hook runs `pnpm test` (unit tests only). This keeps pre-push fast (< 15 seconds). Integration and E2E tests run in CI or manually via `pnpm test:integration` and `pnpm test:e2e`.

```yaml
# lefthook.yml (updated)

pre-commit:
  parallel: true
  commands:
    biome-check:
      run: pnpm biome check --staged
    type-check:
      run: pnpm tsc --noEmit

pre-push:
  commands:
    test:
      run: pnpm test              # unit tests only (fast, < 15s)
```

**Why test-type tiers, not domain slices:** OpenClaw uses 7 configs organized by subsystem (channels, gateway, extensions) because they have 40+ channel implementations. Our system has ~6 plugins total — a single daemon with a clean three-tier architecture. Test-type tiers match our three architectural boundaries: within a component (unit), across components (integration), full system (e2e).

**Alternatives rejected:**
- **Domain-scoped configs** (OpenClaw style) — over-segmentation for our scale. Can be added later if plugins grow significantly.
- **Vitest workspaces** — relevant for monorepo with multiple packages, not for a single package.
- **Two tiers** (unit + e2e only) — missing integration tier means unit tests grow too complex or e2e is the only way to catch interaction bugs.

**Future path:**
- When the project becomes a monorepo, each package gets its own `vitest.config.ts` with a root `vitest.workspace.ts` to orchestrate.
- A `vitest.live.config.ts` can be added for tests against real external APIs, gated behind `ENGINEER_LIVE_TESTS=1`.

---

## Test Directory Structure

### Decision #120: Hybrid — Co-located Units, Separate Cross-cutting

Unit tests live next to their source files. Integration, E2E, boundary tests, and shared infrastructure live in a top-level `test/` directory.

```
src/
  core/
    task-engine/
      index.ts
      index.test.ts              # unit test, co-located
    orchestrator/
      index.ts
      index.test.ts
    event-bus/
      index.ts
      index.test.ts
    safety-layer/
      index.ts
      index.test.ts
    ...
  adapters/
    base.ts
    base.test.ts
    trigger.ts
    errors.ts
    errors.test.ts
  plugins/
    trigger/
      github-trigger/
        github-trigger.ts
        github-trigger.test.ts   # plugin unit test (contract suite + specific)
        config.ts
        config.test.ts           # schema validation test
    ...
  schemas/
    task.ts
    task.test.ts                 # schema parsing + edge case tests
    events.ts
    events.test.ts
  db/
    database.ts
    database.test.ts
  config/
    loader.ts
    loader.test.ts

test/                            # cross-cutting tests + shared infrastructure
  integration/
    registry-plugin-loading.integration.test.ts
    daemon-trigger-polling.integration.test.ts
    task-lifecycle.integration.test.ts
    config-hot-reload.integration.test.ts
    event-bus-delivery.integration.test.ts
    health-state-machine.integration.test.ts
  e2e/
    daemon-lifecycle.e2e.test.ts
    task-happy-path.e2e.test.ts
    crash-recovery.e2e.test.ts
  boundary/
    tier-import-rules.test.ts    # architectural boundary enforcement (Decision #125)
  fixtures/
    configs/                     # test YAML config files (valid + invalid)
    manifests/                   # test plugin manifests (valid + invalid)
    contracts/                   # golden JSON for security-critical shapes
  helpers/
    mock-factories.ts            # createMockManifest(), createMockTriggerEvent(), etc.
    test-database.ts             # in-memory SQLite setup/teardown
    test-registry.ts             # shared immutable Registry with fake plugins
    test-event-bus.ts            # EventBus with assertion helpers
    fake-clock.ts                # injectable clock for time-dependent tests
    contract-suites/             # adapter contract compliance suites
      trigger-contract.ts
      communication-contract.ts
      llm-contract.ts
      tool-contract.ts
      git-hosting-contract.ts
    fake-plugins/                # minimal complete adapter implementations
      fake-trigger/
        engineer.plugin.yaml
        index.ts
      fake-comm/
        engineer.plugin.yaml
        index.ts
      fake-llm/
        engineer.plugin.yaml
        index.ts
      fake-tool/
        engineer.plugin.yaml
        index.ts
      fake-git-hosting/
        engineer.plugin.yaml
        index.ts
  setup.ts                       # global setup (isolated test home, shared registry)
```

**File naming conventions:**
- `*.test.ts` — unit tests (co-located with source, picked up by default config)
- `*.integration.test.ts` — integration tests (in `test/integration/`)
- `*.e2e.test.ts` — end-to-end tests (in `test/e2e/`)

**Why hybrid:**
- **Co-located unit tests** are immediately findable. Change `task-engine/index.ts` → its test is right there. Standard Vitest/TypeScript convention.
- **Separate integration/e2e** can't be co-located — they span multiple components. A test exercising Registry + Daemon + triggers doesn't belong next to any single component.
- **Shared helpers** (`test/helpers/`) are used by all tiers: mock factories, test database, fake plugins, contract suites.

**Alternatives rejected:**
- **Pure co-location** — integration tests span components; placing them next to one component is arbitrary.
- **Pure separation** (`test/unit/core/task-engine.test.ts`) — duplicates source tree structure, extra cognitive overhead.
- **`__tests__/` directories** — adds nesting without benefit. Jest convention, not Vitest.

---

## Coverage Strategy

### Decision #121: Pragmatic Exclusion

**Adopted from OpenClaw:** `coverage.all: false` — only files that tests actually exercise count toward thresholds. Code validated by integration/e2e/manual testing is excluded from coverage measurement. This prevents gaming and focuses thresholds on code where unit test coverage actually matters.

**Global thresholds (unit tests only):**

| Metric | Threshold |
|--------|-----------|
| Lines | 70% |
| Branches | 55% |
| Functions | 70% |
| Statements | 70% |

These numbers are validated by OpenClaw's production codebase (same thresholds, same provider).

**Coverage provider:** `v8` (Vitest built-in, faster than Istanbul, works with native ESM).

**Conceptual Vitest coverage config:**

```typescript
coverage: {
  provider: "v8",
  reporter: ["text", "lcov"],
  all: false,
  thresholds: {
    lines: 70,
    functions: 70,
    branches: 55,
    statements: 70,
  },
  include: ["src/**/*.ts"],
  exclude: [
    // Entry points and wiring — validated by e2e/manual
    "src/index.ts",
    "src/cli/**",

    // Process lifecycle — validated by e2e tests
    "src/core/daemon/**",

    // Plugin implementations — validated by contract suites + integration tests
    "src/plugins/**",

    // File system interactions — validated by integration tests
    "src/config/watcher.ts",

    // SQL migration files — validated by integration tests
    "src/db/migrations/**",

    // Test infrastructure
    "test/**",
    "src/**/*.test.ts",
  ],
}
```

**What IS covered** (and matters most):
- `src/schemas/**` — contract layer, every validation path matters
- `src/core/task-engine/**` — state machine correctness is safety-critical
- `src/core/event-bus/**` — delivery guarantees
- `src/adapters/**` — SDK boundary, abstract classes
- `src/core/safety-layer/**` — security boundary
- `src/core/orchestrator/**` — phase pipeline logic
- `src/config/loader.ts` — config parsing logic

**Where enforced:**
- `pnpm test:coverage` — local, on demand
- CI pipeline (future) — required to pass on PRs
- NOT in pre-push hook — coverage analysis adds 5-10 seconds

**Ratcheting:** Manual. When coverage naturally exceeds thresholds (e.g., lines hit 78% when threshold is 70%), bump the threshold during periodic reviews. No automated ratchet tool — it creates a one-way trap during legitimate refactoring that temporarily drops coverage.

**Alternatives rejected:**
- **`all: true`** — forces writing pointless tests for CLI wiring and daemon process management.
- **Per-directory thresholds** — too granular to maintain, risks coverage gaming on hard-to-test code.
- **No thresholds** — coverage drifts downward. Especially dangerous when an AI agent generates code.
- **Coverage in pre-push hook** — adds 5-10s, pushes hook over 15s, risks developers bypassing it.

---

## Plugin Contract Compliance Testing

### Decision #122: Abstract Contract Test Suites

Contract test suites verify that plugins correctly implement adapter behavioral contracts — not just type signatures (TypeScript handles that), but behavioral expectations that the type system can't express.

**What TypeScript can't catch:**
- `poll()` returns `TriggerEvent[]` with stable, unique idempotency keys
- `initialize()` with invalid config returns `InitResult { success: false }` — doesn't throw
- `healthCheck()` resolves within the configured timeout (default 5s)
- `complete()` always includes usage data in its response (cost tracking is non-negotiable)
- Methods that fail return `AdapterError` with proper fields, not raw exceptions
- `execute()` reports side effects in its `ToolResult` (mandatory per adapter contract)

**One suite per adapter type** in `test/helpers/contract-suites/`:

| Suite | Tests |
|-------|-------|
| `trigger-contract.ts` | poll behavior, idempotency keys, event schema compliance |
| `communication-contract.ts` | sendMessage, formatMessage, capability-gated optional methods |
| `llm-contract.ts` | complete, getCapabilities, usage reporting |
| `tool-contract.ts` | describe, execute, side effects reporting |
| `git-hosting-contract.ts` | PR lifecycle methods (create, update, merge, close) |

**How plugin authors use them:**

```typescript
// src/plugins/trigger/github-trigger/github-trigger.test.ts
import { runTriggerContractSuite } from "test/helpers/contract-suites/trigger-contract.ts";
import { GitHubTriggerPlugin } from "./github-trigger.ts";

// Contract compliance — verifies behavioral expectations
runTriggerContractSuite(() => new GitHubTriggerPlugin(), {
  validConfig: { repos: [{ owner: "test", name: "repo" }], poll_interval: "30s" },
  invalidConfig: { repos: "not-an-array" },
});

// Plugin-specific tests
describe("GitHubTriggerPlugin", () => {
  it("parses GitHub issue payload correctly", /* ... */);
  it("generates stable idempotency key from issue ID + repo", /* ... */);
});
```

**Each contract suite tests:**

1. **Lifecycle compliance:**
   - `initialize()` with valid config returns `{ success: true }`
   - `initialize()` with invalid config returns `{ success: false }` (no throw)
   - `healthCheck()` returns `HealthStatus` with required fields
   - `healthCheck()` resolves within 5 seconds
   - `shutdown()` resolves without throwing

2. **Method contracts:**
   - Primary method returns valid schema-compliant data
   - Error responses use `AdapterError` (not raw exceptions)
   - `AdapterError` includes `code`, `retryable`, `severity`

3. **Type-specific behavioral rules:**
   - Triggers: idempotency keys are stable across calls, events validate against schema
   - LLM: usage data is always present (non-null `input_tokens`, `output_tokens`)
   - Tools: side effects are reported in result
   - Communication: `formatMessage()` produces valid message format

**Mock factories** in `test/helpers/mock-factories.ts`:

```typescript
export function createMockManifest(overrides?: Partial<PluginManifest>): PluginManifest;
export function createMockTriggerEvent(overrides?: Partial<TriggerEvent>): TriggerEvent;
export function createMockCompletionRequest(overrides?: Partial<CompletionRequest>): CompletionRequest;
export function createMockToolResult(overrides?: Partial<ToolResult>): ToolResult;
export function createMockAdapterError(overrides?: Partial<AdapterError>): AdapterError;
```

Factories use Zod schemas to generate valid defaults — mocks are always schema-compliant.

**Contract fixture files** in `test/fixtures/contracts/`: Golden JSON files for security-critical shapes. Adopted from OpenClaw's `system-run-command-contract.json` pattern. Any change to these shapes requires explicit acknowledgment — prevents accidental contract drift.

**Future path:** When `plugin-sdk` becomes a separate package, contract suites move into it. Third-party plugin authors install `@the-engineer/plugin-sdk` and get both adapter abstract classes AND contract test suites. "Passes all contract tests" = certified compatible with The Engineer.

---

## Integration Test Strategy

### Decision #123: Real Core + Fake Plugins

Integration tests exercise cross-component interactions using real Core components wired together, with plugins replaced by lightweight fakes. **The Registry is the primary testing seam** — the boundary between Core and plugins.

**What "integration" means for this system:** Two or more real Core components interact through their real interfaces. Components are NOT mocked — they are real instances with real logic. What IS faked:
- All plugins → replaced by fake implementations with controllable behavior
- External I/O → no network calls, no filesystem except temp directories
- SQLite → fresh in-memory database (`:memory:`) per test

**Shared test registry** (adopted from OpenClaw's `test/setup.ts` pattern): An immutable default Registry pre-loaded with fake plugins, created once and shared across all tests. Tests that need different plugin behavior override the registry and restore it in `afterEach`. Performance-conscious — no per-test registry rebuilds.

```typescript
// test/setup.ts (conceptual)
const DEFAULT_REGISTRY = createTestRegistry([
  { type: "trigger", plugin: new FakeTriggerPlugin() },
  { type: "communication", plugin: new FakeCommunicationPlugin() },
  { type: "llm", plugin: new FakeLLMPlugin() },
  { type: "tool", plugin: new FakeToolPlugin() },
  { type: "git-hosting", plugin: new FakeGitHostingPlugin() },
]);

beforeAll(() => setActiveRegistry(DEFAULT_REGISTRY));
afterEach(() => {
  if (getActiveRegistry() !== DEFAULT_REGISTRY) {
    setActiveRegistry(DEFAULT_REGISTRY);
  }
  if (vi.isFakeTimers()) vi.useRealTimers();
});
```

**Fake plugins vs mocks:** Fakes are minimal complete adapter implementations. They pass the contract compliance suites (Decision #122). They provide working behavior, not call verification:

| Fake | Behavior |
|------|----------|
| `FakeTriggerPlugin` | Returns configurable `TriggerEvent[]`. Can be told to "fail next poll" or "throw on health check." |
| `FakeCommunicationPlugin` | Records all messages sent. `sendMessage()` always succeeds. Assertion: "was this message sent?" |
| `FakeLLMPlugin` | Returns canned `CompletionResult` per phase. Configurable latency. Always reports usage. |
| `FakeToolPlugin` | Records all executed actions. Returns configurable `ToolResult`. Always reports side effects. |
| `FakeGitHostingPlugin` | In-memory PR tracking. `createPR()` stores in a map, `getPRStatus()` reads from it. |

Why fakes over mocks: When a mock returns `undefined` because you forgot to configure it, the test passes silently. A fake returns a schema-valid default, exercising the real downstream code path. **Unit tests use mocks (`vi.fn()`); integration tests use fakes.**

**Integration test categories:**

| Category | Components Involved | What It Validates |
|----------|-------------------|-------------------|
| Plugin loading pipeline | Registry + filesystem + manifest parsing | Five-phase loading sequence (discover → validate → order → load → initialize) |
| Daemon trigger polling | Daemon + Registry + FakeTrigger | Tick loop calls `poll()`, deduplicates via idempotency keys, routes events |
| Task lifecycle | Task Engine + Event Bus + Daemon | Task creation, state transitions, event emission per transition |
| Orchestrator execution | Orchestrator + FakeLLM + FakeTool + Safety Layer | Phase pipeline, action gates (Gate 1 + Gate 2), notification flow |
| Config hot-reload | Config loader + watcher + Safety Layer | File change triggers reload, Safety Layer picks up new limits |
| Event Bus delivery | Event Bus + multiple Core subscribers | Events reach all subscribers, ordering preserved, at-least-once delivery |
| Health monitoring | Registry + controllable-health fake | State machine: healthy → unhealthy → failed → recovered. Type-specific responses. |

**Test database helper:**

```typescript
// test/helpers/test-database.ts (conceptual)
export async function createTestDatabase(): Promise<{
  db: Database;
  cleanup: () => void;
}> {
  const db = new Database(":memory:");
  // Run all migrations
  // Return connection + cleanup function
}
```

`:memory:` for most tests. Temp file when testing persistence across daemon restart.

---

## E2E Test Approach

### Decision #124: In-Process Daemon with Injectable Clock

E2E tests exercise the full daemon lifecycle — from startup through task processing to shutdown — with all external services replaced by in-process fakes.

**In-process daemon (not forked):** The daemon's entry point is structured as `createDaemon(config)` returning a `Daemon` object with `start()`, `stop()`, and `tick()` methods. The CLI (`cli/commands/start.ts`) handles foreground/background modes. Tests call `createDaemon()` directly.

This architecture gives tests:
- Direct access to internal state for assertions
- Ability to inject fake plugins before the daemon starts
- Synchronous tick control (advance one tick, assert, advance another)
- No port conflicts, no PID file management, no signal delivery complexity

**Injectable clock** (inspired by OpenClaw's `useFastShortTimeouts`): The daemon's tick loop and all timers (health check intervals, poll intervals, stuck detection) use an injectable clock. In production, the clock is `Date.now()`. In tests, it's a controllable fake:

```typescript
// test/helpers/fake-clock.ts (conceptual)
class FakeClock {
  private now: number = 0;
  advance(ms: number): void { this.now += ms; }
  current(): number { return this.now; }
}
```

This eliminates `setTimeout`/`setInterval` flakiness. Instead of waiting 60 real seconds for a health check, tests advance the clock by 60,000ms and verify the check ran.

**Key E2E scenarios** (mapped to lifecycle traces from Layer 3):

| Scenario | Maps To | What It Validates |
|----------|---------|-------------------|
| Happy path: issue → PR | Lifecycle Trace 1 | Trigger fires, task created, all 7 Orchestrator phases, PR created, task completed |
| Task decomposition | Lifecycle Trace 2 | Parent task decomposes into subtasks, subtasks execute, progressive merge |
| Crash recovery | Lifecycle Trace 3, P15 | Daemon stops mid-task, restarts, resumes from checkpoint |
| Preemption | P8 + P9 | Higher-priority task arrives, current task checkpointed and preempted |
| Cost limit breach | P10 (cost chain) | Task approaches cost limit, Safety Layer blocks further LLM calls |
| Plugin failure | Decision #106 | Plugin health degrades, system responds per type-specific rules |
| Graceful shutdown | P15, Decision #112 | SIGTERM during active work → checkpoint → clean exit |

**External dependency strategy:**

| Dependency | Strategy |
|------------|----------|
| GitHub API | FakeTriggerPlugin + FakeGitHostingPlugin (no HTTP calls) |
| Telegram API | FakeCommunicationPlugin (records messages) |
| LLM provider | FakeLLMPlugin (canned completions per phase) |
| Git | Real git (temp repos — local binary, deterministic behavior) |
| SQLite | In-memory or temp file (per test) |
| Filesystem | Temp directories, `ENGINEER_HOME` per test (cleaned up after) |

**Why real git:** Git is a local binary with deterministic behavior. Faking it would mean re-implementing git semantics (branches, merges, worktrees). Using real git in temp directories is simpler and more accurate. The Workspace Manager's worktree creation, branch naming, and cleanup are only meaningfully testable with real git.

**Test config:** Minimal YAML configs generated into a temp directory per test. Config values tuned for testing:
- `tick_interval_ms: 0` (no delay between ticks)
- `health_check_interval_ms: 1000` (short, controlled by fake clock)
- `shutdown_timeout_ms: 5000` (short for fast teardown)
- All plugins configured with fake/test credentials

**Alternatives rejected:**
- **Forked process E2E** (spawn `engineer start` as child process) — no internal observability, can't inject fakes, signal delivery is OS-dependent and flaky. Useful as a future smoke test for the actual binary, not as primary E2E strategy.
- **Docker-based** (real GitHub/Telegram/LLM in containers) — violates cost-conscious constraint, slow, complex, flaky.
- **Record/replay** (record real API responses, replay in tests) — maintenance burden (recordings go stale), doesn't test failure conditions.

---

## Architectural Boundary Enforcement

### Decision #125: Three-Tier Import Rules

Tests that verify the three-tier architecture (Core / Adapter / Plugin) is maintained at the import level. No cross-tier leaks.

**Adopted from OpenClaw's `check-channel-agnostic-boundaries.test.ts` pattern.** They use scripts that parse source code and flag forbidden import patterns. We apply the same idea to our three-tier model.

**Rules enforced:**

| Rule | Description |
|------|-------------|
| Plugin → SDK only | Files in `src/plugins/**` may only import from `src/adapters/index.ts` (SDK boundary), `src/schemas/**`, and external packages. Never from `src/core/**`. |
| Adapter → no plugins | Files in `src/adapters/**` never import from `src/plugins/**`. |
| Core → no plugins | Files in `src/core/**` never import from `src/plugins/**` directly. Core interacts with plugins through Registry. |
| No circular tiers | Import direction: Plugin → Adapter → Core. Never reverse. |

**Implementation:** A test in `test/boundary/tier-import-rules.test.ts` that:
1. Globs all `.ts` files (excluding tests) in each tier directory
2. Parses import/export statements (regex matching `from "..."` and `import(...)`)
3. Classifies each import as core, adapter, plugin, schema, or external
4. Asserts no forbidden cross-tier imports exist
5. Reports exact file:line for violations

**Why not Biome:** Biome's `noRestrictedImports` rule works on individual files with static patterns. Our boundaries are directory-based rules that need contextual logic: "any file in `src/plugins/**` must not import any file matching `src/core/**`." A custom test is more expressive, self-documenting, and can provide better error messages.

**Why this matters:** The SDK boundary (`src/adapters/index.ts`) is the contract surface for plugins. If a plugin imports Core internals, it creates a hidden coupling that breaks when Core is refactored. This test catches that at unit-test time, before the coupling becomes established.

**Future path:** These tests become critical when third-party plugins exist. They guarantee the SDK boundary is real — plugins can only use what's exported through the curated re-export.

---

## Test Infrastructure

### Test Setup (`test/setup.ts`)

Global setup that runs before all test files:

1. **Isolated test home** — sets `ENGINEER_HOME` to a temp directory, prevents tests from touching the real `~/.engineer/`
2. **Shared plugin registry** — creates an immutable default Registry with fake plugins (see Decision #123)
3. **Cleanup guards** — restores registry if overridden, restores real timers if fakes leaked

Adopted from OpenClaw's `test/setup.ts` pattern. Their setup creates a shared registry once, restores it in `afterEach`, and guards against leaked fake timers.

### Test Helpers

| Helper | Purpose |
|--------|---------|
| `mock-factories.ts` | Schema-compliant mock object factories (uses Zod to generate valid defaults) |
| `test-database.ts` | In-memory SQLite setup, migration runner, cleanup |
| `test-registry.ts` | `createTestRegistry()` factory, pre-loaded with fake plugins |
| `test-event-bus.ts` | EventBus with collection helpers: `getEmittedEvents()`, `waitForEvent()` |
| `fake-clock.ts` | Injectable clock for deterministic time control |

### Test Fixtures

| Directory | Contents |
|-----------|----------|
| `fixtures/configs/` | YAML config files — valid, invalid, minimal, edge cases |
| `fixtures/manifests/` | Plugin manifest files — valid, invalid, missing fields |
| `fixtures/contracts/` | Golden JSON files for security-critical shapes (AdapterError, event payloads) |

### Fake Plugins

Each fake plugin in `test/helpers/fake-plugins/` is a minimal complete adapter implementation:
- Has a real `engineer.plugin.yaml` manifest
- Has a `createPlugin()` factory function
- Passes the contract compliance suite for its adapter type
- Provides controllable behavior (configurable responses, injectable failures)
- Used by integration and E2E tests — NOT by unit tests (unit tests use `vi.fn()` mocks)

---

## Testing Seams

The architecture has four natural testing boundaries:

| Seam | Unit Tests | Integration Tests | E2E Tests |
|------|-----------|-------------------|-----------|
| **Schema boundary** (`src/schemas/`) | Validate parsing, defaults, edge cases | Schemas validated end-to-end through components | Schemas validated through full pipeline |
| **Adapter boundary** (`src/adapters/index.ts`) | Contract compliance suites | Fake plugins registered through Registry | Fake plugins in full daemon |
| **Component boundary** (`src/core/*/index.ts`) | Individual component logic | Cross-component interactions | Full system behavior |
| **Process boundary** (daemon lifecycle) | Not applicable | Signal handling, PID file | Full startup-to-shutdown lifecycle |

---

## Dependencies Added This Session

None. Vitest was already chosen (Decision #73). All testing infrastructure uses Vitest's built-in capabilities (config files, coverage via v8, mock utilities, fake timers) plus hand-written helpers in `test/`.

---

## CI Pipeline (Future)

When CI is established, the pipeline runs all tiers:

```
1. pnpm biome check              # lint + format
2. pnpm tsc --noEmit             # type check
3. pnpm test:coverage            # unit tests + coverage enforcement
4. pnpm test:integration         # integration tests
5. pnpm test:e2e                 # e2e tests
```

Steps 1-3 are fast (< 30s total). Steps 4-5 may be parallelized. All steps required to pass for merge.

A future `vitest.live.config.ts` can run tests against real external APIs on a schedule (daily/weekly), gated behind `ENGINEER_LIVE_TESTS=1`.
