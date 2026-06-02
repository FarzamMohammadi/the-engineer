# Zod Schemas & Enum Constants

How schemas, types, and runtime enum constants work in The Engineer.

---

## Overview

All data structures are defined as Zod schemas in `src/schemas/`. Types are always inferred from schemas — never manually written. Enum-like values use the `z.enum()` + `.enum` pattern to provide compile-time types AND runtime constant objects in a single declaration.

```
src/schemas/
  task.ts                    — Task entity, state machine, transitions, permissions, block vocabulary
  events.ts                  — Event types, payloads, the payload registry
  config.ts                  — daemon, orchestrator, safety, workspace config
  adapters.ts                — adapter contracts and plugin interfaces (TriggerEvent, AgentRunRequest, etc.)
  orchestrator.ts            — pipeline phase directories, complexity, comm/safety types
  session-memory.ts          — sessions, journal, checkpoints
  ephemeral.ts               — daemon runtime state, dispatch, cost tracking
  observer.ts                — observation types, queries, blob refs
  notifications.ts           — notification kinds and recipients
  git-hosting-event-types.ts — PR-event type discriminant (dependency-free leaf)
  git-hosting-events.ts      — PR-event payloads (the typed PrEvent vocabulary)
```

---

## The Core Pattern: Schema + Type + Const Enum

Every enum-like value follows a three-part export:

```typescript
// 1. Zod schema (source of truth)
export const TaskStateSchema = z.enum([
  "requirements_gathering", "queued", "active",
  "blocked", "completed", "failed", "cancelled",
]);

// 2. TypeScript type (inferred, never manual)
export type TaskState = z.infer<typeof TaskStateSchema>;

// 3. Runtime const enum (what code uses)
export const TaskStates = TaskStateSchema.enum;
```

**Usage:**
```typescript
// Always use the const enum — never raw strings
if (task.state === TaskStates.active) { ... }
taskEngine.getBlockedTasksByReason(BlockReasons.pr_review_pending);
```

**Why all three?**
- **Schema** — runtime validation (parsing config, API payloads, DB rows)
- **Type** — compile-time type checking (function signatures, interfaces)
- **Const enum** — runtime values without string literals (refactorable, autocomplete, typo-proof)

### Naming Convention

| Part | Pattern | Example |
|------|---------|---------|
| Schema | `XxxSchema` | `TaskStateSchema`, `PrEventTypeSchema` |
| Type | `Xxx` | `TaskState`, `PrEventType` |
| Const enum | `Xxxs` (plural) | `TaskStates`, `PrEventTypes` |

### A Few Instances in the Codebase

This is a sample, not an exhaustive list — search for `z.enum` to find them all.

| File | Schema | Type | Const Enum |
|------|--------|------|------------|
| `task.ts` | `TaskStateSchema` | `TaskState` | `TaskStates` |
| `task.ts` | `SubStateSchema` | `SubState` | `SubStates` |
| `task.ts` | `ActionClassSchema` | `ActionClass` | `ActionClasses` |
| `task.ts` | `BlockReasonSchema` | `BlockReason` | `BlockReasons` |
| `task.ts` | `BlockCategorySchema` | `BlockCategory` | `BlockCategories` |
| `events.ts` | `EventTypeSchema` | `EventType` | `EventTypes` |
| `orchestrator.ts` | `ComplexitySchema` | `Complexity` | `Complexities` |
| `config.ts` | `ReviewLensSchema` | `ReviewLens` | `ReviewLensNames` |
| `config.ts` | `AutonomyLevelSchema` | `AutonomyLevel` | `AutonomyLevels` |
| `adapters.ts` | `AdapterTypeSchema` | `AdapterType` | `AdapterTypes` |
| `adapters.ts` | `MergeStrategySchema` | `MergeStrategy` | `MergeStrategies` |
| `session-memory.ts` | `SessionEndReasonSchema` | `SessionEndReason` | `SessionEndReasons` |
| `observer.ts` | `ObservationTypeSchema` | `ObservationTypeValue` | `ObservationTypes` |
| `notifications.ts` | `NotificationKindSchema` | `NotificationKind` | `NotificationKinds` |
| `git-hosting-event-types.ts` | `PrEventTypeSchema` | `PrEventType` | `PrEventTypes` |

---

## Alternative: `as const` Object Enum

When values don't need Zod validation (not parsed from external input), a plain `as const` object works:

```typescript
// src/core/orchestrator/types.ts
export const Outcomes = {
  completed: "completed",
  terminated: "terminated",
  blocked: "blocked",
  error: "error",
} as const;

export type Outcome = (typeof Outcomes)[keyof typeof Outcomes];
```

**When to use which:**
- **`z.enum()`** — value is parsed from config, DB, API, or any external source
- **`as const`** — value is only constructed internally (discriminated unions, return types)

---

## Discriminated Unions

For types with variant shapes (different fields depending on a discriminant), use `z.discriminatedUnion()`:

```typescript
// src/schemas/git-hosting-events.ts — the typed PR-event vocabulary
export const PrEventSchema = z.discriminatedUnion("type", [
  PrCommentsEventSchema,      // { type: "pr_comments"; comments: PRComment[] }
  PrCiFailureEventSchema,     // { type: "pr_ci_failure" }
  PrMergeConflictEventSchema, // { type: "pr_merge_conflict" }
  PrReadyToMergeEventSchema,  // { type: "pr_ready_to_merge" }
  PrMergedEventSchema,        // { type: "pr_merged" }
]);
export type PrEvent = z.infer<typeof PrEventSchema>;
```

