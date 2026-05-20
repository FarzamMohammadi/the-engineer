# Coding Standards

These standards govern all code in this project. Every contributor — human or agent — must adhere to them. No exceptions.

Biome automates what it can: formatting, import ordering, file naming, complexity limits, block statements. Run `pnpm lint` after every change. These standards cover everything biome cannot enforce — structure, naming intent, function design, type discipline, and the philosophical foundations behind every decision.

---

## 1. File Structure & Vertical Ordering

**Newspaper order.** A file reads top-to-bottom like a newspaper article: headline (exports, public API) at the top, details (private helpers) at the bottom. Caller above callee. High-level above low-level.

**`function` declarations for all named functions.** Not `const` arrows. Function declarations hoist, enabling newspaper order without workarounds. Arrow functions are reserved for inline callbacks (`.map(x => x.id)`) and returned closures.

**Section dividers** (`// ── Name ──────────`) are used sparingly — only when a file has 3+ distinct logical sections that serve different purposes. They are navigation landmarks, not documentation.

**File length:** Cohesion matters more than line count. A 400-line file with one cohesive concept is better than 4 fragmented files. 500+ lines is a smell worth examining — probably mixed concerns — but not a rule.

---

## 2. Naming

### Files & Directories

- **Files:** `kebab-case.ts`
- **Directories:** `kebab-case/`

### Variables & Functions

- **Variables and functions:** `camelCase`
- **Classes:** `PascalCase`
- **Types and interfaces:** `PascalCase`
- **Constants (module-level):** `UPPER_SNAKE_CASE` for true constants, `camelCase` for derived/computed values
- **Enum members:** `PascalCase`

### Schema Fields, Config, Database

- **Zod schema fields:** `snake_case`
- **Config YAML keys:** `snake_case`
- **Database columns:** `snake_case`

### Rules

- **Full names, no abbreviations.** `CommunicationAdapter` not `CommAdapter`. `requirements_gathering` not `req_gathering`.
- **Acronyms as words.** `LlmAdapter`, `loadHttpUrl`, `parseJsonBody` — not `LLMAdapter`, `loadHTTPURL`.
- **Boolean prefixes preferred.** Use `is`, `has`, `can`, `should`, `was`, `will` when the bare word is ambiguous. `isActive`, `hasChildren`, `shouldRetry`. Exception: obvious adjectives that can only be boolean — `enabled`, `blocked`, `active` (on a clearly boolean field).
- **No vague -ER suffixes.** `TaskManager` (manages how?) and `DataProcessor` (processes into what?) are banned. `ConfigLoader` and `EventHandler` are fine when precise. The test: if you can't describe what it does without repeating the suffix, rename it.
- **No `utils`, `helpers`, `misc`.** These are junk drawers. Move functions to the concept they belong to.
- **Domain language.** Names should mirror the business domain (Ubiquitous Language). `TaskEngine`, `PipelineStage`, `TriggerEvent` — not `ItemProcessor`, `StepExecutor`, `IncomingData`.

---

## 3. Function Design

### Length

Ousterhout pragmatic: a function can be a few dozen lines if it does one cohesive thing clearly. Don't split for the sake of splitting — splitting multiplies interfaces and forces readers to bounce between functions. The test: can you name it well? Can you follow it without scrolling? Then it's fine.

### Parameters

2-3 positional parameters is ideal. Beyond that, use an options object. Options objects are self-documenting, order-independent, and extensible without breaking callers.

### Guard Clauses

Always. Validate and bail at the top. The happy path reads flat at the lowest indentation level. No arrow code (deeply nested conditionals).

```typescript
function processTask(task: Task, config: Config): ProcessResult {
  if (!task.isReady) return { skipped: true, reason: "not ready" };
  if (task.attempts >= config.max_retries) return { skipped: true, reason: "max retries" };

  // Happy path — flat, clear, no nesting
  const result = executePipeline(task, config);
  return { skipped: false, result };
}
```

### Functional Core, Imperative Shell (FCIS)

Strict separation. If a function makes a **decision**, it must be pure — take data in, return data out, no side effects. If a function **performs effects** (I/O, database, network), it should contain minimal logic — just route the decision into the world.

