/**
 * Shared trace-correlation scope for pipeline observations.
 *
 * Every observation the runner or a sub-phase emits for a dispatch carries the same
 * {task_id, session_id, trace_id, phase} so the dashboard can stitch the whole task
 * together and filter by phase. This is the single source of that scope — the runner
 * emits through it, and so does every sub-phase that records its own observations
 * (agent runs, the verify verdict, the merge decision). The phase comes from the
 * runner-injected {@link Ctx.currentPhase}, overridable by an explicit argument.
 */
import type { SpanOptions } from "../../../schemas/observer.js";
import type { Ctx, Phase } from "./types.js";

/** Build the SpanOptions correlation scope for a pipeline observation, keyed to the current phase. */
export function traceScope(ctx: Ctx, phase?: Phase): SpanOptions {
  return {
    task_id: ctx.task.id,
    session_id: ctx.sessionId,
    trace_id: ctx.traceId,
    phase: phase ?? ctx.currentPhase,
    parent_observation_id: ctx.rootObservationId || undefined,
  };
}
