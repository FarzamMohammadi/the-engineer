import { z } from "zod";

import { CheckpointSchema } from "./session-memory.js";
import { TaskSchema } from "./task.js";

// ── Dispatch ────────────────────────────────────────────────────────────────────
// The context package the Daemon hands to the Orchestrator when scheduling a task.
//
// The schema covers the *serializable* dispatch payload — fields persisted to
// the journal, replayed at boot, or inspected by tests. The runtime `Dispatch`
// type extends it with `signal`, an AbortSignal owned by the dispatch-tracker
// that lets phase-runner / agent-runner / agent plugins honor force-termination.
// `signal` is runtime infrastructure, not parsed input, so it lives outside
// the Zod schema by design (see Parse-Don't-Validate in coding-standards § 4).

export const DispatchSchema = z.object({
  task: TaskSchema,
  resume_from: CheckpointSchema.nullable(),
});
export type DispatchPayload = z.infer<typeof DispatchSchema>;

export type Dispatch = DispatchPayload & {
  /** Aborted by `dispatchTracker.terminate(...)`. Slice 6 ships the wiring;
   *  honoring through phase-runner → agent-runner → agent plugins lands in Slice 8. */
  readonly signal: AbortSignal;
};