```typescript
// PURE — decision logic, trivially testable
function decideNextPhase(task: Task, config: PipelineConfig): PhaseDecision { /* ... */ }

// SHELL — performs effects, minimal logic
async function advanceTask(taskId: TaskId, db: Database, eventBus: EventBus): Promise<void> {
  const task = await db.getTask(taskId);
  const decision = decideNextPhase(task, await db.getPipelineConfig());
  if (decision.next !== task.phase) {
    await db.updatePhase(taskId, decision.next);
    await eventBus.publish("task.phase_changed", { taskId, phase: decision.next });
  }
}
```

---

## 4. Type System & Schemas

### Interfaces vs Types

- **`interface`** for object shapes that represent contracts (things someone might implement or extend).
- **`type`** for unions, intersections, mapped types, and computed types.

```typescript
interface CreateTaskInput {
  title: string;
  repo: string;
  source: string;
}

type TaskState = "pending" | "active" | "blocked" | "completed" | "failed";
type UpdatableField = "phase" | "workspace" | "review";
```

### Branded Types

Brand all domain IDs by default. Smart constructors are the only way to create them.

```typescript
type TaskId = string & { readonly __brand: "TaskId" };
type SessionId = string & { readonly __brand: "SessionId" };

function TaskId(raw: string): TaskId {
  return raw as TaskId;
}
```

This prevents passing a `SessionId` where a `TaskId` is expected — the compiler catches it.

### Schema-First (Zod)

Define the Zod schema once, infer the TypeScript type from it. Single source of truth. No drift between runtime validation and static types.

```typescript
const SafetyConfigSchema = z.object({
  max_retries: z.number().int().positive().default(3),
  cost_limit_usd: z.number().positive().default(5.0),
});

type SafetyConfig = z.infer<typeof SafetyConfigSchema>;
```

### Generics

- Single-letter (`T`, `K`, `V`) for simple, obvious cases like `Array<T>` or `Map<K, V>`.
- Descriptive with T-prefix (`TInput`, `TOutput`, `TError`) when the function has multiple generics or the meaning isn't obvious from context.

### Return Type Annotations

Always annotate return types — on every function, whether exported or private. Explicit and intentful. The return type is a contract with callers and a signal of intent for readers.

```typescript
function buildPriorityQueue(config: SchedulerConfig): PriorityQueue {
  // ...
}
```

### Immutability by Default

Treat mutability as the exception that requires justification. Immutable data eliminates accidental mutation, stale references, and shared-state corruption.

- **`readonly` on properties.** Interface and type properties are `readonly` unless mutation is the explicit purpose of the field.
- **`as const` for literal collections.** Enum-like objects and fixed arrays use `as const` to narrow types and prevent accidental modification.
- **Never mutate function parameters.** If a function needs a modified version of its input, create a new object. The caller's data is not yours to change.

```typescript
// Good — immutable by default
interface TaskSnapshot {
  readonly id: TaskId;
  readonly state: TaskState;
  readonly phase: Phase;
}

const Outcomes = {
  Success: "success",
  Failure: "failure",
  Skipped: "skipped",
} as const;

// Good — new object, input untouched
function withUpdatedPhase(task: TaskSnapshot, phase: Phase): TaskSnapshot {
  return { ...task, phase };
}
```

### Parse, Don't Validate

At system boundaries (user input, config files, API responses, plugin returns), transform raw data into typed values. After the boundary, trust the types — no defensive checks deep in the codebase.

This defines where validation lives: at the edges, once, producing typed guarantees that flow inward. Code inside the boundary never re-checks what the boundary already proved.

```typescript
// Boundary — parse raw input into a typed, validated value
function parseTaskInput(raw: unknown): CreateTaskInput {
  return CreateTaskInputSchema.parse(raw);
}

// Interior — receives CreateTaskInput, trusts the type, no re-validation
function scheduleTask(input: CreateTaskInput, queue: PriorityQueue): ScheduledTask {
  return queue.enqueue(input.priority, input);
}
```

---

## 5. Error Handling

### Error Representation

- **Expected failures** (validation, not-found, rate-limited): return a Result/discriminated union. The caller sees every possible outcome in the return type.
- **Unexpected failures** (invariant violations, bugs, unreachable states): throw an Error subclass. These should never happen in correct code.