TypeScript automatically narrows the variant's fields based on `type`:
```typescript
if (event.type === "pr_comments") {
  // event.comments is available here
}
```

For discriminated unions built from TypeScript types (not Zod-parsed), use the `as const` pattern:

```typescript
// src/core/orchestrator/types.ts
export type ExecuteTaskResult =
  | { outcome: typeof Outcomes.completed }
  | { outcome: typeof Outcomes.terminated; reason: TerminationReason; lastPhase: string | null; checkpointId: string | null }
  | { outcome: typeof Outcomes.blocked; phase: string; reason: string }
  | { outcome: typeof Outcomes.error; phase: string; reason: string };
```

---

## Typed Const Arrays with `as const satisfies`

For structured constant data that must match a type constraint:

```typescript
// src/schemas/task.ts — State machine transitions
export const ValidTransitions = [
  { from: "requirements_gathering", to: "queued" },
  { from: "queued", to: "active", to_sub: "working" },
  // ...
] as const satisfies ReadonlyArray<{
  readonly from: TaskState;
  readonly from_sub?: SubState;
  readonly to: TaskState;
  readonly to_sub?: SubState;
}>;
```

This gives you:
- **Compile-time literal types** — `ValidTransitions[0].from` is `"requirements_gathering"`, not `string`
- **Type safety** — a typo in `from`/`to` values is a compile error
- **Runtime data** — iterable at runtime for validation logic

---

## Lazy Schemas (Circular References)

When a schema needs to reference itself (or two schemas reference each other), `z.lazy()` defers
evaluation so the reference resolves at parse time instead of at definition time:

```typescript
const CategorySchema = z.object({
  name: z.string(),
  children: z.lazy(() => z.array(CategorySchema)),  // self-reference
});
```

Use `z.lazy()` only for genuine circular or self-referential schemas — prefer a flat shape when one
works. (The Engineer's schemas are all flat today; none currently need it.)

---

## Type-Safe Event Publishing with `satisfies`

Event payloads use `satisfies` to ensure the payload shape matches the event type:

```typescript
eventBus.publish({
  type: EventTypes["git.pr_merged"],
  source: "orchestrator",
  task_id: taskId,
  payload: { task_id: taskId, repo, pr_number, merge_strategy, merge_sha, into_branch },
} satisfies PublishInput<"git.pr_merged">);
```

A typo in the payload fields is a compile error. `PublishInput<T>` (in
`src/core/interfaces/event-bus.interface.ts`) maps an `EventType` to its payload schema.

---

## Runtime Schema Registry

For polymorphic validation (a different payload schema per event type):

```typescript
// src/schemas/events.ts
export const eventPayloadSchemas: Record<EventType, ZodType> = {
  "task.created": TaskCreatedPayloadSchema,
  "task.state_changed": TaskStateChangedPayloadSchema,
  // ...one per event type
};
```

Used by `EventTopology.validatePayload()` to validate event payloads at runtime against the
declaration's `payloadSchema`.

---

## Adding a New Enum

1. Define in the appropriate file in `src/schemas/`
2. Follow the three-part export (schema + type + const enum)
3. Use the const enum everywhere — never raw strings

```typescript
// In src/schemas/yourfile.ts
export const StatusSchema = z.enum(["pending", "active", "done"]);
export type Status = z.infer<typeof StatusSchema>;
export const Statuses = StatusSchema.enum;

// In consuming code
import { Statuses } from "../schemas/yourfile.js";
if (item.status === Statuses.active) { ... }
```

---

## Rules

1. **Schemas are the single source of truth** — types are always `z.infer<typeof XxxSchema>`, never manually written
2. **Never use raw string literals** for values that have a const enum — use `TaskStates.active`, not `"active"`
3. **`z.enum()` for external data**, `as const` for internal-only values
4. **Naming:** `XxxSchema` (schema), `Xxx` (type), `Xxxs` (const enum, plural)
5. **Always export all three parts** when using `z.enum()`
6. **Use `satisfies`** for type-safe object literals (event payloads, const arrays)
7. **Use `z.discriminatedUnion()`** for variant types, not a manual union of `z.object()`s
8. **Use `z.lazy()`** only for genuine circular or self-referential schemas

---

## File Reference

| File | What's in it |
|------|-------------|
| `src/schemas/task.ts` | `TaskState`, `SubState`, `ActionClass`, `BlockReason`, `BlockCategory`, `ValidTransitions`, `PermissionTable`, the `Task` entity |
| `src/schemas/events.ts` | `EventType`, the payload schemas, and the `eventPayloadSchemas` registry |
| `src/schemas/config.ts` | `DaemonConfig`, `OrchestratorConfig` (incl. `ReviewLens`), `SafetyConfig`, `WorkspaceConfig` |
| `src/schemas/adapters.ts` | `AdapterType`, adapter contracts, `AgentRunRequest`, `MergeStrategy`, plugin health states |
| `src/schemas/orchestrator.ts` | phase directory constants, `Complexity`, comm/safety query types |
| `src/schemas/session-memory.ts` | session, journal, checkpoint schemas |
| `src/schemas/ephemeral.ts` | `Dispatch` (daemon runtime dispatch state) |
| `src/schemas/observer.ts` | `ObservationType`, observation records and queries |
| `src/schemas/git-hosting-events.ts` | the `PrEvent` discriminated union |
| `src/core/orchestrator/types.ts` | `Outcomes` const (the `executeTask` result discriminant) |