```typescript
// Expected failure — Result type (caller handles both outcomes)
function parseConfig(raw: unknown): ParseResult {
  const result = DaemonConfigSchema.safeParse(raw);
  if (!result.success) return { success: false, error: result.error.message };
  return { success: true, config: result.data };
}

// Unexpected failure — throw (invariant violation, should never happen in correct code)
function getActiveSession(task: Task): Session {
  if (!task.session_id) throw new InvariantError("Task in active state must have a session");
  return sessions.get(task.session_id);
}
```

### Error Messages

Deno style: uppercase first letter, no trailing period, active voice, quote string values.

```typescript
// Good
throw new NotFoundError(`Cannot find task "${taskId}"`);
throw new ValidationError(`Expected positive integer, got "${value}"`);

// Bad
throw new Error("task not found.");
throw new Error(`invalid value: ${value}`);
```

### Where to Catch

Let errors bubble unless you can meaningfully handle them (retry, fallback, translate for a different boundary). Never catch just to log and rethrow. Boundary layers (CLI handlers, daemon loop, API routes) are the natural catch-all points.

### Propagation Through Boundaries

Errors travel outward through the three-tier model. Each boundary translates for its consumer — never swallows, never exposes internals upward.

- **Plugin → Adapter boundary:** The adapter catches plugin-specific errors and translates them into a uniform adapter-level error. Core never sees a GitHub API error — it sees an `AdapterMethodError` with context.
- **Adapter → Core boundary:** Core handles adapter errors at the orchestrator or daemon loop level. Retry logic, fallback decisions, and user-facing messages live here.
- **Core → CLI/API boundary:** The outermost shell catches, formats for the consumer (human-readable for CLI, structured for API), and exits or responds.

```typescript
// Adapter boundary — translate, preserve cause
try {
  return await this.plugin.poll();
} catch (error) {
  throw createAdapterError("poll", this.pluginId, error);
}
```

### Cause Chains

Always preserve the original error via the standard `cause` property. Never destructure into just the message — the stack trace, cause chain, and error class are all diagnostic information.

```typescript
// Good — cause chain preserved, each layer adds context
throw new OrchestratorError(`Phase "${phase}" failed for task "${taskId}"`, { cause: error });

// Bad — original error discarded, stack trace lost
throw new OrchestratorError(`Phase failed: ${error.message}`);
```

### Error Categorization

Domain error classes must signal whether the caller should retry or give up. This is critical for a long-running daemon — the orchestrator's response to "network timeout" and "invalid task state" must be fundamentally different.

```typescript
export abstract class TaskEngineError extends Error {
  abstract readonly tag: string;
  abstract readonly retryable: boolean;
}

export class TaskNotFoundError extends TaskEngineError {
  readonly tag = "TaskNotFound" as const;
  readonly retryable = false;  // permanent — retrying won't help
}

export class WorkspaceNotReadyError extends OrchestratorError {
  readonly tag = "WorkspaceNotReady" as const;
  readonly retryable = true;   // transient — workspace may become ready
}
```

The categorization drives behavior at the boundary: retryable errors get backoff and retry. Permanent errors get logged, reported, and the task moves to a failed state. No guessing.

---

## 6. Imports & Dependencies

### Barrel Files

Allowed for module public API only. Each module directory may have one `index.ts` that defines its public surface. Internal files import directly — never through the barrel of their own module or sibling modules.

```typescript
// Consumer (outside the module):
import { TaskEngine } from "../task-engine/index.js";

// Internal (within the module):
import { StateMachine } from "./state-machine.js";  // Direct, not through index
```

### Import Ordering

Automated by the formatter. No manual ordering required. The formatter enforces a consistent deterministic order.

### No Default Exports

Named exports only. Default exports cause rename confusion, break auto-import tooling, and prevent tree-shaking.

```typescript
// Good
export function createTaskScheduler(): TaskScheduler { /* ... */ }

// Bad
export default function createTaskScheduler(): TaskScheduler { /* ... */ }
```

### Type Imports

Separate `import type` lines. Visually distinguishes runtime dependencies from type-only imports.

```typescript
import type { Task, TaskState } from "../../schemas/task.js";
import { TaskStates, CascadePolicies } from "../../schemas/task.js";
```

---

## 7. Module Boundaries

A well-bounded module is one where a contributor — human or agent — can load its full context, understand it, modify it, and verify the change without needing to understand anything beyond its contract with the outside world. That is the test of modularity. If working on a module requires reading three other modules to form a mental model, the boundaries are wrong.

### One Concept per File

A "concept" may include a type + its factory + its validators — as long as they form one cohesive unit that you can name with a single word. The test: can you name the file after the concept without it feeling forced?

### When to Split

Split when parts of a file change for different reasons (Common Closure Principle). Line count is a smell that triggers this check, not a rule in itself.

### Directory Structure

Hybrid: domain-first at the top level, technical organization within.

```
src/
  core/
    task-engine/       ← domain concept
      index.ts         ← public API (barrel)
      state-machine.ts ← internal
      queries.ts       ← internal
      errors.ts        ← internal
  adapters/            ← architectural layer
  plugins/             ← architectural layer
  schemas/             ← shared type definitions
```

### Structure Reveals Intent

A new contributor should understand what a directory contains and how its files relate — without opening any of them. Directory grouping and file names are the first layer of documentation.

- **Group by cohesion.** Files that change together, deploy together, or serve the same command/feature live in the same directory. A `commands/start/` directory with `start.ts`, `background.ts`, `dashboard.ts`, `bootstrap.ts`, and `shutdown.ts` tells you everything about the start command at a glance.
- **Eliminate redundant prefixes.** When files move into a named directory, drop the prefix that the directory already provides. `start-background.ts` becomes `background.ts` inside `commands/start/`.
- **Flat is fine when names are sufficient.** Not every pair of related files needs a directory. If the file names already communicate purpose clearly (`output.ts`, `progress.ts`, `home.ts`, `pid.ts`), grouping them adds depth without adding clarity.

The test: run `tree src/<module>/` and ask — can someone unfamiliar with the project describe what each part does? If yes, the structure is screaming its intent.

### Test Location

Tests live in a separate `tests/` directory mirroring `src/`. Fixtures colocate with their test files.

```
src/core/task-engine/index.ts
tests/core/task-engine/index.test.ts
tests/core/task-engine/fixtures/sample-task.ts
```

---

## 8. Comments & Documentation

### Philosophy

Minimal. A comment earns its place only when the code cannot express the WHY — hidden constraints, non-obvious workarounds, "we tried X and it broke because Y."

### JSDoc

Every exported function, type, class, and interface gets a one-line JSDoc description. No `@param`/`@returns` unless the signature is genuinely confusing.

```typescript
/** Poll for new trigger events from the external source. */
export function poll(): Promise<TriggerEvent[]> { /* ... */ }
```

### Section Dividers

Navigation landmarks only. Just the section name, no explanation.

```typescript
// ── Event Declarations ──────────────────────────────────────────────────────
```

### TODOs

Allowed. Must include author and context.

```typescript
// TODO(farzam): Handle unicode edge case in Korean input
```

---

## 9. Testing

### Structure

Nested `describe` blocks for context grouping. Maximum 2 levels deep.

```typescript
describe("TaskEngine", () => {
  describe("requestTransition", () => {
    it("advances to next state when transition is valid", () => { /* ... */ });
    it("rejects transition when task is blocked", () => { /* ... */ });
  });
});
```

### Naming

Behavior-as-fact. No "should." Describe what the system does, not what it "should" do.

```typescript
// Good
it("rejects transition when task is blocked")
it("emits task.created event with payload")

// Bad
it("should reject the transition")
it("should emit an event")
```

### Mocking

Mock only at system boundaries — network, filesystem, time, external services. Pure functions need no mocks (test with data). Never mock internal interfaces between modules.

### What Not to Test

- Constructors, trivial getters, simple delegation
- Anything the compiler already guarantees (type correctness, exhaustiveness)
- If TypeScript proves it at compile time, a test adds nothing

---

## 10. Code Layout & Formatting

### Automated by Biome

Biome enforces formatting (120-char lines, 2-space indent, double quotes, semicolons, trailing commas), import ordering, file naming (kebab-case), complexity limits, and block statements. Run `pnpm lint` after every change — biome catches what these standards automate. The standards below cover what biome cannot.

### Visual Principles

- **Blank lines separate concepts.** A blank line between functions, between logical groups within a function.
- **Density within related code.** Related declarations stay packed — no blank lines between a type and its immediately-related factory.
- **Guard clauses at top.** Happy path reads flat.
- **Early returns** over nested else branches.
- **No arrow code.** If indentation exceeds 3 levels, refactor.

---

## 11. Single Source of Truth

Define every value once. Derive everywhere else. A constant that appears in two places will eventually disagree — every duplicate is a future bug. Choose one authoritative location, then read or compute from it.

- **Versions and metadata.** The CLI reads its version from `package.json` at runtime — there is no hardcoded `VERSION` constant. Same applies to every consumer of project metadata.
- **Schemas drive types.** Zod schemas are the runtime source of truth; TypeScript types are derived via `z.infer` / `z.output`. Never declare a schema and a type independently. See § 4 → Schema-First (Zod).
- **Plugin and adapter requirements.** `doctor`'s external-binary checks and the setup wizard's environment detection both derive their lists from plugin manifests. Adding a new plugin requires no edits to either.
- **No duplicate constants.** If a value (a path, a magic number, a default) needs to appear in two files, the second occurrence is a derived computation or an import — never a literal repeat.

The test: when you change a value, do you have to remember every other place it lives? If yes, you have duplication. Centralize.

---

## 12. Logging

### Philosophy

Log at decision points, not I/O points. The question a log answers is **why did the system do what it did** — not what functions were called or what data flowed through.

### Levels

- **`debug`** — Developer investigating a specific issue. High volume, disabled in production. Variable values, branch conditions taken, intermediate results.
- **`info`** — Operator watching the system run. Lifecycle events: daemon started, task dispatched, phase transitioned, plugin loaded.
- **`warn`** — Something unexpected but non-fatal. A retry that succeeded, a deprecated config key, a plugin returning empty results. Deserves attention, not broken yet.
- **`error`** — Something broke and a human needs to know. Failed transitions, unhandled exceptions, invariant violations. Every `error` log must be actionable — if the reader can't respond to it, it's not an error.

### Rules

- **Structured data, always.** Every log call passes a data object alongside the message. `observer.info("Task dispatched", { taskId, phase, priority })` — not string interpolation. Structured data is queryable.
- **Log decisions, not actions.** "Chose retry because rate limit resets in 12s" is useful. "Called GitHub API" is noise — the action is visible in the span; the log captures *reasoning*.
- **One log per decision, not per step.** Don't log entry and exit of every function. Log the meaningful choice points.
- **Uniform across the three-tier boundary.** Adapter-level logging has a consistent format regardless of which plugin is behind it. The operator's experience must not change when a plugin is swapped.

---

## 13. Async Discipline

A long-running daemon cannot tolerate loose async hygiene. In Node.js 15+, an unhandled promise rejection crashes the process. Even when it doesn't crash, it's a silent failure that compounds.

### No Floating Promises

Every `async` call is either `await`ed or explicitly handled with `.catch()`. No fire-and-forget without deliberate acknowledgment.

```typescript
// Good — awaited
await eventBus.publish("task.created", payload);

// Good — explicitly fire-and-forget with error handling
cleanup().catch((error) => observer.warn("Cleanup failed", { error }));

// Bad — floating promise, silent failure
eventBus.publish("task.created", payload);
```

If you intentionally fire-and-forget, the `.catch()` handler is the documentation that it was deliberate.

### Parallel vs. Sequential

Default to sequential `await`. Use `Promise.all()` only when parallelism is intentional, bounded, and the operations are independent. Unbounded `Promise.all()` over a large array risks resource exhaustion.

```typescript
// Good — bounded parallel
const results = await Promise.all(plugins.map((p) => p.healthCheck()));

// Bad — unbounded parallel over unknown-size collection
const results = await Promise.all(allTasks.map((t) => processTask(t)));
```

### Cleanup

Long-running async operations use `AbortController` for cancellation. Resource cleanup lives in `finally` blocks — not in the success path only.

```typescript
const controller = new AbortController();
try {
  await longRunningOperation({ signal: controller.signal });
} finally {
  releaseResources();
}
```

---

## 14. Observability & Tracing

Logging captures *reasoning*. Tracing captures *structure* — the shape of an operation, its duration, its nesting, and its outcome. Together they make any behavior diagnosable after the fact.

### Span Lifecycle

Every non-trivial operation gets a span: start, annotate, end with success or error. Spans nest — a task execution span contains phase spans, which contain LLM call spans.

```typescript
const span = observer.startSpan("phase_transition", `execute-${phase}`, { taskId });
try {
  const result = await runPhase(task, phase);
  span.end({ output: result });
} catch (error) {
  span.setError(error);
  throw error;
}
```

### Trace Correlation

Every log entry carries `trace_id` for correlation with observation spans. This is the bridge between logging and tracing — filter logs by trace ID to see every log line for a specific task execution, across all component boundaries. The observer facade threads this automatically; components don't manage it.

### Record Decisions Explicitly

Non-obvious choices (retry vs. fail, plugin selection, safety verdicts) use `observer.recordDecision()` — not a log line. Decisions are first-class observations: context, options considered, chosen option, reasoning, confidence.

### Structured Events Over Free Text

"What happened" lives in typed `type` and `name` fields. "Why and how" lives in structured `input`/`output`/`metadata`. Free-text messages are for humans scanning logs — structured fields are for querying, dashboards, and automated analysis.

---

## 15. Graceful Degradation

The daemon must survive any single component failure. A plugin crash, a temporary DB lock, an LLM timeout — none of these should take down the system.

### Degrade, Don't Crash

When a dependency fails, reduce capability instead of terminating. A failed trigger plugin means no new events from that source — not a dead daemon. A failed LLM call means the current phase retries or pauses — not an orphaned task.

### Log the Degradation

Every degradation emits a `warn`-level log and a health event. The log captures: what failed, what capability is reduced, and when recovery will be attempted. Silent degradation is invisible degradation — and invisible degradation is a bug.

```typescript
observer.warn("Plugin health check failed — disabling until recovery", {
  pluginId,
  capability: "trigger polling",
  retryIn: backoff.nextAttemptMs,
});
```

### Auto-Recover

When the failed dependency returns, the system resumes full capability without manual intervention. Health checks drive recovery — when a plugin's `healthCheck()` succeeds again, re-enable it and log the recovery at `info` level.

---

## Philosophical Foundations

These are the mental models behind the standards. Internalize them before coding — they guide decisions the rules don't cover.

- **Newspaper metaphor** (Uncle Bob) — A file reads top-to-bottom: headline first, details last. Caller above callee. The reader should never scroll up to understand what they just read.
- **Deep modules** (Ousterhout) — A good module does a lot behind a simple interface. Don't split for the sake of splitting — splitting multiplies interfaces and forces readers to bounce. Pragmatic function length follows from this.
- **Simple over easy** (Hickey) — Easy means familiar. Simple means fewer entanglements. Choose simple — even when it requires learning something new. Avoid complecting (braiding together) separate concerns.
- **Functional Core / Imperative Shell** (Bernhardt) — Decisions are pure functions. Effects are thin wrappers. This makes the hard parts trivially testable and the effectful parts trivially simple.
- **Parse, don't validate** (King) — Transform unstructured input into typed, branded values at the boundary. Once parsed, the type system guarantees correctness — no runtime checks needed downstream.
- **Duplication over wrong abstraction** (Metz) — Three similar functions are better than one premature abstraction. Wait until the pattern is clear. The cost of the wrong abstraction compounds; duplication is cheap to fix later.
- **Semantic compression** (Muratori) — Don't design abstractions upfront. Write the code, see the patterns emerge, then compress. Abstraction is the last step, not the first.
- **Make the change easy, then make the easy change** (Beck) — Refactor first to make the feature trivial to add, then add it. Two small steps beat one complex step.
- **Code as narrative** (Knuth) — Code is read far more than written. Ordering, naming, and structure serve the reader's comprehension, not the writer's convenience.
- **Ubiquitous language** (DDD) — Names mirror the business domain. `TaskEngine`, `PipelineStage`, `TriggerEvent` — not `ItemProcessor`, `StepExecutor`, `IncomingData`.
- **Do one thing well, compose** (Unix) — Small, focused modules with standard interfaces. Composition over inheritance. Pipelines over monoliths.
- **Proximity and chunking** (Gestalt) — Related code stays together. Visual grouping (blank lines, sections) guides the eye. The reader's brain chunks what's close — use that.
- **Explicit over implicit** (Deno/Google) — No default exports, strict TypeScript, explicit error messages. If a reader has to guess, the code is unclear.
